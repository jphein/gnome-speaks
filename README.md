# GNOME Speaks

A GNOME Shell extension that adds voice interaction to your desktop — speech-to-text dictation and text-to-speech readback — powered by [Azure Speech Services](https://azure.microsoft.com/en-us/products/ai-services/speech-services).

## Features

- **Floating voice badge** — glassmorphism-styled status indicator with pulse animations
- **Panel menu** — quick access to all voice actions from the top bar
- **Speech-to-text** — real-time streaming transcription via Azure WebSocket STT
- **Live typing** — partial transcriptions appear in the text field as you speak, replaced by the final text when done
- **Text-to-speech** — HD and Fast voice modes (DragonHD / Neural) with streaming playback
- **Voice quality toggle** — switch between HD (DragonHD, eastus) and Fast (Neural, westus) modes via `Super+Alt+V` or the panel menu
- **Keyboard shortcuts** — `Super+Alt+Space` (listen), `Super+Alt+C` (speak clipboard), `Super+Alt+R` (read selection), `Super+Alt+V` (toggle voice quality)
- **Dictation mode** — transcribed text is typed at the cursor position via ydotool (Wayland) or xdotool (X11)
- **Conversation mode** — voice-to-LLM-to-voice with support for Anthropic, OpenAI, Azure AI, Google Vertex, and AWS Bedrock
- **Continuous dictation** — keeps listening after each utterance
- **Voice commands** — spoken punctuation ("period", "comma", "new line") converted to characters
- **Auto-corrections** — custom find-and-replace rules applied to transcriptions
- **Language switching** — change STT/TTS language on the fly (15 languages)
- **Audio visualization** — badge scales with microphone input level
- **Service auto-reconnect** — badge resets automatically when the service restarts

## Architecture

```
GNOME Shell process                    Background service
┌─────────────────┐     D-Bus IPC     ┌──────────────────────┐
│  extension.js   │◄──────────────────►│ gnome-speaks-service │
│  (UI only)      │   org.gnome.Speaks │  (Python)            │
│  - badge        │                    │  - PipeWire capture  │
│  - panel menu   │                    │  - Azure STT (WS)    │
│  - keybindings  │                    │  - Azure TTS (REST)  │
│  - settings     │                    │  - ydotool live type │
│  - bus watcher  │                    │  - LLM integration   │
└─────────────────┘                    └──────────────────────┘
```

The extension runs inside GNOME Shell's process and handles only UI. All network calls, audio I/O, and speech processing happen in a separate Python service communicating over the session D-Bus. Live typing uses ydotool (or xdotool) to inject keystrokes via `/dev/uinput`, bypassing Wayland's input restrictions.

## Requirements

- GNOME Shell 46, 47, or 48
- PipeWire (for audio capture and playback)
- Python 3.10+
- An [Azure Speech Services](https://azure.microsoft.com/en-us/products/ai-services/speech-services) API key

### Python dependencies

```
requests websocket-client webrtcvad numpy
```

### System tools

```
pw-record aplay glib-compile-schemas wl-paste ydotool
```

#### ydotool (recommended: v1.0+ from source)

The packaged version on Ubuntu 24.04 (v0.1.8) works but adds ~50ms latency per keystroke.
For instant live typing, build v1.0+ from source to get the `ydotoold` daemon:

```bash
sudo apt install -y cmake scdoc git build-essential
git clone https://github.com/ReimuNotMoe/ydotool.git /tmp/ydotool
cd /tmp/ydotool && mkdir build && cd build && cmake .. && make -j$(nproc)
sudo make install
sudo systemctl enable --now ydotool.service
```

The service auto-detects whether `ydotoold` is running and adjusts accordingly.

## Installation

### Quick install

```bash
git clone https://github.com/jphein/gnome-speaks.git
cd gnome-speaks
./install.sh
```

The installer will:
1. Copy extension files to `~/.local/share/gnome-shell/extensions/gnome-speaks@jphein/`
2. Compile GSettings schemas
3. Install and start the systemd user service
4. Register the D-Bus service for auto-activation
5. Install missing Python dependencies
6. Enable the extension

Restart GNOME Shell after installation (log out and back in on Wayland, or `Alt+F2` → `r` on X11).

### Meson build (alternative)

```bash
meson setup build
meson install -C build
```

### Uninstall

```bash
./install.sh --uninstall
```

## Configuration

### Azure Speech key

Create `~/.config/speech-to-cli/config.json`:

```json
{
    "key": "YOUR_AZURE_SPEECH_KEY",
    "region": "westus",
    "tts_region": "eastus",
    "voice": "en-US-Ava:DragonHDLatestNeural",
    "fast_voice": "en-US-AvaNeural",
    "language": "en-US"
}
```

| Key | Description |
|-----|-------------|
| `key` | Azure Speech API key (or set `AZURE_SPEECH_KEY` env var) |
| `region` | STT region and fast-voice TTS region (e.g., `westus`) |
| `tts_region` | HD voice TTS region (e.g., `eastus` — DragonHD voices are only available in select regions) |
| `voice` | HD voice name (used in HD quality mode) |
| `fast_voice` | Fast voice name (used in Fast quality mode) |
| `language` | STT/TTS language code |

You can get a free Azure Speech key at [Azure Portal](https://portal.azure.com) — the free tier includes 500K characters/month for TTS and 5 hours/month for STT.

### Extension preferences

Open GNOME Extensions app → GNOME Speaks → Preferences, or:

```bash
gnome-extensions prefs gnome-speaks@jphein
```

Settings include voice selection (HD/fast), silence timeout, keyboard shortcuts, conversation mode (LLM provider and model), auto-corrections, and badge positioning.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Super+Alt+Space` | Toggle listening (start/stop STT) |
| `Super+Alt+C` | Speak clipboard contents aloud |
| `Super+Alt+R` | Read selected text aloud |
| `Super+Alt+V` | Toggle voice quality (HD / Fast) |

All shortcuts are configurable in the extension preferences.

## Performance

The service is optimized for low-latency voice interaction:

- **Prewarmed connections** — recorder process, STT WebSocket, and TTS HTTP session are kept alive between uses
- **Inline noise calibration** — audio frames are sent to Azure while calibrating (no blocking delay)
- **WebSocket reuse** — persistent STT connection saves ~230ms per utterance
- **Numpy RMS fast-path** — SIMD-vectorized audio energy calculation (~5-10x faster)
- **Diff-aware live typing** — only erases and retypes the changed suffix of each partial hypothesis
- **ydotool daemon mode** — with ydotoold, keystroke injection is sub-millisecond (no uinput device churn)

## Service management

```bash
# Check status
systemctl --user status gnome-speaks

# View live logs
journalctl --user -u gnome-speaks -f

# Restart after config changes
systemctl --user restart gnome-speaks
```

## License

[GPL-3.0-or-later](LICENSE)
