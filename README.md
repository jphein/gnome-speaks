# GNOME Speaks

A GNOME Shell extension that adds voice interaction to your desktop — speech-to-text dictation and text-to-speech readback — powered by [Azure Speech Services](https://azure.microsoft.com/en-us/products/ai-services/speech-services).

## Features

- **Floating voice badge** — glassmorphism-styled status indicator with pulse animations
- **Panel menu** — quick access to all voice actions from the top bar
- **Speech-to-text** — real-time streaming transcription via Azure WebSocket STT
- **Text-to-speech** — HD voice synthesis (DragonHD) with streaming playback
- **Keyboard shortcuts** — `Super+Alt+Space` (listen), `Super+Alt+C` (speak clipboard), `Super+Alt+R` (read selection)
- **Dictation mode** — transcribed text is typed at the cursor position
- **Conversation mode** — voice-to-LLM-to-voice with support for Anthropic, OpenAI, Azure AI, Google Vertex, and AWS Bedrock
- **Continuous dictation** — keeps listening after each utterance
- **Voice commands** — built-in commands for common actions
- **Auto-corrections** — custom find-and-replace rules applied to transcriptions
- **Language switching** — change STT/TTS language on the fly (15 languages)
- **Audio visualization** — badge scales with microphone input level

## Architecture

```
GNOME Shell process                    Background service
┌─────────────────┐     D-Bus IPC     ┌──────────────────────┐
│  extension.js   │◄──────────────────►│ gnome-speaks-service │
│  (UI only)      │   org.gnome.Speaks │  (Python)            │
│  - badge        │                    │  - audio capture     │
│  - panel menu   │                    │  - Azure STT (WS)    │
│  - keybindings  │                    │  - Azure TTS (REST)  │
│  - settings     │                    │  - LLM integration   │
└─────────────────┘                    └──────────────────────┘
```

The extension runs inside GNOME Shell's process and handles only UI. All network calls, audio I/O, and speech processing happen in a separate Python service communicating over the session D-Bus.

## Requirements

- GNOME Shell 46, 47, or 48
- PipeWire (for audio capture and playback)
- Python 3.10+
- An [Azure Speech Services](https://azure.microsoft.com/en-us/products/ai-services/speech-services) API key

### Python dependencies

```
requests websocket-client webrtcvad
```

### System tools

```
pw-record aplay glib-compile-schemas wl-paste
```

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
    "fast_voice": "en-US-AvaNeural"
}
```

Or set the `AZURE_SPEECH_KEY` environment variable.

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

All shortcuts are configurable in the extension preferences.

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
