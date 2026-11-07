#!/bin/sh
# uni-git installer for macOS. In Terminal:
#   curl -fsSL https://github.com/roflseech/uni-git/releases/latest/download/install.sh | sh
# Installs what is missing (Homebrew, Git, Node.js, Git Credential Manager), then the latest uni-git into
# ~/Library/Application Support/uni-git/app with a launcher at ~/Applications/uni-git.app, and starts it.
# Run it again to repair an installation; afterwards the app updates itself. Settings in app/data stay as they are.
# setup.sh (developer setup) runs it with --deps-only, which also covers Debian/Ubuntu; a new prerequisite goes here
# and into install.ps1.
# Test overrides: UNI_GIT_RELEASES (URL of a folder with latest.json), UNI_GIT_INSTALL_DIR.
set -eu

REPO="roflseech/uni-git"

has() { command -v "$1" >/dev/null 2>&1; }
node_ok() { has node && [ "$(node --version | sed 's/^v//' | cut -d. -f1)" -ge 20 ]; }
say() { printf '%s\n' "$*"; }

deps() {
  say "uni-git: checking Git and Node.js ($(uname -s))"
  case "$(uname -s)" in
    Darwin)
      # a Homebrew from an earlier run may not be on this shell's PATH yet
      for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if ! has brew && [ -x "$b" ]; then eval "$("$b" shellenv)"; fi
      done
      if ! has brew; then
        say "Installing Homebrew ..."
        # it asks for the password: give it the terminal, not this piped script
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
        eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
      fi
      has git || { say "Installing Git ..."; brew install git; }
      node_ok || { say "Installing Node.js LTS ..."; brew install node@22; brew link --overwrite --force node@22; }
      has git-credential-manager || { say "Installing Git Credential Manager ..."; brew install --cask git-credential-manager; }
      ;;
    Linux)
      if has apt-get; then
        has git || { say "Installing Git ..."; sudo apt-get update && sudo apt-get install -y git; }
        node_ok || { say "Installing Node.js LTS ..."; curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs; }
        say "Note: Linux also needs libwebkit2gtk-4.1 for the window."
      else
        say "Unsupported Linux distro for automatic install: make sure git and node >= 20 are present."
      fi
      ;;
    *) say "Unsupported OS. On Windows run install.ps1."; exit 1 ;;
  esac
  say "  git $(git --version | sed 's/git version //')"
  say "  node $(node --version)"
}

install_app() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) platform=mac_arm64 ;;
    Darwin/x86_64) platform=mac_x64 ;;
    *) say "uni-git releases exist for Windows and macOS; on $(uname -s) build it from source (setup.sh)."; exit 1 ;;
  esac
  releases="${UNI_GIT_RELEASES:-https://github.com/$REPO/releases/latest/download}"
  app="${UNI_GIT_INSTALL_DIR:-$HOME/Library/Application Support/uni-git/app}"
  bundle="$HOME/Applications/uni-git.app"
  if pgrep -f "$app/uni-git-$platform" >/dev/null 2>&1; then
    say "uni-git is running. Quit it, then run this again."
    exit 1
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  say "Downloading uni-git ..."
  curl -fsSL "$releases/latest.json" -o "$tmp/latest.json"
  # node is installed by now: it reads the manifest (no jq on a stock Mac)
  node -e '
    const m = JSON.parse(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).manifest);
    console.log([m.version, m.baseUrl].join("\t"));
    for (const f of m.files) if (!f.platforms || f.platforms.includes(process.argv[2])) console.log([f.path, f.asset, f.sha256, f.exec ? 1 : 0].join("\t"));
  ' "$tmp/latest.json" "$platform" >"$tmp/list.tsv"
  tab="$(printf '\t')"
  IFS="$tab" read -r version base <"$tmp/list.tsv"
  tail -n +2 "$tmp/list.tsv" >"$tmp/files.tsv"

  mkdir -p "$app"
  while IFS="$tab" read -r path asset sum exec; do
    target="$app/$path"
    if [ -f "$target" ] && [ "$(shasum -a 256 "$target" | cut -d' ' -f1)" = "$sum" ]; then continue; fi
    mkdir -p "$(dirname "$target")"
    curl -fsSL "$base$asset" -o "$target.download"
    if [ "$(shasum -a 256 "$target.download" | cut -d' ' -f1)" != "$sum" ]; then
      rm -f "$target.download"
      say "$asset arrived damaged (checksum mismatch). Run this again."
      exit 1
    fi
    if [ "$exec" = 1 ]; then chmod 755 "$target.download"; fi
    mv -f "$target.download" "$target"
    say "  $path"
  done <"$tmp/files.tsv"
  # Apple Silicon runs only signed native code; a local ad-hoc signature is enough for a file without quarantine flag
  codesign --force --sign - "$app/uni-git-$platform" >/dev/null 2>&1 || true

  # ~/Applications/uni-git.app: a launcher only, the app itself stays outside the bundle so that it can update itself
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
  cat >"$bundle/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>uni-git</string>
  <key>CFBundleDisplayName</key><string>uni-git</string>
  <key>CFBundleIdentifier</key><string>dev.unigit.app</string>
  <key>CFBundleExecutable</key><string>uni-git</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
  cat >"$bundle/Contents/MacOS/uni-git" <<EOF
#!/bin/sh
# uni-git launcher (written by install.sh): the app lives in its own folder so that it can update itself.
cd "$app" && exec "./uni-git-$platform" --path="$app"
EOF
  chmod 755 "$bundle/Contents/MacOS/uni-git"
  if [ -f "$app/icon.png" ] && has iconutil; then
    iconset="$tmp/AppIcon.iconset"
    mkdir -p "$iconset"
    for s in 16 32 128 256 512; do
      sips -z "$s" "$s" "$app/icon.png" --out "$iconset/icon_${s}x${s}.png" >/dev/null 2>&1 || true
      sips -z "$((s * 2))" "$((s * 2))" "$app/icon.png" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
    done
    iconutil -c icns "$iconset" -o "$bundle/Contents/Resources/AppIcon.icns" >/dev/null 2>&1 || true
  fi
  touch "$bundle"

  say "uni-git $version is installed: ~/Applications/uni-git.app. It updates itself from now on."
  open "$bundle"
}

main() {
  deps
  if [ "${1:-}" = "--deps-only" ]; then return 0; fi
  install_app
}

# everything above is only definitions: a download cut short runs nothing
main "$@"
