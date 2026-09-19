#!/bin/bash
# Restart Elgato Stream Deck app completely — for plugin reload (applying built plugin.js).
# Since Stream Deck runs as a global process, send graceful quit via osascript then relaunch.
# Usage: `bash scripts/restart-streamdeck.sh` (or `npm run restart`)
set -euo pipefail

APP="Elgato Stream Deck"

echo "==> Quitting $APP (osascript graceful quit)..."
osascript -e "tell application \"$APP\" to quit" >/dev/null 2>&1 || true

# Wait up to ~5s for shutdown
for _ in $(seq 1 10); do
  if ! pgrep -x "Stream Deck" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if pgrep -x "Stream Deck" >/dev/null 2>&1; then
  echo "==> Still running; forcing kill..."
  pkill -x "Stream Deck" || true
  sleep 1
fi

echo "==> Relaunching $APP..."
open -a "$APP"

echo "==> Done. Give it a moment to rescan plugins."