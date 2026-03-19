#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# GNOME Speaks — TTS/STT floating badge for GNOME Shell
# Copyright (C) 2025 JP Hein
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
"""
GNOME Speaks — Session DBus service providing TTS and STT via Azure Speech Services.

Bus name:    org.gnome.Speaks
Object path: /org/gnome/Speaks
Interface:   org.gnome.Speaks

Uses speech-to-cli modules for all audio optimizations:
prewarmed recorder, persistent WebSocket, noise calibration caching,
HTTP session pooling, VAD, energy-gated silence detection.
"""

import argparse
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

import gi
gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib

# ---------------------------------------------------------------------------
# Import speech modules from speech-to-cli
# ---------------------------------------------------------------------------

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SPEECH_ENGINE = os.environ.get("SPEECH_ENGINE_PATH", os.path.expanduser("~/Projects/speech-to-cli"))
if not os.path.isdir(_SPEECH_ENGINE):
    print(f"Error: speech-to-cli not found at {_SPEECH_ENGINE}", file=sys.stderr)
    print("Set SPEECH_ENGINE_PATH or clone https://github.com/jphein/speech-to-cli", file=sys.stderr)
    sys.exit(1)
sys.path.insert(0, _SPEECH_ENGINE)

# ---------------------------------------------------------------------------
# Import cloud-chat-assistant path for LLM providers
# ---------------------------------------------------------------------------

_CCA_PATH = os.environ.get("CLOUD_CHAT_PATH", os.path.expanduser("~/Projects/cloud-chat-assistant"))

import state  # noqa: E402
from state import CONFIG, HAS_VAD, HAS_WS, HAS_WHISPER, FRAME_BYTES, FRAME_MS, SAMPLE_RATE  # noqa: E402
from audio import (  # noqa: E402
    _take_prewarmed_rec, _build_rec_cmd, calibrate_noise,
    is_speech_energy, rms_energy, _schedule_warmup, _prewarm_recorder,
    _discard_prewarmed_rec,
    detect_audio_output, has_echo_cancel, _refresh_audio_detection,
)
from stt import (  # noqa: E402
    stt as stt_dispatch,
    _get_stt_ws, _invalidate_stt_ws, _init_stt_ws_session,
    _make_ws_audio_msg, _parse_ws_msg, _rest_stt_fallback,
    _check_end_word, _strip_end_word,
)
import speech_tts  # noqa: E402

if HAS_VAD:
    import webrtcvad  # noqa: E402
if HAS_WS:
    import websocket  # noqa: E402

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    stream=sys.stderr,
    level=logging.DEBUG,
    format="%(asctime)s [gnome-speaks] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gnome-speaks")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BUS_NAME = "org.gnome.Speaks"
OBJECT_PATH = "/org/gnome/Speaks"
INTERFACE_NAME = "org.gnome.Speaks"

INACTIVITY_TIMEOUT_SEC = 600  # 10 minutes

MAX_LISTEN_SECONDS = 30

# ---------------------------------------------------------------------------
# DBus introspection XML
# ---------------------------------------------------------------------------

INTROSPECTION_XML = """
<node>
  <interface name="org.gnome.Speaks">
    <method name="StartListening">
      <arg direction="out" type="s" name="result"/>
    </method>
    <method name="StopListening">
      <arg direction="out" type="s" name="transcription"/>
    </method>
    <method name="Speak">
      <arg direction="in" type="s" name="text"/>
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="SpeakClipboard">
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="SpeakSelection">
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="SetLanguage">
      <arg direction="in" type="s" name="language"/>
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="GetLanguage">
      <arg direction="out" type="s" name="language"/>
    </method>
    <method name="ToggleConversationMode">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="ToggleContinuousDictation">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="ToggleVoiceQuality">
      <arg direction="out" type="s" name="quality"/>
    </method>
    <method name="GetVoiceQuality">
      <arg direction="out" type="s" name="quality"/>
    </method>
    <method name="ToggleBargeIn">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="GetBargeIn">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="ToggleHandsFree">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="GetContinuousDictation">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="GetConversationMode">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="GetHandsFree">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="ToggleTerminalMode">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="GetTerminalMode">
      <arg direction="out" type="b" name="enabled"/>
    </method>
    <method name="Talk">
      <arg direction="in" type="s" name="text"/>
      <arg direction="out" type="s" name="reply"/>
    </method>
    <method name="GetAudioInfo">
      <arg direction="out" type="s" name="info"/>
    </method>
    <method name="SetSTTMode">
      <arg direction="in" type="s" name="mode"/>
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="GetSTTMode">
      <arg direction="out" type="s" name="mode"/>
    </method>
    <method name="GetSTTModes">
      <arg direction="out" type="s" name="modes"/>
    </method>
    <method name="Stop">
      <arg direction="out" type="b" name="success"/>
    </method>
    <method name="GetState">
      <arg direction="out" type="s" name="state"/>
    </method>
    <signal name="StateChanged">
      <arg type="s" name="state"/>
    </signal>
    <signal name="TranscriptionReady">
      <arg type="s" name="text"/>
    </signal>
    <signal name="PartialTranscription">
      <arg type="s" name="text"/>
    </signal>
    <signal name="AudioLevel">
      <arg type="d" name="level"/>
    </signal>
    <signal name="Error">
      <arg type="s" name="message"/>
    </signal>
  </interface>
</node>
"""

# ---------------------------------------------------------------------------
# Clipboard helpers (our own — do not import from speech-to-cli)
# ---------------------------------------------------------------------------

def clipboard_read():
    """Read text from the clipboard (Wayland-first, X11 fallback)."""
    for cmd in [["wl-paste", "--no-newline"], ["xclip", "-selection", "clipboard", "-o"]]:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return result.stdout
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            pass
    return ""


