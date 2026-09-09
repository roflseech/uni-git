#!/usr/bin/env bash
# epic-git — macOS (and Debian/Ubuntu best-effort) setup. Run:  ./setup.sh
# Installs what is missing (Git, Node.js LTS, Git Credential Manager) and then the project dependencies.
set -euo pipefail
cd "$(dirname "$0")"

has() { command -v "$1" >/dev/null 2>&1; }
node_ok() { has node && [ "$(node --version | sed 's/^v//' | cut -d. -f1)" -ge 20 ]; }

echo "epic-git setup ($(uname -s))"

case "$(uname -s)" in
  Darwin)
    if ! has brew; then
      echo "Installing Homebrew ..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
    fi
    has git || { echo "Installing Git ..."; brew install git; }
    node_ok || { echo "Installing Node.js LTS ..."; brew install node@22; brew link --overwrite --force node@22; }
    has git-credential-manager || { echo "Installing Git Credential Manager ..."; brew install --cask git-credential-manager; }
    ;;
  Linux)
    if has apt-get; then
      has git || { echo "Installing Git ..."; sudo apt-get update && sudo apt-get install -y git; }
      node_ok || { echo "Installing Node.js LTS ..."; curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs; }
      echo "Note: Linux also needs libwebkit2gtk-4.1 for the Neutralino window."
    else
      echo "Unsupported Linux distro for automatic install: make sure git and node >= 20 are present."
    fi
    ;;
  *) echo "Unsupported OS. On Windows run setup.cmd."; exit 1 ;;
esac

echo "  git $(git --version | sed 's/git version //')"
echo "  node $(node --version), npm $(npm --version)"

echo "Installing npm workspaces and Neutralino binaries ..."
npm run setup

echo
echo "Done. Next:  npm run dev   (or npm run dist for a distributable build)"
