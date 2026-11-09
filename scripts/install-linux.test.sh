#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/install-linux.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/webboard-install-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAILED=1; }

REPO="$WORK/repo"
mkdir -p "$REPO/target/release" "$REPO/src-tauri/icons"
printf '#!/bin/sh\nexit 0\n' > "$REPO/target/release/webboard"
chmod +x "$REPO/target/release/webboard"
printf 'not really a png' > "$REPO/src-tauri/icons/128x128@2x.png"

NOICON="$WORK/noicon"
mkdir -p "$NOICON/target/release"
cp "$REPO/target/release/webboard" "$NOICON/target/release/webboard"

mkdir -p "$WORK/bin"
{
  echo '#!/usr/bin/env bash'
  echo 'if [[ -n "${WEBBOARD_FAKE_PIDS:-}" ]]; then printf "%s\n" $WEBBOARD_FAKE_PIDS; exit 0; fi'
  echo 'exit 1'
} > "$WORK/bin/pgrep"
chmod +x "$WORK/bin/pgrep"

run_install() {
  local home="$WORK/$1"
  mkdir -p "$home"
  shift
  env HOME="$home" PATH="$WORK/bin:$PATH" "$@" bash "$SCRIPT" "$REPO" 2>&1
}

echo "install-linux.sh"

NOBIN="$WORK/emptyrepo"
mkdir -p "$NOBIN"
set +e
OUT="$(env HOME="$WORK/h0" PATH="$WORK/bin:$PATH" bash "$SCRIPT" "$NOBIN" 2>&1)"
STATUS=$?
set -e
[[ $STATUS -ne 0 ]] && ok "missing binary exits non-zero" || bad "missing binary should exit non-zero (status $STATUS): $OUT"
case "$OUT" in
  *"npm run tauri build"*) ok "names npm run tauri build" ;;
  *) bad "does not name npm run tauri build: $OUT" ;;
esac
case "$OUT" in
  *"cargo build --release"*) bad "recommends cargo build --release: $OUT" ;;
  *) ok "does not recommend cargo build --release" ;;
esac

set +e
OUT="$(env HOME="$WORK/h4" PATH="$WORK/bin:$PATH" bash "$SCRIPT" "$NOICON" 2>&1)"
STATUS=$?
set -e
[[ $STATUS -ne 0 ]] && ok "missing icon exits non-zero" || bad "missing icon should exit non-zero (status $STATUS): $OUT"
case "$OUT" in
  *"128x128@2x.png"*) ok "names the missing icon" ;;
  *) bad "does not name the missing icon: $OUT" ;;
esac
[[ ! -e "$WORK/h4/.local/bin/webboard" && ! -e "$WORK/h4/.local/share/applications/webboard.desktop" ]] \
  && ok "missing icon installs nothing" || bad "missing icon left a partial install"

OUT="$(run_install h1 WEBBOARD_FAKE_PIDS=)"
case "$OUT" in
  *"OLD BINARY"*) bad "warned about a running app when none is running" ;;
  *) ok "quiet when nothing is running" ;;
esac
case "$OUT" in
  *"installed:"*) ok "says it installed" ;;
  *) bad "did not install: $OUT" ;;
esac

LINK="$WORK/h1/.local/bin/webboard"
if [[ -L "$LINK" && "$(readlink "$LINK")" == "$REPO/target/release/webboard" ]]; then
  ok "links ~/.local/bin/webboard to the release binary"
else
  bad "no symlink $LINK -> $REPO/target/release/webboard"
fi

ICON="$WORK/h1/.local/share/icons/hicolor/512x512/apps/webboard.png"
[[ -f "$ICON" ]] && ok "installs the icon as webboard.png" || bad "no icon at $ICON"

DESKTOP="$WORK/h1/.local/share/applications/webboard.desktop"
if [[ -f "$DESKTOP" ]]; then
  ok "writes webboard.desktop"
  for line in "Name=WebBoard" "Exec=$WORK/h1/.local/bin/webboard" "Icon=webboard" "StartupWMClass=WebBoard" "Type=Application"; do
    grep -qxF "$line" "$DESKTOP" && ok "desktop entry has $line" || bad "desktop entry lacks $line: $(cat "$DESKTOP")"
  done
else
  bad "no desktop entry at $DESKTOP"
fi

OUT="$(run_install h2 WEBBOARD_FAKE_PIDS=4242)"
case "$OUT" in
  *"STILL THE OLD BINARY"*) ok "says the running app is the old binary" ;;
  *) bad "no relaunch warning while webboard is running: $OUT" ;;
esac
case "$OUT" in
  *4242*) ok "names the pid" ;;
  *) bad "does not name the pid: $OUT" ;;
esac
case "$OUT" in
  *"Quit it and start it again"*) ok "says to quit and relaunch" ;;
  *) bad "does not say to relaunch: $OUT" ;;
esac

mkdir -p "$WORK/nopgrep"
for tool in bash env mkdir ln install cat tr rm dirname; do
  ln -sf "$(command -v "$tool")" "$WORK/nopgrep/$tool"
done
OUT="$(env HOME="$WORK/h3" PATH="$WORK/nopgrep" WEBBOARD_FAKE_PIDS=4242 bash "$SCRIPT" "$REPO" 2>&1 || true)"
case "$OUT" in
  *"cannot say whether WebBoard is"*) ok "absent pgrep is stated, not silent" ;;
  *) bad "silent when pgrep is missing: $OUT" ;;
esac

exit $FAILED
