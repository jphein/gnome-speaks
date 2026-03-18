# Smart LLM Context System

## Problem
Conversation mode sends each user turn as a stateless request -- no memory of prior turns, no awareness of time/clipboard/focused app. This makes the voice assistant feel amnesic and disconnected from the user's environment.

## Design: Layered Context with Intent Detection

### Architecture
Three layers assembled per turn:
1. **Base system prompt** (~150 tokens, always present) -- terse voice personality + `<type>` tag instructions
2. **Dynamic context** (0-100 tokens, injected when relevant) -- time, clipboard, focused app
3. **Conversation history** (variable, trimmed to 20 exchanges) -- full session memory

### Intent Detection
Regex keyword matching on user text determines which dynamic context blocks to inject:
- `time_query`: matches "what time", "today", "what date", etc. -> injects datetime
- `clipboard`: matches "clipboard", "paste", "copied", etc. -> injects first 200 chars of clipboard via `wl-paste`/`xclip`
- `app_context`: matches "this window", "this app", "current app", etc. -> injects focused window name via GNOME Shell eval

No LLM call needed for classification -- simple regex is fast and sufficient for these patterns.

### Message Assembly
```
[system: base_prompt + dynamic_blocks]
[history: user/assistant pairs from session]
[user: current turn]
```

Provider-specific formatting:
- **Anthropic**: `system` separate, messages = history + current
- **OpenAI/Azure/Bedrock (via cloud-chat-assistant)**: system as first message in messages array
- **Google**: converted to `contents` format with `user`/`model` roles

### Conversation History Management
- `self._conversation_history: list[dict]` -- list of `{"role": "user/assistant", "content": ...}`
- Appended after each successful LLM call (both user turn and assistant reply)
- Trimmed to last 40 messages (20 exchanges) before each call
- Cleared when conversation mode is toggled off
- Cleared when hands-free mode is toggled off

### System Prompt
Default (when no custom `llm_system_prompt` configured):
```
You are a voice assistant. Be terse -- short sentences, no filler, no preamble. Answer directly.
When asked to type, write, or draft text, wrap it in <type>...</type> tags. Everything else is spoken aloud.
Only use <type> tags when the user explicitly asks you to type or write something.
```

### Context Retrieval
- **Time**: `datetime.now().strftime('%I:%M %p, %A %B %d, %Y')`
- **Focused app**: `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "global.display.get_focus_window()?.get_wm_class() || ''"` -- parsed from GVariant tuple
- **Clipboard**: `wl-paste --no-newline` (Wayland) with `xclip -selection clipboard -o` (X11) fallback, truncated to 200 chars

### Files Modified
- `gnome-speaks-service.py`: Add `_INTENT_PATTERNS`, `_detect_intents()`, `_get_focused_app()`, `_get_clipboard_text()`, `_build_context()`. Modify `_conversation_worker()` to use context builder and maintain history. Modify `_call_cloud_chat_assistant()` to accept full messages. Clear history on mode toggle.

### Token Budget (typical turn)
- Base prompt: ~50 tokens
- Dynamic context: 0-30 tokens (only when triggered)
- Per history turn: ~20-50 tokens
- Max history: ~800 tokens (20 exchanges)
- **Total max**: ~880 tokens system + history

### Trade-offs
- **Pro**: Minimal tokens on simple "what's the weather" queries
- **Pro**: Intent detection is zero-latency (regex)
- **Con**: Regex can miss unusual phrasings (acceptable -- missing context doesn't break anything)
- **Con**: Subprocess calls for clipboard/focused app add ~50ms (only when triggered)
