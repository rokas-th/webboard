# WebBoard brand assets

Chosen direction (2026-11-10, Rokas): concept A, "Timeline" — a three-row Gantt staircase (done, doing, todo) with dependency arrows, cut by an amber today line that runs down the tile's centre axis. Cyberdeck family with WebHub and WebSync: same squircle, CRT scanlines, HUD corner brackets and status LEDs as WebHub; the doing bar takes WebHub's hub treatment (wide cyan glow, magenta/cyan misconvergence, phosphor line) and the TODAY tab takes its amber core. Glow is layered wide strokes and gradients, never SVG filters or blur — it rasterizes crisply at every size.

Palette:

| Token | Value | Use |
|---|---|---|
| tile | `#0A0A14` | mark backgrounds, bar tracks |
| panel | `#10101E` | doing and todo bar tracks |
| grid | `#23233D` | timeline grid lines |
| cyan | `#24E0FF` | done/doing: progress fill, connectors, todo outline, brackets |
| cyan-dim | `#158CA6` | done bar |
| amber | `#FFB000` | today: line, tab, core gradient (`#FFF3D6` → `#FFD98A` → `#FFB000`) |
| magenta | `#FF3B6B` | misconvergence fringe and the third LED only — never a planning colour |
| phosphor | `#EAF3FF` | doing-bar main line |

Geometry (1024 master): grid lines at x = 182 + 66k; bars on rows y 274 / 456 / 638, 112 high — done x 248–380, doing x 380–644 with progress to 512, todo x 644–776, symmetric about x = 512. Today line and TODAY tab (x 476–548) sit on x = 512, the tile's centre axis.

Files:

- `logo-icon.svg` — 1024×1024 app-icon master: macOS squircle (832 px at 96, rx 186) on a transparent canvas. Source of truth for the desktop icons in `src-tauri/icons/`.
- `logo-icon-ios.svg` — the iOS master: the same artwork with the tile filling the whole 1024 square (no squircle clip, no transparent corners) and the content scaled about the centre by 1024/832, so it fills the iOS mask as the squircle content fills the macOS tile. iOS masks the icon itself, and App Store icons have no transparency. Source of truth for `src-tauri/icons/ios/` and `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/`.
- `logo-mark.svg` — the mark alone, 100×100, transparent. Use at 24–64 px. In the app: the About mark (48 px) and the favicon; `public/logo-mark.svg` is a byte-identical copy that Vite serves at `/logo-mark.svg` (a unit test keeps the two equal).
- `logo-mark-16.svg` — the 16 px variant: three bars and the today line, no connectors or tab, every edge on a 6.25-unit (1 px at 16) grid.
- `logo-template.svg` — monochrome black mark for macOS template-image use (menu-bar extra, if it ever ships); macOS recolors template images itself.

PNGs are generated, never kept by hand. Nothing in this folder is a render.

## Icon pipeline

**[Mac]**, from the repo root, with `librsvg` and `jq` installed (`brew install librsvg jq`). The 1024 render goes to a temporary directory, never into the repo.

```bash
OUT=$(mktemp -d)
rsvg-convert -w 1024 -h 1024 assets/brand/logo-icon.svg -o "$OUT/icon-1024.png"
npm run tauri -- icon "$OUT/icon-1024.png"
rm -rf src-tauri/icons/android
rm -f src-tauri/icons/Square*Logo.png src-tauri/icons/StoreLogo.png
A=src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset
jq -r '.images[] | "\(.filename) \((.size | split("x")[0] | tonumber) * (.scale | rtrimstr("x") | tonumber))"' "$A/Contents.json" \
  | while read -r f px; do rsvg-convert -w "$px" -h "$px" assets/brand/logo-icon-ios.svg -o "$A/$f"; done
cp "$A"/*.png src-tauri/icons/ios/
sips -g hasAlpha "$A"/*.png
rm -r "$OUT"
```

`tauri icon` writes the desktop set (`icon.icns`, `icon.ico`, `icon.png`, `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`) from the macOS master. It also writes iOS icons into the asset catalog and `src-tauri/icons/ios/`, but from the macOS master and always as RGBA, and App Store icons must have no alpha channel. So every size the catalog's `Contents.json` lists is rendered again straight from `logo-icon-ios.svg`: `rsvg-convert` writes an opaque image as RGB, and the `sips` line must print `hasAlpha: no` for all 18 files. `src-tauri/icons/ios/` holds the same files. The Android, Windows Store (`Square*Logo.png`) and `StoreLogo.png` outputs are deleted: no config uses them.

The Xcode project is not regenerated; `src-tauri/gen/apple/webboard.xcodeproj/project.pbxproj` stays unchanged.
