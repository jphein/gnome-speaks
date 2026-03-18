#!/usr/bin/env python3
"""
GNOME Speaks — Session DBus service providing TTS and STT via Azure Speech Services.

Bus name:    org.gnome.Speaks
Object path: /org/gnome/Speaks
Interface:   org.gnome.Speaks

Uses vendored speech modules (speech/) for all audio optimizations:
prewarmed recorder, persistent WebSocket, noise calibration caching,
HTTP session pooling, VAD, energy-gated silence detection.
"""

import argparse
import logging
import os
import re
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
# Import speech modules: prefer live speech-to-cli (dev), fall back to vendored speech/
# ---------------------------------------------------------------------------

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_LIVE_PATH = os.path.expanduser("~/Projects/speech-to-cli")
if os.path.isdir(_LIVE_PATH):
    sys.path.insert(0, _LIVE_PATH)
else:
    sys.path.insert(0, os.path.join(_SCRIPT_DIR, "speech"))

import state  # noqa: E402
from state import CONFIG, HAS_VAD, HAS_WS, FRAME_BYTES, FRAME_MS, SAMPLE_RATE  # noqa: E402
from audio import (  # noqa: E402
    _take_prewarmed_rec, _build_rec_cmd, calibrate_noise,
    is_speech_energy, rms_energy, _schedule_warmup, _prewarm_recorder,
    _discard_prewarmed_rec,
)
from stt import (  # noqa: E402
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


def type_at_cursor(text):
    """Type text at the current cursor position using wtype (Wayland) or xdotool (X11)."""
    if not text:
        return False

    # Brief delay to let focus settle after badge interaction
    time.sleep(0.05)

    # Try wtype first (Wayland-native)
    if os.environ.get("WAYLAND_DISPLAY"):
        try:
            subprocess.Popen(
                ["wtype", "--", text],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except FileNotFoundError:
            pass

    # Try xdotool (X11)
    if os.environ.get("DISPLAY"):
        try:
            subprocess.Popen(
                ["xdotool", "type", "--clearmodifiers", "--", text],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except FileNotFoundError:
            pass

    # Final fallback: copy to clipboard
    log.warning("No typing tool available, copying to clipboard instead")
    return clipboard_write(text)


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

        # Inactivity timer
        self._inactivity_source_id = None
        self._main_loop = None

        # DBus connection (set after registration)
        self._connection = None

    # -- State management --------------------------------------------------

    @property
    def current_state(self):
        with self._state_lock:
            return self._state

    def _set_state(self, new_state):
        """Set state and emit StateChanged on the main loop."""
        with self._state_lock:
            if self._state == new_state:
                return
            self._state = new_state
        log.info("State -> %s", new_state)
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
        """Start microphone recording with streaming STT. Returns 'ok' or error string."""
        if self.current_state != "idle":
            return f"error: busy ({self.current_state})"

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
        for attempt in range(2):
            try:
                ws = _get_stt_ws()
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
            _init_stt_ws_session(ws, request_id)
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

        # 4. Sender thread: read audio frames, send to WS with VAD
        def send_audio():
            try:
                energy_threshold, cal_frames = calibrate_noise(proc)
                _log(f"calibrated: threshold={energy_threshold:.0f}, cal_frames={len(cal_frames)}")

                for frame in cal_frames:
                    ws.send(_make_ws_audio_msg(request_id, frame), opcode=websocket.ABNF.OPCODE_BINARY)

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

                    total_frames += 1

                    # Emit audio level for badge visualization
                    level = rms_energy(chunk) / 10000.0
                    if total_frames % 3 == 0:  # Throttle to every 3rd frame
                        GLib.idle_add(self._emit_audio_level, min(level, 1.0))

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
                except Exception:
                    pass
                sender_done.set()

        sender = threading.Thread(target=send_audio, daemon=True)
        sender.start()

        # 5. Receive WS messages (on this thread)
        deadline = time.time() + MAX_LISTEN_SECONDS + 5
        got_phrase = False

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
                    except Exception:
                        break
                else:
                    continue
            except Exception:
                break

            mtype = _parse_ws_msg(msg, phrases, partial_holder, end_word_event, end_word, _log)

            if mtype == "hypothesis":
                text = partial_holder[0]
                if text:
                    GLib.idle_add(self._emit_partial_transcription, text)
            elif mtype == "phrase":
                got_phrase = True
                text = partial_holder[0]
                if text:
                    GLib.idle_add(self._emit_partial_transcription, text)
                if sender_done.is_set():
                    try:
                        ws.settimeout(0.5)
                        ws.recv()
                    except Exception:
                        pass
                    break
            elif mtype == "turn_end":
                _log(f"turn.end received (phrases={len(phrases)})")
                # Signal sender to stop recording immediately
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
                mtype = _parse_ws_msg(msg, phrases, partial_holder, end_word_event, end_word, _log)
                if mtype == "phrase":
                    got_phrase = True
                    text = partial_holder[0]
                    if text:
                        GLib.idle_add(self._emit_partial_transcription, text)
                elif mtype == "turn_end":
                    break

        # 6. Final text
        user_text = " ".join(phrases).strip()

        if not user_text and raw_frames:
            _log(f"WS returned nothing, falling back to REST STT (frames={len(raw_frames)})")
            user_text = _rest_stt_fallback(raw_frames, _log) or ""

        user_text = _strip_end_word(user_text, end_word)
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
                self._conversation_worker(user_text)
                _schedule_warmup()
                return

            # Type at cursor (dictation mode) or just copy to clipboard
            if CONFIG.get("dictation_mode", True):
                type_at_cursor(user_text)
            else:
                clipboard_write(user_text)
        else:
            log.info("No speech detected")
            GLib.idle_add(self._emit_transcription_ready, "")

        self._set_state("idle")

        # 9. Prewarm for next use
        _schedule_warmup()

        # 10. Continuous dictation: auto-restart listening
        if user_text and CONFIG.get("continuous_dictation", False) and not self._stop_event.is_set():
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
        if not text or not text.strip():
            return False

        if self.current_state not in ("idle",):
            self.stop()

        if not CONFIG.get("key"):
            GLib.idle_add(self._emit_error, "Azure Speech key not configured")
            return False

        self._set_state("speaking")
        self._speak_thread = threading.Thread(
            target=self._speak_worker,
            args=(text.strip(),),
            daemon=True,
        )
        self._speak_thread.start()
        return True

    def _speak_worker(self, text):
        """Background thread: TTS using speech_tts.tts()."""
        try:
            state._cancel_event.clear()
            result = speech_tts.tts(text, quality="hd", progress_token=None)
            if result.get("error"):
                GLib.idle_add(self._emit_error, result["error"])
        except Exception as exc:
            log.exception("Speak failed: %s", exc)
            GLib.idle_add(self._emit_error, f"Speak failed: {exc}")
        finally:
            # Only transition to idle if we're still in speaking state.
            # Don't wrap _set_state in _state_lock — _set_state acquires it
            # internally, and Lock is not reentrant (would deadlock).
            if self._state == "speaking":
                self._set_state("idle")
            _schedule_warmup()

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
        log.info("Conversation mode: %s", not current)
        return not current

    def toggle_continuous_dictation(self):
        current = CONFIG.get("continuous_dictation", False)
        CONFIG["continuous_dictation"] = not current
        log.info("Continuous dictation: %s", not current)
        return not current

    # -- Conversation mode (voice -> LLM -> TTS) --------------------------

    def _conversation_worker(self, user_text):
        """Send transcribed text to an LLM and speak the response."""
        try:
            import requests as http_requests

            api_key = CONFIG.get("llm_api_key", "")
            provider = CONFIG.get("llm_provider", "anthropic")
            model = CONFIG.get("llm_model", "claude-sonnet-4-20250514")
            system_prompt = CONFIG.get(
                "llm_system_prompt",
                "You are a helpful voice assistant. Keep responses concise and conversational.",
            )

            if not api_key:
                GLib.idle_add(self._emit_error, "No LLM API key configured")
                self._set_state("idle")
                return

            if provider == "anthropic":
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
                        "messages": [{"role": "user", "content": user_text}],
                    },
                    timeout=30,
                )
                resp.raise_for_status()
                reply = resp.json()["content"][0]["text"]
            elif provider == "openai":
                resp = http_requests.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_text},
                        ],
                        "max_tokens": 1024,
                    },
                    timeout=30,
                )
                resp.raise_for_status()
                reply = resp.json()["choices"][0]["message"]["content"]
            else:
                GLib.idle_add(self._emit_error, f"Unknown LLM provider: {provider}")
                self._set_state("idle")
                return

            if reply:
                self.speak(reply)
            else:
                self._set_state("idle")
        except Exception as exc:
            log.exception("Conversation failed: %s", exc)
            GLib.idle_add(self._emit_error, f"LLM error: {exc}")
            self._set_state("idle")

    # -- Stop --------------------------------------------------------------

    def stop(self):
        """Stop any current operation and return to idle."""
        current = self.current_state
        log.info("Stop requested (current state: %s)", current)

        # Signal our stop event for the STT sender loop
        self._stop_event.set()

        # Kill all active procs and signal cancellation
        state.cancel_active()

        # Wait for threads to finish with short timeouts
        if self._stt_thread is not None:
            self._stt_thread.join(timeout=3)
            self._stt_thread = None
        if self._speak_thread is not None:
            self._speak_thread.join(timeout=3)
            self._speak_thread = None

        self._set_state("idle")
        return True

    # -- Cleanup -----------------------------------------------------------

    def shutdown(self):
        """Clean up resources on exit."""
        log.info("Shutting down")
        self.stop()
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
                result = self.service.speak(text)
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "SpeakClipboard":
                result = self.service.speak_clipboard()
                invocation.return_value(GLib.Variant("(b)", (result,)))

            elif method_name == "SpeakSelection":
                result = self.service.speak_selection()
                invocation.return_value(GLib.Variant("(b)", (result,)))

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
        "Starting GNOME Speaks service (speech=%s, region=%s, vad=%s, ws=%s)",
        os.path.join(_SCRIPT_DIR, "speech"), CONFIG.get("region"), HAS_VAD, HAS_WS,
    )

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
