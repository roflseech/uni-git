#!/usr/bin/env bash
# uni-git — developer setup on macOS (and Debian/Ubuntu best-effort). Run:  ./setup.sh
# Installs what is missing (Git, Node.js LTS, Git Credential Manager) through install.sh --deps-only, then the npm
# workspaces and the Neutralino binaries. To just use the app, run install.sh.
set -euo pipefail
cd "$(dirname "$0")"

echo "uni-git setup ($(uname -s))"
sh ./install.sh --deps-only
# Homebrew installed just now is on install.sh's PATH, not on this shell's
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if ! command -v brew >/dev/null 2>&1 && [ -x "$b" ]; then eval "$("$b" shellenv)"; fi
done

echo "Installing npm workspaces and Neutralino binaries ..."
npm run setup

echo
echo "Done. Next:  npm run dev   (or npm run dist for a distributable build)"
