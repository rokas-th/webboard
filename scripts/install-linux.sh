#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BIN_SRC="$REPO_DIR/target/release/webboard"
ICON_SRC="$REPO_DIR/src-tauri/icons/128x128@2x.png"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"

if [[ ! -x "$BIN_SRC" ]]; then
  echo "error: no release binary at $BIN_SRC" >&2
  echo "build it first:  cd $REPO_DIR && . ~/.cargo/env && npm run tauri build" >&2
  exit 1
fi

if [[ ! -f "$ICON_SRC" ]]; then
  echo "error: no icon at $ICON_SRC" >&2
  echo "the launcher entry needs it; restore src-tauri/icons from the repository" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"

ln -sfn "$BIN_SRC" "$BIN_DIR/webboard"

install -m 644 "$ICON_SRC" "$ICON_DIR/webboard.png"

cat > "$APP_DIR/webboard.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=WebBoard
Comment=Project timeline planner
Exec=$BIN_DIR/webboard
Icon=webboard
Terminal=false
Categories=Office;ProjectManagement;
StartupWMClass=WebBoard
DESKTOP

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR"
fi

echo "installed:"
echo "  binary   $BIN_DIR/webboard -> $BIN_SRC"
echo "  icon     $ICON_DIR/webboard.png"
echo "  desktop  $APP_DIR/webboard.desktop"
echo
echo "If ~/.local/bin is not on PATH, launch from the COSMIC launcher instead."

if ! command -v pgrep >/dev/null 2>&1; then
  echo
  echo "note: pgrep is not installed, so this script cannot say whether WebBoard is"
  echo "      already running — if it is, quit and relaunch it."
elif RUNNING=$(pgrep -x webboard) && [[ -n "$RUNNING" ]]; then
  echo
  echo "WebBoard is already running (pid $(echo "$RUNNING" | tr '\n' ' ')) and is STILL THE OLD BINARY."
  echo "Quit it and start it again — this install does not touch a running process."
fi