def clipboard_write(text):
    """Write text to the clipboard (Wayland-first, X11 fallback)."""
    for cmd in [["wl-copy"], ["xclip", "-selection", "clipboard"]]:
        try:
            subprocess.run(
                cmd, input=text.encode("utf-8"),
                check=True, timeout=5,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except FileNotFoundError:
            continue
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
    return False


_TYPING_TOOL = None
_YDOTOOL_V1 = False  # True if ydotool >= 1.0 (daemon mode, different CLI flags)


def _detect_typing_tool():
    """Detect the best available typing tool at startup (avoids repeated PATH lookups)."""
    global _TYPING_TOOL, _YDOTOOL_V1
    if shutil.which("ydotool"):
        _TYPING_TOOL = "ydotool"
        _YDOTOOL_V1 = shutil.which("ydotoold") is not None or _is_ydotoold_running()
        if _YDOTOOL_V1:
            log.info("Typing tool: ydotool v1.0+ (daemon mode)")
        else:
            log.info("Typing tool: ydotool v0.x (no daemon)")
    elif shutil.which("xdotool"):
        _TYPING_TOOL = "xdotool"
        log.info("Typing tool: xdotool")
    else:
        _TYPING_TOOL = "clipboard"
        log.info("Typing tool: clipboard (install ydotool for live typing)")


def _is_ydotoold_running():
    """Check if ydotoold daemon is running."""
    try:
        result = subprocess.run(["pidof", "ydotoold"], capture_output=True, timeout=2)
        return result.returncode == 0
    except Exception:
        return False


def _reset_ydotoold():
    """Restart ydotoold to clear any stuck key state on its virtual device.

    When a ydotool command is interrupted between a key-down and key-up event,
    the virtual uinput device retains that key as "pressed". The Wayland
    compositor then suppresses that key from all physical keyboards. Restarting
    the daemon destroys the old virtual device and creates a clean one.
    """
    if not _YDOTOOL_V1:
        return
    try:
        subprocess.run(
            ["systemctl", "--user", "restart", "ydotoold"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=5,
        )
        # Give ydotoold time to create the new virtual device
        time.sleep(0.1)
        log.info("Reset ydotoold to clear stuck key state")
    except Exception as e:
        log.warning("Failed to restart ydotoold: %s", e)


def _run_ydotool(args, **kwargs):
    """Run a ydotool command, resetting ydotoold if it fails or times out.

    Any interrupted ydotool key/type command can leave keys stuck on the
    virtual device. This wrapper catches failures and restarts the daemon
    to prevent permanent key loss.
    """
    try:
        subprocess.run(args, **kwargs)
    except subprocess.TimeoutExpired:
        log.warning("ydotool timed out (%s), resetting ydotoold", args[1])
        _reset_ydotoold()
    except Exception as e:
        log.warning("ydotool failed (%s): %s, resetting ydotoold", args[1], e)
        _reset_ydotoold()


def _send_backspaces(count):
    """Send N backspace keypresses via ydotool or xdotool. Blocks until complete."""
    if count <= 0:
        return
    if _TYPING_TOOL == "ydotool":
        if _YDOTOOL_V1:
            # v1.0+: -d for key-delay, repeat by listing key pairs N times
            # Listing all pairs is more reliable than --repeat which doesn't exist in v1
            keys = ["14:1", "14:0"] * count
            _run_ydotool(
                ["ydotool", "key", "-d", "1"] + keys,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=5,
            )
        else:
            # v0.1.x: --delay for device registration, --key-delay, --repeat
            _run_ydotool(
                ["ydotool", "key", "--delay", "50", "--key-delay", "0",
                 "--repeat", str(count), "14:1", "14:0"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=5,
            )
    elif _TYPING_TOOL == "xdotool" and os.environ.get("DISPLAY"):
        subprocess.run(
            ["xdotool", "key", "--clearmodifiers"] + ["BackSpace"] * count,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=5,
        )


def _type_raw(text):
    """Type text at the cursor. Blocks until complete."""
    if not text:
        return
    if _TYPING_TOOL == "ydotool":
        if _YDOTOOL_V1:
            # v1.0+: pipe text via stdin to avoid argument-parsing space issues
            _run_ydotool(
                ["ydotool", "type", "-d", "3", "--file", "-"],
                input=text.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=10,
            )
        else:
            # v0.1.x: --delay for device registration, --key-delay between chars
            _run_ydotool(
                ["ydotool", "type", "--delay", "50", "--key-delay", "0", "--", text],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=10,
            )
    elif _TYPING_TOOL == "xdotool" and os.environ.get("DISPLAY"):
        subprocess.run(
            ["xdotool", "type", "--clearmodifiers", "--", text],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=10,
        )


def type_at_cursor(text):
    """Type text at the current cursor position using the pre-detected tool."""
    if not text:
        return False

    # Brief delay to let focus settle after badge interaction
    time.sleep(0.05)

    _type_raw(text)
    if _TYPING_TOOL in ("ydotool", "xdotool"):
        return True

    log.warning("No typing tool available (install ydotool), copying to clipboard instead")
    return clipboard_write(text)


def _clipboard_paste(text):
    """Copy text to clipboard and paste via Ctrl+Shift+V (terminals) or Ctrl+V."""
    try:
        subprocess.run(["wl-copy", "--", text], timeout=2,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        return False
    time.sleep(0.01)
    if _TYPING_TOOL == "ydotool":
        if _YDOTOOL_V1:
            # Ctrl(29) + Shift(42) + V(47) — works in terminals and most apps
            _run_ydotool(
                ["ydotool", "key", "-d", "3",
                 "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=5,
            )
        else:
            _run_ydotool(
                ["ydotool", "key", "--delay", "50", "--key-delay", "3",
                 "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=5,
            )
    return True


def replace_typed_text(old_text, new_text):
    """Update live-typed text. Append-only when possible to avoid visual flicker.

    If new_text is an extension of old_text, just type the new suffix (fast, smooth).
    If it's a revision, erase and paste via clipboard (atomic, reliable).
    """
    if _TYPING_TOOL not in ("ydotool", "xdotool"):
        return  # clipboard mode can't do live partials
    if old_text == new_text:
        return
    # Append-only: Azure hypotheses almost always extend the previous one
    if new_text.startswith(old_text):
        suffix = new_text[len(old_text):]
        if suffix:
            _type_raw(suffix)
    else:
        # Hypothesis revised earlier text — erase and paste via clipboard
        if old_text:
            _send_backspaces(len(old_text))
            time.sleep(0.01)
        _clipboard_paste(new_text)


def selection_read():
    """Read the currently highlighted/selected text (PRIMARY selection)."""
    for cmd in [["wl-paste", "--primary", "--no-newline"], ["xclip", "-selection", "primary", "-o"]]:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return result.stdout
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            pass
    return ""


# Voice commands: spoken punctuation → actual characters
_VOICE_COMMANDS = [
    (re.compile(r'\b(?:period|full stop)\b', re.I), '.'),
    (re.compile(r'\bcomma\b', re.I), ','),
    (re.compile(r'\bquestion mark\b', re.I), '?'),
    (re.compile(r'\bexclamation (?:mark|point)\b', re.I), '!'),
    (re.compile(r'\bcolon\b', re.I), ':'),
    (re.compile(r'\bsemicolon\b', re.I), ';'),
    (re.compile(r'\bnew line\b', re.I), '\n'),
    (re.compile(r'\bnew paragraph\b', re.I), '\n\n'),
    (re.compile(r'\bopen quote\b', re.I), '"'),
    (re.compile(r'\bclose quote\b', re.I), '"'),
    (re.compile(r'\bhyphen\b', re.I), '-'),
    (re.compile(r'\bdash\b', re.I), ' \u2014 '),
    (re.compile(r'\bellipsis\b', re.I), '...'),
    (re.compile(r'\btab key\b', re.I), '\t'),
]


def apply_voice_commands(text):
    """Replace spoken punctuation commands with actual characters."""
    if not CONFIG.get("voice_commands", True):
        return text
    result = text
    for pattern, replacement in _VOICE_COMMANDS:
        result = pattern.sub(replacement, result)
    # Clean up whitespace before punctuation
    result = re.sub(r'\s+([.,?!:;])', r'\1', result)
    return result


def apply_auto_corrections(text):
    """Apply user-defined word corrections from config."""
    corrections = CONFIG.get("auto_corrections", {})
    if not corrections:
        return text
    for wrong, right in corrections.items():
        text = re.sub(r'\b' + re.escape(wrong) + r'\b', right, text, flags=re.IGNORECASE)
    return text


# ---------------------------------------------------------------------------
# Service implementation
# ---------------------------------------------------------------------------

class GnomeSpeaksService:
    """Core service logic using speech-to-cli building blocks."""

    STATES = ("idle", "listening", "processing", "speaking")

    def __init__(self):
        self._state = "idle"
        self._state_lock = threading.Lock()

        # STT streaming state
        self._stop_event = threading.Event()  # our own, NOT state._cancel_event
        self._stt_thread = None
        self._stt_lock = threading.Lock()

        # TTS state
        self._speak_thread = None
        self._speak_lock = threading.Lock()

        # Talk (full-duplex TTS+STT) state
        self._talk_thread = None
        self._talk_lock = threading.Lock()

        # STT mode selection (auto, streaming, whisper, vad, fixed)
        self._stt_mode = "auto"

        # Inactivity timer
        self._inactivity_source_id = None
        self._main_loop = None

        # DBus connection (set after registration)
        self._connection = None

        # Voice quality toggle (hd = DragonHD + eastus, fast = Neural + westus)
        self._voice_quality = "hd"
        self._original_tts_region = CONFIG.get("tts_region")
        self._original_tts_key = CONFIG.get("tts_key")

        # Conversation history (cleared when conversation mode toggled off)
        self._conversation_history = []
        self._conversation_lock = threading.Lock()

    # -- State management --------------------------------------------------

    @property
    def current_state(self):
        with self._state_lock:
            return self._state

    _VALID_TRANSITIONS = {
        "idle": {"listening", "speaking"},
        "listening": {"processing", "idle"},
        "speaking": {"idle", "listening"},  # listening: hands-free auto-restart
        "processing": {"idle", "speaking"},
    }

    def _set_state(self, new_state):
        """Set state and emit StateChanged on the main loop."""
        with self._state_lock:
            if self._state == new_state:
                return
            allowed = self._VALID_TRANSITIONS.get(self._state, set())
            if new_state not in allowed:
                log.warning("Unexpected transition %s -> %s (forcing)", self._state, new_state)
            old = self._state
            self._state = new_state
        log.info("State %s -> %s", old, new_state)
        GLib.idle_add(self._emit_state_changed, new_state)
        self._reset_inactivity_timer()

    def _emit_state_changed(self, state_str):
        if self._connection is not None:
            self._connection.emit_signal(
                None, OBJECT_PATH, INTERFACE_NAME,
                "StateChanged",
                GLib.Variant("(s)", (state_str,)),
            )
        return False

    def _emit_transcription_ready(self, text):
        if self._connection is not None:
            self._connection.emit_signal(
                None, OBJECT_PATH, INTERFACE_NAME,
                "TranscriptionReady",
                GLib.Variant("(s)", (text,)),
            )
        return False

    def _emit_partial_transcription(self, text):
        if self._connection is not None:
            self._connection.emit_signal(
                None, OBJECT_PATH, INTERFACE_NAME,
                "PartialTranscription",
                GLib.Variant("(s)", (text,)),
            )
        return False

    def _emit_audio_level(self, level):
        if self._connection is not None:
            self._connection.emit_signal(
                None, OBJECT_PATH, INTERFACE_NAME,
                "AudioLevel",
                GLib.Variant("(d)", (level,)),
            )
        return False

    def _emit_error(self, message):
        log.error("Error signal: %s", message)
        if self._connection is not None:
            self._connection.emit_signal(
                None, OBJECT_PATH, INTERFACE_NAME,
                "Error",
                GLib.Variant("(s)", (message,)),
            )
        return False

    # -- Inactivity timer --------------------------------------------------

    def _reset_inactivity_timer(self):
        if self._inactivity_source_id is not None:
            GLib.source_remove(self._inactivity_source_id)
            self._inactivity_source_id = None
        self._inactivity_source_id = GLib.timeout_add_seconds(
            INACTIVITY_TIMEOUT_SEC, self._on_inactivity_timeout,
        )

    def _on_inactivity_timeout(self):
        if self.current_state == "idle":
            log.info("Inactivity timeout reached, quitting.")
            if self._main_loop is not None:
                self._main_loop.quit()
            return False
        self._inactivity_source_id = None
        self._reset_inactivity_timer()
        return False

    # -- STT: Streaming WebSocket using speech-to-cli building blocks ------

    def start_listening(self):
        """Start microphone recording with STT. Returns 'ok' or error string."""
        _refresh_audio_detection()
        if self.current_state != "idle":
            return f"error: busy ({self.current_state})"

        # Determine effective mode
        mode = self._stt_mode
        if mode == "auto":
            if HAS_WS and HAS_VAD:
                mode = "streaming"
            elif HAS_VAD:
                mode = "vad"
            else:
                mode = "fixed"

        # Use non-streaming STT backends (whisper, vad, fixed)
        if mode in ("whisper", "vad", "fixed"):
            if mode == "whisper" and not HAS_WHISPER:
                GLib.idle_add(self._emit_error, "faster-whisper not installed")
                return "error: no whisper support"
            if mode != "whisper" and not CONFIG.get("key"):
                GLib.idle_add(self._emit_error, "Azure Speech key not configured")
                return "error: no API key"

            self._stop_event.clear()
            self._set_state("listening")

            self._stt_thread = threading.Thread(
                target=self._batch_stt_worker,
                args=(mode,),
                daemon=True,
            )
            self._stt_thread.start()
            return "ok"

        # Streaming mode (default)
        if not CONFIG.get("key"):
            GLib.idle_add(self._emit_error, "Azure Speech key not configured")
            return "error: no API key"

        if not HAS_WS:
            GLib.idle_add(self._emit_error, "websocket-client not installed")
            return "error: no websocket support"

        self._stop_event.clear()
        self._set_state("listening")

        self._stt_thread = threading.Thread(
            target=self._streaming_stt_worker,
            daemon=True,
        )
        self._stt_thread.start()
        return "ok"

    def _batch_stt_worker(self, mode):
        """Background thread: batch STT using stt() dispatcher (whisper, vad, fixed)."""
        try:
            state._cancel_event.clear()
            result = stt_dispatch(mode=mode)

            if result.get("cancelled"):
                log.info("STT cancelled")
                GLib.idle_add(self._emit_transcription_ready, "")
                self._set_state("idle")
                _schedule_warmup()
                return

            user_text = result.get("text", "")

            self._set_state("processing")
            if user_text:
                user_text = apply_voice_commands(user_text)
                user_text = apply_auto_corrections(user_text)
                GLib.idle_add(self._emit_transcription_ready, user_text)
                log.info("Transcription (%s): %s", mode, user_text[:100])

                if CONFIG.get("conversation_mode", False):
                    self._conversation_worker(user_text)
                    _schedule_warmup()
                    return

                if CONFIG.get("dictation_mode", True):
                    type_at_cursor(user_text)
                else:
                    clipboard_write(user_text)
            else:
                log.info("No speech detected (%s)", mode)
                GLib.idle_add(self._emit_transcription_ready, "")

            self._set_state("idle")
            _schedule_warmup()

            if user_text and CONFIG.get("continuous_dictation", False) and not self._stop_event.is_set():
                GLib.idle_add(lambda: self.start_listening() or False)
        except Exception as exc:
            log.exception("Batch STT (%s) failed: %s", mode, exc)
            GLib.idle_add(self._emit_error, f"STT failed: {exc}")
            self._set_state("idle")
            _schedule_warmup()

    def _streaming_stt_worker(self):
        """Background thread: streaming STT using speech-to-cli building blocks."""
        _log_tag = "stt-gnome"
        _dbg = "/tmp/speech-debug.log" if (os.environ.get("SPEECH_DEBUG") or CONFIG.get("debug")) else None

        def _log(msg):
            log.debug("STT: %s", msg)
            if _dbg:
                with open(_dbg, "a") as f:
                    f.write(f"[{_log_tag} {time.strftime('%H:%M:%S')}] {msg}\n")

        end_word = CONFIG.get("end_word", "over")

        # 1. Get prewarmed recorder (or start fresh)
        proc = _take_prewarmed_rec()
        if proc is None:
            try:
                proc = subprocess.Popen(
                    _build_rec_cmd(),
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                )
            except FileNotFoundError as exc:
                GLib.idle_add(self._emit_error, f"Recorder not found: {exc}")
                self._set_state("idle")
                _schedule_warmup()
                return

        state.register_proc(proc)

        # 2. Get persistent WebSocket (with retry)
        ws = None
        ws_fresh = False
        for attempt in range(2):
            try:
                ws, ws_fresh = _get_stt_ws()
                break
            except Exception as exc:
                _log(f"WS connect attempt {attempt + 1} failed: {exc}")
                _invalidate_stt_ws()
                if attempt == 1:
                    proc.terminate()
                    proc.wait()
                    state.unregister_proc(proc)
                    GLib.idle_add(self._emit_error, f"STT WebSocket failed: {exc}")
                    self._set_state("idle")
                    _schedule_warmup()
                    return

        request_id = uuid.uuid4().hex
        try:
            _init_stt_ws_session(ws, request_id, drain=not ws_fresh)
        except Exception as exc:
            _log(f"WS session init failed: {exc}")
            _invalidate_stt_ws()
            proc.terminate()
            proc.wait()
            state.unregister_proc(proc)
            GLib.idle_add(self._emit_error, f"STT session init failed: {exc}")
            self._set_state("idle")
            _schedule_warmup()
            return

        # 3. Shared state between sender and receiver
        phrases = []
        partial_holder = [""]
        end_word_event = threading.Event()
        sender_done = threading.Event()
        raw_frames = []
        live_typing = (CONFIG.get("dictation_mode", True)
                       and not CONFIG.get("conversation_mode", False)
                       and _TYPING_TOOL in ("ydotool", "xdotool"))
        use_lexical = CONFIG.get("terminal_mode", False)
        typed_partial = [""]  # mutable: text currently live-typed into the text field
        raw_partial = [""]    # unwindowed hypothesis text for live typing diff

        # 4. Sender thread: calibrate noise, then send audio with VAD
        #    Uses calibrate_noise() to buffer calibration frames, then sends
        #    them to Azure before entering the VAD loop — matching the proven
        #    pattern from speech-to-cli's stt_streaming().
        def send_audio():
            try:
                # Calibrate noise threshold (buffers frames without sending)
                energy_threshold, cal_frames = calibrate_noise(proc)
                _log(f"calibrated: threshold={energy_threshold:.0f}, cal_frames={len(cal_frames)}")

                # Send buffered calibration frames to Azure
                for frame in cal_frames:
                    ws.send(_make_ws_audio_msg(request_id, frame), opcode=websocket.ABNF.OPCODE_BINARY)
                    raw_frames.append(frame)

                vad = webrtcvad.Vad(state.VAD_AGGRESSIVENESS) if HAS_VAD else None
                silence_frames = 0
                speech_frames = 0
                total_frames = 0
                max_silence = int(state.SILENCE_TIMEOUT * 1000 / FRAME_MS)
                max_no_speech = int(state.NO_SPEECH_TIMEOUT * 1000 / FRAME_MS)
                min_speech = int(state.MIN_SPEECH_DURATION * 1000 / FRAME_MS)
                max_frames = int(MAX_LISTEN_SECONDS * 1000 / FRAME_MS)

                _log(f"limits: max_silence={max_silence} max_no_speech={max_no_speech} min_speech={min_speech}")

                while not self._stop_event.is_set():
                    chunk = proc.stdout.read(FRAME_BYTES)
                    if not chunk or len(chunk) < FRAME_BYTES:
                        _log(f"recorder EOF at frame {total_frames}")
                        break

                    raw_frames.append(chunk)

                    try:
                        ws.send(_make_ws_audio_msg(request_id, chunk), opcode=websocket.ABNF.OPCODE_BINARY)
                    except Exception as exc:
                        _log(f"WS send error at frame {total_frames}: {exc}")
                        break

                    energy = rms_energy(chunk)
                    total_frames += 1

                    # Emit audio level for badge visualization
                    if total_frames % 3 == 0:
                        GLib.idle_add(self._emit_audio_level, min(energy / 10000.0, 1.0))

                    if is_speech_energy(chunk, vad, energy_threshold):
                        speech_frames += 1
                        silence_frames = 0
                    else:
                        silence_frames += 1

                    if end_word_event.is_set():
                        _log(f"STOP: end word '{end_word}' detected. speech={speech_frames}")
                        break
                    if speech_frames >= min_speech and silence_frames >= max_silence:
                        _log(f"STOP: silence timeout. speech={speech_frames} silence={silence_frames}/{max_silence}")
                        break
                    if speech_frames == 0 and total_frames >= max_no_speech:
                        _log(f"STOP: no speech timeout. total={total_frames}/{max_no_speech}")
                        break
                    if total_frames >= max_frames:
                        _log(f"STOP: max duration. total={total_frames}")
                        break

                _log(f"REC END: speech={speech_frames} total={total_frames}")
            except Exception as exc:
                _log(f"sender exception: {exc}")
            finally:
                proc.terminate()
                proc.wait()
                state.unregister_proc(proc)
                try:
                    ws.send(_make_ws_audio_msg(request_id, b""), opcode=websocket.ABNF.OPCODE_BINARY)
                except Exception as exc:
                    _log(f"WS final audio send failed: {exc}")
                sender_done.set()

        sender = threading.Thread(target=send_audio, daemon=True)
        sender.start()

        # 5. Receive WS messages (on this thread)
        deadline = time.time() + MAX_LISTEN_SECONDS + 5
        got_phrase = False
        natural_end = False  # True when Azure sends turn_end (vs user clicking stop)

        while time.time() < deadline and not self._stop_event.is_set():
            try:
                ws.settimeout(1.0)
                msg = ws.recv()
            except websocket.WebSocketTimeoutException:
                if sender_done.is_set():
                    if got_phrase:
                        break
                    try:
                        ws.settimeout(2.0)
                        msg = ws.recv()
                    except Exception as exc:
                        _log(f"WS recv after sender done: {exc}")
                        break
                else:
                    continue
            except Exception as exc:
                _log(f"WS recv error: {exc}")
                break

            mtype = _parse_ws_msg(msg, phrases, partial_holder, end_word_event, end_word, _log,
                                  raw_partial_holder=raw_partial, use_lexical=use_lexical)

            if mtype == "hypothesis":
                text = partial_holder[0]
                if text:
                    GLib.idle_add(self._emit_partial_transcription, text)
                    if live_typing:
                        replace_typed_text(typed_partial[0], raw_partial[0])
                        typed_partial[0] = raw_partial[0]
            elif mtype == "phrase":
                got_phrase = True
                text = partial_holder[0]
                if text:
                    GLib.idle_add(self._emit_partial_transcription, text)
                if sender_done.is_set():
                    try:
                        ws.settimeout(0.5)
                        ws.recv()  # drain final message
                    except Exception:
                        pass  # expected — no more messages
                    break
            elif mtype == "turn_end":
                _log(f"turn.end received (phrases={len(phrases)})")
                got_phrase = True  # WS analyzed audio, even if no speech found
                # Signal sender to stop recording immediately.
                # Use _stop_event for sender flow control, but track that
                # this was a natural end (not user-initiated) so continuous
                # dictation can still auto-restart.
                natural_end = True
                self._stop_event.set()
                break

        # If stop_event was set mid-stream, still wait a bit for final WS messages
        if self._stop_event.is_set() and not sender_done.is_set():
            sender.join(timeout=2)
        elif not sender_done.is_set():
            sender.join(timeout=2)
        else:
            sender.join(timeout=0.5)

        # Drain any remaining WS messages after sender is done
        if self._stop_event.is_set() and sender_done.is_set():
            drain_deadline = time.time() + 1.0
            while time.time() < drain_deadline:
                try:
                    ws.settimeout(0.5)
                    msg = ws.recv()
                except Exception:
                    break
                mtype = _parse_ws_msg(msg, phrases, partial_holder, end_word_event, end_word, _log,
                                      raw_partial_holder=raw_partial, use_lexical=use_lexical)
                if mtype == "phrase":
                    got_phrase = True
                    text = partial_holder[0]
                    if text:
                        GLib.idle_add(self._emit_partial_transcription, text)
                elif mtype == "turn_end":
                    got_phrase = True  # WS analyzed audio
                    break

        # 6. Final text
        user_text = " ".join(phrases).strip()

        # Only fall back to REST if WS never responded (connection failure).
        # If WS returned a phrase status (even InitialSilenceTimeout) or turn.end,
        # it already analyzed the audio — REST would just repeat the same result.
        if not user_text and raw_frames and not got_phrase:
            _log(f"WS returned nothing, falling back to REST STT (frames={len(raw_frames)})")
            user_text = _rest_stt_fallback(raw_frames, _log) or ""
        elif not user_text and got_phrase:
            _log(f"WS analyzed audio but found no speech (skipping REST fallback)")

        user_text = _strip_end_word(user_text, end_word)
        if use_lexical and user_text:
            user_text = user_text.lower()
        _log(f"FINAL: {repr(user_text[:100])}")

        # 7. Post-process: voice commands and auto-corrections
        if user_text:
            user_text = apply_voice_commands(user_text)
            user_text = apply_auto_corrections(user_text)

        # 8. Emit results and type/copy
        self._set_state("processing")
        if user_text:
            GLib.idle_add(self._emit_transcription_ready, user_text)
            log.info("Transcription: %s", user_text[:100])

            # Conversation mode: send to LLM then speak response
            if CONFIG.get("conversation_mode", False):
                if live_typing:
                    # Erase partial before conversation mode takes over
                    _send_backspaces(len(typed_partial[0]))
                    time.sleep(0.02)
                self._conversation_worker(user_text)
                _schedule_warmup()
                return

            # Type at cursor (dictation mode) or just copy to clipboard
            if CONFIG.get("dictation_mode", True):
                if live_typing and CONFIG.get("skip_final_paste", False):
                    # Keep the live-typed partial text as-is, no erase+paste
                    pass
                elif live_typing:
                    # Erase the live partial and paste the clean final text
                    _send_backspaces(len(typed_partial[0]))
                    time.sleep(0.02)
                    _clipboard_paste(user_text)
                else:
                    type_at_cursor(user_text)
            else:
                if live_typing and typed_partial[0]:
                    _send_backspaces(len(typed_partial[0]))
                clipboard_write(user_text)
        else:
            log.info("No speech detected")
            # Erase any partial that was live-typed
            if live_typing and typed_partial[0]:
                _send_backspaces(len(typed_partial[0]))
            GLib.idle_add(self._emit_transcription_ready, "")

        self._set_state("idle")

        # 9. Prewarm for next use
        _schedule_warmup()

        # 10. Continuous dictation: auto-restart listening
        # Restart if: text was captured, continuous mode is on, and either the
        # turn ended naturally (turn_end from Azure) or _stop_event was never
        # set (silence/VAD ended recording). Skip restart only when the user
        # explicitly stopped (stop_listening/stop set _stop_event without turn_end).
        if user_text and CONFIG.get("continuous_dictation", False) and (natural_end or not self._stop_event.is_set()):
            GLib.idle_add(lambda: self.start_listening() or False)

    def stop_listening(self):
        """Stop recording but keep accumulated text. Returns transcription."""
        if self.current_state != "listening":
            return ""

        # Signal our sender to stop (NOT state._cancel_event — that would kill the WS too)
        self._stop_event.set()

        # Wait for the STT worker thread to finish (it drains remaining WS messages)
        with self._stt_lock:
            thread = self._stt_thread
        if thread is not None:
            thread.join(timeout=10)
            with self._stt_lock:
                self._stt_thread = None

        # The worker thread already emitted TranscriptionReady and set state to idle.
        # Return empty here — the result was emitted via signal.
        return ""

    # -- TTS: Using speech_tts.tts() directly ------------------------------

    def speak(self, text):
        """Synthesize and play text via speech_tts.tts(). Returns True on success."""
        _refresh_audio_detection()
        if not text or not text.strip():
            return False

        # Stop outside lock to prevent deadlock (stop() acquires multiple locks)
        if self.current_state not in ("idle",):
            self.stop()

        if not CONFIG.get("key"):
            GLib.idle_add(self._emit_error, "Azure Speech key not configured")
            return False

        with self._speak_lock:
            self._set_state("speaking")
            self._speak_thread = threading.Thread(
                target=self._speak_worker,
                args=(text.strip(),),
                daemon=True,
            )
            self._speak_thread.start()
            return True

    def _tts_level_cb(self, level):
        """Emit AudioLevel from TTS audio stream for badge VU effect."""
        GLib.idle_add(self._emit_audio_level, level)

    def _speak_worker(self, text):
        """Background thread: TTS using speech_tts.tts()."""
        try:
            state._cancel_event.clear()
            # Show text being spoken as live subtitle on badge
            GLib.idle_add(self._emit_partial_transcription, text)
            result = speech_tts.tts(text, quality=self._voice_quality, progress_token=None,
                                    audio_level_cb=self._tts_level_cb)
            if result.get("error"):
                GLib.idle_add(self._emit_error, result["error"])
        except Exception as exc:
            log.exception("Speak failed: %s", exc)
            GLib.idle_add(self._emit_error, f"Speak failed: {exc}")
        finally:
            # Only transition to idle if we're still in speaking state.
            # Read state under lock, then call _set_state outside (it acquires its own lock).
            with self._state_lock:
                still_speaking = self._state == "speaking"
            if still_speaking:
                self._set_state("idle")
            _schedule_warmup()

            # Hands-free loop: after TTS finishes in conversation mode,
            # automatically restart listening if continuous_dictation is enabled
            if (CONFIG.get("continuous_dictation", False)
                    and CONFIG.get("conversation_mode", False)
                    and not self._stop_event.is_set()):
                log.info("Hands-free: auto-restarting listening after TTS")
                GLib.idle_add(lambda: self.start_listening() or False)

    def speak_clipboard(self):
        """Read clipboard and speak its contents."""
        text = clipboard_read()
        if not text or not text.strip():
            GLib.idle_add(self._emit_error, "Clipboard is empty")
            return False
        return self.speak(text)

    def speak_selection(self):
        """Read the currently selected/highlighted text and speak it."""
        text = selection_read()
        if not text or not text.strip():
            GLib.idle_add(self._emit_error, "No text selected")
            return False
        return self.speak(text)

    # -- Talk (full-duplex TTS+STT) ----------------------------------------

    def talk(self, text):
        """Speak text and listen for user reply via full-duplex TTS+STT.

        Returns the user's spoken reply text, or an error string prefixed
        with 'error:'.
        """
        if not text or not text.strip():
            return "error: no text provided"

        with self._talk_lock:
            if self.current_state not in ("idle",):
                self.stop()

            if not CONFIG.get("key"):
                GLib.idle_add(self._emit_error, "Azure Speech key not configured")
                return "error: no API key"

            self._stop_event.clear()
            self._set_state("speaking")

            # Use an event to pass the result back from the worker thread
            result_holder = {"reply": ""}
            done_event = threading.Event()

            self._talk_thread = threading.Thread(
                target=self._talk_worker,
                args=(text.strip(), result_holder, done_event),
                daemon=True,
            )
            self._talk_thread.start()

            # Wait for the worker to complete (blocks the D-Bus call)
            done_event.wait()
            return result_holder["reply"]

    def _talk_worker(self, text, result_holder, done_event):
        """Background thread: full-duplex TTS+STT via speech_tts.talk_fullduplex()."""
        try:
            state._cancel_event.clear()
            # Show text being spoken as live subtitle on badge
            GLib.idle_add(self._emit_partial_transcription, text)

            result = speech_tts.talk_fullduplex(
                text, quality=self._voice_quality,
                audio_level_cb=self._tts_level_cb,
                partial_cb=lambda t: GLib.idle_add(self._emit_partial_transcription, t),
            )

            if result.get("error"):
                GLib.idle_add(self._emit_error, result["error"])
                result_holder["reply"] = f"error: {result['error']}"
            elif result.get("cancelled"):
                result_holder["reply"] = ""
            else:
                user_reply = result.get("text", "")
                result_holder["reply"] = user_reply
                if user_reply:
                    GLib.idle_add(self._emit_transcription_ready, user_reply)
        except Exception as exc:
            log.exception("Talk failed: %s", exc)
            GLib.idle_add(self._emit_error, f"Talk failed: {exc}")
            result_holder["reply"] = f"error: {exc}"
        finally:
            self._set_state("idle")
            _schedule_warmup()
            done_event.set()

    def set_language(self, language):
        """Change the STT language at runtime."""
        CONFIG["language"] = language
        log.info("Language set to: %s", language)
        _invalidate_stt_ws()
        return True

    def get_language(self):
        return CONFIG.get("language", "en-US")

    def toggle_conversation_mode(self):
        current = CONFIG.get("conversation_mode", False)
        CONFIG["conversation_mode"] = not current
        if current:
            # Turning off — clear conversation history
            with self._conversation_lock:
                self._conversation_history.clear()
        log.info("Conversation mode: %s", not current)
        return not current

    def toggle_continuous_dictation(self):
        current = CONFIG.get("continuous_dictation", False)
        CONFIG["continuous_dictation"] = not current
        log.info("Continuous dictation: %s", not current)
        return not current

    def toggle_barge_in(self):
        current = CONFIG.get("enable_barge_in", False)
        CONFIG["enable_barge_in"] = not current
        log.info("Barge-in: %s", not current)
        return not current

    def get_barge_in(self):
        return CONFIG.get("enable_barge_in", False)

    def get_continuous_dictation(self):
        return CONFIG.get("continuous_dictation", False)

    def get_conversation_mode(self):
        return CONFIG.get("conversation_mode", False)

    def get_hands_free(self):
        conv = CONFIG.get("conversation_mode", False)
        cont = CONFIG.get("continuous_dictation", False)
        return conv and cont

    def toggle_terminal_mode(self):
        current = CONFIG.get("terminal_mode", False)
        CONFIG["terminal_mode"] = not current
        log.info("Terminal mode: %s", not current)
        return not current

    def get_terminal_mode(self):
        return CONFIG.get("terminal_mode", False)

    def toggle_hands_free(self):
        """Toggle hands-free mode: enables both continuous_dictation + conversation_mode together."""
        # If either is off, turn both on; if both are on, turn both off
        conv = CONFIG.get("conversation_mode", False)
        cont = CONFIG.get("continuous_dictation", False)
        if conv and cont:
            CONFIG["conversation_mode"] = False
            CONFIG["continuous_dictation"] = False
            with self._conversation_lock:
                self._conversation_history.clear()
            log.info("Hands-free mode: off")
            return False
        else:
            CONFIG["conversation_mode"] = True
            CONFIG["continuous_dictation"] = True
            log.info("Hands-free mode: on")
            return True

    def toggle_voice_quality(self):
        """Toggle between HD (DragonHD, eastus) and Fast (Neural, westus) voice modes.

        Returns the new quality string: 'fast' or 'hd'.
        """
        current = self._voice_quality
        if current == "hd":
            self._voice_quality = "fast"
            # Use STT region for faster TTS latency
            CONFIG["tts_region"] = None
            CONFIG["tts_key"] = None
            log.info("Voice quality: fast (%s, region=%s)",
                     CONFIG["fast_voice"], CONFIG["region"])
        else:
            self._voice_quality = "hd"
            # Restore HD region for DragonHD voices
            CONFIG["tts_region"] = self._original_tts_region
            CONFIG["tts_key"] = self._original_tts_key
            log.info("Voice quality: hd (%s, region=%s)",
                     CONFIG["voice"], CONFIG.get("tts_region") or CONFIG["region"])
        return self._voice_quality

    def get_voice_quality(self):
        return self._voice_quality

    def get_audio_info(self):
        """Return JSON string with detected audio device and echo cancellation info."""
        import json as _json
        _refresh_audio_detection()
        dev_type = CONFIG.get("_detected_output", "unknown")
        dev_info = CONFIG.get("_detected_output_info", {})
        ec = has_echo_cancel()
        return _json.dumps({
            "device_type": dev_type,
            "echo_cancel": ec,
            "half_duplex": CONFIG.get("half_duplex", False),
            "description": dev_info.get("description", ""),
        })

    def set_stt_mode(self, mode):
        """Set the STT mode. Valid: auto, streaming, whisper, vad, fixed."""
        valid = ("auto", "streaming", "whisper", "vad", "fixed")
        if mode not in valid:
            log.warning("Invalid STT mode: %s (valid: %s)", mode, ", ".join(valid))
            return False
        self._stt_mode = mode
        log.info("STT mode set to: %s", mode)
        return True

    def get_stt_mode(self):
        return self._stt_mode

    def get_stt_modes(self):
        """Return comma-separated list of available STT modes."""
        modes = ["auto"]
        if HAS_WS and HAS_VAD:
            modes.append("streaming")
        if HAS_WHISPER:
            modes.append("whisper")
        if HAS_VAD:
            modes.append("vad")
        modes.append("fixed")
        return ",".join(modes)

    # -- Conversation mode (voice -> LLM -> TTS) --------------------------

    _TYPE_TAG_RE = re.compile(r'<type>(.*?)</type>', re.DOTALL)

    _INTENT_PATTERNS = {
        'time_query': re.compile(
            r'\b(what time|what\'s the time|current time|what day'
            r'|what is today|what date|when is it|today\'s date)\b', re.I),
        'clipboard': re.compile(
            r'\b(clipboard|paste|pasted|copied|what I copied)\b', re.I),
        'app_context': re.compile(
            r'\b(this window|this app|what app|what window|focused'
            r'|current app|screen|what am I (using|running|in))\b', re.I),
    }

    _BASE_SYSTEM_PROMPT = (
        "You are a voice assistant. Be terse \u2014 short sentences, no filler, no preamble. "
        "Answer directly.\n"
        "When asked to type, write, or draft text, wrap it in <type>...</type> tags. "
        "Everything else is spoken aloud.\n"
        "Only use <type> tags when the user explicitly asks you to type or write something."
    )

    # Parses gdbus Eval output like "(true, 'some-app')" → 'some-app'
    _GDBUS_EVAL_RE = re.compile(r"\(true,\s*'([^']*)'\)")

    def _detect_intents(self, text):
        """Return list of intent keys matched by keyword patterns."""
        return [k for k, pat in self._INTENT_PATTERNS.items() if pat.search(text)]

    def _get_focused_app(self):
        """Get the focused window's WM_CLASS via GNOME Shell eval."""
        try:
            result = subprocess.run(
                ["gdbus", "call", "--session",
                 "--dest", "org.gnome.Shell",
                 "--object-path", "/org/gnome/Shell",
                 "--method", "org.gnome.Shell.Eval",
                 "global.display.get_focus_window()?.get_wm_class() || ''"],
                capture_output=True, text=True, timeout=1,
            )
            if result.returncode == 0:
                m = self._GDBUS_EVAL_RE.search(result.stdout)
                return m.group(1) if m and m.group(1) else None
        except Exception:
            pass
        return None

    def _get_clipboard_text(self):
        """Get clipboard text (Wayland first, X11 fallback), truncated to 200 chars."""
        for cmd in [["wl-paste", "--no-newline"], ["xclip", "-selection", "clipboard", "-o"]]:
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=1)
                if result.returncode == 0 and result.stdout.strip():
                    return result.stdout.strip()[:200]
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
        return None

    def _build_context(self, user_text):
        """Build system prompt with dynamic context. Returns (system_prompt, history)."""
        from datetime import datetime

        custom = CONFIG.get("llm_system_prompt", "")
        parts = [custom] if custom else [self._BASE_SYSTEM_PROMPT]

        # Terminal mode: inject command-generation context
        if CONFIG.get("terminal_mode", False):
            parts.append(
                "TERMINAL MODE IS ON. The user is working in a terminal. "
                "When they describe something to run, wrap the exact command in <type>...</type> tags. "
                "Keep explanations extremely brief — prefer just the command. "
                "Use lowercase, no markdown, no code fences. "
                "If they ask a general question, answer normally (spoken aloud)."
            )

        # Intent-based dynamic context injection
        intents = self._detect_intents(user_text)

        if 'time_query' in intents:
            parts.append(f"Current time: {datetime.now().strftime('%I:%M %p, %A %B %d, %Y')}")

        if 'app_context' in intents:
            app = self._get_focused_app()
            if app:
                parts.append(f"Focused application: {app}")

        if 'clipboard' in intents:
            clip = self._get_clipboard_text()
            if clip:
                parts.append(f"Clipboard content: {clip}")

        system_prompt = "\n".join(parts)

        # Trim history to last 20 exchanges (40 messages)
        with self._conversation_lock:
            history = list(self._conversation_history[-40:])
        return system_prompt, history

    def _parse_type_tags(self, reply):
        """Extract <type>...</type> content and remaining spoken text.

        Returns (type_text, speak_text). type_text is the concatenated
        content of all <type> tags (to be typed at cursor). speak_text
        is everything else (to be spoken aloud).
        """
        type_parts = self._TYPE_TAG_RE.findall(reply)
        type_text = "\n".join(type_parts) if type_parts else ""
        speak_text = self._TYPE_TAG_RE.sub("", reply).strip()
        # Clean up leftover whitespace from tag removal
        speak_text = re.sub(r'\s{2,}', ' ', speak_text)
        return type_text, speak_text

    def _conversation_worker(self, user_text):
        """Send transcribed text to an LLM and speak the response."""
        try:
            import requests as http_requests

            api_key = CONFIG.get("llm_api_key", "")
            provider = CONFIG.get("llm_provider", "anthropic")
            model = CONFIG.get("llm_model", "claude-opus-4-6")

            # Build system prompt with dynamic context + conversation history
            system_prompt, history = self._build_context(user_text)

            reply = None

            if provider in ("cloud-chat-assistant", "bedrock"):
                messages = [{"role": "system", "content": system_prompt}]
                messages.extend(history)
                messages.append({"role": "user", "content": user_text})
                reply = self._call_cloud_chat_assistant(messages, model)
            elif provider == "anthropic":
                if not api_key:
                    GLib.idle_add(self._emit_error, "No Anthropic API key configured")
                    self._set_state("idle")
                    return
                msgs = list(history) + [{"role": "user", "content": user_text}]
                resp = http_requests.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": model,
                        "max_tokens": 1024,
                        "system": system_prompt,
                        "messages": msgs,
                    },
                    timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()
                reply = data.get("content", [{}])[0].get("text", "") if data.get("content") else ""
            elif provider == "openai":
                if not api_key:
                    GLib.idle_add(self._emit_error, "No OpenAI API key configured")
                    self._set_state("idle")
                    return
                msgs = [{"role": "system", "content": system_prompt}]
                msgs.extend(history)
                msgs.append({"role": "user", "content": user_text})
                resp = http_requests.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={"model": model, "messages": msgs, "max_tokens": 1024},
                    timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()
                reply = data.get("choices", [{}])[0].get("message", {}).get("content", "") if data.get("choices") else ""
            elif provider == "azure":
                cca_config = self._load_cca_config()
                azure_key = cca_config.get("api_key", "")
                endpoint = cca_config.get("endpoint", "")
                if not azure_key or not endpoint:
                    GLib.idle_add(self._emit_error, "Azure AI not configured in cloud-chat-assistant config")
                    self._set_state("idle")
                    return
                msgs = [{"role": "system", "content": system_prompt}]
                msgs.extend(history)
                msgs.append({"role": "user", "content": user_text})
                serverless = [
                    "grok-3", "grok-3-mini", "DeepSeek-R1",
                    "Meta-Llama-3.1-405B-Instruct", "Meta-Llama-3.1-8B-Instruct",
                    "Llama-3.2-11B-Vision-Instruct", "Llama-3.2-90B-Vision-Instruct",
                    "Llama-3.3-70B-Instruct", "Llama-4-Scout-17B-16E-Instruct",
                    "Phi-4", "Cohere-command-r-plus-08-2024", "Cohere-command-r-08-2024",
                    "Codestral-2501", "Ministral-3B",
                ]
                if model in serverless:
                    url = f"{endpoint}/models/chat/completions?api-version=2024-12-01-preview"
                    body = {"model": model, "messages": msgs, "max_tokens": 1024}
                else:
                    url = f"{endpoint}/openai/deployments/{model}/chat/completions?api-version=2024-12-01-preview"
                    body = {"messages": msgs, "max_tokens": 1024}
                resp = http_requests.post(
                    url,
                    headers={"api-key": azure_key, "Content-Type": "application/json"},
                    json=body, timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()
                reply = data.get("choices", [{}])[0].get("message", {}).get("content", "") if data.get("choices") else ""
            elif provider == "google":
                cca_config = self._load_cca_config()
                google_key = cca_config.get("google_api_key", "")
                if not google_key:
                    GLib.idle_add(self._emit_error, "Google API key not configured")
                    self._set_state("idle")
                    return
                # Convert history to Google format
                contents = []
                for msg in history:
                    role = "model" if msg["role"] == "assistant" else "user"
                    contents.append({"role": role, "parts": [{"text": msg["content"]}]})
                contents.append({"role": "user", "parts": [{"text": user_text}]})
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={google_key}"
                resp = http_requests.post(
                    url,
                    headers={"Content-Type": "application/json"},
                    json={
                        "system_instruction": {"parts": [{"text": system_prompt}]},
                        "contents": contents,
                    },
                    timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()
                reply = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
            else:
                GLib.idle_add(self._emit_error, f"Unknown LLM provider: {provider}")
                self._set_state("idle")
                return

            if reply:
                # Track conversation history
                with self._conversation_lock:
                    self._conversation_history.append({"role": "user", "content": user_text})
                    self._conversation_history.append({"role": "assistant", "content": reply})
                # Parse <type>...</type> tags — type that text at cursor, speak the rest
                type_text, speak_text = self._parse_type_tags(reply)
                if type_text:
                    log.info("Typing %d chars at cursor", len(type_text))
                    type_at_cursor(type_text)

                # If there's nothing left to speak, go idle
                if not speak_text or not speak_text.strip():
                    self._set_state("idle")
                    _schedule_warmup()
                    return

                half_duplex = CONFIG.get("half_duplex", False)
                self._set_state("speaking")
                state._cancel_event.clear()
                # Show reply text as live subtitle on badge
                GLib.idle_add(self._emit_partial_transcription, speak_text)

                if half_duplex:
                    # Half-duplex: speak, then re-listen via streaming STT
                    log.info("Conversation reply (half-duplex): %s", speak_text[:100])
                    speech_tts.tts(speak_text, quality=self._voice_quality,
                                    audio_level_cb=self._tts_level_cb)
                    if state._cancel_event.is_set():
                        self._set_state("idle")
                        return
                    # Re-listen via start_listening → _streaming_stt_worker,
                    # which routes back to _conversation_worker when
                    # conversation_mode is on, giving full streaming partials.
                    self._set_state("idle")
                    _schedule_warmup()
                    GLib.idle_add(lambda: self.start_listening() or False)
                    return
                else:
                    # Full-duplex: speak + listen simultaneously
                    log.info("Conversation reply (full-duplex): %s", speak_text[:100])
                    result = speech_tts.talk_fullduplex(
                        speak_text, quality=self._voice_quality,
                        audio_level_cb=self._tts_level_cb,
                        partial_cb=lambda t: GLib.idle_add(self._emit_partial_transcription, t),
                    )
                    user_reply = result.get("text", "")

                if user_reply:
                    user_reply = apply_voice_commands(user_reply)
                    user_reply = apply_auto_corrections(user_reply)
                    GLib.idle_add(self._emit_transcription_ready, user_reply)
                    log.info("Conversation turn: %s", user_reply[:100])
                    # Continue the conversation loop
                    self._conversation_worker(user_reply)
                    return
                self._set_state("idle")
            else:
                self._set_state("idle")
        except Exception as exc:
            log.exception("Conversation failed: %s", exc)
            GLib.idle_add(self._emit_error, f"LLM error: {exc}")
            self._set_state("idle")

    def _load_cca_config(self):
        """Load cloud-chat-assistant config."""
        path = os.path.expanduser("~/.config/cloud-chat-assistant/config.json")
        try:
            with open(path) as f:
                import json as _json
                return _json.load(f)
        except Exception:
            return {}

    def _call_cloud_chat_assistant(self, messages, model):
        """Call cloud-chat-assistant's call_llm with a pre-built messages list."""
        if os.path.isdir(_CCA_PATH):
            try:
                import asyncio
                if _CCA_PATH not in sys.path:
                    sys.path.insert(0, _CCA_PATH)
                import mcp_cloud_chat as cca
                cca_config = self._load_cca_config()
                for k, v in cca_config.items():
                    cca.CONFIG[k] = v
                cca.CONFIG["deployment"] = model
                cca.CONFIG["model"] = model
                cca.CONFIG["model_type"] = cca_config.get("model_type", "bedrock")
                loop = asyncio.new_event_loop()
                try:
                    import httpx
                    async def _do_chat():
                        async with httpx.AsyncClient(timeout=60) as client:
                            response, usage, latency = await cca.call_llm(client, messages, None, model)
                            return response
                    result = loop.run_until_complete(_do_chat())
                    if result and not result.startswith("Error"):
                        return result
                    log.warning("cloud-chat-assistant returned: %s", result[:200] if result else "empty")
                    return None
                finally:
                    loop.close()
            except Exception as exc:
                log.warning("cloud-chat-assistant direct call failed: %s, falling back", exc)
        # Fallback: use Anthropic API with messages converted
        import requests as http_requests
        api_key = CONFIG.get("llm_api_key", "")
        if not api_key:
            GLib.idle_add(self._emit_error, "No API key and cloud-chat-assistant unavailable")
            return None
        # Extract system prompt and user/assistant messages for Anthropic format
        system_prompt = ""
        anthropic_msgs = []
        for msg in messages:
            if msg["role"] == "system":
                system_prompt = msg["content"]
            else:
                anthropic_msgs.append(msg)
        resp = http_requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model if "claude" in model else "claude-opus-4-6",
                "max_tokens": 1024,
                "system": system_prompt,
                "messages": anthropic_msgs,
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("content", [{}])[0].get("text", "") if data.get("content") else None

    # -- Stop --------------------------------------------------------------

    def stop(self):
        """Stop any current operation and return to idle."""
        log.info("Stop requested (current state: %s)", self.current_state)

        # Signal our stop event for the STT sender loop
        self._stop_event.set()

        # Kill all active procs and signal cancellation
        state.cancel_active()

        # Wait for threads to finish with short timeouts
        # Skip joining the current thread (e.g. conversation mode calls speak() from STT thread)
        me = threading.current_thread()

        with self._stt_lock:
            stt_t = self._stt_thread
        if stt_t is not None and stt_t is not me:
            stt_t.join(timeout=3)
            if stt_t.is_alive():
                log.warning("STT thread did not finish in 3s")
        with self._stt_lock:
            self._stt_thread = None

        with self._speak_lock:
            speak_t = self._speak_thread
        if speak_t is not None and speak_t is not me:
            speak_t.join(timeout=3)
            if speak_t.is_alive():
                log.warning("Speak thread did not finish in 3s")
        with self._speak_lock:
            self._speak_thread = None

        with self._talk_lock:
            talk_t = self._talk_thread
        if talk_t is not None and talk_t is not me:
            talk_t.join(timeout=3)
            if talk_t.is_alive():
                log.warning("Talk thread did not finish in 3s")
        with self._talk_lock:
            self._talk_thread = None

        self._set_state("idle")
        return True

    # -- Cleanup -----------------------------------------------------------

    def shutdown(self):
        """Clean up resources on exit."""
        log.info("Shutting down")
        self.stop()
        _reset_ydotoold()
        _discard_prewarmed_rec()
        _invalidate_stt_ws()


# ---------------------------------------------------------------------------
# DBus method dispatch
# ---------------------------------------------------------------------------

class DBusHandler:
    """Handles incoming DBus method calls and dispatches to the service."""

    def __init__(self, service):
        self.service = service

    def handle_method_call(self, connection, sender, object_path, interface_name,
                           method_name, parameters, invocation):
        """GDBus method call handler."""
        try:
            if method_name == "StartListening":
                result = self.service.start_listening()
                invocation.return_value(GLib.Variant("(s)", (result,)))

            elif method_name == "StopListening":
                # StopListening can block while waiting for transcription
                def _do():
                    result = self.service.stop_listening()
                    GLib.idle_add(
                        lambda: invocation.return_value(
                            GLib.Variant("(s)", (result,))
                        ) or False
                    )
                threading.Thread(target=_do, daemon=True).start()

            elif method_name == "Speak":
                text = parameters.unpack()[0]
                def _do_speak():
                    result = self.service.speak(text)
                    GLib.idle_add(
                        lambda: invocation.return_value(
                            GLib.Variant("(b)", (result,))
                        ) or False
                    )
                threading.Thread(target=_do_speak, daemon=True).start()

            elif method_name == "SpeakClipboard":
                def _do_speak_clip():
                    result = self.service.speak_clipboard()
                    GLib.idle_add(
                        lambda: invocation.return_value(
                            GLib.Variant("(b)", (result,))
                        ) or False
                    )
                threading.Thread(target=_do_speak_clip, daemon=True).start()

            elif method_name == "SpeakSelection":
                def _do_speak_sel():
                    result = self.service.speak_selection()
                    GLib.idle_add(
                        lambda: invocation.return_value(
                            GLib.Variant("(b)", (result,))
                        ) or False
                    )
                threading.Thread(target=_do_speak_sel, daemon=True).start()

            elif method_name == "Talk":
                text = parameters.unpack()[0]
                def _do_talk():
                    result = self.service.talk(text)
                    GLib.idle_add(
                        lambda: invocation.return_value(
                            GLib.Variant("(s)", (result,))
                        ) or False
                    )
                threading.Thread(target=_do_talk, daemon=True).start()

            elif method_name == "SetLanguage":
                lang = parameters.unpack()[0]
                result = self.service.set_language(lang)
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "GetLanguage":
                result = self.service.get_language()
                invocation.return_value(GLib.Variant("(s)", (result,)))

            elif method_name == "ToggleConversationMode":
                result = self.service.toggle_conversation_mode()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "ToggleContinuousDictation":
                result = self.service.toggle_continuous_dictation()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "ToggleVoiceQuality":
                result = self.service.toggle_voice_quality()
                invocation.return_value(GLib.Variant("(s)", (result,)))

            elif method_name == "GetVoiceQuality":
                result = self.service.get_voice_quality()
                invocation.return_value(GLib.Variant("(s)", (result,)))

            elif method_name == "ToggleBargeIn":
                result = self.service.toggle_barge_in()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "GetBargeIn":
                result = self.service.get_barge_in()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "ToggleHandsFree":
                result = self.service.toggle_hands_free()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "GetContinuousDictation":
                result = self.service.get_continuous_dictation()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "GetConversationMode":
                result = self.service.get_conversation_mode()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "GetHandsFree":
                result = self.service.get_hands_free()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "ToggleTerminalMode":
                result = self.service.toggle_terminal_mode()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "GetTerminalMode":
                result = self.service.get_terminal_mode()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "GetAudioInfo":
                result = self.service.get_audio_info()
                invocation.return_value(GLib.Variant("(s)", (result,)))

            elif method_name == "SetSTTMode":
                mode = parameters.unpack()[0]
                result = self.service.set_stt_mode(mode)
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "GetSTTMode":
                result = self.service.get_stt_mode()
                invocation.return_value(GLib.Variant("(s)", (result,)))

            elif method_name == "GetSTTModes":
                result = self.service.get_stt_modes()
                invocation.return_value(GLib.Variant("(s)", (result,)))

            elif method_name == "Stop":
                # Stop can block while joining threads — run async
                def _do_stop():
                    result = self.service.stop()
                    GLib.idle_add(
                        lambda: invocation.return_value(
                            GLib.Variant("(b)", (result,))
                        ) or False
                    )
                threading.Thread(target=_do_stop, daemon=True).start()

            elif method_name == "GetState":
                result = self.service.current_state
                invocation.return_value(GLib.Variant("(s)", (result,)))

            else:
                invocation.return_dbus_error(
                    "org.gnome.Speaks.UnknownMethod",
                    f"Unknown method: {method_name}",
                )
        except Exception as exc:
            log.exception("Error handling %s", method_name)
            invocation.return_dbus_error(
                "org.gnome.Speaks.InternalError",
                str(exc),
            )


# ---------------------------------------------------------------------------
# Bus ownership callbacks
# ---------------------------------------------------------------------------

def on_bus_acquired(connection, name, service, handler):
    """Called when we have a connection to the session bus."""
    log.info("Bus acquired: %s", name)

    node_info = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION_XML)
    interface_info = node_info.lookup_interface(INTERFACE_NAME)

    connection.register_object(
        OBJECT_PATH,
        interface_info,
        handler.handle_method_call,
        None,  # get_property
        None,  # set_property
    )

    service._connection = connection
    log.info("Object registered at %s", OBJECT_PATH)


def on_name_acquired(connection, name):
    """Called when we successfully own the bus name."""
    log.info("Name acquired: %s", name)


def on_name_lost(connection, name, loop):
    """Called when we lose the bus name (another instance took over, or error)."""
    log.warning("Name lost: %s — exiting", name)
    loop.quit()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="GNOME Speaks DBus service")
    parser.add_argument(
        "--replace", action="store_true",
        help="Replace an existing instance of the service",
    )
    args = parser.parse_args()

    # Validate config
    if not CONFIG.get("key"):
        log.error(
            "No Azure Speech key found. "
            "Set AZURE_SPEECH_KEY or configure ~/.config/speech-to-cli/config.json",
        )
        # Continue anyway — we will emit Error signals on method calls

    log.info(
        "Starting GNOME Speaks service (speech=%s, region=%s, vad=%s, ws=%s, whisper=%s)",
        _SPEECH_ENGINE, CONFIG.get("region"), HAS_VAD, HAS_WS, HAS_WHISPER,
    )

    _detect_typing_tool()
    _reset_ydotoold()

    # Detect audio output device and auto-enable echo cancellation
    _refresh_audio_detection()
    dev_type = CONFIG.get("_detected_output", "unknown")
    ec_present = has_echo_cancel()
    if ec_present and dev_type == "headphones":
        CONFIG["enable_echo_cancel"] = True
        log.info("Auto-enabled echo cancellation (headphones + PipeWire EC detected)")
    log.info("Audio output: %s, echo_cancel=%s, half_duplex=%s",
             dev_type, ec_present, CONFIG.get("half_duplex", False))

    # Prewarm recorder, WebSocket, and HTTP session so first call is instant
    _prewarm_recorder()
    # Pre-warm STT WebSocket and TTS HTTP connection in background
    def _prewarm_connections():
        try:
            if HAS_WS:
                _get_stt_ws()
                log.info("STT WebSocket pre-warmed")
        except Exception as exc:
            log.debug("STT WebSocket pre-warm failed (will retry on first use): %s", exc)
        try:
            session = state.get_http_session()
            tts_region = CONFIG.get("tts_region") or CONFIG.get("region")
            if tts_region:
                session.head(f"https://{tts_region}.tts.speech.microsoft.com", timeout=5)
                log.info("TTS HTTP session pre-warmed")
        except Exception as exc:
            log.debug("TTS HTTP pre-warm failed (will retry on first use): %s", exc)
    threading.Thread(target=_prewarm_connections, daemon=True).start()

    # Create service and handler
    service = GnomeSpeaksService()
    handler = DBusHandler(service)

    # Set up main loop
    loop = GLib.MainLoop()
    service._main_loop = loop

    # Request bus name
    flags = Gio.BusNameOwnerFlags.NONE
    if args.replace:
        flags = Gio.BusNameOwnerFlags.REPLACE

    owner_id = Gio.bus_own_name(
        Gio.BusType.SESSION,
        BUS_NAME,
        flags,
        lambda conn, name: on_bus_acquired(conn, name, service, handler),
        lambda conn, name: on_name_acquired(conn, name),
        lambda conn, name: on_name_lost(conn, name, loop),
    )

    # Start inactivity timer
    service._reset_inactivity_timer()

    # Handle SIGTERM/SIGINT
    def _on_signal(signum):
        log.info("Received signal %d, shutting down", signum)
        service.shutdown()
        loop.quit()
        return GLib.SOURCE_REMOVE

    GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGTERM, _on_signal, signal.SIGTERM)
    GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGINT, _on_signal, signal.SIGINT)

    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    finally:
        service.shutdown()
        Gio.bus_unown_name(owner_id)
        log.info("Exited cleanly")


if __name__ == "__main__":
    main()
