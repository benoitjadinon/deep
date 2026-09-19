#!/bin/bash
# Run plugin.js with system node instead of Elgato-managed Node runtime.
# Robustly search for node across different macOS setups (PATH -> Homebrew/local/nvm).
# Forward arguments passed by Stream Deck (-port/-pluginUUID/-registerEvent/-info) via "$@".
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node 2>/dev/null)"
for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -z "$NODE" ] && [ -x "$p" ] && NODE="$p"
done
[ -z "$NODE" ] && NODE=node
exec "$NODE" "$DIR/plugin.js" "$@"
