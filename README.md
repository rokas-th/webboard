# WebBoard

WebBoard is a project planner for macOS, Linux and iPhone/iPad, with a timeline, a board and a list over the same plan. You lay out tasks, milestones and groups on a working-day calendar, link them, and the app moves dependent work when something slips. It is built for one person, or a small trusted group, who plans on several devices and wants the same plans on all of them, offline included.

## What works

- Plans with tasks, milestones and nested groups; FS, SS, FF and SF links with lag; loop detection; a conflict list when a stored start no longer fits its links.
- Working calendars, edited in Settings > Working time: choose the working weekdays, add closures, and pull public holidays from OpenHolidays (every country it lists), GOV.UK (United Kingdom), OPM (United States) or any ICS/webcal feed. Changes stay a draft until you review their impact and apply them.
- Baselines, undo and redo, a history of every change, and a trash for deleted items and plans.
- Plans are kept on the device as an append-only log and open without a network.
- Sync between devices: set up a space with a server secret, add devices with a short pairing code, remove them again. When two devices change the same thing while apart, the app shows both versions and asks which to keep rather than silently picking one.
- Three tabs per plan, picked from the toolbar or with keys 1, 2 and 3. The app reopens on the last plan, tab and zoom.
- Timeline: drag a bar to move it, its edges to change start or length, and its nub to another item to link them; a ghost bar shows where it lands and how many items move. Undated items wait in a tray under the chart and get a start date when dragged onto it.
- Board: one column per step of the plan's own workflow, with colours, optional WIP limits (shown, never enforced) and one step that marks items done. Move cards by drag, by the card menu, or with Option-Cmd 1 to 9 on a selected card (Ctrl-Alt 1 to 9 on Linux). Until a plan has steps of its own, the columns follow dates (Now, Next, Later, Done).
- List: a table with columns you add, reorder and resize, sort on up to three keys, scopes (Open, Due soon, Late, Blocked, Unassigned, Mine and more), filters by step, assignee, kind and group, and grouping by outline, step or assignee.
- People per plan, with colours and initials; an item can have up to eight assignees. The List's Mine scope needs "This is me", chosen per device in Settings > General; until then Mine shows nothing.
- One search field filters all three tabs by name, notes, step, assignee and group. A command palette (Cmd/Ctrl K) and keys cover selecting, creating, moving and undoing. The selected item's detail sits in the inspector, with previous and next in the current tab's order; a double-click or Space opens it as a modal.
- Settings has app pages (General, Theme, Sync, Import & export) and, while a plan is open, plan pages (Overview, People, Workflow, Working time, Defaults, Baselines, Danger zone). Plan pages edit the plan, so they sync; default tab, week start, date format, theme and display choices stay on the device.
- Plan defaults for new items: duration, dated or undated, assignee, the group the Board adds to and the step for undated items. A default whose person, group or step is gone is dropped and the page says why.
- Files: export a plan as `.webboard`, the List as CSV (its current columns, sort, scope and filters), dated milestones as an ICS calendar, and all plans as one `.zip` of `.webboard` files. Import takes `.webboard` and `.gantt` files and always creates a new plan; to restore a backup, unzip it and import each file.
- A plan holding changes from a newer build opens read-only instead of being damaged: it shows what this build understands, lists the changes it cannot read and refuses edits until the app is updated. Import refuses a file from a newer format.
- Fifteen built-in themes, your own themes from five seed colours with a readability check, and following the system's light or dark mode. Printing of the plan as a table of items (start, end, days, status, dependencies) on macOS and Linux.
- Desktop and iPad: the plan list, the timeline's outline and the inspector are resizable panes in a wide window (1024 px on desktop, 1180 px on iPad); a narrower iPad shows the plan list and inspector as drawers or sheets.
- iPhone: its own layout with one view at a time. The Board pages through steps and moves a card through a touch-and-hold menu; the Timeline is read-only (tap to open, pinch to zoom); the List has search and one sort and group menu. Settings is a sheet of pushed pages. There is no command palette on the phone, and no printing on iPhone or iPad.
- Signed in-app updates for the macOS and Linux builds; the iOS build has no updater.
- `npm run gantt:wbx -- <in.gantt> [<out.webboard>] [--name "<plan name>"]` converts a `.gantt` JSON file into a `.webboard` plan file.

## Not yet

