#!/bin/bash
# Stream Deck 어플 전체 재시작 — 플러그인 재로드(빌드된 plugin.js 반영)용.
# Stream Deck은 전역 프로세스로 떠 있으므로 `open -a`로 종료 사인 후 재기동.
# 사용: `bash scripts/restart-streamdeck.sh` (또는 `npm run restart`)
set -euo pipefail

APP="Elgato Stream Deck"

echo "==> Quitting $APP (osascript graceful quit)..."
osascript -e "tell application \"$APP\" to quit" >/dev/null 2>&1 || true

# 종료될 때까지 최대 ~5초 대기
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