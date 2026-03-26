<!-- claude-md-version: c2e0cdd | updated: 2026-03-22 -->
# CLAUDE.md — gnome-speaks

GNOME Shell extension (v46-48) for desktop voice interaction: STT, TTS, and AI conversation via Azure Speech Services.

## Architecture

Two-process design connected by session D-Bus (`org.gnome.Speaks`):

| File | Runtime | Role | Lines |
|------|---------|------|-------|
| `extension.js` | GNOME Shell (GJS) | UI: badge, panel indicator, subtitle overlay, keybindings, drag | ~1,800 |
| `gnome-speaks-service.py` | systemd user service (Python) | Audio, STT, TTS, LLM, typing, clipboard, conversation | ~3,000 |
| `prefs.js` | GNOME Extensions app (GJS/Gtk4) | 9-page preferences window | ~1,600 |
| `stylesheet.css` | GNOME Shell | Badge states, animations, subtitle overlay | ~350 |

The extension touches **no** network or audio -- all I/O is in the Python service.

## External Dependencies

Two sibling projects are imported at runtime (not pip packages):

- **speech-to-cli** (`~/Projects/speech-to-cli`, env `SPEECH_ENGINE_PATH`) -- provides `state`, `audio`, `stt`, `speech_tts` modules
- **cloud-chat-assistant** (`~/Projects/cloud-chat-assistant`, env `CLOUD_CHAT_PATH`) -- optional Bedrock/Azure LLM backend

Config files:
- `~/.config/speech-to-cli/config.json` -- Azure keys, STT/TTS settings, mode flags
- `~/.config/cloud-chat-assistant/config.json` -- Azure AI / Bedrock credentials

## Build & Install

```bash
./install.sh          # copies to ~/.local/share/gnome-shell/extensions/, compiles schemas, starts service
./install.sh -u       # uninstall
```

After editing extension.js, prefs.js, or stylesheet.css, re-run `./install.sh` and restart GNOME Shell (log out/in on Wayland).

After editing gnome-speaks-service.py only:
```bash
systemctl --user restart gnome-speaks.service
```

No separate build step -- files are plain JS and Python (no transpilation, no bundling).

## Service Management

```bash
systemctl --user status gnome-speaks.service
systemctl --user restart gnome-speaks.service
journalctl --user -u gnome-speaks.service -f    # live logs
```

HTTP REST API on `localhost:7710` for browser-based TTS control.

## D-Bus Interface

Bus name: `org.gnome.Speaks` | Path: `/org/gnome/Speaks`

Key methods: `StartListening`, `StopListening`, `Speak(text)`, `SpeakClipboard`, `SpeakSelection`, `Talk(text)`, `Stop`, `GetState`

Signals: `StateChanged`, `TranscriptionReady`, `PartialTranscription`, `SubtitleUpdate`, `AudioLevel`, `Error`

Test from CLI:
```bash
dbus-send --session --dest=org.gnome.Speaks --print-reply /org/gnome/Speaks org.gnome.Speaks.GetState
```

## LLM Providers

8 providers configured via prefs. `MODEL_MAP` dict in gnome-speaks-service.py translates canonical model names to provider-specific IDs.

Streaming (sentence-level TTS): Anthropic, OpenAI, Azure AI, Google, DigitalOcean, Puter
Synchronous fallback: cloud-chat-assistant, Bedrock

## Modes

| Mode | What it does |
|------|-------------|
| Type (default) | STT -> typed at cursor via ydotool |
| AI | STT -> LLM -> TTS (streaming sentence-level) |
| Loop | Auto-restart listening after each utterance |
| Terminal | Lowercase, no punctuation, lexical output |
| Talk | D-Bus API for external apps (blocking call) |
| Half/Full Duplex | Auto-detected speaker vs headphone routing |

## Coding Conventions

- **extension.js**: GJS with GNOME Shell imports (St, Clutter, Meta, Shell). No ES modules from npm -- pure GObject Introspection. Prefix private methods with `_`.
- **gnome-speaks-service.py**: GLib main loop + threading for blocking audio/network ops. `GLib.idle_add()` to marshal D-Bus signal emissions back to the main thread. Logs to stderr via `logging`.
- **prefs.js**: Adw (libadwaita) preferences pages. Config changes written to `~/.config/speech-to-cli/config.json` with debounced saves.
- **stylesheet.css**: GNOME Shell CSS (subset of CSS3). No SCSS or preprocessors.

## Key Gotchas

- **ydotool stuck keys**: If a ydotool command is interrupted between key-down and key-up, the virtual device retains that key as pressed. The service auto-restarts `ydotoold` to recover. Scripts: `fix-ydotool.sh`, `install-ydotool.sh`.
- **pw-record ignores SIGTERM**: Must use SIGKILL (`proc.kill()`) to stop PipeWire recorder processes.
- **Half-duplex drain**: On speakers, 0.5s delay after TTS before opening mic to prevent echo pickup.
- **Config dual-write**: Mode flags exist in both the Python `CONFIG` dict (runtime) and `~/.config/speech-to-cli/config.json` (disk). `_reload_config_flags()` and `_save_config_flag()` keep them in sync. Be careful not to create drift.
- **Schema compilation**: After editing the `.gschema.xml`, must run `glib-compile-schemas` on the install directory.
- **Disposed notification sources**: During shell init/restart, `MessageTray` `source-added` can fire with already-disposed `FdoNotificationDaemonSource` objects. Any signal connection on them crashes the shell. Always wrap `source.connect()` in try-catch and listen for `source-removed` to drop references before GC disposes them.
- **Azure content filter**: Avoid `[SYSTEM:]` prefix in system prompts -- Azure GPT content filter blocks it.

## Testing

No test suite. Validate changes by:
1. Restarting the service (`systemctl --user restart gnome-speaks.service`)
2. Checking logs (`journalctl --user -u gnome-speaks.service -f`)
3. Testing via D-Bus (`dbus-send`) or keyboard shortcuts
4. Python syntax check: `python3 -c "import py_compile; py_compile.compile('gnome-speaks-service.py', doraise=True)"`

## Git

Conventional commits (`feat:`, `fix:`, `refactor:`). Branch naming: `<type>/<short-description>`.