- No Windows build and no browser version; the interface runs only inside the native shell.
- The iPhone's native tab bar for Timeline, Board and List is built and compiles for iOS but has never run on a device; if it cannot be installed, the app says so and shows its own view switch.
- The sync host `webboard.rokass.org` is hard-coded across the app, the server and the release script, and the app refuses every other host. Self-hosting means changing every occurrence (`git grep webboard.rokass.org`): `HOST` and `OTHER_HOST` in `crates/webboard-core/src/sync.rs`, the message in `src-tauri/src/commands/sync.rs`, the user agent in `crates/webboard-core/src/net.rs`, the CSP and updater endpoint in `src-tauri/tauri.conf.json`, `DEFAULT_SERVER` in `src/ui/sync/SetupPane.tsx`, the route in `server/wrangler.jsonc` and `BASE_URL` in `scripts/release.mjs`; putting your own updater public key in `plugins.updater.pubkey`; updating the tests that pin the host; then rebuilding.
- One server deployment holds one space. Every device in it sees every plan; there are no per-plan permissions or separate users.
- Plan data is encrypted in transit only, not end to end.
- Release builds cover Apple silicon Macs and amd64 Linux (`.deb`) only. The macOS build is ad-hoc signed and not notarised. The iOS build installs for development only; there is no App Store or TestFlight release.
- No continuous integration; tests are run by hand.

## Architecture

- `src/`: React and TypeScript interface. Each plan is a Yjs document holding a log of actions; the schedule, conflicts and the keep-which-version choices are derived from that log.
- `src-tauri/`: Tauri 2 shell for macOS, Linux and iOS. Files, the local store, the app menu and native printing (macOS only; Linux prints from the web view), and the device key (macOS/iOS Keychain, Linux Secret Service); on iOS also native alerts, pull-down menus, haptics, the light/dark appearance and the tab bar.
- `crates/webboard-core/`: Rust library for the local store, holiday sources with an on-disk cache, and the sync client's HTTP calls.
- `server/`: Cloudflare Worker. A `Space` Durable Object handles setup, pairing, device tickets and removal over HTTPS; one `Room` Durable Object per plan relays and stores Yjs updates over WebSockets (partyserver). Both use Durable Object SQLite storage.

Stack: TypeScript, React 19, Vite, Yjs, Rust, Tauri 2, Cloudflare Workers and Durable Objects, Vitest.

## Running it locally

Needs Node.js 22.13, or 24 and newer, with npm (the server's wrangler needs 22 or newer), the Rust toolchain pinned in `rust-toolchain.toml`, and the system packages Tauri lists for your platform (https://tauri.app/start/prerequisites/; on Linux that includes WebKitGTK 4.1, and the Secret Service keyring needs libdbus). iOS also needs Xcode.

```sh
npm ci
npm run tauri dev            # desktop app with hot reload
npm run tauri ios dev        # iOS, see below
```

The iOS build is set up for the author's Apple team. To run it on your own device, set your own team id in `src-tauri/tauri.ios.conf.json` and in `src-tauri/gen/apple/project.yml` (then regenerate the Xcode project), and your own bundle identifier in `identifier` of `src-tauri/tauri.conf.json` and in `project.yml`. The bundle identifier is also the keychain service name in `src-tauri/src/keychain.rs`, which its test pins.

The server runs with `npm ci --prefix server`, then `cp server/.dev.vars.example server/.dev.vars`, set `SETUP_SECRET` (at least 32 bytes), and `cd server && npx wrangler dev`. A stock app build will not connect to a local server; see the sync host note above.

## Tests

```sh
npm test                               # interface and domain (Vitest, jsdom)
npm run lint
npx tsc -b                             # type check
npm run build                          # the script tests and the layout probe read dist/
npx playwright install chromium-headless-shell  # once: the browser the layout probe and its test drive (found in the ms-playwright cache; Playwright is not a project dependency)
npm run test:scripts                   # Node tests for scripts/ and the Linux installer test
npm run layout:probe                   # layout measurements over dist/; about half an hour
npm ci --prefix server                 # once, before the server tests
npm test --prefix server               # Worker and Durable Objects in workerd
cargo test --workspace --no-fail-fast  # store, holidays, sync client, Tauri commands
```

`src/log/budget.test.ts` holds timing budgets measured on an Apple silicon Mac; its replay budgets run on macOS only, its size budget everywhere. On a slower or busy machine it can fail with nothing wrong: run it again on its own (`npx vitest run src/log/budget.test.ts`) before reading it as a regression.

Holiday tests that call the real services are marked `#[ignore]` and run only on request (`cargo test -p webboard-core --test holidays -- --ignored`). One of them appends a report to the file named by `WEBBOARD_PROBES_OUT`, which must be an absolute path; it fails if that variable is unset or relative.

## Licence

All rights reserved. The source is published to be read; see LICENSE.
