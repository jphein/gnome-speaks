#!/usr/bin/env bash
# Sync vendored speech modules from speech-to-cli
set -euo pipefail

SRC="${1:-$HOME/Projects/speech-to-cli}"
DST="$(dirname "$(realpath "$0")")/speech"

if [[ ! -d "$SRC" ]]; then
    echo "Error: speech-to-cli not found at $SRC" >&2
    echo "Usage: $0 [/path/to/speech-to-cli]" >&2
    exit 1
fi

for f in state.py audio.py stt.py speech_tts.py; do
    cp "$SRC/$f" "$DST/$f"
    echo "  $f"
done

echo "Synced from $SRC"
