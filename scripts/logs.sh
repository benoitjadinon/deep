#!/bin/bash
# Show the Deep plugin log written by OpenDeck (the plugin's stdout/stderr).
# Usage: npm run logs            # last 80 lines
#        npm run logs -- -f      # follow
UUID="com.byjw.deep.sdPlugin"
CANDIDATES=(
  "$HOME/.var/app/me.amankhanna.opendeck/data/opendeck/logs/plugins/$UUID.log"  # Linux Flatpak
  "${XDG_DATA_HOME:-$HOME/.local/share}/opendeck/logs/plugins/$UUID.log"          # Linux native
  "$HOME/Library/Application Support/opendeck/logs/plugins/$UUID.log"             # macOS
)
for f in "${CANDIDATES[@]}"; do
  if [ -f "$f" ]; then
    echo "==> $f" >&2
    if [ "${1:-}" = "-f" ]; then exec tail -n 40 -f "$f"; else exec tail -n 80 "$f"; fi
  fi
done
echo "No OpenDeck log found for $UUID" >&2
exit 1
