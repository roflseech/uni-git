#!/bin/sh
# macOS/Linux launcher for the backend extension. GUI apps start with a minimal PATH, so look for node
# in the usual places (Homebrew, nvm, fnm, volta) before giving up.
here="$(cd "$(dirname "$0")" && pwd)"
for candidate in \
  "$(command -v node 2>/dev/null)" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$HOME/.volta/bin/node" \
  "$HOME/.fnm/aliases/default/bin/node" \
  "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$here/main.js" "$@"
  fi
done
echo "epic-git: node not found" >&2
exit 1
