#!/bin/bash
# Restart OpenDeck (the Stream Deck host app in use) completely — for plugin reload (applying built plugin.js).
# Since OpenDeck runs as a global process, send graceful quit via osascript then relaunch.
# Usage: `bash scripts/restart-opendeck.sh` (or `npm run restart`)
set -euo pipefail

APP="OpenDeck"
PROC="opendeck"

if [ "$(uname -s)" = "Linux" ]; then
  # Linux: native OpenDeck build (e.g. ~/.local/bin/opendeck) if present, otherwise the Flatpak
  # (where the plugin itself runs on the host via flatpak-spawn).
  if command -v opendeck >/dev/null 2>&1; then
    echo "==> Stopping $APP (native)..."
    pkill -x opendeck || true
    for _ in $(seq 1 10); do
      if ! pgrep -x "$PROC" >/dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done
    if pgrep -x "$PROC" >/dev/null 2>&1; then
      echo "==> Still running; forcing kill..."
      pkill -9 -x "$PROC" || true
      sleep 0.5
    fi
    pkill -f "com.byjw.deep.sdPlugin/bin/plugin.js" || true
    echo "==> Relaunching $APP..."
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --user --unit=opendeck-app --collect opendeck >/dev/null 2>&1 || setsid opendeck >/dev/null 2>&1 < /dev/null &
    else
      setsid opendeck >/dev/null 2>&1 < /dev/null &
    fi
    for _ in $(seq 1 10); do
      if pgrep -x "$PROC" >/dev/null 2>&1; then
        echo "==> OpenDeck running (PID $(pgrep -x "$PROC" | head -n 1)). Give it a moment to rescan plugins."
        exit 0
      fi
      sleep 0.5
    done
    echo "==> Warning: OpenDeck did not appear in process list."
    exit 0
  fi
  FLATPAK_ID="me.amankhanna.opendeck"
  echo "==> Stopping $APP ($FLATPAK_ID)..."
  flatpak kill "$FLATPAK_ID" >/dev/null 2>&1 || true
  # Host-side plugin processes survive the sandbox kill; OpenDeck starts them as
  # `node bin/plugin.js ... -pluginUUID com.byjw.deep.sdPlugin`.
  pkill -f "^node bin/plugin\.js .*-pluginUUID com\.byjw\.deep\." || true
  sleep 1
  echo "==> Relaunching $APP..."
  setsid flatpak run "$FLATPAK_ID" >/dev/null 2>&1 < /dev/null &
  echo "==> Done. Give it a moment to rescan plugins."
  exit 0
fi

echo "==> Quitting $APP (osascript graceful quit)..."
osascript -e "tell application \"$APP\" to quit" >/dev/null 2>&1 || true

# OpenDeck is the active host; also quit Elgato Stream Deck if it happens to be running,
# so it doesn't fight OpenDeck over the hardware or keep a duplicate deep plugin loop alive.
osascript -e 'tell application "Elgato Stream Deck" to quit' >/dev/null 2>&1 || true

# Wait up to ~5s for shutdown
for _ in $(seq 1 10); do
  if ! pgrep -x "$PROC" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if pgrep -x "$PROC" >/dev/null 2>&1; then
  echo "==> Still running; forcing kill..."
  pkill -x "$PROC" || true
  sleep 1
fi

# Kill orphaned deep plugin processes (e.g. left by a previously killed host);
# OpenDeck respawns the plugin after it comes back up.
pkill -f "com.byjw.deep.sdPlugin/bin/plugin.js" || true

echo "==> Relaunching $APP..."
open -a "$APP"

echo "==> Done. Give it a moment to rescan plugins."