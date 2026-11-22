# WebBoard

WebBoard is a project timeline planner for macOS, Linux and iPhone/iPad. You lay out tasks, milestones and groups on a working-day calendar, link them, and the app moves dependent work when something slips. It is built for one person, or a small trusted group, who plans on several devices and wants the same plans on all of them, offline included.

## What works

- Plans with tasks, milestones and nested groups; FS, SS, FF and SF links with lag; loop detection; a conflict list when a stored start no longer fits its links.
- Working calendars: choose the working weekdays, add closures, and pull public holidays from OpenHolidays (every country it lists), GOV.UK (United Kingdom), OPM (United States) or any ICS/webcal feed.
- Baselines, undo and redo, a history of every change, and a trash for deleted items and plans.
- Plans are kept on the device as an append-only log and open without a network. Export and import use a `.webboard` file.
- Sync between devices: set up a space with a server secret, add devices with a short pairing code, remove them again. When two devices change the same thing while apart, the app shows both versions and asks which to keep rather than silently picking one.
- Printing, themes with an editor and a command palette.
- Timeline, board and list views. On desktop and iPad the plan list, the timeline's outline and the item inspector are resizable panes; the phone has its own layout.
- Signed in-app updates for the macOS and Linux builds.
- `npm run gantt:wbx -- <in.gantt> [<out.webboard>] [--name "<plan name>"]` converts a `.gantt` JSON file into a `.webboard` plan file.

## Not yet

- No Windows build and no browser version; the interface runs only inside the native shell.
- The sync host `webboard.rokass.org` is hard-coded across the app, the server and the release script, and the app refuses every other host. Self-hosting means changing every occurrence (`git grep webboard.rokass.org`): `HOST` and `OTHER_HOST` in `crates/webboard-core/src/sync.rs`, the user agent in `crates/webboard-core/src/net.rs`, the CSP and updater endpoint in `src-tauri/tauri.conf.json`, `DEFAULT_SERVER` in `src/ui/sync/SetupPane.tsx`, the route in `server/wrangler.jsonc` and `BASE_URL` in `scripts/release.mjs`; putting your own updater public key in `plugins.updater.pubkey`; updating the tests that pin the host; then rebuilding.
- One server deployment holds one space. Every device in it sees every plan; there are no per-plan permissions or separate users.
- Plan data is encrypted in transit only, not end to end.
- Release builds cover Apple silicon Macs and amd64 Linux (`.deb`) only. The macOS build is ad-hoc signed and not notarised. The iOS build installs for development only; there is no App Store or TestFlight release.
- No continuous integration; tests are run by hand.

## Architecture

- `src/`: React and TypeScript interface. Each plan is a Yjs document holding a log of actions; the schedule, conflicts and the keep-which-version choices are derived from that log.
- `src-tauri/`: Tauri 2 shell for macOS, Linux and iOS. Files, the local store, printing, native menus and alerts, and the device key (macOS/iOS Keychain, Linux Secret Service).
- `crates/webboard-core/`: Rust library for the local store, holiday sources with an on-disk cache, and the sync client's HTTP calls.
- `server/`: Cloudflare Worker. A `Space` Durable Object handles setup, pairing, device tickets and removal over HTTPS; one `Room` Durable Object per plan relays and stores Yjs updates over WebSockets (partyserver). Both use Durable Object SQLite storage.

Stack: TypeScript, React 19, Vite, Yjs, Rust, Tauri 2, Cloudflare Workers and Durable Objects, Vitest.

## Running it locally

Needs Node.js 20.19, 22.13 or 24 and newer with npm, the Rust toolchain pinned in `rust-toolchain.toml`, and the system packages Tauri lists for your platform (https://tauri.app/start/prerequisites/; on Linux that includes WebKitGTK 4.1, and the Secret Service keyring needs libdbus). iOS also needs Xcode.

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
npx playwright install chromium-headless-shell  # once: the browser the layout probe drives
npm run test:scripts                   # Node tests for scripts/ and the Linux installer test
npm ci --prefix server                 # once, before the server tests
npm test --prefix server               # Worker and Durable Objects in workerd
cargo test --workspace --no-fail-fast  # store, holidays, sync client, Tauri commands
```

`src/log/budget.test.ts` holds timing budgets measured on an Apple silicon Mac and runs on macOS only. On a slower or busy machine it can fail with nothing wrong: run it again on its own (`npx vitest run src/log/budget.test.ts`) before reading it as a regression.

Holiday tests that call the real services are marked `#[ignore]` and run only on request (`cargo test -p webboard-core --test holidays -- --ignored`). One of them appends a report to the file named by `WEBBOARD_PROBES_OUT`, which must be an absolute path; it fails if that variable is unset or relative.

## Licence

All rights reserved. The source is published to be read; see LICENSE.
