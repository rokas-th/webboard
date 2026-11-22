# WebBoard brand assets

The WebBoard mark is a three-row Gantt staircase (done, doing, todo) joined by dependency arrows and cut by an amber "today" line on the tile's centre axis. Glow is drawn with layered strokes and gradients, never with SVG filters or blur, so every file rasterizes crisply at any size.

## Files

| File | Size | What it is | Where it is used |
|---|---|---|---|
| `logo-icon.svg` | 1024×1024 | App-icon master: the artwork on an 832 px rounded tile (offset 96, corner radius 186) on a transparent canvas. | `scripts/brand-icons.sh` renders it into the desktop icons in `src-tauri/icons/`. |
| `logo-icon-ios.svg` | 1024×1024 | iOS icon master: the same artwork with the tile filling the whole square, no rounded corners and no transparency, content scaled by 1024/832 about the centre. iOS applies its own mask, and App Store icons may not be transparent. | `scripts/brand-icons.sh` renders it into `src-tauri/icons/ios/` and `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/`. |
| `logo-mark.svg` | 100×100 | The mark alone on a transparent background, for 24 to 64 px: no grid, brackets or status lights. | `public/logo-mark.svg` is a byte-identical copy that the app serves as the favicon (`index.html`) and as the 48 px mark in the About view (`src/ui/common/About.tsx`). `src/brand.test.ts` keeps the two files equal. |
| `logo-mark-16.svg` | 100×100 | Variant for 16 px: three bars and the today line, every edge on a 6.25-unit grid (1 px at 16 px). | Not used by the app. |
| `logo-template.svg` | 100×100 | Monochrome black mark for a macOS template image, which macOS recolours itself. | Not used by the app. |

No rendered PNG is kept in this folder; every PNG icon in the repository is generated from the masters above.

## Palette

| Token | Value | Use |
|---|---|---|
| tile | `#0A0A14` | backgrounds, bar tracks |
| panel | `#10101E` | doing and todo bar tracks |
| grid | `#23233D` | timeline grid lines |
| cyan | `#24E0FF` | progress fill, connectors, todo outline, brackets |
| cyan-dim | `#158CA6` | done bar |
| amber | `#FFB000` | today line and tab (core gradient `#FFF3D6` → `#FFD98A` → `#FFB000`) |
| magenta | `#FF3B6B` | colour fringe and one status light only, never a planning colour |
| phosphor | `#EAF3FF` | main line of the doing bar |

## Regenerating the icons

On macOS, from the repository root, with `librsvg` and `jq` installed (`brew install librsvg jq`; `sips` ships with macOS):

```bash
bash scripts/brand-icons.sh
```

The script checks its tools and inputs first and exits non-zero, naming what is missing, before it changes anything. It renders into a temporary directory, runs `tauri icon` for the desktop set, renders every size listed in the asset catalog's `Contents.json` from `logo-icon-ios.svg` as opaque RGB and copies those over both iOS icon folders, and deletes the Android and Windows Store outputs that no configuration uses. It ends by checking with `sips` that no iOS icon has an alpha channel; `bash scripts/brand-icons.sh --check` runs that check alone. `src/brand.test.ts` enforces the same rule in the unit suite.

`tauri icon` writes the entries of `icon.icns` in a different order on each run, with identical contents, so a rerun on an unchanged master shows `icon.icns` as changed; keep the committed one in that case.
