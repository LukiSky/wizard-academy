#!/usr/bin/env bash
# Start the game. Reads .env if there is one, so the n8n webhook and the voice
# can be set without exporting anything by hand.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] && { set -a; . ./.env; set +a; }

# Pocket TTS lives in the venv one level up, next to say.py. Falling back to the
# system python is fine - the server notices the import failed and uses the
# browser's voice instead of dying.
# The path must be absolute: python resolves its own venv from argv[0], and a
# "../" in there makes site.py warn on every start.
VENV="$(cd .. && pwd)/.venv-pockettts/bin/python"
if [ -x "$VENV" ]; then PY="$VENV"; else PY="$(command -v python3)"; fi

exec "$PY" server.py "$@"
