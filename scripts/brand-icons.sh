#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MAC="$ROOT/assets/brand/logo-icon.svg"
IOS="$ROOT/assets/brand/logo-icon-ios.svg"
ICONS="$ROOT/src-tauri/icons"
CATALOG="$ROOT/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"

fail() {
  echo "brand-icons: $*" >&2
  exit 1
}

need_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed (brew install librsvg jq; sips ships with macOS)"
  done
}

need_files() {
  local file
  for file in "$@"; do
    [[ -f $file ]] || fail "$file is missing"
  done
}

check_opaque() {
  local pngs=("$CATALOG"/*.png "$ICONS"/ios/*.png)
  local report alpha opaque
  report=$(sips -g hasAlpha "${pngs[@]}")
  alpha=$(awk '/^\// { file = $0 } /hasAlpha: yes/ { print file }' <<<"$report")
  opaque=$(awk '/hasAlpha: no/ { n++ } END { print n + 0 }' <<<"$report")
  [[ -z $alpha ]] || fail "these iOS icons have an alpha channel, and App Store icons must not:
$alpha"
  [[ $opaque -eq ${#pngs[@]} ]] || fail "sips reported hasAlpha: no for $opaque of ${#pngs[@]} iOS icons"
  echo "brand-icons: all ${#pngs[@]} iOS icons report hasAlpha: no"
}

if [[ ${1:-} == --check ]]; then
  need_tools sips awk
  check_opaque
  exit 0
fi
[[ $# -eq 0 ]] || fail "unknown arguments: $* (run with no arguments, or --check)"

need_tools rsvg-convert jq sips awk npm
need_files "$MAC" "$IOS" "$CATALOG/Contents.json"

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

SIZES=$(jq -r '.images[] | "\(.filename) \((.size | split("x")[0] | tonumber) * (.scale | rtrimstr("x") | tonumber))"' "$CATALOG/Contents.json")
[[ -n $SIZES ]] || fail "$CATALOG/Contents.json lists no images"

rsvg-convert -w 1024 -h 1024 "$MAC" -o "$OUT/icon-1024.png"
mkdir "$OUT/ios"
while read -r file px; do
  rsvg-convert -w "$px" -h "$px" "$IOS" -o "$OUT/ios/$file"
done <<<"$SIZES"

npm --prefix "$ROOT" run tauri -- icon "$OUT/icon-1024.png"
rm -rf "$ICONS/android"
rm -f "$ICONS"/Square*Logo.png "$ICONS/StoreLogo.png"
cp "$OUT"/ios/*.png "$CATALOG/"
cp "$OUT"/ios/*.png "$ICONS/ios/"

check_opaque
