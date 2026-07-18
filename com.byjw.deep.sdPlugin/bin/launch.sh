#!/bin/bash
# Elgato 관리형 Node 런타임 대신 시스템 node로 plugin.js를 실행.
# 여러 맥에서 동작하도록 node 위치를 견고하게 탐색(PATH → 홈브루/로컬/nvm).
# Stream Deck이 넘기는 -port/-pluginUUID/-registerEvent/-info 를 "$@"로 전달.
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node 2>/dev/null)"
for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -z "$NODE" ] && [ -x "$p" ] && NODE="$p"
done
[ -z "$NODE" ] && NODE=node
exec "$NODE" "$DIR/plugin.js" "$@"
