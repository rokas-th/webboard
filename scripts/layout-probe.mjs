import { createServer } from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { buildFixtures, CONVERTED_FILE, LONG_NAMES, PLAN_IDS, UNREADABLE_LINE, UPDATE_CHECK_FAILED, UPDATE_VERSION } from "./layout-fixtures.mjs";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));

const SHELL_CANDIDATES = [`${process.env.HOME}/Library/Caches/ms-playwright`, `${process.env.HOME}/.cache/ms-playwright`];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const desk = (w, h) => ({ size: [w, h], screen: [w, h], touch: false, form: "full" });
const touch = (w, h, form) => ({ size: [w, h], screen: [w, h], touch: true, form });
const cdesk = (w, h) => ({ size: [w, h], screen: [w, h], touch: false, form: "compact" });

const DESKTOP = [desk(1180, 760), desk(1440, 920), desk(1920, 1080)];
const BREAK_EDGE = [desk(1241, 800), desk(1260, 800)];
const ABOVE_BREAK = [desk(1280, 800)];
const COMPACT_DESK = [cdesk(1024, 700), cdesk(1100, 760), cdesk(1179, 760)];
const PHONE = [touch(390, 844, "phone")];
const PORTRAIT = [touch(820, 1180, "compact")];
const LANDSCAPE = [touch(1180, 820, "full"), touch(1366, 1024, "full")];
const NARROW = [{ size: [500, 820], screen: [820, 1180], touch: true, form: "compact" }];
const IPAD_11 = [touch(834, 1194, "compact"), { size: [1194, 834], screen: [834, 1194], touch: true, form: "full" }];
const PHONE_LANDSCAPE = [{ size: [844, 390], screen: [390, 844], touch: true, form: "phone" }];
const IPAD_WINDOWS = [
  { size: [700, 1000], screen: [834, 1194], touch: true, form: "compact" },
  { size: [699, 1000], screen: [834, 1194], touch: true, form: "compact" },
  { size: [1179, 820], screen: [834, 1194], touch: true, form: "compact" },
  { name: "1180x820-on-834x1194", size: [1180, 820], screen: [834, 1194], touch: true, form: "full" },
];
const IPAD_OWNER = [touch(970, 1389, "compact"), { size: [1389, 970], screen: [970, 1389], touch: true, form: "full" }];
const MAC_834 = [{ ...cdesk(834, 1194), name: "834x1194-desk" }];
const SHEET_DESK = [cdesk(820, 760), ...MAC_834];
const TIERS_TS = readFileSync(new URL("../src/ui/shell/planListMode.ts", import.meta.url), "utf8");
const tierMin = (name) => {
  const m = TIERS_TS.match(new RegExp(`^export const ${name} = (\\d+);$`, "m"));
  if (m === null) throw new Error(`layout-probe: src/ui/shell/planListMode.ts has no "export const ${name} = <number>;"`);
  return Number(m[1]);
};
const MEDIUM_MIN = tierMin("MEDIUM_MIN");
const BOUNDARY_SPARE = 16;
const ROOMY_MIN = tierMin("ROOMY_MIN");
const padWindow = (w, h) => ({ size: [w, h], screen: [834, 1194], touch: true, form: "compact" });
const IPAD_TIERS = [padWindow(560, 1000), padWindow(MEDIUM_MIN - 1, 1000), padWindow(MEDIUM_MIN, 1000), padWindow(ROOMY_MIN - 1, 820), padWindow(ROOMY_MIN, 820)];
const VIEWPORTS = [...DESKTOP, ...BREAK_EDGE, ...ABOVE_BREAK, ...COMPACT_DESK, ...PHONE, ...PORTRAIT, ...LANDSCAPE, ...NARROW, ...IPAD_11, ...PHONE_LANDSCAPE, ...IPAD_WINDOWS, ...IPAD_TIERS, ...IPAD_OWNER, ...SHEET_DESK];
const TOOLBAR = [...DESKTOP, ...BREAK_EDGE, ...ABOVE_BREAK, ...COMPACT_DESK, ...PORTRAIT, ...LANDSCAPE, ...NARROW, ...IPAD_11, ...IPAD_WINDOWS, ...IPAD_TIERS, ...IPAD_OWNER, ...SHEET_DESK];
const LOAD_MS = 2000;

const nameOf = (v) => v.name ?? `${v.size[0]}x${v.size[1]}`;
const CONTROL = ":is(button, a[href], select, summary)";
export const CHROME = Object.freeze({
  toolbar: [`.toolbar ${CONTROL}:not(.overlay *)`],
  phoneBars: [`.phone-head ${CONTROL}:not(.overlay *)`, `.phone-views ${CONTROL}`],
  phoneStatus: [`.phone-status ${CONTROL}`],
  planList: [`.sidebar ${CONTROL}`],
  sheetHead: [`.sheet-head ${CONTROL}`],
  dialogHead: [`.modal-head ${CONTROL}`],
  drawerHead: [`.drawer-head ${CONTROL}`],
  detailHead: [`.detail-head ${CONTROL}`],
  dialogActions: [`.modal-actions ${CONTROL}`],
  panelActions: [`.panel .actions ${CONTROL}`],
  settingsHead: [`.settings-head ${CONTROL}`],
  settingsTabs: [`.settings-tabs ${CONTROL}`],
  sync: [`.sync-tabs ${CONTROL}`, `.sync-buttons ${CONTROL}`],
  banners: [`.banner ${CONTROL}`],
  choiceBanners: [`.choice-banner ${CONTROL}`],
});
const hitChrome = (...groups) => ({ hit44: groups.flatMap((g) => CHROME[g]) });
const READY_MS = 5000;
const QUIET_MS = 4000;
const SEND_TIMEOUT_MS = 30_000;
const DEVTOOLS_MS = 10_000;
const FONTS = [
  ["IBM Plex Mono", '13px "IBM Plex Mono"'],
  ["Chakra Petch", '600 12px "Chakra Petch"'],
];

const PHONE_NAME_MIN = 90;
const TOAST_TEXT_MIN = 240;
const UNCAUGHT = "Holiday warm for plan p failed: the holiday service did not answer in time";
const LISTED = ["WebBoard would show different dates than the .gantt file:", ...Array.from({ length: 40 }, (_, i) => `- Task ${i + 2} Step ${i + 2}: source 2026-09-07 → 2026-09-10, WebBoard 2026-09-07 → 2026-09-11`)].join("\n");
const EMPTY_PLAN = "No items yet. Add one with + New.";
const EXAMPLE_PLAN = "Example: Website relaunch";
const CALENDAR_BANNER = "The calendar was changed on two devices. Nothing moves until you choose.";
const NEWER_PLAN = "This plan has changes from a newer WebBoard. Update to edit.";
const PICKED = "Tracking: review results";
const HISTORY_ROW = '.slot-panel button.summary-row[data-summary-row="history"]';
const PICKED_CHOICE = "Tracking: review results and fixes";
const STATUS_FIRST = "Holidays for 2031 not loaded — load";
const STATUS_REFUSED = "Holidays for 2031 not available — open calendar";

const expect = (selector, text) => ({ expect: text === undefined ? [selector] : [selector, text] });
const count = (selector, n) => ({ count: [selector, n] });
const loaded = (selector) => ({ loaded: selector });
const click = (selector, text) => ({ click: text === undefined ? [selector] : [selector, text] });
const tap = (selector, text) => ({ tap: [selector, text] });
const swipe = (selector, dx, dy) => ({ swipe: [selector, dx, dy] });
const doubleClick = (selector, text, dx) => ({ doubleClick: [selector, text ?? null, dx ?? 0] });
const doubleTap = (selector, text) => ({ doubleTap: [selector, text ?? null] });
const none = (selector, text) => ({ none: [selector, text] });
const key = (k, code, modifiers) => ({ key: { key: k, code, modifiers } });
const reveal = (selector, text) => ({ reveal: text === undefined ? [selector] : [selector, text] });
const nubs = (reach) => ({ nubs: reach });
const todayShown = () => ({ today: true });
const edges = () => ({ edges: true });
const shown = (selector, n) => ({ shown: [selector, n] });
const width = (selector, min, max) => ({ width: [selector, min, max] });
const heightShare = (selector, min, max) => ({ heightShare: [selector, min, max] });
const chart = (min) => ({ chart: min });
const aligned = () => ({ aligned: true });
const style = (selector, prop, value, pseudo) => ({ style: pseudo === undefined ? [selector, prop, value] : [selector, prop, value, pseudo] });
const valued = (selector, text) => ({ valued: [selector, text] });
const ellipsed = (selector) => ({ ellipsed: selector });
const within_ = (selector, box, n) => ({ within: [selector, box, n] });
const fitLabels = () => ({ fitLabels: true });
const monthCut = () => ({ monthCut: true });
const raise = (message) => ({ raise: message });
const media = (kind) => ({ media: kind });
const oneRow = (selector, n) => ({ oneRow: [selector, n] });
const centred = (selector) => ({ centred: selector });
const nearCentre = (selector) => ({ nearCentre: selector });
const edgeAt = (selector, side, at) => ({ edgeAt: [selector, side, at] });
const oneLine = (selector) => ({ oneLine: selector });
const spare = (selector, min, below) => ({ spare: [selector, min, below === undefined ? null : below] });
const focus = (selector) => ({ focus: selector });
const fontMin = (selector, px) => ({ fontMin: [selector, px] });
const keep = (selector) => ({ keep: selector });
const kept = (selector) => ({ kept: selector });
const meets = (selector, side, other, otherSide) => ({ meets: [selector, side, other, otherSide] });
const centredIn = (selector) => ({ centredIn: selector });
const corner = (selector, box, at, gap) => ({ corner: [selector, box, at, gap] });
const inWindow = (selector) => ({ inWindow: selector });
const uncovered = (selector) => ({ uncovered: selector });
const still = () => ({ still: true });
const asked = (titles) => ({ nativeMenu: titles });
const askedExactly = (byWidth) => ({ nativeMenu: [], byWidth });
const chooseNative = (title) => ({ choose: title });

const VIEWS = [
  ["timeline-w", { view: "timeline", zoom: "W" }, ".tl-row .name"],
  ["timeline-m", { view: "timeline", zoom: "M" }, ".tl-row .name"],
  ["timeline-q", { view: "timeline", zoom: "Q" }, ".tl-row .name"],
  ["board", { view: "board", zoom: "W" }, ".card .card-name"],
  ["list", { view: "list", zoom: "W" }, ".list .list-name"],
];

const PANE_OPEN = { open: true, w: null };
const panesFor = (place, o) => {
  const closed = o.closed ?? [];
  const sized = o.w ?? {};
  const listBase = { open: place === null || place.sidebarOpen === undefined ? true : place.sidebarOpen, w: place === null || place.sidebarWidth === undefined ? null : place.sidebarWidth };
  const pane = (key, base) => ({ open: base.open && !closed.includes(key), w: sized[key] ?? base.w });
  const set = { list: pane("list", listBase), outline: pane("outline", PANE_OPEN), inspector: pane("inspector", PANE_OPEN) };
  return { v: 1, desk: set, padLandscape: set, padPortrait: set };
};
const OUTLINE_CLOSED = { closed: ["outline"] };

const viewExpect = (view) =>
  view === "timeline" ? expect(".tl-canvas") : view === "board" ? count(".nnl .col", 3) : expect("table.list tbody tr");

function states() {
  const out = [];
  const add = (name, fixture, o = {}) =>
    out.push({
      name,
      fixture,
      place: o.place ?? { view: "timeline", zoom: "W" },
      actions: o.actions ?? [],
      sizes: o.sizes ?? "desktop",
      dialog: o.dialog === true,
      clip: o.clip === true ? LONG_NAMES : o.clip ?? [],
      clipIn: o.clipIn ?? [],
      logs: o.logs ?? [],
      net: { ws: o.net?.ws ?? "none", online: o.net?.online ?? true },
      shotMedia: o.shotMedia ?? null,
      theme: o.theme ?? null,
      panes: o.panes === undefined ? null : panesFor(o.place === undefined ? { view: "timeline", zoom: "W" } : o.place, o.panes),
    });

  add("empty", "empty", {
    place: null,
    actions: [
      expect(".empty-state button", "New plan"),
      expect(".empty-state button", "Show an example plan"),
      expect(".empty-state button", "Import plan…"),
      expect(".empty-state button", "Join with a code"),
      expect(".empty-state button", "Set up sync"),
      expect(".toolbar .sync-chip", "Local only"),
    ],
  });
  add("blank-plan", "blank-plan", { actions: [expect(".tl-empty", EMPTY_PLAN)] });
  VIEWS.forEach(([slug, place, names]) => {
    add(`mesa/${slug}/plan`, "mesa", {
      place,
      actions: [
        viewExpect(place.view),
        count(".toolbar .seg-zoom", place.view === "timeline" ? 1 : 0),
        ...(place.view === "list" ? [width("table.list tbody tr:not(.grp) td.item", 180, 100000)] : []),
        expect(".slot-panel .panel h2", "Plan"),
      ],
    });
    add(`mesa/${slug}/item`, "mesa", {
      place,
      actions: [viewExpect(place.view), tap(names, PICKED), expect(".slot-panel .panel .kind", "TASK")],
    });
  });
  add("fit/labels", "mesa", { place: { view: "timeline", zoom: "F" }, actions: [viewExpect("timeline"), fitLabels(), monthCut()] });
  add("scale", "scale", { actions: [expect(".tl-row .name", "WS01 task 01"), valued(".plan-head h1 input", "Scale: 1,000 items")] });
  add("print/scale", "scale-print", {
    sizes: "standard",
    shotMedia: "print",
    actions: [
      expect(".tl-row .name", "WS01 task 01"),
      key("p", "KeyP", 4),
      count("body > .print-sheet", 1),
      style("body > .print-sheet", "display", "none"),
      media("print"),
      expect(".print-sheet h1", "Scale: 1,000 items"),
      count(".print-sheet tbody tr", 1000),
      style("#root", "display", "none"),
      style("body > .print-sheet", "display", "block"),
      style("body", "background-color", "rgb(255, 255, 255)"),
      style(".print-sheet .print-bar:not(.group)", "border-top-color", "rgb(43, 110, 128)"),
      style(".print-sheet .print-bar:not(.group)", "border-top-style", "solid"),
      media("screen"),
      style("body > .print-sheet", "display", "none"),
    ],
  });
  VIEWS.forEach(([slug, place]) =>
    add(`long-names/${slug}`, "long-names", {
      place,
      ...(place.view === "timeline" ? { panes: OUTLINE_CLOSED } : {}),
      clip: true,
      actions: [
        viewExpect(place.view),
        ...(place.view === "list" ? [width("table.list tbody tr:not(.grp) td.item", 180, 100000)] : []),
        ...(place.view === "board" ? [style(".card .card-name", "-webkit-line-clamp", "2")] : []),
        ...(place.view === "list" ? [ellipsed(".plan-head .plan-name-input")] : []),
        shown(".sidebar .entry-more", 1),
        count(".sidebar .entry", 2),
      ],
    }),
  );
  add("choices", "choices", {
    dialog: true,
    actions: [
      expect(".plan-head .chip-amber", "3 open choices · Choose…"),
      expect(".plan-head button.chip-amber", "1 held"),
      expect(".plan-head .calendar-banner .banner-text", CALENDAR_BANNER),
      tap(".tl-row .name", PICKED_CHOICE),
      expect(".slot-panel .choice-banner button", "Choose"),
      click(".slot-panel .choice-banner button", "Choose"),
      count('[role="dialog"] .choice-col', 3),
    ],
  });
  add("unreadable", "unreadable", {
    actions: [
      count(".plan-head .head-line.bad", 1),
      expect(".plan-head .head-line.bad", UNREADABLE_LINE),
      expect(".plan-head .chip-cyan", "Receiving… · 1 change waiting"),
      count(".plan-head .forward-lock", 1),
      expect(".plan-head .forward-lock", NEWER_PLAN),
      expect(".toolbar button:disabled", "+ New"),
    ],
  });
  add("unreadable/ios-pad", "unreadable-ios-pad", {
    sizes: "ipad-11-landscape",
    actions: [expect(".plan-head .forward-lock", NEWER_PLAN), expect(".toolbar button:disabled", "+ New"), hitChrome("toolbar")],
  });
  add("unreadable/ios-phone", "unreadable-ios-phone", {
    sizes: "phone",
    actions: [expect(".phone-status .status-strip .status-text", NEWER_PLAN), hitChrome("phoneBars", "phoneStatus")],
  });
  add("two-choices", "two-choices", {
    actions: [
      expect(".plan-head .chip-amber", "2 open choices · Choose…"),
      click(".plan-head .chip-button", "Choose…"),
      count(".plan-head .choice-list li", 2),
    ],
  });
  add("calendar-dialog", "mesa", {
    sizes: "both",
    dialog: true,
    actions: [
      click(".slot-panel button", "Change calendar…"),
      expect('.modal-wide[role="dialog"] h3', "Calendar · MESA 1.0"),
      width('.closure-add input[type="text"]', 300, 100000),
      expect(".cal-grid select"),
    ],
  });
  const calendarFromSheet = [
    click(".toolbar button", "Plan"),
    click('.sheet[role="dialog"] button', "Change calendar…"),
    expect('.modal-wide[role="dialog"] h3', "Calendar · MESA 1.0"),
    expect(".cal-grid select"),
  ];
  add("calendar-dialog/compact", "mesa", { sizes: "compact-all", dialog: true, actions: calendarFromSheet });
  add("choice-dialog", "choices", {
    sizes: "dialog",
    dialog: true,
    actions: [click(".plan-head button.chip-amber", "1 held"), count('[role="dialog"] .choice-col', 3)],
  });
  add("palette", "mesa", {
    sizes: "desktop-and-compact",
    dialog: true,
    actions: [key("k", "KeyK", 4), expect('.palette[role="dialog"]'), expect(".palette-item .palette-label")],
  });
  const SETTINGS_TAB = '.settings-tabs [role="tab"]';
  const SETTINGS_SHOWN = '[role="tabpanel"]:not([hidden])';
  const settingsOn = (label) => expect(`${SETTINGS_TAB}[aria-selected="true"]`, label);
  const aboutShown = [count(`${SETTINGS_SHOWN} img.about-mark`, 1), loaded(`${SETTINGS_SHOWN} img.about-mark`), expect(`${SETTINGS_SHOWN} .settings-about p`, "Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.")];
  add("about", "mesa", {
    actions: [key("k", "KeyK", 4), tap(".palette-item .palette-label", "About WebBoard"), expect(".settings-panel h2", "Settings"), settingsOn("About"), ...aboutShown],
  });
  add("theme", "mesa", {
    actions: [key("k", "KeyK", 4), tap(".palette-item .palette-label", "Theme…"), expect(".settings-panel h2", "Settings"), settingsOn("Theme"), expect(`${SETTINGS_SHOWN} .theme-body`)],
  });
  add("theme-compact", "mesa", {
    sizes: "compact-all",
    dialog: true,
    actions: [key("k", "KeyK", 4), tap(".palette-item .palette-label", "Theme…"), expect('.sheet[role="dialog"] .sheet-title', "Settings"), settingsOn("Theme")],
  });
  add("settings-button", "mesa", {
    actions: [
      viewExpect("timeline"),
      count('.toolbar button[aria-label="Settings"][aria-pressed="false"]', 1),
      click('.toolbar button[aria-label="Settings"]'),
      expect(".settings-panel h2", "Settings"),
      settingsOn("Theme"),
      count('.toolbar button[aria-label="Settings"][aria-pressed="true"]', 1),
    ],
  });
  add("settings-button-compact", "mesa", {
    sizes: "compact-all",
    dialog: true,
    actions: [viewExpect("timeline"), click('.toolbar button[aria-label="Settings"]'), expect('.sheet[role="dialog"] .sheet-title', "Settings"), settingsOn("Theme")],
  });
  const settingsTabs = (labels) => [
    ["theme", "Theme", [expect(`${SETTINGS_SHOWN} .theme-body`), expect(`${SETTINGS_SHOWN} button`, "Save theme")]],
    ["sync", "Sync", [expect(`${SETTINGS_SHOWN} .settings-status.cyan`, "Local only"), count(`${SETTINGS_SHOWN} .settings-buttons button`, 4), expect(`${SETTINGS_SHOWN} .settings-buttons button`, "Join with a code")]],
    ["updates", "Updates", [expect(`${SETTINGS_SHOWN} .update-line .update-status`, "Up to date · checked 09:00")]],
    ["about", "About", aboutShown],
  ].filter(([, label]) => labels.includes(label));
  const DESK_TABS = ["Theme", "Sync", "Updates", "About"];
  settingsTabs(DESK_TABS).forEach(([slug, label, shownTab]) => {
    add(`settings/${slug}`, "mesa", {
      sizes: "smallest",
      actions: [
        viewExpect("timeline"),
        click('.toolbar button[aria-label="Settings"]'),
        width(".slot-panel", 360, 360),
        click(SETTINGS_TAB, label),
        settingsOn(label),
        oneRow(SETTINGS_TAB, DESK_TABS.length),
        ...shownTab,
      ],
    });
    add(`settings-compact/${slug}`, "mesa", {
      sizes: "compact-all",
      dialog: true,
      actions: [
        viewExpect("timeline"),
        click('.toolbar button[aria-label="Settings"]'),
        expect('.sheet[role="dialog"] .sheet-title', "Settings"),
        click(SETTINGS_TAB, label),
        settingsOn(label),
        oneRow(SETTINGS_TAB, DESK_TABS.length),
        ...shownTab,
      ],
    });
  });
  settingsTabs(DESK_TABS).forEach(([slug, label, shownTab]) => {
    add(`phone-settings/${slug}`, "mesa", {
      sizes: "phone",
      dialog: true,
      actions: [
        click(".phone-head button", "Plans"),
        click(".plans-sheet button.settings-row", "Settings…"),
        expect('.sheet[role="dialog"] .sheet-title', "Settings"),
        click(SETTINGS_TAB, label),
        settingsOn(label),
        oneRow(SETTINGS_TAB, DESK_TABS.length),
        ...shownTab,
      ],
    });
  });
  add("light-timeline", "mesa", {
    theme: { v: 1, mode: "fixed", active: "paper", dark: "cyberdeck", light: "daylight", mine: [] },
    actions: [viewExpect("timeline"), count(".toolbar .seg-zoom", 1), expect(".slot-panel .panel h2", "Plan"), expect('html[data-scheme="light"]')],
  });
  add("linux-toolbar", "mesa-linux", {
    sizes: "smallest",
    actions: [viewExpect("timeline"), expect("header.toolbar .wordmark", "WebBoard"), count(".toolbar-mac", 0)],
  });
  [
    ["mac", "mesa"],
    ["linux", "mesa-linux"],
  ].forEach(([os, fixture]) => {
    const timeline = [viewExpect("timeline"), count(".toolbar .seg-zoom", 1)];
    const board = { place: { view: "board", zoom: "W" } };
    const boardShown = [viewExpect("board"), count(".toolbar .seg-zoom", 0)];
    add(`tabs-centred/${os}`, fixture, { sizes: "widest", actions: [...timeline, centred(".seg-modes")] });
    add(`tabs-centred/${os}/board`, fixture, { ...board, sizes: "widest", actions: [...boardShown, centred(".seg-modes")] });
    add(`tabs-near-centre/${os}`, fixture, { sizes: "above-break-and-standard", actions: [...timeline, nearCentre(".seg-modes")] });
    add(`tabs-near-centre/${os}/board`, fixture, { ...board, sizes: "above-break-and-standard", actions: [...boardShown, nearCentre(".seg-modes")] });
  });
  add("tabs-near-centre/offline", "sync-space", {
    sizes: "above-break-and-wide",
    net: { ws: "silent", online: false },
    actions: [viewExpect("timeline"), expect(".toolbar button.sync-chip.chip-amber", "Offline — 1 change waiting"), nearCentre(".seg-modes")],
  });
  add("sync-chip/off", "mesa", { actions: [viewExpect("timeline"), expect(".toolbar button.sync-chip.chip-cyan", "Local only")] });
  add("sync-chip/syncing", "sync-space", { net: { ws: "silent" }, actions: [viewExpect("timeline"), expect(".toolbar button.sync-chip.chip-cyan", "Syncing")] });
  add("sync-chip/synced", "sync-space", {
    net: { ws: "sync" },
    actions: [viewExpect("timeline"), count(".toolbar .sync-chip .dot-live", 1), expect(".toolbar button.sync-chip.chip-cyan", "Synced")],
  });
  add("sync-chip/receiving", "sync-receiving", { net: { ws: "sync" }, actions: [viewExpect("timeline"), expect(".toolbar button.sync-chip.chip-cyan", "Receiving…")] });
  add("sync-chip/offline", "sync-space", { net: { ws: "silent", online: false }, actions: [viewExpect("timeline"), expect(".toolbar button.sync-chip.chip-amber", "Offline — 1 change waiting")] });
  add("sync-chip/error", "sync-removed", { actions: [viewExpect("timeline"), expect(".toolbar button.sync-chip.chip-magenta", "Device removed")] });
  add("removed-banner", "sync-removed", {
    actions: [
      viewExpect("timeline"),
      expect(".removed-banner button", "Join with a code"),
      expect(".removed-banner button", "Set up sync"),
      count(".removed-banner button", 2),
    ],
  });
  add("sync-dialog", "sync-dialog", {
    sizes: "dialog",
    dialog: true,
    actions: [click(".toolbar .sync-chip", "Local only"), expect('[role="dialog"] [role="tab"][aria-selected="true"]', "Set up sync"), expect('[role="dialog"] button', "Create or join space")],
  });
  const UPDATE_AVAILABLE = `WebBoard ${UPDATE_VERSION} is available`;
  const UPDATE_FAILED = `Could not check for updates: ${UPDATE_CHECK_FAILED}`;
  const UPDATE_DOWNLOADING = `Downloading ${UPDATE_VERSION}… 50%`;
  const exampleHead = valued(".plan-head h1 input", EXAMPLE_PLAN);
  add("example/timeline", "example", {
    sizes: "timeline",
    place: { view: "timeline", zoom: "W" },
    actions: [viewExpect("timeline"), todayShown(), edges(), exampleHead, expect(".tl-row .name", "Visual design"), count(".plan-head .chip-magenta", 0), count(".plan-head .chip-amber", 0)],
  });
  add("example/board", "example", {
    sizes: "standard",
    place: { view: "board", zoom: "W" },
    actions: [viewExpect("board"), exampleHead, expect(".card .card-name", "Visual design")],
  });
  add("example/list", "example", {
    sizes: "standard",
    place: { view: "list", zoom: "W" },
    actions: [viewExpect("list"), exampleHead, expect(".list .list-name", "QA and fixes")],
  });
  add("example/phone-timeline", "example", {
    sizes: "phone",
    actions: [
      expect(".phone-head .phone-plan-name", EXAMPLE_PLAN),
      click('.phone-views [role="tab"]', "Timeline"),
      expect('.phone-views [role="tab"][aria-selected="true"]', "Timeline"),
      expect(".tl-canvas"),
      todayShown(),
      width(".tl-corner", 132, 132),
      shown(".tl-corner .days", 0),
      shown(".tl-row .days", 0),
      width(".phone-head .phone-glyph", 36, 40),
      width(".phone-head .phone-plan-name", PHONE_NAME_MIN, 390),
      expect(".tl-row .name", "Visual design"),
    ],
  });
  add("phone-toast/uncaught", "example", {
    sizes: "phone",
    actions: [
      expect(".phone-head .phone-plan-name", EXAMPLE_PLAN),
      raise(UNCAUGHT),
      expect('.toast-bad [role="alert"]', UNCAUGHT),
      expect(".toast-bad .toast-actions button", "Copy details"),
      width(".toast-bad .toast", TOAST_TEXT_MIN, 390),
    ],
  });
  add("toast/listed", "mesa", {
    actions: [
      viewExpect("timeline"),
      raise(LISTED),
      expect('.toast-bad [role="alert"]', LISTED),
      style(".toast-bad .toast", "white-space", "pre-line"),
      style(".toast-bad .toast", "overflow-y", "auto"),
      expect(".toast-bad .toast-actions button", "Copy details"),
    ],
  });
  add("toast/uncaught", "mesa", {
    actions: [viewExpect("timeline"), raise(UNCAUGHT), expect('.toast-bad [role="alert"]', UNCAUGHT), width(".toast-bad .toast", TOAST_TEXT_MIN, 640)],
  });
  add("update/current", "mesa", { panes: OUTLINE_CLOSED, actions: [viewExpect("timeline"), expect(".sidebar .update-line .update-status", "Up to date · checked 09:00")] });
  add("update/available", "update-available", {
    panes: OUTLINE_CLOSED,
    clip: [UPDATE_AVAILABLE],
    actions: [viewExpect("timeline"), expect(".sidebar .update-line button", "Install and restart"), expect(".sidebar .update-line .update-status.amber", UPDATE_AVAILABLE)],
  });
  add("update/check-failed", "update-check-failed", {
    panes: OUTLINE_CLOSED,
    clip: [UPDATE_FAILED],
    logs: [UPDATE_CHECK_FAILED],
    actions: [viewExpect("timeline"), expect(".sidebar .update-line button", "Try again"), expect(".sidebar .update-line .update-status.bad", UPDATE_FAILED)],
  });
  add("update/downloading", "update-downloading", {
    panes: OUTLINE_CLOSED,
    clip: [UPDATE_DOWNLOADING],
    actions: [viewExpect("timeline"), click(".sidebar .update-line button", "Install and restart"), expect(".sidebar .update-line .update-status", UPDATE_DOWNLOADING)],
  });
  const planSheet = [click(".toolbar button", "Plan"), expect('.sheet[role="dialog"] .sheet-title', "Plan"), expect(".sheet .panel h2", "Plan")];
  add("phone/list", "mesa", {
    sizes: "phone",
    actions: [count(".sidebar", 0), expect('.phone-views [role="tab"][aria-selected="true"]', "List"), expect(".phone-list .prow .prow-name")],
  });
  add("phone-plans", "phone-plans", {
    place: { plan: PLAN_IDS.long, view: "timeline", zoom: "W" },
    sizes: "phone",
    dialog: true,
    clip: true,
    clipIn: [".plans-sheet .entry-name", ".phone-plan-name"],
    actions: [
      click(".phone-head button", "Plans"),
      expect('.sheet[role="dialog"] .sheet-title', "Plans"),
      count(".plans-sheet .entries .entry", 3),
      expect(".plans-sheet section .entry-name", "Blank plan"),
    ],
  });
  add("phone-choice", "phone-choice", {
    sizes: "phone",
    dialog: true,
    actions: [
      click(".phone-head button.chip-amber", "2 held"),
      count('.sheet[role="dialog"] .choice-col', 2),
      count('.sheet[role="dialog"] [role="switch"]', 2),
      count('.sheet[role="dialog"] .pick-row', 2),
      expect('.sheet[role="dialog"] button.button-primary', "Apply"),
    ],
  });
  add("phone-plan-sheet", "mesa", {
    sizes: "phone",
    dialog: true,
    actions: [
      click(".phone-head button.phone-more", "⋯"),
      expect('.sheet[role="dialog"] .sheet-title', "Plan"),
      expect(".plan-sheet h2", "History"),
      expect(".plan-sheet button", "Export plan…"),
      expect(".plan-sheet button.settings-row", "Settings…"),
    ],
  });
  add("phone-theme", "mesa", {
    sizes: "phone",
    dialog: true,
    actions: [
      click(".phone-head button", "Plans"),
      click(".plans-sheet button.settings-row", "Settings…"),
      expect('.sheet[role="dialog"] .sheet-title', "Settings"),
      settingsOn("Theme"),
    ],
  });
  add("phone-about", "mesa", {
    sizes: "phone",
    dialog: true,
    actions: [
      click(".phone-head button.phone-more", "⋯"),
      click(".plan-sheet button.settings-row", "Settings…"),
      expect('.sheet[role="dialog"] .sheet-title', "Settings"),
      click(SETTINGS_TAB, "About"),
      settingsOn("About"),
      ...aboutShown,
    ],
  });
  add("phone-status/strip", "phone-status", {
    sizes: "phone",
    clip: [LONG_NAMES[0], STATUS_FIRST],
    clipIn: [".phone-plan-name", ".status-strip .status-text"],
    actions: [expect(".phone-status .status-strip .status-text", STATUS_FIRST), expect(".phone-status .status-strip .status-more", "· +1 more")],
  });
  add("phone-status", "phone-status", {
    sizes: "phone",
    dialog: true,
    actions: [
      click(".phone-status .status-strip", `${STATUS_FIRST} · +1 more`),
      expect('.sheet[role="dialog"] .sheet-title', "Status"),
      count(".status-lines .status-line", 2),
      expect(".status-line.note .status-text", STATUS_FIRST),
      click(".status-line.note .status-actions button", "Load"),
      expect(".status-line.warn .status-text", STATUS_REFUSED),
      expect(".status-line.warn .status-actions button", "Change calendar…"),
      expect(".status-line.magenta .status-text", "1 conflict"),
      expect(".status-line.magenta .status-actions button", "Go to first conflict"),
    ],
  });
  const fullShell = [viewExpect("timeline"), expect(".sidebar"), expect(".slot-panel .panel h2", "Plan")];
  add("touch/full", "mesa", { sizes: "landscape", panes: OUTLINE_CLOSED, actions: fullShell });
  add("desk/full-1180", "mesa", { sizes: "smallest", panes: OUTLINE_CLOSED, actions: [...fullShell, expect("header.toolbar .wordmark", "WebBoard"), count('.toolbar button[aria-label="Settings"]', 1), width(".main", 582, 582)] });
  add("touch/nub", "mesa", {
    sizes: "ipad-pro",
    actions: [viewExpect("timeline"), click(".tl-row .name", PICKED), expect(".bar.selected .nub"), nubs(60), expect(".slot-panel .panel .kind", "TASK")],
  });
  add("compact/shell", "mesa", {
    sizes: "compact-all",
    actions: [
      viewExpect("timeline"),
      expect(".toolbar button", "Plans"),
      expect(".toolbar button", "Plan"),
      count(".sidebar", 0),
      count(".slot-panel", 0),
      count('[role="dialog"]', 0),
    ],
  });
  add("compact/plan-sheet", "mesa", { sizes: "compact-all", dialog: true, actions: planSheet });
  add("compact/item", "mesa", {
    sizes: "compact-all",
    dialog: true,
    actions: [viewExpect("timeline"), tap(".tl-row .name", PICKED), count('.sheet[role="dialog"]', 1), expect('.sheet[role="dialog"] .kind', "TASK")],
  });
  add("compact/empty", "all-trashed", {
    place: null,
    actions: [
      expect(".toolbar button", "Plans"),
      none(".toolbar button", "Plan"),
      expect(".empty-state button", "New plan"),
      expect(".empty-state button", "Show an example plan"),
      expect(".empty-state button", "Import plan…"),
      expect(".empty-state button", "Join with a code"),
      expect(".empty-state button", "Set up sync"),
      expect(".toolbar .sync-chip", "Local only"),
      count('.toolbar button[aria-label="Settings"]', 1),
    ],
    sizes: "compact-all",
  });
  add("narrow-shell", "mesa", { sizes: "narrow", actions: [viewExpect("timeline"), expect(".toolbar button", "Plans"), expect(".toolbar button", "Plan")] });
  add("narrow-sheet", "mesa", { sizes: "narrow", dialog: true, actions: planSheet });
  add("narrow-dialog", "mesa", { sizes: "narrow", dialog: true, actions: calendarFromSheet });
  const syncDialog = [click(".toolbar .sync-chip", "Local only"), expect('[role="dialog"] [role="tab"][aria-selected="true"]', "Set up sync"), expect('[role="dialog"] button', "Create or join space")];
  add("narrow-sync-dialog", "sync-dialog", { sizes: "narrow", dialog: true, actions: syncDialog });
  add("compact-desk/sync-dialog", "sync-dialog", { sizes: "sheet-desk", dialog: true, actions: syncDialog });
  add("long-names/compact/list", "long-names", {
    sizes: "compact-all",
    place: { view: "list", zoom: "W" },
    clip: true,
    actions: [viewExpect("list"), width("table.list tbody tr:not(.grp) td.item", 180, 100000)],
  });
  add("long-names/compact/board", "long-names", {
    sizes: "compact-all",
    place: { view: "board", zoom: "W" },
    clip: true,
    actions: [viewExpect("board"), style(".card .card-name", "-webkit-line-clamp", "2")],
  });
  const localTags = [count(".entry-open .entry-tag", 3), within_(".entry-tag", ".entry-open", 3), expect(".local-line button", "Move both")];
  add("sync-local", "sync-local", {
    place: { plan: PLAN_IDS.long, view: "timeline", zoom: "W" },
    panes: OUTLINE_CLOSED,
    net: { ws: "sync" },
    clip: true,
    actions: [viewExpect("timeline"), ...localTags],
  });
  add("phone-sync-local", "sync-local", {
    place: { plan: PLAN_IDS.long, view: "timeline", zoom: "W" },
    sizes: "phone",
    net: { ws: "sync" },
    dialog: true,
    actions: [click(".phone-head button", "Plans"), expect('.sheet[role="dialog"] .sheet-title', "Plans"), ...localTags],
  });
  add("long-names/touch", "long-names", { sizes: "touch-wide", clip: true, actions: [viewExpect("timeline"), expect(".tl-row .name")] });
  const phoneChip = (tone, label) => expect(`.phone-head button.sync-chip.chip-compact.${tone}[aria-label="${label}"]`);
  add("phone-sync/off", "mesa", { sizes: "phone", actions: [phoneChip("chip-cyan", "Local only")] });
  add("phone-sync/syncing", "sync-space", { sizes: "phone", net: { ws: "silent" }, actions: [phoneChip("chip-cyan", "Syncing")] });
  add("phone-sync/synced", "sync-space", {
    sizes: "phone",
    net: { ws: "sync" },
    actions: [count(".phone-head .chip-compact .dot-live", 1), phoneChip("chip-cyan", "Synced")],
  });
  add("phone-sync/receiving", "sync-receiving", { sizes: "phone", net: { ws: "sync" }, actions: [phoneChip("chip-cyan", "Receiving…")] });
  add("phone-sync/offline", "sync-space", { sizes: "phone", net: { ws: "silent", online: false }, actions: [phoneChip("chip-amber", "Offline — 1 change waiting")] });
  add("phone-sync/error", "sync-removed", { sizes: "phone", actions: [phoneChip("chip-magenta", "Device removed")] });
  add("phone-sync-sheet", "phone-sync-sheet", {
    sizes: "phone",
    dialog: true,
    actions: [
      click(".phone-head button", "Plans"),
      click(".plans-sync button", "Set up sync"),
      expect('.sheet[role="dialog"] .sheet-title', "Sync"),
      expect('[role="dialog"] [role="tab"][aria-selected="true"]', "Set up sync"),
      expect('[role="dialog"] button', "Create or join space"),
    ],
  });
  add("phone-removed-banner", "phone-removed-banner", {
    sizes: "phone",
    actions: [
      expect(".removed-banner button", "Export…"),
      expect(".removed-banner button", "Join with a code"),
      expect(".removed-banner button", "Set up sync"),
      count(".removed-banner button", 3),
    ],
  });
  add("long-names/phone", "long-names", { sizes: "phone", clip: true, actions: [expect(".phone-list .prow .prow-name")] });
  add("detail/summary", "mesa", {
    actions: [
      viewExpect("timeline"),
      expect(".slot-panel .plan-summary h2", "Plan"),
      count(".slot-panel .summary-row", 2),
      expect(".slot-panel .summary-row .summary-row-label", "History"),
      expect(".slot-panel .summary-row .summary-row-label", "Trash"),
      expect(".slot-panel .summary-bar span"),
      click(HISTORY_ROW),
      expect(".slot-panel .summary-back", "‹ Plan"),
      expect(".slot-panel .panel h2", "History"),
      click(".slot-panel .summary-back"),
      count(".slot-panel .summary-row", 2),
    ],
  });
  add("history", "mesa", {
    actions: [click(HISTORY_ROW), reveal(".slot-panel .panel h2", "History"), width(".slot-panel .history li button", 1, 90), count(".slot-panel .history li", 40)],
  });
  add("converted-report", "converted", {
    place: null,
    sizes: "desktop-and-compact",
    dialog: true,
    actions: [
      click(".empty-state button", "Import plan…"),
      expect('[role="dialog"] p', `Plan “Probe plan” from ${CONVERTED_FILE}`),
      count(".converted-dropped li", 5),
      style(".converted-dropped", "list-style-type", "none"),
      style(".converted-dropped", "padding-left", "10px"),
      within_(".converted-dropped li", ".converted-dropped", 5),
    ],
  });
  const TOGGLE = '.toolbar button[aria-label="Plan list"]';
  const hiddenPlace = { view: "timeline", zoom: "W", sidebarOpen: false };
  const hiddenList = [viewExpect("timeline"), count(".sidebar", 0), count(".sidebar-resizer", 0), count(".plan-overlay-layer", 0), count(`${TOGGLE}[aria-expanded="false"]`, 1), oneLine(".toolbar"), edgeAt(".main", "left", 0)];
  add("plan-list/hidden", "mesa", { place: hiddenPlace, panes: OUTLINE_CLOSED, sizes: "full-all", actions: hiddenList });
  [
    ["mac", "mesa"],
    ["linux", "mesa-linux"],
  ].forEach(([os, fixture]) => {
    add(`plan-list/hidden-centred/${os}`, fixture, { place: hiddenPlace, panes: OUTLINE_CLOSED, sizes: "widest", actions: [...hiddenList, centred(".seg-modes")] });
    add(`plan-list/hidden-near-centre/${os}`, fixture, { place: hiddenPlace, panes: OUTLINE_CLOSED, sizes: "above-break-and-standard", actions: [...hiddenList, nearCentre(".seg-modes")] });
  });
  add("plan-list/toggle", "mesa", {
    sizes: "full-all",
    panes: OUTLINE_CLOSED,
    actions: [
      viewExpect("timeline"),
      count(`${TOGGLE}[aria-expanded="true"]`, 1),
      expect(".sidebar"),
      expect(".sidebar-resizer"),
      click(TOGGLE),
      count(".sidebar", 0),
      count(`${TOGGLE}[aria-expanded="false"]`, 1),
      edgeAt(".main", "left", 0),
      click(TOGGLE),
      count(`${TOGGLE}[aria-expanded="true"]`, 1),
      expect(".sidebar"),
      oneLine(".toolbar"),
    ],
  });
  add("plan-list/attention", "update-available", {
    place: hiddenPlace,
    panes: OUTLINE_CLOSED,
    sizes: "smallest",
    actions: [viewExpect("timeline"), count(".sidebar", 0), count(`${TOGGLE}[data-attention="true"]`, 1), oneLine(".toolbar")],
  });
  const resizedBare = (keyName, size) => [
    viewExpect("timeline"),
    focus(".sidebar-resizer"),
    key(keyName, keyName),
    width(".sidebar", size, size),
    expect(`.sidebar-resizer[aria-valuenow="${size}"]`),
    count(".slot-panel", 0),
    edgeAt(".main", "right", "window"),
    edgeAt(".sidebar", "left", 0),
    oneLine(".toolbar"),
  ];
  const resized = (keyName, size) => [
    viewExpect("timeline"),
    focus(".sidebar-resizer"),
    key(keyName, keyName),
    width(".sidebar", size, size),
    expect(`.sidebar-resizer[aria-valuenow="${size}"]`),
    expect(".slot-panel .panel h2", "Plan"),
    edgeAt(".slot-panel", "right", "window"),
    edgeAt(".sidebar", "left", 0),
    oneLine(".toolbar"),
  ];
  add("plan-list/min", "mesa", { sizes: "full-all", panes: OUTLINE_CLOSED, actions: resized("Home", 200) });
  add("plan-list/max", "mesa", { sizes: "full-480", panes: { closed: ["outline", "inspector"] }, actions: resizedBare("End", 480) });
  add("plan-list/max-1180", "mesa", { sizes: "full-1180", panes: { closed: ["outline", "inspector"] }, actions: resizedBare("End", 472) });
  add("plan-list/no-toggle/compact", "mesa", {
    sizes: "compact-all",
    panes: OUTLINE_CLOSED,
    actions: [viewExpect("timeline"), expect(".toolbar button", "Plans"), count(TOGGLE, 0), count(".sidebar-resizer", 0)],
  });
  add("plan-list/no-toggle/narrow", "mesa", { sizes: "narrow", actions: [viewExpect("timeline"), expect(".toolbar button", "Plans"), count(TOGGLE, 0), count(".sidebar-resizer", 0)] });
  add("plan-list/no-toggle/phone", "mesa", {
    sizes: "phone",
    actions: [expect(".phone-head button", "Plans"), count('button[aria-label="Plan list"]', 0), count(".sidebar-resizer", 0)],
  });
  const stamped = (os, idiom) => [count(`html[data-os="${os}"]`, 1), count(idiom === null ? "html[data-idiom]" : `html[data-idiom="${idiom}"]`, idiom === null ? 0 : 1)];
  add("platform/macos", "mesa", { sizes: "standard", actions: [viewExpect("timeline"), ...stamped("macos", null)] });
  add("platform/linux", "mesa-linux", { sizes: "standard", actions: [viewExpect("timeline"), ...stamped("linux", null)] });
  add("platform/ipad-11-portrait", "mesa-ios-pad", { sizes: "ipad-11-portrait", actions: [viewExpect("timeline"), count(`${TOGGLE}[aria-expanded="false"]`, 1), none(".toolbar button", "Plans"), count(".sidebar", 0), ...stamped("ios", "pad")] });
  add("platform/ipad-11-landscape", "mesa-ios-pad", { sizes: "ipad-11-landscape", panes: OUTLINE_CLOSED, actions: [...fullShell, ...stamped("ios", "pad")] });
  add("platform/iphone-landscape", "mesa-ios-phone", { sizes: "phone-landscape", actions: [expect(".phone-head button", "Plans"), ...stamped("ios", "phone")] });
  const FIELDS = '.sheet input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]), .sheet select, .sheet textarea';
  const phoneItemSheet = [click(".phone-list .prow"), expect('.sheet[role="dialog"] [data-detail="sheet"] .detail-body')];
  const phoneSettings = [click(".phone-head button", "Plans"), click(".plans-sheet button.settings-row", "Settings…"), expect('.sheet[role="dialog"] .sheet-title', "Settings"), settingsOn("Theme")];
  add("ios-fields/phone-item", "mesa-ios-phone", { sizes: "phone", dialog: true, actions: [...phoneItemSheet, fontMin(FIELDS, 16)] });
  add("ios-fields/phone-settings", "mesa-ios-phone", { sizes: "phone", dialog: true, actions: [...phoneSettings, fontMin(FIELDS, 16)] });
  const settingsFromMore = [click('.toolbar button[aria-label="More"]'), chooseNative("Settings")];
  const NEW_ROWS = ["New task", "New milestone", "New group"];
  const PLAN_ROWS = ["Export plan…", "Import plan…"];
  const INSPECTOR_DRAWER = '.inspector-overlay[role="dialog"][aria-label="Inspector"]';
  const padItem = [click(".tl-row .name", PICKED), still(), expect(`${INSPECTOR_DRAWER} .panel .kind`, "TASK"), count(".sheet", 0)];
  add("ios44/phone/plan", "mesa-ios-phone", { sizes: "phone", actions: [expect(".phone-head button", "Plans"), hitChrome("phoneBars")] });
  add("ios44/phone/plans", "mesa-ios-phone", { sizes: "phone", dialog: true, actions: [click(".phone-head button", "Plans"), expect('.sheet[role="dialog"] .sheet-title', "Plans"), hitChrome("sheetHead", "planList")] });
  add("ios44/phone/item", "mesa-ios-phone", { sizes: "phone", dialog: true, actions: [...phoneItemSheet, reveal('.sheet .detail-body [data-detail-field="group"]'), expect(".sheet .detail-body .actions button", "Move up"), hitChrome("sheetHead", "panelActions")] });
  add("ios44/phone/item-end", "mesa-ios-phone", { sizes: "phone", dialog: true, actions: [...phoneItemSheet, reveal(".sheet .detail-body > .actions button", "Delete"), hitChrome("sheetHead", "panelActions")] });
  add("phone/detent-medium", "mesa-ios-phone", {
    sizes: "phone",
    dialog: true,
    actions: [...phoneItemSheet, still(), count('.sheet[data-detent="medium"]', 1), heightShare(".sheet", 50, 54), expect(".sheet .detail-head .detail-expand"), inWindow(".sheet"), hitChrome("sheetHead", "detailHead")],
  });
  add("phone/detent-large", "mesa-ios-phone", {
    sizes: "phone",
    dialog: true,
    actions: [...phoneItemSheet, still(), swipe(".sheet .sheet-title", 0, -120), still(), count('.sheet[data-detent="large"]', 1), heightShare(".sheet", 95, 100), inWindow(".sheet")],
  });
  add("ios44/phone/settings", "mesa-ios-phone", { sizes: "phone", dialog: true, actions: [...phoneSettings, hitChrome("sheetHead", "settingsTabs")] });
  add("ios44/phone/sync", "mesa-ios-phone", {
    sizes: "phone",
    dialog: true,
    actions: [click(".phone-head button", "Plans"), click(".plans-sync button", "Set up sync"), expect('.sheet[role="dialog"] .sheet-title', "Sync"), hitChrome("sheetHead", "sync")],
  });
  add("ios44/phone/new-menu", "mesa-ios-phone", {
    sizes: "phone",
    actions: [click(".phone-head button.phone-add", "+"), asked(NEW_ROWS), hitChrome("phoneBars")],
  });
  add("ios44/phone/plan-sheet", "mesa-ios-phone", {
    sizes: "phone",
    dialog: true,
    actions: [click('.phone-head button[aria-label="Plan"]'), expect('.sheet[role="dialog"] .sheet-title', "Plan"), expect(".sheet .history button", "Revert"), style(".sheet .history li button", "position", "static"), hitChrome("sheetHead")],
  });
  add("ios44/phone/removed-banner", "phone-removed-banner-ios", { sizes: "phone", actions: [count(".removed-banner button", 3), hitChrome("phoneBars", "banners")] });
  add("ios44/pad-landscape/removed-banner", "sync-removed-ios-pad", { sizes: "ipad-11-landscape", actions: [count(".removed-banner button", 2), hitChrome("toolbar", "banners")] });
  add("ios44/pad-landscape/choice-banner", "choices-ios-pad", {
    sizes: "ipad-11-landscape",
    actions: [tap(".tl-row .name", PICKED_CHOICE), expect(".slot-panel .choice-banner button", "Choose"), hitChrome("choiceBanners", "panelActions")],
  });
  add("ios44/pad-portrait/new-menu", "mesa-ios-pad", {
    sizes: "ipad-11-portrait",
    actions: [viewExpect("timeline"), click(".toolbar button", "+ New"), asked(NEW_ROWS), hitChrome("toolbar")],
  });
  add("ios44/pad-landscape/plan-menu", "mesa-ios-pad", {
    sizes: "ipad-11-landscape",
    panes: OUTLINE_CLOSED,
    actions: [...fullShell, click('.plan-head button[aria-label="Plan menu"]'), asked(PLAN_ROWS)],
  });
  add("ios44/phone-landscape/plan", "mesa-ios-phone", { sizes: "phone-landscape", actions: [expect(".phone-head button", "Plans"), hitChrome("phoneBars")] });
  add("ios44/phone/status-strip", "phone-status-ios", { sizes: "phone", actions: [expect(".phone-status .status-strip .status-text", STATUS_FIRST), hitChrome("phoneBars", "phoneStatus")] });
  add("ios44/pad-landscape/dialog", "mesa-ios-pad", {
    sizes: "ipad-11-landscape",
    panes: OUTLINE_CLOSED,
    dialog: true,
    actions: [...fullShell, click(HISTORY_ROW), click(".slot-panel .history button", "Revert"), expect('[role="dialog"] h3', "Revert this action"), hitChrome("dialogActions", "dialogHead")],
  });
  add("ios44/pad-portrait/plan", "mesa-ios-pad", { sizes: "ipad-11-portrait", actions: [viewExpect("timeline"), hitChrome("toolbar")] });
  add("ios44/pad-portrait/plans", "mesa-ios-pad", {
    sizes: "ipad-11-portrait",
    dialog: true,
    actions: [viewExpect("timeline"), click(TOGGLE), still(), expect('.plan-overlay[role="dialog"] .sidebar'), hitChrome("toolbar", "planList")],
  });
  add("ios44/pad-portrait/item", "mesa-ios-pad", { sizes: "ipad-11-portrait", dialog: true, actions: [viewExpect("timeline"), ...padItem, count(`${INSPECTOR_DRAWER} .detail-expand`, 1), hitChrome("drawerHead", "detailHead", "panelActions")] });
  add("ios44/pad-portrait/detail-head", "mesa-ios-pad", {
    sizes: "ipad-11-portrait",
    dialog: true,
    actions: [viewExpect("timeline"), ...padItem, count(`${INSPECTOR_DRAWER} .detail-head .inspector-close`, 0), count(`${INSPECTOR_DRAWER} .detail-head .detail-next`, 1), hitChrome("detailHead")],
  });
  add("ios44/pad-landscape/detail-head", "mesa-ios-pad", {
    place: { view: "board", zoom: "W" },
    sizes: "ipad-11-landscape",
    panes: OUTLINE_CLOSED,
    actions: [viewExpect("board"), tap(".card .card-name", PICKED), expect(".slot-panel .detail .kind", "TASK"), count(".slot-panel .detail-head .inspector-close", 1), hitChrome("detailHead")],
  });
  const PICKED_BAR = '.tl-chart .bar[data-bar="t3"]';
  add("detail/pair-ipad-bar", "mesa-ios-pad", {
    sizes: "ipad-11-landscape",
    panes: OUTLINE_CLOSED,
    dialog: true,
    actions: [viewExpect("timeline"), doubleTap(PICKED_BAR), still(), count(".modal-item", 1), count(".slot-panel", 0), expect(".modal-item [data-detail] .kind", "TASK"), hitChrome("dialogHead", "detailHead")],
  });
  add("detail/pair-ipad-drawer", "mesa-ios-pad", {
    sizes: "ipad-11-portrait",
    dialog: true,
    actions: [viewExpect("timeline"), doubleTap(".tl-row .name", PICKED), still(), count(".modal-item", 1), count(".inspector-overlay-layer", 0), expect(".modal-item [data-detail] .kind", "TASK"), hitChrome("dialogHead", "detailHead")],
  });
  add("detail/pair-desk-bar", "mesa", {
    panes: OUTLINE_CLOSED,
    dialog: true,
    actions: [viewExpect("timeline"), doubleClick(PICKED_BAR), still(), count(".modal-item", 1), count(".slot-panel", 0), count('.modal-item [data-detail-item="t3"]', 1), centredIn(".modal-item")],
  });
  add("detail/pair-desk-card", "mesa", {
    place: { view: "board", zoom: "W" },
    dialog: true,
    actions: [viewExpect("board"), doubleClick(".card .card-name", PICKED), still(), count(".modal-item", 1), count(".slot-panel", 0), expect('.modal-item [data-detail="modal"] .kind', "TASK")],
  });
  add("detail/micro-drag", "mesa", {
    panes: OUTLINE_CLOSED,
    actions: [viewExpect("timeline"), doubleClick(PICKED_BAR, null, 5), still(), count(".modal-item", 0), count('.slot-panel [data-detail-item="t3"]', 1), count(".tl-row.selected", 1)],
  });
  add("detail/modal-size", "mesa", {
    sizes: "standard",
    panes: OUTLINE_CLOSED,
    dialog: true,
    actions: [viewExpect("timeline"), doubleClick(PICKED_BAR), still(), width(".modal-item", 720, 720), heightShare(".modal-item", 79, 81), inWindow(".modal-item"), centredIn(".modal-item")],
  });
  add("detail/ipad-form-sheet", "mesa-ios-pad", {
    sizes: "ipad-11-portrait",
    dialog: true,
    actions: [viewExpect("timeline"), ...padItem, click(`${INSPECTOR_DRAWER} .detail-expand`), still(), count(".modal-item", 1), count(".inspector-overlay-layer", 0), width(".modal-item", 600, 786), inWindow(".modal-item"), centredIn(".modal-item")],
  });
  add("ios44/pad-portrait/settings", "mesa-ios-pad", {
    sizes: "ipad-11-portrait",
    dialog: true,
    actions: [viewExpect("timeline"), ...settingsFromMore, expect('.sheet[role="dialog"] .sheet-title', "Settings"), settingsOn("Theme"), hitChrome("sheetHead", "settingsTabs")],
  });
  add("ios44/pad-landscape/plan", "mesa-ios-pad", { sizes: "ipad-landscapes", panes: OUTLINE_CLOSED, actions: [...fullShell, hitChrome("toolbar", "planList", "panelActions")] });
  add("ios44/pad-landscape/settings", "mesa-ios-pad", {
    sizes: "ipad-11-landscape",
    actions: [viewExpect("timeline"), click('.toolbar button[aria-label="Settings"]'), expect(".settings-panel h2", "Settings"), settingsOn("Theme"), hitChrome("toolbar", "settingsHead", "settingsTabs")],
  });
  const OVERLAY = '.plan-overlay[role="dialog"][aria-label="Plans"]';
  add("ipad-mode/overlay", "mesa-ios-pad", {
    sizes: "ipad-overlay",
    actions: [
      viewExpect("timeline"),
      count(`${TOGGLE}[aria-expanded="false"]`, 1),
      none(".toolbar button", "Plans"),
      count(".sidebar", 0),
      count(".sidebar-resizer", 0),
      count(".plan-overlay-layer", 0),
      count(".toolbar .kbd-button", 0),
      count('.toolbar button.glyph-button[aria-label="Undo"]', 1),
      count('.toolbar button.glyph-button[aria-label="Redo"]', 1),
      hitChrome("toolbar"),
    ],
  });
  add("ipad-mode/one-row", "mesa-ios-pad", { sizes: "ipad-1179", actions: [viewExpect("timeline"), oneLine(".toolbar")] });
  add("ipad-mode/sheet", "mesa-ios-pad", { sizes: "ipad-699", actions: [viewExpect("timeline"), expect(".toolbar button", "Plans"), count(TOGGLE, 0), count(".sidebar", 0), count(".plan-overlay-layer", 0), hitChrome("toolbar")] });
  add("ipad-mode/column", "mesa-ios-pad", {
    sizes: "ipad-column",
    panes: OUTLINE_CLOSED,
    actions: [...fullShell, count(`${TOGGLE}[aria-expanded="true"]`, 1), expect(".sidebar-resizer"), count(".plan-overlay-layer", 0), expect(".toolbar .kbd-button", "⌘K"), expect(".toolbar button", "Undo")],
  });
  const overlayOpened = [viewExpect("timeline"), keep(".main"), keep(".toolbar"), click(TOGGLE), still(), count(`${TOGGLE}[aria-expanded="true"]`, 1), expect(`${OVERLAY} nav.sidebar`)];
  add("ipad-overlay/open", "mesa-ios-pad", {
    sizes: "ipad-overlay-open",
    dialog: true,
    actions: [
      ...overlayOpened,
      count(".plan-overlay-layer[data-shown]", 1),
      count("main.main[inert]", 1),
      edgeAt(OVERLAY, "left", 0),
      meets(OVERLAY, "top", ".toolbar", "bottom"),
      meets(".plan-overlay-scrim", "top", ".toolbar", "bottom"),
      edgeAt(".plan-overlay-scrim", "right", "window"),
      kept(".toolbar"),
      kept(".main"),
      uncovered(".toolbar button"),
      inWindow(OVERLAY),
      width(OVERLAY, 320, 320),
    ],
  });
  add("ipad-overlay/hit44", "mesa-ios-pad", { sizes: "ipad-overlay-open", dialog: true, actions: [...overlayOpened, hitChrome("toolbar", "planList", "drawerHead")] });
  add("ipad-overlay/closed", "mesa-ios-pad", {
    sizes: "ipad-overlay-open",
    actions: [...overlayOpened, click(TOGGLE), still(), count(".plan-overlay-layer", 0), count("main.main[inert]", 0), count(`${TOGGLE}[aria-expanded="false"]`, 1), kept(".main")],
  });
  add("ipad-overlay/escape", "mesa-ios-pad", {
    sizes: "ipad-portraits",
    actions: [...overlayOpened, key("Escape", "Escape"), still(), count(".plan-overlay-layer", 0), count(`${TOGGLE}:focus`, 1), count(`${TOGGLE}[aria-expanded="false"]`, 1)],
  });
  add("ipad-overlay/cmd-b", "mesa-ios-pad", {
    sizes: "ipad-portraits",
    actions: [viewExpect("timeline"), key("b", "KeyB", 4), still(), expect(`${OVERLAY} nav.sidebar`), key("b", "KeyB", 4), still(), count(".plan-overlay-layer", 0)],
  });
  add("ipad-form-sheet/settings", "mesa-ios-pad", {
    sizes: "ipad-overlay-open",
    dialog: true,
    actions: [viewExpect("timeline"), ...settingsFromMore, expect('.sheet[role="dialog"] .sheet-title', "Settings"), settingsOn("Theme"), style(".sheet", "border-bottom-width", "1px"), style(".sheet", "border-bottom-left-radius", "12px"), style(".sheet", "padding-bottom", "0px"), centredIn(".sheet")],
  });
  add("ipad-form-sheet/item", "mesa-ios-pad", {
    sizes: "ipad-portraits",
    dialog: true,
    actions: [
      viewExpect("timeline"),
      ...padItem,
      count(`${INSPECTOR_DRAWER} > .drawer-head:first-child > .drawer-close`, 1),
      edgeAt(INSPECTOR_DRAWER, "right", "window"),
      width(INSPECTOR_DRAWER, 360, 360),
      hitChrome("drawerHead"),
      click(`${INSPECTOR_DRAWER} .detail-expand`),
      still(),
      count(".inspector-overlay-layer", 0),
      count(".modal-item .modal-head .modal-close", 1),
      expect('.modal-item [data-detail="modal"] .kind', "TASK"),
      inWindow(".modal-item"),
      centredIn(".modal-item"),
      hitChrome("dialogHead", "detailHead"),
    ],
  });
  add("ipad-form-sheet/plans-below-700", "mesa-ios-pad", {
    sizes: "ipad-699",
    dialog: true,
    actions: [viewExpect("timeline"), click(".toolbar button", "Plans"), expect('.sheet[role="dialog"] .sheet-title', "Plans"), hitChrome("sheetHead", "planList"), style(".sheet", "border-bottom-width", "0px"), edgeAt(".sheet", "bottom", 1000)],
  });
  add("ipad-menus/new", "mesa-ios-pad", {
    sizes: "ipad-all",
    actions: [viewExpect("timeline"), click(".toolbar button", "+ New"), asked(NEW_ROWS)],
  });
  add("ipad-menus/plan", "mesa-ios-pad", {
    sizes: "ipad-all",
    actions: [viewExpect("timeline"), click('.plan-head button[aria-label="Plan menu"]'), asked(PLAN_ROWS)],
  });
  const MORE = '.toolbar button[aria-label="More"]';
  const INSPECTOR_TOGGLE = '.toolbar button[aria-label="Inspector"]';
  const oneRowBar = [oneLine(".toolbar"), hitChrome("toolbar")];
  add("ipad-toolbar/roomy", "mesa-ios-pad", { sizes: "ipad-roomy", actions: [viewExpect("timeline"), oneLine(".toolbar"), count(MORE, 0), count(".toolbar .seg-zoom", 1), expect(".toolbar .sync-chip-text"), expect('.toolbar button[aria-label="Settings"]'), ...oneRowBar] });
  add("ipad-toolbar/medium", "mesa-ios-pad", {
    sizes: "ipad-medium",
    actions: [viewExpect("timeline"), oneLine(".toolbar"), count(MORE, 1), count(".toolbar .seg-zoom", 1), expect(".toolbar button", "Today"), count(".toolbar .chip-compact", 1), count('.toolbar button[aria-label="Settings"]', 0), expect(".toolbar .seg-modes button", "Board"), ...oneRowBar],
  });
  add("ipad-toolbar/narrow", "mesa-ios-pad", {
    sizes: "ipad-narrow",
    actions: [viewExpect("timeline"), oneLine(".toolbar"), count(MORE, 1), count(".toolbar .seg-zoom", 0), none(".toolbar button", "Today"), count(".toolbar .chip-compact", 1), expect(".toolbar .seg-modes button", "Board"), ...oneRowBar],
  });
  add("ipad-toolbar/roomy-min", "mesa-ios-pad", { sizes: "ipad-roomy-min", actions: [viewExpect("timeline"), count(MORE, 0), oneLine(".toolbar"), spare(".toolbar", BOUNDARY_SPARE, BOUNDARY_SPARE + 10)] });
  add("ipad-toolbar/medium-min", "mesa-ios-pad", { sizes: "ipad-medium-min", actions: [viewExpect("timeline"), count(MORE, 1), count(".toolbar .seg-zoom", 1), oneLine(".toolbar"), spare(".toolbar", BOUNDARY_SPARE, BOUNDARY_SPARE + 10)] });
  add("ipad-toolbar/narrow-min", "mesa-ios-pad", { sizes: "ipad-narrow-min", actions: [viewExpect("timeline"), count(MORE, 1), count(".toolbar .seg-zoom", 0), oneLine(".toolbar"), spare(".toolbar", 0)] });
  add("ipad-toolbar/owner-landscape", "mesa-ios-pad", { sizes: "ipad-owner-landscape", panes: OUTLINE_CLOSED, actions: [...fullShell, ...oneRowBar] });
  add("ipad-toolbar/overlay-open", "mesa-ios-pad", {
    sizes: "ipad-overlay-open",
    dialog: true,
    actions: [...overlayOpened, still(), uncovered(MORE), ...oneRowBar],
  });
  const MORE_ROWS = [
    [0, ["group Zoom", "Week ✓", "Month", "Quarter", "Fit", "Go to today", "Settings"]],
    [MEDIUM_MIN, ["Settings"]],
  ];
  add("ipad-toolbar/more-open", "mesa-ios-pad", {
    sizes: "ipad-overlay-open",
    actions: [viewExpect("timeline"), click(MORE), askedExactly(MORE_ROWS)],
  });
  const fromMoreOverOverlay = (row) => [...overlayOpened, click(MORE), chooseNative(row), expect('.sheet[role="dialog"] .sheet-title', row), still(), count(`${TOGGLE}[aria-expanded="true"]`, 1), uncovered(`.sheet-head ${CONTROL}`)];
  add("ipad-toolbar/settings-over-overlay", "mesa-ios-pad", { sizes: "ipad-overlay-open", actions: fromMoreOverOverlay("Settings") });
  add("ipad-toolbar/inspector-over-overlay", "mesa-ios-pad", {
    sizes: "ipad-overlay-open",
    dialog: true,
    actions: [...overlayOpened, click(INSPECTOR_TOGGLE), still(), count(".plan-overlay-layer", 0), count(`${INSPECTOR_TOGGLE}[aria-expanded="true"]`, 1), expect(`${INSPECTOR_DRAWER} .panel h2`, "Plan"), count("main.main[inert]", 1), uncovered(INSPECTOR_TOGGLE)],
  });
  add("ipad-toolbar/more-over-overlay", "mesa-ios-pad", {
    sizes: "ipad-overlay-open",
    dialog: true,
    actions: [...overlayOpened, click(MORE), count(`${TOGGLE}[aria-expanded="true"]`, 1), askedExactly(MORE_ROWS)],
  });
  add("ipad-mode/mac-compact", "mesa", { sizes: "mac-compact", actions: [viewExpect("timeline"), expect(".toolbar button", "Plans"), count(TOGGLE, 0), count(".plan-overlay-layer", 0), expect(".toolbar .kbd-button", "⌘K"), expect(".toolbar button", "Undo")] });
  add("ipad-mode/mac-834-plans", "mesa", {
    sizes: "mac-834",
    dialog: true,
    actions: [viewExpect("timeline"), click(".toolbar button", "Plans"), expect('.sheet[role="dialog"] .sheet-title', "Plans"), count(".plan-overlay-layer", 0), style(".sheet", "border-bottom-width", "0px"), edgeAt(".sheet", "bottom", 1194)],
  });
  const PANE_TOGGLE = '.toolbar button[aria-label="Inspector"]';
  [
    [1024, false, 183],
    [1100, false, 259],
    [1180, false, 300],
    [1280, false, 300],
    [1440, true, 300],
  ].forEach(([w, listColumn, grid]) => {
    add(`panes/budget-${w}`, "mesa", {
      sizes: `panes-${w}`,
      actions: [
        viewExpect("timeline"),
        count(".sidebar", listColumn ? 1 : 0),
        count(`${TOGGLE}[aria-expanded="${listColumn ? "true" : "false"}"]`, 1),
        width(".slot-panel", 360, 360),
        edgeAt(".slot-panel", "right", "window"),
        chart(480),
        oneLine(".toolbar"),
        width(".tl-grid", grid, grid),
      ],
    });
  });
  add("panes/budget-linux-1024", "mesa-linux", {
    sizes: "panes-1024",
    actions: [viewExpect("timeline"), count(".sidebar", 0), width(".slot-panel", 360, 360), chart(480), oneLine(".toolbar"), width(".tl-grid", 183, 183)],
  });
  add("panes/board-1180", "mesa", {
    place: { view: "board", zoom: "W" },
    sizes: "panes-1180",
    actions: [viewExpect("board"), width(".sidebar", 236, 236), width(".slot-panel", 360, 360), width(".main", 582, 582)],
  });
  add("panes/inspector-collapsed", "mesa", {
    sizes: "panes-1440",
    panes: { closed: ["outline", "inspector"] },
    actions: [viewExpect("timeline"), count(".slot-panel", 0), count(".inspector-resizer", 0), count(`${PANE_TOGGLE}[aria-expanded="false"]`, 1), edgeAt(".main", "right", "window"), oneLine(".toolbar")],
  });
  add("panes/inspector-reveal", "mesa", {
    sizes: "panes-1440",
    panes: { closed: ["inspector"] },
    actions: [
      viewExpect("timeline"),
      count(".slot-panel", 0),
      click(".tl-row .name", PICKED),
      count(".slot-panel", 1),
      expect(".slot-panel .detail .kind", "TASK"),
      edgeAt(".slot-panel", "right", "window"),
      click(".slot-panel .inspector-close"),
      count(".slot-panel", 0),
      count(".tl-row.selected", 1),
      edgeAt(".main", "right", "window"),
    ],
  });
  [
    ["Home", 300],
    ["End", 640],
  ].forEach(([keyName, size]) => {
    add(`panes/inspector-${keyName.toLowerCase()}`, "mesa", {
      sizes: "panes-1440",
      panes: OUTLINE_CLOSED,
      actions: [
        viewExpect("timeline"),
        focus(".inspector-resizer"),
        key(keyName, keyName),
        width(".slot-panel", size, size),
        expect(`.inspector-resizer[aria-valuenow="${size}"]`),
        edgeAt(".slot-panel", "right", "window"),
        expect(".sidebar"),
      ],
    });
  });
  add("panes/inspector-drawer", "mesa-ios-pad", {
    sizes: "ipad-11-portrait",
    dialog: true,
    actions: [viewExpect("timeline"), click(PANE_TOGGLE), still(), count("main.main[inert]", 1), edgeAt(".inspector-overlay", "right", "window"), meets(".inspector-overlay", "top", ".toolbar", "bottom"), width(".inspector-overlay", 360, 360), inWindow(".inspector-overlay")],
  });
  add("panes/inspector-drawer-85", "mesa-ios-pad", {
    sizes: "ipad-700",
    dialog: true,
    panes: { w: { inspector: 640 } },
    actions: [viewExpect("timeline"), click(PANE_TOGGLE), still(), edgeAt(".inspector-overlay", "right", "window"), width(".inspector-overlay", 595, 595)],
  });
  add("panes/list-edge", "mesa-ios-pad", {
    sizes: "ipad-portraits",
    dialog: true,
    actions: [
      viewExpect("timeline"),
      count(".app-body > .list-edge:first-child", 1),
      width(".list-edge", 20, 20),
      edgeAt(".list-edge", "left", 0),
      meets(".list-edge", "top", ".toolbar", "bottom"),
      style(".list-edge", "touch-action", "pan-y"),
      count(`${TOGGLE}[aria-expanded="false"]`, 1),
      swipe(".list-edge", 60, 6),
      still(),
      expect(`${OVERLAY} nav.sidebar`),
      count(`${TOGGLE}[aria-expanded="true"]`, 1),
      count("main.main[inert]", 1),
      count(".list-edge", 0),
      width(OVERLAY, 320, 320),
    ],
  });
  add("panes/list-edge-vertical", "mesa-ios-pad", {
    sizes: "ipad-11-portrait",
    actions: [viewExpect("timeline"), swipe(".list-edge", 10, 90), still(), count(".plan-overlay-layer", 0), count(`${TOGGLE}[aria-expanded="false"]`, 1), count(".list-edge", 1)],
  });
  add("panes/list-edge-column", "mesa-ios-pad", { sizes: "ipad-column", panes: OUTLINE_CLOSED, actions: [...fullShell, count(".list-edge", 0)] });
  add("panes/list-edge-landscape-yield", "mesa-ios-pad", {
    sizes: "ipad-owner-landscape",
    dialog: true,
    actions: [
      viewExpect("timeline"),
      count(".sidebar", 0),
      count(`${TOGGLE}[aria-expanded="false"]`, 1),
      count(".app-body > .list-edge:first-child", 1),
      width(".list-edge", 20, 20),
      swipe(".list-edge", 60, 6),
      still(),
      expect(`${OVERLAY} nav.sidebar`),
      count(".list-edge", 0),
    ],
  });
  add("panes/pad-dividers-44", "mesa-ios-pad", {
    sizes: "ipad-landscapes",
    panes: OUTLINE_CLOSED,
    actions: [
      ...fullShell,
      style('[data-pane-divider="list"]', "width", "44px", "::before"),
      style('[data-pane-divider="list"]', "left", "-22px", "::before"),
      style('[data-pane-divider="inspector"]', "width", "44px", "::before"),
      style('[data-pane-divider="inspector"]', "left", "-22px", "::before"),
      style('[data-pane-divider="list"]', "touch-action", "none"),
    ],
  });
  add("panes/pad-outline-divider-44", "mesa-ios-pad", {
    sizes: "ipad-11-landscape",
    actions: [viewExpect("timeline"), chart(480), style('[data-pane-divider="outline"]', "width", "44px", "::before")],
  });
  const OUTLINE_DIVIDER = '[data-pane-divider="outline"]';
  [
    ["Home", 160],
    ["End", 314],
  ].forEach(([keyName, size]) => {
    add(`panes/outline-${keyName.toLowerCase()}`, "mesa", {
      sizes: "panes-1440",
      actions: [
        viewExpect("timeline"),
        focus(OUTLINE_DIVIDER),
        key(keyName, keyName),
        width(".tl-grid", size, size),
        width(".tl-corner", size, size),
        expect(`${OUTLINE_DIVIDER}[aria-valuenow="${size}"]`),
        chart(480),
        expect(".sidebar"),
        width(".slot-panel", 360, 360),
        ...(size >= 220 ? [style(".tl-row .days", "display", "block"), style(".tl-corner .days", "display", "block"), style(".tl-row .dot", "display", "block")] : [shown(".tl-row .days", 0), shown(".tl-row .dot", 0)]),
        aligned(),
      ],
    });
  });
  add("panes/outline-200", "mesa", {
    sizes: "panes-1440",
    panes: { w: { outline: 200 } },
    actions: [viewExpect("timeline"), width(".tl-grid", 200, 200), shown(".tl-row .days", 0), shown(".tl-corner .days", 0), style(".tl-row .dot", "display", "block"), expect(".tl-row .name"), aligned()],
  });
  add("panes/outline-170", "mesa", {
    sizes: "panes-1440",
    panes: { w: { outline: 170 } },
    actions: [viewExpect("timeline"), width(".tl-grid", 170, 170), shown(".tl-row .days", 0), shown(".tl-corner .days", 0), shown(".tl-row .dot", 0), expect(".tl-row .name"), aligned()],
  });
  add("panes/outline-strip", "mesa", {
    sizes: "panes-1440",
    panes: OUTLINE_CLOSED,
    actions: [
      viewExpect("timeline"),
      count('.tl-frame[data-outline="collapsed"]', 1),
      count(OUTLINE_DIVIDER, 0),
      width(".outline-strip", 8, 8),
      shown(".tl-row", 0),
      expect(".bar-label.group-label"),
      chart(480),
      aligned(),
      click(".outline-strip"),
      count('.tl-frame[data-outline="open"]', 1),
      width(".tl-grid", 300, 300),
      count(".outline-strip", 0),
      count(".bar-label.group-label", 0),
      aligned(),
    ],
  });
  add("panes/outline-strip-over-edge", "mesa-ios-pad", {
    sizes: "ipad-portraits",
    panes: OUTLINE_CLOSED,
    actions: [viewExpect("timeline"), count(".list-edge", 1), count('.tl-frame[data-outline="collapsed"]', 1), uncovered(".outline-strip"), click(".outline-strip"), count('.tl-frame[data-outline="open"]', 1), count(".plan-overlay-layer", 0)],
  });
  add("panes/outline-phone", "mesa-ios-phone", {
    sizes: "phone",
    actions: [
      click('.phone-views [role="tab"]', "Timeline"),
      expect(".tl-canvas"),
      width(".tl-grid", 132, 132),
      width(".tl-corner", 132, 132),
      count(OUTLINE_DIVIDER, 0),
      width(".outline-collapse", 44, 44),
      style(".tl-row .dot", "display", "block"),
      aligned(),
      click(".outline-collapse"),
      width(".outline-strip", 8, 8),
      count(".outline-collapse", 0),
      count(OUTLINE_DIVIDER, 0),
      click(".outline-strip"),
      width(".tl-grid", 132, 132),
      count(OUTLINE_DIVIDER, 0),
    ],
  });
  add("close/dialog", "mesa", {
    dialog: true,
    actions: [click(HISTORY_ROW), click(".slot-panel .history button", "Revert"), expect('[role="dialog"] h3', "Revert this action"), width(".modal-close", 28, 28), style(".modal-close", "width", "24px", "::after"), style(".modal-close", "height", "24px", "::after"), corner(".modal-close", ".modal", "top-leading", 20)],
  });
  add("close/sheet-mac", "mesa", {
    sizes: "mac-compact",
    dialog: true,
    actions: [viewExpect("timeline"), click(".toolbar button", "Plans"), expect('.sheet[role="dialog"] .sheet-title', "Plans"), width(".sheet-close", 28, 28), style(".sheet-close", "width", "24px", "::after"), style(".sheet-close", "height", "24px", "::after"), corner(".sheet-close", ".sheet", "top-leading", 24)],
  });
  add("close/sheet-ios", "mesa-ios-phone", {
    sizes: "phone",
    dialog: true,
    actions: [
      click(".phone-head button", "Plans"),
      expect('.sheet[role="dialog"] .sheet-title', "Plans"),
      count(".sheet > .sheet-grabber:first-child", 1),
      width(".sheet-grabber", 36, 36),
      style(".sheet-grabber", "height", "5px"),
      within_(".sheet-grabber", ".sheet", 1),
      style(".sheet-head", "touch-action", "none"),
      corner(".sheet-close", ".sheet", "top-leading", 16),
      hitChrome("sheetHead"),
    ],
  });
  add("close/palette", "mesa", {
    dialog: true,
    actions: [key("k", "KeyK", 4), expect('.palette[role="dialog"] .palette-field input'), count(".palette-field > *", 2), count(".palette-field > .palette-close:last-child", 1), width(".palette-close", 28, 28), corner(".palette-close", ".palette-field", "top-trailing", 8)],
  });
  add("close/popover", "two-choices", {
    actions: [
      expect(".plan-head .chip-amber", "2 open choices · Choose…"),
      click(".plan-head .chip-button", "Choose…"),
      count('.plan-head .popover[role="dialog"]:not([aria-modal]) .choice-list li', 2),
      count(".plan-head .popover > .popover-close:last-child", 1),
      width(".popover-close", 20, 20),
      style(".popover-close", "width", "28px", "::before"),
      style(".popover-close", "height", "28px", "::before"),
      corner(".popover-close", ".popover", "top-trailing", 12),
    ],
  });
  add("close/drawer", "mesa-ios-pad", {
    sizes: "ipad-overlay-open",
    dialog: true,
    actions: [...overlayOpened, count(`${OVERLAY} > .drawer-head:first-child > .drawer-close`, 1), width(".drawer-close", 44, 44), corner(".drawer-close", OVERLAY, "top-leading", 16)],
  });
  add("revert-preview", "mesa", {
    dialog: true,
    actions: [click(HISTORY_ROW), click(".slot-panel .history button", "Revert"), expect('[role="dialog"] h3', "Revert this action"), expect(".revert-text p")],
  });

  const names = new Set();
  out.forEach((s) => {
    if (names.has(s.name)) throw new Error(`layout-probe: two states are named ${s.name}`);
    names.add(s.name);
    const last = s.actions[s.actions.length - 1];
    if (last === undefined || (last.expect === undefined && last.count === undefined && last.loaded === undefined && last.shown === undefined && last.width === undefined && last.style === undefined && last.valued === undefined && last.ellipsed === undefined && last.within === undefined && last.fitLabels === undefined && last.monthCut === undefined && last.centred === undefined && last.nearCentre === undefined && last.edgeAt === undefined && last.oneLine === undefined && last.spare === undefined && last.hit44 === undefined && last.fontMin === undefined && last.kept === undefined && last.meets === undefined && last.centredIn === undefined && last.corner === undefined && last.inWindow === undefined && last.uncovered === undefined && last.nativeMenu === undefined && last.aligned === undefined)) {
      throw new Error(`layout-probe: state ${s.name} does not end with an expect`);
    }
  });
  return out;
}

const namesOf = (vs) => vs.map(nameOf);
const SIZES = {
  desktop: namesOf(DESKTOP),
  dialog: namesOf([LANDSCAPE[0], ...PORTRAIT]),
  both: namesOf([...DESKTOP, LANDSCAPE[0]]),
  smallest: ["1180x760"],
  standard: ["1440x920"],
  widest: ["1920x1080"],
  "above-break-and-standard": namesOf([...BREAK_EDGE, ...ABOVE_BREAK, DESKTOP[1]]),
  "above-break-and-wide": namesOf([...BREAK_EDGE, ...ABOVE_BREAK, DESKTOP[1], DESKTOP[2]]),
  phone: namesOf(PHONE),
  portrait: namesOf(PORTRAIT),
  landscape: namesOf(LANDSCAPE),
  "ipad-pro": ["1366x1024"],
  narrow: namesOf(NARROW),
  "touch-wide": namesOf([...PORTRAIT, ...LANDSCAPE, ...NARROW]),
  timeline: namesOf([...DESKTOP, ...PORTRAIT, ...LANDSCAPE, ...NARROW]),
  "sheet-desk": namesOf(SHEET_DESK),
  "compact-all": namesOf([...PORTRAIT, ...SHEET_DESK]),
  "desktop-and-compact": namesOf([...DESKTOP, ...COMPACT_DESK]),
  "full-all": namesOf([...DESKTOP, ...BREAK_EDGE, ...ABOVE_BREAK, ...LANDSCAPE]),
  "full-480": namesOf([...DESKTOP.slice(1), ...BREAK_EDGE, ...ABOVE_BREAK, LANDSCAPE[1]]),
  "full-1180": namesOf([DESKTOP[0], LANDSCAPE[0]]),
  "ipad-11-portrait": namesOf([IPAD_11[0]]),
  "ipad-11-landscape": namesOf([IPAD_11[1]]),
  "phone-landscape": namesOf(PHONE_LANDSCAPE),
  "ipad-699": namesOf([IPAD_WINDOWS[1]]),
  "ipad-1179": namesOf([IPAD_WINDOWS[2]]),
  "ipad-overlay": namesOf([IPAD_WINDOWS[0], IPAD_11[0], IPAD_WINDOWS[2], IPAD_OWNER[0]]),
  "ipad-overlay-open": namesOf([IPAD_WINDOWS[0], IPAD_11[0], IPAD_OWNER[0]]),
  "ipad-column": namesOf([LANDSCAPE[0], IPAD_WINDOWS[3], IPAD_11[1], IPAD_OWNER[1]]),
  "ipad-portraits": namesOf([IPAD_11[0], IPAD_OWNER[0]]),
  "ipad-landscapes": namesOf([IPAD_11[1], IPAD_OWNER[1]]),
  "ipad-owner-landscape": namesOf([IPAD_OWNER[1]]),
  "ipad-all": namesOf([IPAD_WINDOWS[1], IPAD_WINDOWS[0], IPAD_11[0], IPAD_WINDOWS[2], LANDSCAPE[0], IPAD_WINDOWS[3], IPAD_11[1]]),
  "ipad-roomy-min": namesOf([IPAD_TIERS[4]]),
  "ipad-medium-min": namesOf([IPAD_TIERS[2]]),
  "ipad-narrow-min": namesOf([IPAD_TIERS[0]]),
  "ipad-roomy": namesOf([IPAD_TIERS[4], IPAD_WINDOWS[2]]),
  "ipad-medium": namesOf([IPAD_TIERS[2], IPAD_TIERS[3], IPAD_OWNER[0]]),
  "ipad-narrow": namesOf([IPAD_TIERS[0], IPAD_WINDOWS[1], IPAD_WINDOWS[0], IPAD_TIERS[1], IPAD_11[0]]),
  "mac-834": namesOf(MAC_834),
  "panes-1024": ["1024x700"],
  "panes-1100": ["1100x760"],
  "panes-1180": ["1180x760"],
  "panes-1280": ["1280x800"],
  "panes-1440": ["1440x920"],
  "ipad-700": namesOf([IPAD_WINDOWS[0]]),
  "mac-compact": namesOf([...PORTRAIT, ...SHEET_DESK]),
};

const sizesOf = (s) => {
  const sizes = SIZES[s.sizes];
  if (sizes === undefined) throw new Error(`layout-probe: state ${s.name} names no known sizes: ${s.sizes}`);
  return sizes;
};

const SHIM = String.raw`
(function () {
  var P = window.__PROBE__;
  Object.defineProperty(window, "__WEBBOARD_PLATFORM__", { value: Object.freeze(P.fixture.platform), enumerable: true });
  localStorage.clear();
  if (P.place !== null) localStorage.setItem("webboard.place", JSON.stringify(P.place));
  if (P.theme !== null) localStorage.setItem("webboard.theme", JSON.stringify(P.theme));
  if (P.panes !== null) localStorage.setItem("webboard.panes", JSON.stringify(P.panes));
  window.__PROBE_MISSING__ = [];
  window.__PROBE_TICKETS__ = {};
  window.__PROBE_MENUS__ = [];
  window.__PROBE_LISTENERS__ = {};
  var RealDate = Date;
  var pin = new RealDate(2026, 10, 9, 9, 0, 0, 0).getTime();
  var started = performance.now();
  function now() {
    return pin + Math.floor(performance.now() - started);
  }
  function PinnedDate() {
    if (new.target === undefined) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, arguments.length === 0 ? [now()] : Array.prototype.slice.call(arguments), new.target);
  }
  Object.setPrototypeOf(PinnedDate, RealDate);
  PinnedDate.prototype = RealDate.prototype;
  PinnedDate.now = now;
  window.Date = PinnedDate;
  function bytes(b64) {
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  var docs = {};
  Object.keys(P.fixture.docs).forEach(function (id) {
    docs[id] = bytes(P.fixture.docs[id]);
  });
  var newDoc = P.fixture.newDoc === null ? null : bytes(P.fixture.newDoc);
  var newDocServed = null;
  function isPlanId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id) && id.indexOf("ix-") !== 0;
  }
  var ipc = P.fixture.ipc;
  function missing(cmd, why) {
    window.__PROBE_MISSING__.push(cmd + ": " + why);
    return Promise.reject({ code: "probe.missing", message: "The layout probe has no answer for " + cmd + " (" + why + ")" });
  }
  function answer(cmd, args) {
    if (cmd === "plugin:event|listen") {
      var heard = window.__PROBE_LISTENERS__[args.event] || [];
      heard.push(args.handler);
      window.__PROBE_LISTENERS__[args.event] = heard;
    }
    if (cmd === "menu_show") window.__PROBE_MENUS__.push(JSON.parse(JSON.stringify(args.menu)));
    if (cmd === "sync_ticket") {
      var ticketDoc = String(args ? args.doc : undefined);
      var asked = (window.__PROBE_TICKETS__[ticketDoc] || 0) + 1;
      window.__PROBE_TICKETS__[ticketDoc] = asked;
      if (asked > 1) window.__PROBE_MISSING__.push("sync_ticket: ticket " + asked + " for " + ticketDoc + ", where a state asks for one per doc");
    }
    if (cmd === "store_load") {
      var doc = args && args.doc;
      if (doc in docs) return Promise.resolve(docs[doc].slice().buffer);
      if (newDoc === null || newDocServed !== null || !isPlanId(doc)) return missing(cmd, "doc " + doc);
      newDocServed = doc;
      return Promise.resolve(newDoc.slice().buffer);
    }
    if (!(cmd in ipc)) return missing(cmd, "no fixture");
    var a = ipc[cmd];
    if (a !== null && typeof a === "object" && typeof a.__bytes === "string") return Promise.resolve(bytes(a.__bytes).buffer);
    if (a !== null && typeof a === "object" && "__reject" in a) return Promise.reject(a.__reject);
    if (a !== null && typeof a === "object" && typeof a.__channel === "string") {
      var channel = args ? args[a.__channel] : undefined;
      if (channel === undefined || channel === null || typeof channel.id !== "number") return missing(cmd, "no channel in " + a.__channel);
      a.messages.forEach(function (m, i) {
        window["_" + channel.id]({ index: i, message: JSON.parse(JSON.stringify(m)) });
      });
      return new Promise(function () {});
    }
    if (a !== null && typeof a === "object" && !Array.isArray(a) && typeof a.__byArg === "string") {
      var k = String(args ? args[a.__byArg] : undefined);
      if (!(k in a.map)) return missing(cmd, a.__byArg + " " + k);
      var hit = a.map[k];
      if (hit !== null && typeof hit === "object" && "__reject" in hit) return Promise.reject(JSON.parse(JSON.stringify(hit.__reject)));
      return Promise.resolve(JSON.parse(JSON.stringify(hit)));
    }
    return Promise.resolve(JSON.parse(JSON.stringify(a)));
  }
  var SYNCED = [0, 1, 2, 0, 0];
  class ProbeSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.binaryType = "blob";
      if (P.net.ws === "none") {
        window.__PROBE_MISSING__.push("WebSocket: the state opened " + this.url + " but allows no socket");
        return;
      }
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }, 0);
    }
    send(data) {
      var b = new Uint8Array(data);
      if (P.net.ws !== "sync" || b[0] !== 0 || b[1] !== 0) return;
      setTimeout(() => {
        if (this.readyState === 1) this.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(SYNCED).buffer }));
      }, 0);
    }
    close(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent("close", { code: code === undefined ? 1000 : code, reason: "" }));
    }
  }
  [["CONNECTING", 0], ["OPEN", 1], ["CLOSING", 2], ["CLOSED", 3]].forEach(function (c) {
    ProbeSocket[c[0]] = c[1];
    ProbeSocket.prototype[c[0]] = c[1];
  });
  window.WebSocket = ProbeSocket;
  if (!P.net.online) Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: function () { return false; } });
  var nextId = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    plugins: {},
    transformCallback: function (cb) {
      var id = nextId++;
      window["_" + id] = cb;
      return id;
    },
    unregisterCallback: function (id) {
      delete window["_" + id];
    },
    invoke: function (cmd, args) {
      return answer(cmd, args);
    },
  };
})();
`;

const MEASURE = String.raw`
(function () {
  var EPS = 1;
  var P = window.__PROBE__;
  if (typeof P.dialog !== "boolean") throw new Error("__PROBE__ carries no dialog flag");
  var se = document.scrollingElement || document.documentElement;
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var wasTop = se.scrollTop;
  var wasLeft = se.scrollLeft;
  se.scrollTop = 0;
  se.scrollLeft = 0;

  function css(el, prop) {
    return el === null ? null : getComputedStyle(el).getPropertyValue(prop);
  }
  function sel(el) {
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    var cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += "." + cls.slice(0, 3).join(".");
    return s;
  }
  function path(el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) parts.unshift(sel(n));
    return parts.join(" > ");
  }
  function clips(el, axis) {
    var o = getComputedStyle(el)["overflow" + axis];
    return o === "auto" || o === "scroll" || o === "hidden" || o === "clip";
  }
  function scrolls(el, axis) {
    var o = getComputedStyle(el)["overflow" + axis];
    return o === "auto" || o === "scroll";
  }

  var all = Array.prototype.slice.call(document.querySelectorAll("*"));
  function scope() {
    return document.querySelector(".app");
  }
  var scopeFound = scope() !== null;

  function offenders() {
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "LINK") continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      var overBottom = r.bottom > vh + EPS;
      var overRight = r.right > vw + EPS;
      if (!overBottom && !overRight) continue;
      var held = false;
      for (var a = el.parentElement; a !== null; a = a.parentElement) {
        var ar = a.getBoundingClientRect();
        if (overBottom && clips(a, "Y") && ar.bottom <= vh + EPS) held = true;
        if (overRight && clips(a, "X") && ar.right <= vw + EPS) held = true;
        if (held) break;
      }
      if (!held) out.push({ el: el, rect: r, overBottom: overBottom, overRight: overRight });
    }
    var top = out.filter(function (o) {
      return !out.some(function (p) {
        return p.el !== o.el && p.el.contains(o.el);
      });
    });
    return top.slice(0, 12).map(function (o) {
      return {
        path: path(o.el),
        bottom: Math.round(o.rect.bottom),
        right: Math.round(o.rect.right),
        over: (o.overBottom ? "bottom " + Math.round(o.rect.bottom - vh) + "px" : "") +
          (o.overBottom && o.overRight ? " / " : "") +
          (o.overRight ? "right " + Math.round(o.rect.right - vw) + "px" : ""),
        position: getComputedStyle(o.el).position,
      };
    });
  }

  function tallest() {
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom < se.scrollHeight - 2) continue;
      var clippedBy = null;
      for (var a = el.parentElement; a !== null && a !== document.documentElement; a = a.parentElement) {
        if (clips(a, "Y") && a.getBoundingClientRect().bottom < r.bottom - 1) {
          clippedBy = sel(a);
          break;
        }
      }
      out.push({ path: path(el), bottom: Math.round(r.bottom), height: Math.round(r.height), position: getComputedStyle(el).position, clippedBy: clippedBy });
    }
    return out.filter(function (o) {
      return !out.some(function (p) {
        return p.path !== o.path && o.path.indexOf(p.path + " > ") === 0;
      });
    }).slice(0, 8);
  }

  function escapees() {
    var app = scope();
    if (app === null) return [];
    var out = [];
    var boxes = app.querySelectorAll("*");
    for (var i = 0; i < boxes.length; i++) {
      var el = boxes[i];
      var pos = getComputedStyle(el).position;
      if (pos !== "absolute") continue;
      var cb = null;
      for (var a = el.parentElement; a !== null && a !== document.documentElement; a = a.parentElement) {
        var s = getComputedStyle(a);
        var established = s.position !== "static" || s.transform !== "none" || s.perspective !== "none" ||
          s.filter !== "none" || s.willChange.indexOf("transform") !== -1 ||
          s.contain.indexOf("paint") !== -1 || s.contain.indexOf("layout") !== -1;
        if (established) { cb = a; break; }
      }
      if (cb !== null) continue;
      var r = el.getBoundingClientRect();
      out.push({ path: path(el), position: pos, bottom: Math.round(r.bottom), right: Math.round(r.right) });
    }
    var seen = {};
    var uniq = [];
    out.forEach(function (o) {
      var k = o.path.split(" > ").pop();
      if (seen[k] !== undefined) {
        seen[k].count += 1;
        seen[k].lowest = Math.max(seen[k].lowest, o.bottom);
        seen[k].furthest = Math.max(seen[k].furthest, o.right);
        return;
      }
      seen[k] = { path: o.path, position: o.position, count: 1, lowest: o.bottom, furthest: o.right };
      uniq.push(seen[k]);
    });
    return uniq;
  }

  function scrollableHidden() {
    var watch = [document.documentElement, document.body, document.getElementById("root"),
                 document.querySelector(".app"), document.querySelector(".app-body")];
    var out = [];
    for (var i = 0; i < watch.length; i++) {
      var el = watch[i];
      if (el === null) continue;
      var topWas = el.scrollTop, leftWas = el.scrollLeft;
      el.scrollTop = 9999; el.scrollLeft = 9999;
      var gotTop = el.scrollTop, gotLeft = el.scrollLeft;
      el.scrollTop = topWas; el.scrollLeft = leftWas;
      if (gotTop !== 0 || gotLeft !== 0) {
        out.push({ path: sel(el), scrollTop: Math.round(gotTop), scrollLeft: Math.round(gotLeft),
                   scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      }
    }
    return out;
  }

  function furthest(el, across) {
    var box = el.getBoundingClientRect();
    var best = null;
    var reach = across ? box.right : box.bottom;
    Array.prototype.forEach.call(el.querySelectorAll("*"), function (kid) {
      var r = kid.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      for (var a = kid.parentElement; a !== null && a !== el; a = a.parentElement) {
        if (clips(a, across ? "X" : "Y")) return;
      }
      var edge = across ? r.right : r.bottom;
      if (edge > reach + EPS && (best === null || edge > best.edge + EPS)) best = { path: path(kid), edge: Math.round(edge) };
    });
    return best;
  }

  function clipped() {
    var app = scope();
    if (app === null) return [];
    var out = [];
    var boxes = [app].concat(Array.prototype.slice.call(app.querySelectorAll("*")));
    for (var i = 0; i < boxes.length; i++) {
      var el = boxes[i];
      var s = getComputedStyle(el);
      var hidY = s.overflowY === "hidden" || s.overflowY === "clip";
      var hidX = s.overflowX === "hidden" || s.overflowX === "clip";
      if (!hidY && !hidX) continue;
      if (s.textOverflow === "ellipsis") continue;
      if (s.webkitLineClamp !== "none" && s.webkitLineClamp !== "") continue;
      if (el.clientHeight <= 1 && el.clientWidth <= 1) continue;
      var byY = hidY ? el.scrollHeight - el.clientHeight : 0;
      var byX = hidX ? el.scrollWidth - el.clientWidth : 0;
      if (byY <= EPS && byX <= EPS) continue;
      out.push({ path: path(el), byY: byY, byX: byX, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
                 scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, culprit: furthest(el, byX > EPS) });
    }
    return out.filter(function (o) {
      return !out.some(function (p) {
        return p.path !== o.path && o.path.indexOf(p.path) === 0;
      });
    }).slice(0, 12);
  }

  function rendered(el) {
    if (typeof el.checkVisibility === "function" &&
        !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) {
      return false;
    }
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function lastRendered(el) {
    for (var i = el.children.length - 1; i >= 0; i--) {
      var kid = el.children[i];
      if (!rendered(kid)) continue;
      return lastRendered(kid) || kid;
    }
    return null;
  }

  function panes() {
    var app = scope();
    if (app === null) return [];
    var out = [];
    var boxes = Array.prototype.slice.call(app.querySelectorAll("*"));
    for (var i = 0; i < boxes.length; i++) {
      var el = boxes[i];
      var overflows = (scrolls(el, "Y") && el.scrollHeight - el.clientHeight > EPS) ||
                      (scrolls(el, "X") && el.scrollWidth - el.clientWidth > EPS);
      if (!overflows) continue;
      var last = lastRendered(el);
      if (last === null) continue;
      var wasTop = el.scrollTop, wasLeft = el.scrollLeft;
      el.scrollTop = el.scrollHeight; el.scrollLeft = el.scrollWidth;
      var pr = el.getBoundingClientRect();
      var lr = last.getBoundingClientRect();
      var reached = lr.bottom <= pr.bottom + 4 && lr.right <= pr.right + 4;
      el.scrollTop = wasTop; el.scrollLeft = wasLeft;
      out.push({ path: sel(el), reached: reached, overflowBy: Math.round(el.scrollHeight - el.clientHeight),
                 last: path(last), lastPosition: getComputedStyle(last).position,
                 lastBottom: Math.round(lr.bottom), paneBottom: Math.round(pr.bottom),
                 shortBy: Math.round(Math.max(lr.bottom - pr.bottom, lr.right - pr.right)) });
    }
    return out;
  }

  var HUGE = 1e7;
  var inkOf = new Map();
  var rectOf = new Map();
  var extentOf = new Map();
  var flowKidsOf = new Map();

  function one(v) {
    return Math.round(v * 10) / 10;
  }
  function meet(a, b) {
    return { top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom),
             left: Math.max(a.left, b.left), right: Math.min(a.right, b.right) };
  }
  function real(r) {
    return r !== null && r.bottom - r.top > 0 && r.right - r.left > 0;
  }
  function scrollport(el) {
    var s = getComputedStyle(el);
    var cy = s.overflowY !== "visible";
    var cx = s.overflowX !== "visible";
    if (!cy && !cx) return null;
    var r = el.getBoundingClientRect();
    return {
      top: cy ? r.top + (parseFloat(s.borderTopWidth) || 0) : -HUGE,
      bottom: cy ? r.bottom - (parseFloat(s.borderBottomWidth) || 0) : HUGE,
      left: cx ? r.left + (parseFloat(s.borderLeftWidth) || 0) : -HUGE,
      right: cx ? r.right - (parseFloat(s.borderRightWidth) || 0) : HUGE,
    };
  }
  function boxKids(el) {
    var out = [];
    if (el instanceof SVGElement) return out;
    for (var i = 0; i < el.children.length; i++) {
      var kid = el.children[i];
      var display = getComputedStyle(kid).display;
      if (display === "none") continue;
      if (display === "contents") {
        out = out.concat(boxKids(kid));
        continue;
      }
      if (!rendered(kid)) continue;
      out.push(kid);
    }
    return out;
  }
  function solid(el) {
    return el.getClientRects().length === 1;
  }
  function outOfFlow(el) {
    var p = getComputedStyle(el).position;
    return p === "absolute" || p === "fixed" || p === "sticky";
  }
  function walk(el, clip) {
    var r = el.getBoundingClientRect();
    rectOf.set(el, r);
    var ink = r.width > 0 && r.height > 0 ? meet({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }, clip) : null;
    if (!real(ink)) ink = null;
    inkOf.set(el, ink);
    var port = scrollport(el);
    var inner = port === null ? clip : meet(clip, port);
    var kids = boxKids(el);
    var flow = [];
    var extent = ink;
    for (var i = 0; i < kids.length; i++) {
      walk(kids[i], inner);
      if (outOfFlow(kids[i])) continue;
      flow.push(kids[i]);
      var kx = extentOf.get(kids[i]);
      if (kx === null) continue;
      extent = extent === null ? kx : {
        top: Math.min(extent.top, kx.top), bottom: Math.max(extent.bottom, kx.bottom),
        left: Math.min(extent.left, kx.left), right: Math.max(extent.right, kx.right),
      };
    }
    flowKidsOf.set(el, flow);
    extentOf.set(el, extent);
  }
  function crosses(x, y) {
    if (x === null || y === null || x === undefined || y === undefined) return null;
    var oy = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
    var ox = Math.min(x.right, y.right) - Math.max(x.left, y.left);
    return oy > EPS && ox > EPS ? { y: oy, x: ox } : null;
  }
  function paintsOver(a, b) {
    var reach = crosses(extentOf.get(a), inkOf.get(b));
    if (reach === null) return null;
    var culprits = [];
    (function descend(el) {
      var hit = crosses(inkOf.get(el), inkOf.get(b));
      if (hit !== null && solid(el)) {
        culprits.push({ el: el, hit: hit });
        return;
      }
      var kids = flowKidsOf.get(el) || [];
      for (var i = 0; i < kids.length; i++) descend(kids[i]);
    })(a);
    if (culprits.length === 0) return null;
    var abox = rectOf.get(a);
    return {
      a: path(a), b: path(b), overY: one(reach.y), overX: one(reach.x),
      by: culprits.slice(0, 3).map(function (c) {
        var raw = rectOf.get(c.el);
        return { path: path(c.el), covers: one(c.hit.y), bottom: one(raw.bottom), spill: one(raw.bottom - abox.bottom) };
      }),
    };
  }
  function overpaints() {
    var out = [];
    flowKidsOf.forEach(function (kids, parent) {
      if (kids.length < 2) return;
      for (var i = 0; i < kids.length; i++) {
        for (var j = i + 1; j < kids.length; j++) {
          if (!solid(kids[i]) || !solid(kids[j])) continue;
          var hit = paintsOver(kids[i], kids[j]) || paintsOver(kids[j], kids[i]);
          if (hit === null) continue;
          out.push(Object.assign({ parent: path(parent) }, hit));
        }
      }
    });
    return out.slice(0, 12);
  }

  var POPUPS = ".overlay, .popover, .popover-scrim, .plan-menu-list, .plan-overlay-layer, .inspector-overlay-layer";
  var ON_TOP = [".tl-head", ".tl-corner", "table.list th", ".col-head"];
  function coveredUp() {
    var out = [];
    var targets = all.filter(function (el) {
      return getComputedStyle(el).position === "sticky" || ON_TOP.some(function (s) { return el.matches(s); });
    });
    for (var t = 0; t < targets.length; t++) {
      var el = targets[t];
      var ink = inkOf.get(el);
      if (ink === null || ink === undefined) continue;
      var x = (ink.left + ink.right) / 2;
      var y = (ink.top + ink.bottom) / 2;
      if (x < 0 || y < 0 || x > vw || y > vh) continue;
      var hits = document.elementsFromPoint(x, y);
      var front = hits.length > 0 ? hits[0] : null;
      if (front !== null && (front === el || el.contains(front))) continue;
      var solid = hits.filter(function (h) { return h.closest("[data-pane-divider]") === null; })[0];
      if (solid !== undefined && solid !== el && solid.closest(".tl-corner, .outline-strip") !== null && el.closest(".tl-scale") !== null) continue;
      var popup = front === null ? null : front.closest(POPUPS);
      if (popup !== null && !popup.contains(el)) continue;
      out.push({ path: path(el), at: one(x) + "," + one(y), on: front === null ? "nothing at all" : path(front),
                 stack: hits.slice(0, 4).map(sel) });
    }
    return out;
  }

  function lines(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var tops = [];
    Array.prototype.forEach.call(range.getClientRects(), function (r) {
      if (r.width < 1) return;
      var top = Math.round(r.top);
      if (tops.every(function (t) { return Math.abs(t - top) > 2; })) tops.push(top);
    });
    return tops.length;
  }
  function linesShown(el) {
    var bottom = el.getBoundingClientRect().bottom;
    var range = document.createRange();
    range.selectNodeContents(el);
    var tops = [];
    Array.prototype.forEach.call(range.getClientRects(), function (r) {
      if (r.width < 1 || r.bottom > bottom + 2) return;
      var top = Math.round(r.top);
      if (tops.every(function (t) { return Math.abs(t - top) > 2; })) tops.push(top);
    });
    return tops.length;
  }
  function ownText(el) {
    return Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; })
      .map(function (n) { return n.textContent; }).join("").trim();
  }
  function blockOf(el) {
    for (var n = el; n !== null; n = n.parentElement) {
      if (getComputedStyle(n).display !== "inline") return n;
    }
    return document.documentElement;
  }
  function names() {
    var long = P.clip;
    if (long.length === 0) return { checked: 0, faults: [], missing: [] };
    var shows = function (t) {
      return long.some(function (n) { return t === n || t === "◆ " + n; });
    };
    var hits = all.filter(function (el) {
      return rendered(el) && shows(ownText(el));
    });
    var faults = [];
    hits.forEach(function (el) {
      var n = lines(el);
      var es = getComputedStyle(el);
      var clamp = parseInt(es.webkitLineClamp, 10);
      if (clamp > 0) {
        var shown = linesShown(el);
        if (es.overflowY !== "hidden") faults.push(path(el) + " clamps to " + clamp + " lines but does not hide the rest");
        else if (shown > clamp) faults.push(path(el) + " shows " + shown + " lines of the name, over its clamp of " + clamp);
        return;
      }
      if (n > 1) {
        faults.push(path(el) + " wraps the name onto " + n + " lines");
        return;
      }
      var box = blockOf(el);
      if (box.scrollWidth <= box.clientWidth + EPS) return;
      var s = getComputedStyle(box);
      var cut = (s.overflowX === "hidden" || s.overflowX === "clip") && s.textOverflow === "ellipsis";
      if (!cut) faults.push(path(box) + " overflows by " + (box.scrollWidth - box.clientWidth) + "px without an ellipsis");
    });
    var missing = P.clipIn.filter(function (s) {
      return !hits.some(function (el) { return el.matches(s); });
    });
    return { checked: hits.length, faults: faults.slice(0, 12), missing: missing };
  }

  function inside(r, box) {
    return r.left >= box.left - EPS && r.right <= box.right + EPS;
  }
  function dialogs() {
    var found = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"]')).filter(rendered);
    if (found.length !== 1) return { count: found.length, faults: [] };
    var d = found[0];
    var box = d.getBoundingClientRect();
    var faults = [];
    if (box.left < -EPS || box.top < -EPS || box.right > vw + EPS || box.bottom > vh + EPS) {
      faults.push(path(d) + " lies outside the viewport (" + Math.round(box.left) + "," + Math.round(box.top) + " to " +
        Math.round(box.right) + "," + Math.round(box.bottom) + ")");
    }
    if (d.scrollWidth > d.clientWidth + EPS) faults.push(path(d) + " overflows horizontally by " + (d.scrollWidth - d.clientWidth) + "px");
    Array.prototype.forEach.call(d.querySelectorAll("*"), function (el) {
      if (!rendered(el) || el.scrollWidth <= el.clientWidth + EPS) return;
      var s = getComputedStyle(el);
      if (s.textOverflow === "ellipsis" || s.display === "inline") return;
      faults.push(path(el) + " overflows horizontally by " + (el.scrollWidth - el.clientWidth) + "px inside the dialog");
    });
    Array.prototype.forEach.call(d.querySelectorAll("button"), function (b) {
      if (!rendered(b)) return;
      var r = b.getBoundingClientRect();
      var scroller = d;
      for (var a = b.parentElement; a !== null && a !== d; a = a.parentElement) {
        if (scrolls(a, "Y")) { scroller = a; break; }
      }
      var sr = scroller.getBoundingClientRect();
      var top = sr.top - scroller.scrollTop;
      var bottom = top + Math.max(scroller.scrollHeight, sr.height);
      if (!inside(r, box) || r.top < top - EPS || r.bottom > bottom + EPS) {
        faults.push(path(b) + " (" + JSON.stringify(b.textContent.trim().slice(0, 30)) + ") lies outside the dialog's box");
      }
    });
    return { count: 1, box: { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom) }, faults: faults.slice(0, 12) };
  }

  function textLines(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var tops = [];
    for (var n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (n.textContent.trim() === "") continue;
      var range = document.createRange();
      range.selectNodeContents(n);
      Array.prototype.forEach.call(range.getClientRects(), function (r) {
        if (r.width < 1) return;
        var top = Math.round(r.top);
        if (tops.every(function (t) { return Math.abs(t - top) > 2; })) tops.push(top);
      });
    }
    return tops.length;
  }
  function toolbarControls() {
    var bar = document.querySelector(".toolbar");
    if (bar === null) return { found: false, controls: [], overlaps: [] };
    var picked = Array.prototype.slice.call(bar.querySelectorAll("button, .seg, .wordmark")).filter(rendered);
    var tops = picked.filter(function (el) {
      return !picked.some(function (other) { return other !== el && other.contains(el); });
    });
    var controls = tops.map(function (el) {
      var r = el.getBoundingClientRect();
      return { name: sel(el) + " " + JSON.stringify(el.textContent.trim().slice(0, 30)), lines: textLines(el), box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } };
    });
    var overlaps = [];
    for (var i = 0; i < controls.length; i++) {
      for (var j = i + 1; j < controls.length; j++) {
        var hit = crosses(controls[i].box, controls[j].box);
        if (hit !== null) overlaps.push({ a: controls[i].name, b: controls[j].name, x: one(hit.x), y: one(hit.y) });
      }
    }
    return {
      found: true,
      controls: controls.map(function (c) {
        return { name: c.name, lines: c.lines, left: one(c.box.left), right: one(c.box.right), top: one(c.box.top), bottom: one(c.box.bottom) };
      }),
      overlaps: overlaps,
    };
  }

  walk(document.documentElement, { top: -HUGE, bottom: HUGE, left: -HUGE, right: HUGE });
  var overpainting = overpaints();
  var coverings = coveredUp();

  function chain() {
    var list = ["html", "body", "#root", ".app", ".app-body", ".sidebar", ".main", ".plan-head", ".view", ".slot",
                ".tl-scroll", ".nnl", ".list-wrap", ".tray", ".slot-panel", ".panel", '[role="dialog"]'];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i] === "html" ? document.documentElement : list[i] === "body" ? document.body : document.querySelector(list[i]);
      if (el === null) continue;
      var s = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      out.push({ name: list[i], client: el.clientHeight, scroll: el.scrollHeight, top: one(r.top), bottom: one(r.bottom), left: one(r.left), right: one(r.right),
                 css: s.height + " min " + s.minHeight + " w " + s.width + " minw " + s.minWidth + " flex " + s.flex + " overflow " + s.overflow + " display " + s.display });
    }
    return out;
  }

  var root = document.getElementById("root");
  var app = document.querySelector(".app");
  return {
    chain: chain(),
    form: document.documentElement.getAttribute("data-form"),
    stamp: { os: document.documentElement.getAttribute("data-os"), idiom: document.documentElement.getAttribute("data-idiom"), want: P.fixture.platform },
    scope: { name: ".app", found: scopeFound },
    fonts: P.fonts.map(function (f) {
      var faces = [];
      document.fonts.forEach(function (face) {
        if (face.family.replace(/^["']|["']$/g, "") === f[0]) faces.push(face.status);
      });
      return { family: f[0], faces: faces.length, loaded: faces.indexOf("loaded") !== -1 && document.fonts.check(f[1]) };
    }),
    doc: { scrollHeight: se.scrollHeight, innerHeight: vh, scrollWidth: se.scrollWidth, innerWidth: vw,
           overY: se.scrollHeight - vh, overX: se.scrollWidth - vw,
           alreadyScrolledTo: { top: Math.round(wasTop), left: Math.round(wasLeft) } },
    overflow: {
      html: css(document.documentElement, "overflow"),
      body: css(document.body, "overflow"),
      "#root": root === null ? null : css(root, "overflow"),
      ".app": app === null ? null : css(app, "overflow"),
    },
    offenders: offenders(),
    escapees: escapees(),
    tallest: se.scrollHeight > vh + EPS ? tallest() : [],
    scrollableHidden: scrollableHidden(),
    clipped: clipped(),
    panes: panes(),
    overpaints: overpainting,
    covered: coverings,
    toolbar: toolbarControls(),
    names: names(),
    dialogs: dialogs(),
    text: (app === null ? "" : app.textContent.trim()).length,
    missing: window.__PROBE_MISSING__.slice(),
    tickets: Object.assign({}, window.__PROBE_TICKETS__),
  };
})()
`;

export const ACT = String.raw`
window.__probeAct = function (a) {
  function matching(selector, text) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    if (text === undefined) return { nodes: nodes, hit: nodes[0] };
    return { nodes: nodes, hit: nodes.filter(function (n) { return n.textContent.trim() === text; })[0] };
  }
  function missed(selector, text, nodes) {
    return "no " + selector + (text === undefined ? "" : " reading " + JSON.stringify(text)) +
      " (have: " + nodes.slice(0, 6).map(function (n) { return JSON.stringify(n.textContent.trim().slice(0, 40)); }).join(" | ") + ")";
  }
  if (a.click !== undefined) {
    var c = matching(a.click[0], a.click[1]);
    if (c.hit === undefined) return { fail: missed(a.click[0], a.click[1], c.nodes) };
    c.hit.click();
    return { ok: true };
  }
  if (a.tap !== undefined) {
    var t = matching(a.tap[0], a.tap[1]);
    if (t.hit === undefined) return { fail: missed(a.tap[0], a.tap[1], t.nodes) };
    t.hit.scrollIntoView({ block: "nearest", inline: "nearest" });
    var r = t.hit.getBoundingClientRect();
    var x = Math.min(r.left + 6, r.right - 1);
    var y = (r.top + r.bottom) / 2;
    var front = document.elementFromPoint(x, y);
    if (front === null || !(front === t.hit || t.hit.contains(front))) {
      return { fail: a.tap[0] + " " + JSON.stringify(a.tap[1]) + " is covered at " + Math.round(x) + "," + Math.round(y) +
        " by " + (front === null ? "nothing" : front.tagName.toLowerCase() + "." + String(front.className)) };
    }
    return { at: [x, y] };
  }
  if (a.doubleClick !== undefined || a.doubleTap !== undefined) {
    var dd = a.doubleClick !== undefined ? a.doubleClick : a.doubleTap;
    var dm = matching(dd[0], dd[1] === null ? undefined : dd[1]);
    if (dm.hit === undefined) return { fail: missed(dd[0], dd[1] === null ? undefined : dd[1], dm.nodes) };
    dm.hit.scrollIntoView({ block: "nearest", inline: "nearest" });
    var dr = dm.hit.getBoundingClientRect();
    var ddx = Math.min(dr.left + 6, dr.right - 1);
    var ddy = (dr.top + dr.bottom) / 2;
    var dfront = document.elementFromPoint(ddx, ddy);
    if (dfront === null || !(dfront === dm.hit || dm.hit.contains(dfront))) {
      return { fail: dd[0] + " " + JSON.stringify(dd[1]) + " is covered at " + Math.round(ddx) + "," + Math.round(ddy) +
        " by " + (dfront === null ? "nothing" : dfront.tagName.toLowerCase() + "." + String(dfront.className)) };
    }
    return a.doubleClick !== undefined ? { doubleClick: [ddx, ddy, dd[2]] } : { doubleTap: [ddx, ddy] };
  }
  if (a.swipe !== undefined) {
    var sw = matching(a.swipe[0]);
    if (sw.hit === undefined) return { fail: missed(a.swipe[0], undefined, sw.nodes) };
    var sr = sw.hit.getBoundingClientRect();
    var sx = sr.left + Math.min(6, sr.width / 2);
    var sy = (sr.top + sr.bottom) / 2;
    var sfront = document.elementFromPoint(sx, sy);
    if (sfront !== sw.hit) {
      return { fail: a.swipe[0] + " is covered at " + Math.round(sx) + "," + Math.round(sy) + " by " + (sfront === null ? "nothing" : sfront.tagName.toLowerCase() + "." + String(sfront.className)) };
    }
    return { swipe: [sx, sy, a.swipe[1], a.swipe[2]] };
  }
  if (a.reveal !== undefined) {
    var v = matching(a.reveal[0], a.reveal[1]);
    if (v.hit === undefined) return { fail: missed(a.reveal[0], a.reveal[1], v.nodes) };
    v.hit.scrollIntoView({ block: "start" });
    return { ok: true };
  }
  if (a.raise !== undefined) {
    window.dispatchEvent(new ErrorEvent("error", { error: new Error(a.raise), message: "Uncaught Error: " + a.raise }));
    return { ok: true };
  }
  if (a.hit44 !== undefined) {
    var HIT_MIN = 44;
    function nameOf(node) {
      var tag = node.tagName.toLowerCase();
      if (node.classList.length > 0) return tag + "." + node.classList[0];
      if (node.id !== "") return tag + "#" + node.id;
      return tag;
    }
    function sameBox(p, q) {
      return p.left === q.left && p.top === q.top && p.right === q.right && p.bottom === q.bottom;
    }
    function clippedByAncestors(box, el) {
      var out = { box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, by: null };
      for (var up = el.parentElement; up !== null && up !== document.body && up !== document.documentElement; up = up.parentElement) {
        var next = clipped(out.box, up);
        if (out.by === null && !sameBox(next, out.box)) out.by = up;
        out.box = next;
      }
      return out;
    }
    function translationOf(s, what) {
      var bad = null;
      var shift = { tx: 0, ty: 0 };
      if (s.transform !== "none") {
        var m = /^matrix\(([^)]*)\)$/.exec(s.transform);
        if (m === null) {
          bad = s.transform;
        } else {
          var n = m[1].split(",").map(function (part) { return parseFloat(part); });
          if (n.length !== 6 || !n.every(isFinite)) throw new Error("hit44: " + what + " has a transform that cannot be read: " + s.transform);
          if (n[0] === 1 && n[1] === 0 && n[2] === 0 && n[3] === 1) shift = { tx: n[4], ty: n[5] };
          else bad = s.transform;
        }
      }
      if (bad === null && s.scale !== "none") bad = "scale: " + s.scale;
      if (bad === null && s.rotate !== "none") bad = "rotate: " + s.rotate;
      if (bad === null && s.zoom !== undefined && s.zoom !== "1" && s.zoom !== "normal") bad = "zoom: " + s.zoom;
      return bad === null ? shift : { bad: bad };
    }
    function requireTranslationChain(el) {
      for (var node = el; node !== null; node = node.parentElement) {
        var t = translationOf(getComputedStyle(node), nameOf(node));
        if (t.bad !== undefined) throw new Error("hit44: " + nameOf(node) + " has a transform (" + t.bad + ") that changes the size of " + el.tagName.toLowerCase() + "'s pseudo-elements; their computed boxes do not show it");
        if (node === document.documentElement) return;
      }
    }
    var targets = [];
    var unmatched = [];
    a.hit44.forEach(function (selector) {
      var found = Array.prototype.slice.call(document.querySelectorAll(selector)).filter(function (el) {
        return el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible";
      }).map(function (el) {
        var raw = el.getBoundingClientRect();
        var c = clippedByAncestors(raw, el);
        return { el: el, raw: raw, box: c.box, by: c.by };
      }).filter(function (t) {
        return t.by === null || (t.box.right > t.box.left && t.box.bottom > t.box.top);
      });
      if (found.length === 0) unmatched.push(selector);
      found.forEach(function (t) {
        targets.push({ selector: selector, el: t.el, raw: t.raw, box: t.box, by: t.by });
      });
    });
    if (unmatched.length > 0) return { fail: "no visible element matches " + unmatched.join(", ") + ", so no hit area was measured" };
    function paddingBox(node) {
      var r = node.getBoundingClientRect();
      var s = getComputedStyle(node);
      return {
        left: r.left + parseFloat(s.borderLeftWidth),
        top: r.top + parseFloat(s.borderTopWidth),
        right: r.right - parseFloat(s.borderRightWidth),
        bottom: r.bottom - parseFloat(s.borderBottomWidth),
      };
    }
    function clips(node) {
      var s = getComputedStyle(node);
      return { x: s.overflowX !== "visible", y: s.overflowY !== "visible" };
    }
    function clipped(box, node) {
      var c = clips(node);
      if (!c.x && !c.y) return box;
      var p = paddingBox(node);
      return {
        left: c.x ? Math.max(box.left, p.left) : box.left,
        top: c.y ? Math.max(box.top, p.top) : box.top,
        right: c.x ? Math.min(box.right, p.right) : box.right,
        bottom: c.y ? Math.min(box.bottom, p.bottom) : box.bottom,
      };
    }
    function candidates(t) {
      var el = t.el;
      var box = t.box;
      var list = [box];
      var own = getComputedStyle(el);
      if (own.position === "static") return list;
      var originX = t.raw.left + parseFloat(own.borderLeftWidth);
      var originY = t.raw.top + parseFloat(own.borderTopWidth);
      var chainChecked = false;
      ["::before", "::after"].forEach(function (which) {
        var ps = getComputedStyle(el, which);
        if (ps.content === "none" || ps.content === "normal" || ps.display === "none" || ps.position !== "absolute" || ps.pointerEvents === "none" || ps.visibility !== "visible") return;
        var tag = el.tagName.toLowerCase();
        var shift = translationOf(ps, which + " of " + tag);
        if (shift.bad !== undefined) throw new Error("hit44: " + which + " of " + tag + " has a transform (" + shift.bad + "), which its computed box does not show");
        if (!chainChecked) {
          requireTranslationChain(el);
          chainChecked = true;
        }
        var outer = ps.boxSizing === "border-box" ? 0 : parseFloat(ps.paddingLeft) + parseFloat(ps.paddingRight) + parseFloat(ps.borderLeftWidth) + parseFloat(ps.borderRightWidth);
        var outerY = ps.boxSizing === "border-box" ? 0 : parseFloat(ps.paddingTop) + parseFloat(ps.paddingBottom) + parseFloat(ps.borderTopWidth) + parseFloat(ps.borderBottomWidth);
        var left = originX + parseFloat(ps.left) + parseFloat(ps.marginLeft) + shift.tx;
        var top = originY + parseFloat(ps.top) + parseFloat(ps.marginTop) + shift.ty;
        var w = parseFloat(ps.width) + outer;
        var h = parseFloat(ps.height) + outerY;
        if (![left, top, w, h].every(isFinite)) throw new Error("hit44: " + which + " of " + tag + " has no resolved box: left " + ps.left + " top " + ps.top + " width " + ps.width + " height " + ps.height);
        var pb = clippedByAncestors(clipped({ left: left, top: top, right: left + w, bottom: top + h }, el), el).box;
        if (pb.right <= pb.left || pb.bottom <= pb.top) return;
        if (pb.left > box.right || pb.right < box.left || pb.top > box.bottom || pb.bottom < box.top) return;
        list.push(pb);
      });
      return list;
    }
    function measure(r) {
      return { w: Math.round((r.right - r.left) * 10) / 10, h: Math.round((r.bottom - r.top) * 10) / 10 };
    }
    function fits(s) {
      return s.w >= HIT_MIN - 0.01 && s.h >= HIT_MIN - 0.01;
    }
    function labelOf(t) {
      var label = t.el.textContent.trim() || t.el.getAttribute("aria-label") || "";
      return t.selector + " " + JSON.stringify(label.slice(0, 40));
    }
    function listed(items, line) {
      return items.slice(0, 6).map(line).join("; ") + (items.length > 6 ? "; and " + (items.length - 6) + " more" : "");
    }
    var chosen = targets.map(function (t) {
      var boxes = candidates(t);
      var passing = boxes.filter(function (r) { return fits(measure(r)); })[0];
      var best = boxes.reduce(function (p, q) {
        var mp = measure(p);
        var mq = measure(q);
        return mq.w * mq.h > mp.w * mp.h ? q : p;
      });
      var area = boxes.reduce(function (p, q) {
        return { left: Math.min(p.left, q.left), top: Math.min(p.top, q.top), right: Math.max(p.right, q.right), bottom: Math.max(p.bottom, q.bottom) };
      });
      return { t: t, rect: passing === undefined ? best : passing, area: area, fits: passing !== undefined };
    });
    var small = chosen.filter(function (c) { return !c.fits; }).map(function (c) {
      var m = measure(c.rect);
      return { t: c.t, w: m.w, h: m.h };
    });
    if (small.length > 0) {
      return { fail: listed(small, function (m) {
        var note = m.t.by === null ? "" : " (clipped by " + nameOf(m.t.by) + ")";
        return labelOf(m.t) + " has a hit area of " + m.w + "x" + m.h + " px, under " + HIT_MIN + "x" + HIT_MIN + note;
      }) };
    }
    var overlaps = [];
    chosen.forEach(function (p, i) {
      chosen.slice(i + 1).forEach(function (q) {
        if (p.t.el.contains(q.t.el) || q.t.el.contains(p.t.el)) return;
        var ox = Math.min(p.area.right, q.area.right) - Math.max(p.area.left, q.area.left);
        var oy = Math.min(p.area.bottom, q.area.bottom) - Math.max(p.area.top, q.area.top);
        if (ox > 0.5 && oy > 0.5) overlaps.push({ p: p.t, q: q.t, w: Math.round(ox * 10) / 10, h: Math.round(oy * 10) / 10 });
      });
    });
    if (overlaps.length > 0) {
      return { fail: listed(overlaps, function (o) {
        return labelOf(o.p) + " and " + labelOf(o.q) + " have hit areas that overlap by " + o.w + "x" + o.h + " px";
      }) };
    }
    return { ok: true };
  }
  function lastMenu() {
    var sent = window.__PROBE_MENUS__;
    return sent.length === 0 ? null : sent[sent.length - 1];
  }
  function menuLines(menu) {
    var out = [];
    menu.sections.forEach(function (s) {
      if (s.title !== null) out.push("group " + s.title);
      s.rows.forEach(function (r) {
        out.push(r.checked ? r.title + " ✓" : r.title);
      });
    });
    return out;
  }
  if (a.nativeMenu !== undefined) {
    var nm = lastMenu();
    if (nm === null) return { fail: "no menu_show was sent, so no native menu asked for " + JSON.stringify(a.nativeMenu) };
    var nmLines = menuLines(nm);
    if (a.byWidth !== undefined) {
      var nmWant = a.byWidth.filter(function (e) { return window.innerWidth >= e[0]; }).map(function (e) { return e[1]; }).pop();
      if (nmWant === undefined) return { fail: "no expected native menu for the width " + window.innerWidth };
      if (JSON.stringify(nmLines) !== JSON.stringify(nmWant)) return { fail: "menu_show sent " + JSON.stringify(nmLines) + " at width " + window.innerWidth + ", not exactly " + JSON.stringify(nmWant) };
    }
    var nmAt = 0;
    var nmMissing = a.nativeMenu.filter(function (want) {
      var at = nmLines.indexOf(want, nmAt);
      if (at < 0) return true;
      nmAt = at + 1;
      return false;
    });
    if (nmMissing.length > 0) return { fail: "menu_show sent " + JSON.stringify(nmLines) + ", without " + JSON.stringify(nmMissing) + " in order" };
    var nmLists = document.querySelectorAll(".plan-menu-list").length;
    if (nmLists > 0) return { fail: "a native menu was asked for, but the page also renders " + nmLists + " HTML .plan-menu-list" };
    var an = nm.anchor;
    if (!(an.width > 0 && an.height > 0 && an.x >= -0.5 && an.y >= -0.5 && an.x + an.width <= window.innerWidth + 0.5 && an.y + an.height <= window.innerHeight + 0.5)) {
      return { fail: "the native menu's anchor " + JSON.stringify(an) + " is not a box inside the " + window.innerWidth + "x" + window.innerHeight + " window" };
    }
    return { ok: true };
  }
  if (a.choose !== undefined) {
    var cm = lastMenu();
    if (cm === null) return { fail: "no menu_show was sent to choose " + JSON.stringify(a.choose) + " from" };
    var cmRow = cm.sections.reduce(function (found, s) {
      return found !== null ? found : s.rows.filter(function (r) { return r.title === a.choose; })[0] || null;
    }, null);
    if (cmRow === null) return { fail: "the native menu has no row " + JSON.stringify(a.choose) + " (has " + JSON.stringify(menuLines(cm)) + ")" };
    var cmHeard = window.__PROBE_LISTENERS__;
    if (!cmHeard["menu-ended"] || !cmHeard["menu-chosen"]) return { fail: "the page listens to no menu-ended or menu-chosen event" };
    [["menu-ended", { token: cm.token }], ["menu-chosen", { token: cm.token, id: cmRow.id }]].forEach(function (ev) {
      cmHeard[ev[0]].forEach(function (handler) {
        window["_" + handler]({ event: ev[0], id: 0, payload: ev[1] });
      });
    });
    return { ok: true };
  }
  if (a.expect !== undefined) {
    var e = matching(a.expect[0], a.expect[1]);
    if (e.hit === undefined) return { fail: missed(a.expect[0], a.expect[1], e.nodes) };
    return { ok: true };
  }
  if (a.none !== undefined) {
    var z = matching(a.none[0], a.none[1]);
    if (z.hit !== undefined) return { fail: a.none[0] + " " + JSON.stringify(a.none[1]) + " is there and should not be" };
    return { ok: true };
  }
  if (a.count !== undefined) {
    var n = document.querySelectorAll(a.count[0]).length;
    if (n !== a.count[1]) return { fail: a.count[0] + " matches " + n + " elements, not " + a.count[1] };
    return { ok: true };
  }
  function onScreen(el) {
    var r = el.getBoundingClientRect();
    return (r.width > 0 || r.height > 0) && getComputedStyle(el).visibility !== "hidden";
  }
  if (a.shown !== undefined) {
    var seen = Array.prototype.slice.call(document.querySelectorAll(a.shown[0])).filter(onScreen).length;
    if (seen !== a.shown[1]) return { fail: a.shown[0] + " shows " + seen + " elements on screen, not " + a.shown[1] };
    return { ok: true };
  }
  if (a.chart !== undefined) {
    var chartScroll = document.querySelector(".tl-scroll");
    var chartGrid = document.querySelector(".tl-grid");
    if (chartScroll === null || chartGrid === null) return { fail: "no .tl-scroll and .tl-grid to measure the chart between" };
    var chartW = chartScroll.getBoundingClientRect().width - chartGrid.getBoundingClientRect().width;
    if (chartW < a.chart - 0.5) return { fail: "the chart beside the outline is " + Math.round(chartW * 10) / 10 + " px wide, under " + a.chart };
    return { ok: true };
  }
  if (a.aligned !== undefined) {
    var alRows = Array.prototype.slice.call(document.querySelectorAll(".tl-row[data-row]"));
    var alLines = Array.prototype.slice.call(document.querySelectorAll(".tl-rowline"));
    if (alRows.length === 0) return { fail: "no .tl-row to align with the chart" };
    if (alRows.length !== alLines.length) return { fail: alRows.length + " .tl-row against " + alLines.length + " .tl-rowline" };
    var alChecked = 0;
    for (var ai = 0; ai < alRows.length; ai++) {
      var alId = alRows[ai].getAttribute("data-row");
      var alRow = alRows[ai].getBoundingClientRect();
      var alLine = alLines[ai].getBoundingClientRect();
      if (Math.abs(alRow.top - alLine.top) > 0.5) return { fail: "row " + alId + " has its top at " + Math.round(alRow.top * 10) / 10 + " px, its chart row at " + Math.round(alLine.top * 10) / 10 + " px" };
      var alMarks = Array.prototype.slice.call(document.querySelectorAll('[data-bar="' + alId + '"], [data-gbar="' + alId + '"], [data-group-label="' + alId + '"]'));
      for (var am = 0; am < alMarks.length; am++) {
        var alBox = alMarks[am].getBoundingClientRect();
        if (alBox.top < alLine.top - 0.5 || alBox.bottom > alLine.bottom + 0.5) {
          var alWhat = alMarks[am].hasAttribute("data-bar") ? "bar" : alMarks[am].hasAttribute("data-gbar") ? "group bar" : "group label";
          return { fail: "the " + alWhat + " of row " + alId + " spans " + Math.round(alBox.top * 10) / 10 + ".." + Math.round(alBox.bottom * 10) / 10 + " px, outside its chart row " + Math.round(alLine.top * 10) / 10 + ".." + Math.round(alLine.bottom * 10) / 10 };
        }
      }
      if (alMarks.length > 0) alChecked++;
    }
    if (alChecked === 0) return { fail: "none of the " + alRows.length + " rows has a bar to align" };
    return { ok: true };
  }
  if (a.width !== undefined) {
    var wide = Array.prototype.slice.call(document.querySelectorAll(a.width[0])).filter(onScreen)[0];
    if (wide === undefined) return { fail: "no " + a.width[0] + " on screen to measure" };
    var ww = wide.getBoundingClientRect().width;
    if (ww < a.width[1] - 0.5 || ww > a.width[2] + 0.5) return { fail: a.width[0] + " is " + Math.round(ww * 10) / 10 + " px wide, not " + a.width[1] + ".." + a.width[2] };
    return { ok: true };
  }
  if (a.heightShare !== undefined) {
    var tall = Array.prototype.slice.call(document.querySelectorAll(a.heightShare[0])).filter(onScreen)[0];
    if (tall === undefined) return { fail: "no " + a.heightShare[0] + " on screen to measure" };
    var share = (tall.getBoundingClientRect().height / window.innerHeight) * 100;
    if (share < a.heightShare[1] || share > a.heightShare[2]) return { fail: a.heightShare[0] + " is " + Math.round(share * 10) / 10 + " % of the window's height, not " + a.heightShare[1] + ".." + a.heightShare[2] + " %" };
    return { ok: true };
  }
  if (a.focus !== undefined) {
    var focused = document.querySelector(a.focus);
    if (!(focused instanceof HTMLElement)) return { fail: "no " + a.focus + " to focus" };
    focused.focus();
    if (document.activeElement !== focused) return { fail: a.focus + " did not take focus" };
    return { ok: true };
  }
  if (a.edgeAt !== undefined) {
    var edged = Array.prototype.slice.call(document.querySelectorAll(a.edgeAt[0])).filter(onScreen)[0];
    if (edged === undefined) return { fail: "no " + a.edgeAt[0] + " on screen to measure" };
    var edgeWant = a.edgeAt[2] === "window" ? window.innerWidth : a.edgeAt[2];
    var edgeGot = edged.getBoundingClientRect()[a.edgeAt[1]];
    if (typeof edgeGot !== "number") return { fail: "a box has no " + a.edgeAt[1] + " edge" };
    if (Math.abs(edgeGot - edgeWant) > 0.5) return { fail: a.edgeAt[0] + " has its " + a.edgeAt[1] + " edge at " + Math.round(edgeGot * 10) / 10 + " px, not " + edgeWant };
    return { ok: true };
  }
  function firstShown(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector)).filter(onScreen)[0];
  }
  function boxOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  function tenth(n) {
    return Math.round(n * 10) / 10;
  }
  if (a.still !== undefined) {
    var ending = document.getAnimations().filter(function (an) { return an.effect === null || an.effect.getComputedTiming().iterations !== Infinity; });
    return Promise.all(ending.map(function (an) { return an.finished.catch(function () { return null; }); })).then(function () {
      return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r({ ok: true }); }); }); });
    });
  }
  if (a.keep !== undefined) {
    var keepEl = firstShown(a.keep);
    if (keepEl === undefined) return { fail: "no " + a.keep + " on screen to keep" };
    window.__probeKept = window.__probeKept || {};
    window.__probeKept[a.keep] = boxOf(keepEl);
    return { ok: true };
  }
  if (a.kept !== undefined) {
    var keptWas = (window.__probeKept || {})[a.kept];
    if (keptWas === undefined) return { fail: a.kept + " was never kept" };
    var keptEl = firstShown(a.kept);
    if (keptEl === undefined) return { fail: "no " + a.kept + " on screen to compare" };
    var keptNow = boxOf(keptEl);
    var keptMoved = ["left", "top", "right", "bottom"].filter(function (k) { return Math.abs(keptNow[k] - keptWas[k]) > 0.5; });
    if (keptMoved.length > 0) return { fail: a.kept + " moved: " + keptMoved.map(function (k) { return k + " " + tenth(keptWas[k]) + " -> " + tenth(keptNow[k]); }).join(", ") };
    return { ok: true };
  }
  if (a.meets !== undefined) {
    var meetA = firstShown(a.meets[0]);
    var meetB = firstShown(a.meets[2]);
    if (meetA === undefined || meetB === undefined) return { fail: "no " + (meetA === undefined ? a.meets[0] : a.meets[2]) + " on screen to measure" };
    var meetGot = meetA.getBoundingClientRect()[a.meets[1]];
    var meetWant = meetB.getBoundingClientRect()[a.meets[3]];
    if (Math.abs(meetGot - meetWant) > 0.5) return { fail: a.meets[0] + " has its " + a.meets[1] + " edge at " + tenth(meetGot) + " px, not at " + a.meets[2] + "'s " + a.meets[3] + " edge, " + tenth(meetWant) + " px" };
    return { ok: true };
  }
  if (a.corner !== undefined) {
    var kEl = firstShown(a.corner[0]);
    if (kEl === undefined) return { fail: "no " + a.corner[0] + " on screen to measure" };
    var kHolder = kEl.closest(a.corner[1]);
    if (kHolder === null) return { fail: a.corner[0] + " is not inside a " + a.corner[1] };
    if (a.corner[2] !== "top-leading" && a.corner[2] !== "top-trailing") throw new Error("corner: no corner " + a.corner[2]);
    var kr = boxOf(kEl);
    var kb = boxOf(kHolder);
    if (kr.left < kb.left - 0.5 || kr.top < kb.top - 0.5 || kr.right > kb.right + 0.5 || kr.bottom > kb.bottom + 0.5) return { fail: a.corner[0] + " runs out of its " + a.corner[1] };
    var kLeading = a.corner[2] === "top-leading";
    var kSide = kLeading ? kr.left - kb.left : kb.right - kr.right;
    var kTop = kr.top - kb.top;
    if (kSide > a.corner[3] + 0.5 || kTop > a.corner[3] + 0.5) return { fail: a.corner[0] + " sits " + tenth(kSide) + " px from the " + (kLeading ? "leading" : "trailing") + " side and " + tenth(kTop) + " px from the top of its " + a.corner[1] + ", more than " + a.corner[3] };
    return { ok: true };
  }
  if (a.centredIn !== undefined) {
    var cEl = firstShown(a.centredIn);
    if (cEl === undefined) return { fail: "no " + a.centredIn + " on screen to measure" };
    var cb = boxOf(cEl);
    var offX = (cb.left + cb.right) / 2 - window.innerWidth / 2;
    var offY = (cb.top + cb.bottom) / 2 - window.innerHeight / 2;
    if (Math.abs(offX) > 1 || Math.abs(offY) > 1) return { fail: a.centredIn + " sits " + tenth(offX) + " px across and " + tenth(offY) + " px down from the window's centre" };
    if (cb.left < -0.5 || cb.top < -0.5 || cb.right > window.innerWidth + 0.5 || cb.bottom > window.innerHeight + 0.5) return { fail: a.centredIn + " runs out of the window" };
    return { ok: true };
  }
  if (a.inWindow !== undefined) {
    var winEls = Array.prototype.slice.call(document.querySelectorAll(a.inWindow)).filter(onScreen);
    if (winEls.length === 0) return { fail: "no " + a.inWindow + " on screen to measure" };
    var winBad = [];
    winEls.forEach(function (el) {
      var raw = boxOf(el);
      var label = JSON.stringify((el.getAttribute("aria-label") || el.textContent.trim()).slice(0, 30));
      if (raw.left < -0.5 || raw.top < -0.5 || raw.right > window.innerWidth + 0.5 || raw.bottom > window.innerHeight + 0.5) {
        winBad.push(label + " lies at " + tenth(raw.left) + "," + tenth(raw.top) + " to " + tenth(raw.right) + "," + tenth(raw.bottom) + ", outside the window");
        return;
      }
      for (var up = el.parentElement; up !== null && up !== document.documentElement; up = up.parentElement) {
        var us = getComputedStyle(up);
        if (us.overflowX === "visible" && us.overflowY === "visible") continue;
        var ub = up.getBoundingClientRect();
        var inX = us.overflowX === "visible" || (raw.left >= ub.left + parseFloat(us.borderLeftWidth) - 0.5 && raw.right <= ub.right - parseFloat(us.borderRightWidth) + 0.5);
        var inY = us.overflowY === "visible" || (raw.top >= ub.top + parseFloat(us.borderTopWidth) - 0.5 && raw.bottom <= ub.bottom - parseFloat(us.borderBottomWidth) + 0.5);
        if (!inX || !inY) {
          winBad.push(label + " is clipped by " + up.tagName.toLowerCase() + (up.classList.length > 0 ? "." + up.classList[0] : ""));
          return;
        }
      }
    });
    if (winBad.length > 0) return { fail: a.inWindow + ": " + winBad.slice(0, 6).join("; ") };
    return { ok: true };
  }
  if (a.uncovered !== undefined) {
    var covEls = Array.prototype.slice.call(document.querySelectorAll(a.uncovered)).filter(onScreen);
    if (covEls.length === 0) return { fail: "no " + a.uncovered + " on screen to check" };
    var covBad = covEls.filter(function (el) {
      var r = el.getBoundingClientRect();
      var front = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return front === null || !(front === el || el.contains(front));
    });
    if (covBad.length > 0) return { fail: covBad.length + " of " + covEls.length + " " + a.uncovered + " are covered at their centre: " + covBad.slice(0, 6).map(function (el) { return JSON.stringify((el.getAttribute("aria-label") || el.textContent.trim()).slice(0, 20)); }).join(", ") };
    return { ok: true };
  }
  if (a.spare !== undefined) {
    var spareBar = document.querySelector(a.spare[0]);
    if (spareBar === null || !onScreen(spareBar)) return { fail: "no " + a.spare[0] + " on screen" };
    var spareCss = getComputedStyle(spareBar);
    var spareItems = [];
    (function flat(el) {
      Array.prototype.forEach.call(el.children, function (kid) {
        var ks = getComputedStyle(kid);
        if (ks.display === "contents") flat(kid);
        else if (ks.display !== "none" && ks.position !== "absolute" && ks.position !== "fixed" && !kid.classList.contains("toolbar-spacer")) spareItems.push(kid);
      });
    })(spareBar);
    var spareUsed = spareItems.reduce(function (sum, el) {
      var ks = getComputedStyle(el);
      return sum + el.getBoundingClientRect().width + parseFloat(ks.marginLeft) + parseFloat(ks.marginRight);
    }, 0);
    var spareCut = Array.prototype.reduce.call(spareBar.querySelectorAll(".sync-chip-text"), function (sum, el) { return sum + el.scrollWidth - el.clientWidth; }, 0);
    var spareGaps = parseFloat(spareCss.columnGap) * Math.max(spareItems.length - 1, 0);
    var spareRoom = spareBar.clientWidth - parseFloat(spareCss.paddingLeft) - parseFloat(spareCss.paddingRight);
    var spareLeft = Math.round((spareRoom - spareUsed - spareCut - spareGaps) * 10) / 10;
    if (spareLeft < a.spare[1]) return { fail: a.spare[0] + " has " + spareLeft + " px to spare, under " + a.spare[1] + " (room " + Math.round(spareRoom) + ", content " + Math.round(spareUsed + spareCut + spareGaps) + ")" };
    if (a.spare[2] !== null && spareLeft >= a.spare[2]) return { fail: a.spare[0] + " has " + spareLeft + " px to spare, " + a.spare[2] + " or more: a narrower boundary would fit (room " + Math.round(spareRoom) + ", content " + Math.round(spareUsed + spareCut + spareGaps) + ")" };
    return { ok: true };
  }
  if (a.oneLine !== undefined) {
    var lineBar = document.querySelector(a.oneLine);
    if (lineBar === null || !onScreen(lineBar)) return { fail: "no " + a.oneLine + " on screen" };
    var lineCtls = Array.prototype.slice.call(lineBar.querySelectorAll("button, .seg, .wordmark")).filter(onScreen);
    var lineTop = lineCtls.filter(function (el) { return !lineCtls.some(function (other) { return other !== el && other.contains(el); }); });
    if (lineTop.length < 2) return { fail: a.oneLine + " shows " + lineTop.length + " controls, too few to tell a row" };
    var mids = lineTop.map(function (el) { var r0 = el.getBoundingClientRect(); return (r0.top + r0.bottom) / 2; });
    var off = lineTop.filter(function (el, i) { return Math.abs(mids[i] - mids[0]) > 1; });
    if (off.length > 0) return { fail: a.oneLine + " runs onto more than one row: " + off.map(function (el) { return JSON.stringify((el.getAttribute("aria-label") || el.textContent.trim()).slice(0, 20)); }).join(", ") + " sit off the first control's line" };
    var lineBox = lineBar.getBoundingClientRect();
    var lineOut = lineTop.filter(function (el) { var r0 = el.getBoundingClientRect(); return r0.left < lineBox.left - 0.5 || r0.right > lineBox.right + 0.5; });
    if (lineOut.length > 0) return { fail: lineOut.length + " controls spill out of " + a.oneLine };
    return { ok: true };
  }
  if (a.centred !== undefined || a.nearCentre !== undefined) {
    var tabSel = a.centred !== undefined ? a.centred : a.nearCentre;
    var bar = document.querySelector(".toolbar");
    if (bar === null) return { fail: "no .toolbar to measure " + tabSel + " in" };
    var tabsEl = bar.querySelector(tabSel);
    if (tabsEl === null || !onScreen(tabsEl)) return { fail: "no " + tabSel + " on screen in the toolbar" };
    var pickedCtl = Array.prototype.slice.call(bar.querySelectorAll("button, .seg, .wordmark")).filter(onScreen);
    var ctls = pickedCtl.filter(function (el) { return !pickedCtl.some(function (other) { return other !== el && other.contains(el); }); });
    var at = ctls.indexOf(tabsEl);
    var prevEl = ctls[at - 1];
    var nextEl = ctls[at + 1];
    if (prevEl === undefined || nextEl === undefined) return { fail: tabSel + " has no toolbar control on both sides to measure against" };
    var t = tabsEl.getBoundingClientRect();
    var prevR = prevEl.getBoundingClientRect();
    var nextR = nextEl.getBoundingClientRect();
    var mid = window.innerWidth / 2;
    var c = (t.left + t.right) / 2;
    var free = (prevR.right + nextR.left) / 2;
    var gap = parseFloat(getComputedStyle(bar).columnGap);
    var r1 = function (x) { return Math.round(x * 10) / 10; };
    var where = tabSel + " centre is " + r1(c - mid) + " px from the window centre (today's free-space centre " + r1(free - mid) + ", " + r1(t.left - prevR.right) + " px after " + JSON.stringify(prevEl.textContent.trim().slice(0, 20)) + ", " + r1(nextR.left - t.right) + " px before " + JSON.stringify(nextEl.textContent.trim().slice(0, 20)) + ")";
    if (Math.abs(c - mid) <= 1) return { ok: true };
    if (a.centred !== undefined) return { fail: where };
    if (c < Math.min(free, mid) - 0.5 || c > Math.max(free, mid) + 0.5) return { fail: where + ": outside the range from the free-space centre to the window centre" };
    if (t.left - prevR.right < gap - 0.5 || nextR.left - t.right < gap - 0.5) return { fail: where + ": closer to a neighbour than the toolbar gap of " + gap + " px" };
    var towardEnd = c < mid;
    var room = towardEnd ? nextR.left - t.right : t.left - prevR.right;
    if (room > gap + 1) return { fail: where + ": the tabs stop short of the window centre with " + r1(room) + " px free toward it, gap " + gap + " px" };
    var side = towardEnd ? ctls.slice(at) : ctls.slice(0, at + 1).reverse();
    var loose = side.slice(1).map(function (el, i) {
      var a1 = side[i].getBoundingClientRect();
      var b1 = el.getBoundingClientRect();
      return { el: el, space: towardEnd ? b1.left - a1.right : a1.left - b1.right };
    }).filter(function (s1) { return s1.space > gap + 1; });
    if (loose.length > 0) return { fail: where + ": the side that pushes the tabs is not packed, " + r1(loose[0].space) + " px before " + JSON.stringify(loose[0].el.textContent.trim().slice(0, 20)) };
    var outer = side[side.length - 1];
    var group = outer.closest(".toolbar-group");
    if (group === null) return { fail: where + ": " + JSON.stringify(outer.textContent.trim().slice(0, 20)) + " sits in no .toolbar-group" };
    var gcss = getComputedStyle(group);
    var gr = group.getBoundingClientRect();
    var bcss = getComputedStyle(bar);
    var br = bar.getBoundingClientRect();
    var or = outer.getBoundingClientRect();
    var slack = towardEnd
      ? br.right - parseFloat(bcss.paddingRight) - or.right
      : gr.left - (br.left + parseFloat(bcss.paddingLeft)) + or.left - (gr.left + parseFloat(gcss.paddingLeft));
    var outerName = JSON.stringify((outer.getAttribute("aria-label") || outer.textContent.trim()).slice(0, 20));
    if (slack > 1) return { fail: where + ": the side that pushes the tabs leaves " + r1(slack) + " px between " + outerName + " and the toolbar's edge" };
    if ((towardEnd ? or.right - br.right : br.left - or.left) > 0.5) return { fail: where + ": " + outerName + " spills past the toolbar's edge" };
    return { ok: true };
  }
  if (a.oneRow !== undefined) {
    var tabsIn = Array.prototype.slice.call(document.querySelectorAll(a.oneRow[0])).filter(onScreen);
    if (tabsIn.length !== a.oneRow[1]) return { fail: a.oneRow[0] + " shows " + tabsIn.length + " elements on screen, not " + a.oneRow[1] };
    var rowEl = tabsIn[0].parentElement;
    var rowBox = rowEl.getBoundingClientRect();
    var tabBoxes = tabsIn.map(function (el) { return el.getBoundingClientRect(); });
    var first = tabBoxes[0];
    var wrapped = tabsIn.filter(function (el, i) { return Math.abs(tabBoxes[i].top - first.top) > 0.5 || Math.abs(tabBoxes[i].height - first.height) > 0.5; });
    if (wrapped.length > 0) return { fail: a.oneRow[0] + " wraps: " + wrapped.map(function (el) { return JSON.stringify(el.textContent); }).join(", ") + " sits off the first row" };
    var twoLine = tabsIn.filter(function (el) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var tops = Array.prototype.slice.call(range.getClientRects()).filter(function (rc) { return rc.width >= 1; }).map(function (rc) { return Math.round(rc.top); });
      return tops.some(function (t) { return Math.abs(t - tops[0]) > 2; });
    });
    if (twoLine.length > 0) return { fail: twoLine.length + " " + a.oneRow[0] + " break their label onto two lines, first " + JSON.stringify(twoLine[0].textContent) };
    var crossing = tabBoxes.slice(1).filter(function (bx, i) { return bx.left < tabBoxes[i].right - 0.5; });
    if (crossing.length > 0) return { fail: crossing.length + " " + a.oneRow[0] + " overlap the one before them" };
    var outsideRow = tabBoxes.filter(function (bx) { return bx.left < rowBox.left - 0.5 || bx.right > rowBox.right + 0.5; });
    if (outsideRow.length > 0 || rowEl.scrollWidth > rowEl.clientWidth + 0.5) return { fail: a.oneRow[0] + " runs out of its row (" + rowEl.scrollWidth + " of " + rowEl.clientWidth + " px)" };
    return { ok: true };
  }
  if (a.valued !== undefined) {
    var fields = Array.prototype.slice.call(document.querySelectorAll(a.valued[0]));
    if (!fields.some(function (f) { return f.value === a.valued[1]; })) {
      return { fail: "no " + a.valued[0] + " holding " + JSON.stringify(a.valued[1]) + " (have: " + fields.slice(0, 6).map(function (f) { return JSON.stringify(String(f.value).slice(0, 40)); }).join(" | ") + ")" };
    }
    return { ok: true };
  }
  if (a.fitLabels !== undefined) {
    var pairs = Array.prototype.slice.call(document.querySelectorAll(".tl-chart .bar[data-bar]")).map(function (bar) {
      var label = bar.nextElementSibling;
      return { bar: bar, label: label !== null && label.classList.contains("bar-label") ? label : null };
    });
    var unpaired = pairs.filter(function (pr) { return pr.label === null; });
    if (unpaired.length > 0) return { fail: unpaired.length + " task bars have no .bar-label after them" };
    var narrowOnes = pairs.filter(function (pr) { return pr.bar.offsetWidth < pr.label.offsetWidth; });
    var wideOnes = pairs.filter(function (pr) { return pr.bar.offsetWidth >= pr.label.offsetWidth; });
    if (narrowOnes.length === 0) return { fail: "the Fit zoom shows no task bar narrower than its label, so the rule is not tested" };
    var visible = function (el) { return getComputedStyle(el).visibility !== "hidden"; };
    var shownNarrow = narrowOnes.filter(function (pr) { return visible(pr.label); });
    var hiddenWide = wideOnes.filter(function (pr) { return !visible(pr.label); });
    if (shownNarrow.length > 0) return { fail: shownNarrow.length + " task bars narrower than their label still show it, first " + shownNarrow[0].bar.getAttribute("data-bar") + " (" + shownNarrow[0].bar.offsetWidth + " < " + shownNarrow[0].label.offsetWidth + " px)" };
    if (hiddenWide.length > 0) return { fail: hiddenWide.length + " task bars as wide as their label hide it, first " + hiddenWide[0].bar.getAttribute("data-bar") };
    return { ok: true };
  }
  if (a.within !== undefined) {
    var inner = Array.prototype.slice.call(document.querySelectorAll(a.within[0]));
    if (inner.length !== a.within[2]) return { fail: a.within[0] + " matches " + inner.length + " elements, not " + a.within[2] };
    var outside = inner.filter(function (el) {
      var box = el.closest(a.within[1]);
      if (box === null) return true;
      var r = el.getBoundingClientRect();
      var b = box.getBoundingClientRect();
      return r.width === 0 || r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5;
    });
    if (outside.length > 0) return { fail: outside.length + " " + a.within[0] + " are empty or not inside their " + a.within[1] + ": " + outside.map(function (el) { return JSON.stringify(el.textContent); }).join(", ") };
    return { ok: true };
  }
  if (a.monthCut !== undefined) {
    var cutMonths = Array.prototype.slice.call(document.querySelectorAll(".tl-month-text")).filter(function (m) { return m.scrollWidth > m.clientWidth; });
    if (cutMonths.length === 0) return { fail: "no .tl-month-text is narrower than its text, so the month ellipsis is not tested" };
    var plainCut = cutMonths.filter(function (m) { return getComputedStyle(m).textOverflow !== "ellipsis"; });
    if (plainCut.length > 0) return { fail: plainCut.length + " cut month labels end without an ellipsis, first " + JSON.stringify(plainCut[0].textContent) };
    return { ok: true };
  }
  if (a.ellipsed !== undefined) {
    var cut = document.querySelector(a.ellipsed);
    if (cut === null) return { fail: "no " + a.ellipsed + " to check for an ellipsis" };
    var overflowCss = getComputedStyle(cut).textOverflow;
    if (cut.scrollWidth <= cut.clientWidth) return { fail: a.ellipsed + " fits (" + cut.scrollWidth + " of " + cut.clientWidth + " px), so its ellipsis is not tested" };
    if (overflowCss !== "ellipsis") return { fail: a.ellipsed + " overflows with text-overflow: " + overflowCss + ", not ellipsis" };
    return { ok: true };
  }
  if (a.fontMin !== undefined) {
    var typed = Array.prototype.slice.call(document.querySelectorAll(a.fontMin[0])).filter(function (el) {
      return el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible";
    });
    if (typed.length === 0) return { fail: "no visible " + a.fontMin[0] + " to read a font size from" };
    var tiny = typed.map(function (el) {
      return { el: el, px: parseFloat(getComputedStyle(el).fontSize) };
    }).filter(function (f) { return !(f.px >= a.fontMin[1]); });
    if (tiny.length > 0) {
      return { fail: tiny.map(function (f) {
        var label = f.el.getAttribute("aria-label") || f.el.getAttribute("name") || f.el.getAttribute("type") || "";
        return f.el.tagName.toLowerCase() + " " + JSON.stringify(label) + " renders at " + f.px + " px, under " + a.fontMin[1];
      }).join("; ") };
    }
    return { ok: true };
  }
  if (a.style !== undefined) {
    var styled = document.querySelector(a.style[0]);
    if (styled === null) return { fail: "no " + a.style[0] + " to read " + a.style[1] + " from" };
    var pseudo = a.style[3] === undefined ? null : a.style[3];
    if (pseudo !== null && pseudo !== "::before" && pseudo !== "::after") throw new Error("style: no pseudo-element " + pseudo);
    var got = getComputedStyle(styled, pseudo).getPropertyValue(a.style[1]);
    var named = a.style[0] + (pseudo === null ? "" : pseudo);
    if (got !== a.style[2]) return { fail: named + " has " + a.style[1] + ": " + JSON.stringify(got) + ", not " + JSON.stringify(a.style[2]) };
    return { ok: true };
  }
  if (a.loaded !== undefined) {
    var begun = performance.now();
    return new Promise(function (resolve) {
      (function poll() {
        var img = document.querySelector(a.loaded);
        if (img !== null && img.complete && img.naturalWidth > 0) return resolve({ ok: true });
        if (img !== null && img.complete) return resolve({ fail: a.loaded + " " + JSON.stringify(img.getAttribute("src")) + " is broken: complete with naturalWidth 0" });
        if (performance.now() - begun < ${LOAD_MS}) return setTimeout(poll, 25);
        resolve({
          fail: a.loaded + (img === null ? " never appeared" :
            " " + JSON.stringify(img.getAttribute("src")) + " did not load in " + ${LOAD_MS} + " ms: still not complete"),
        });
      })();
    });
  }
  if (a.today !== undefined) {
    var line = document.querySelector(".tl-today");
    var pane = document.querySelector(".tl-scroll");
    var column = document.querySelector(".tl-grid");
    if (line === null || pane === null || column === null) return { fail: "no .tl-today, .tl-scroll and .tl-grid to place today against" };
    var lr = line.getBoundingClientRect();
    var from = column.getBoundingClientRect().right;
    var to = pane.getBoundingClientRect().left + pane.clientWidth;
    if (lr.left < from || lr.right > to) {
      return { fail: "today line at " + Math.round(lr.left) + ".." + Math.round(lr.right) + " is outside the visible chart " + Math.round(from) + ".." + Math.round(to) +
        " (scrollLeft " + Math.round(pane.scrollLeft) + ", pane " + pane.clientWidth + " px)" };
    }
    return { ok: true };
  }
  if (a.edges !== undefined) {
    var sp = document.querySelector(".tl-scroll");
    var gr = document.querySelector(".tl-grid");
    var corner = document.querySelector(".tl-corner");
    var pill = document.querySelector(".tl-today-label");
    var monthBoxes = Array.prototype.slice.call(document.querySelectorAll(".tl-month"));
    if (sp === null || gr === null || corner === null || pill === null || monthBoxes.length === 0) return { fail: "no .tl-scroll, .tl-grid, .tl-corner, .tl-today-label and .tl-month to check the edges with" };
    var was = sp.scrollLeft;
    var gw = gr.getBoundingClientRect().width;
    var widest = monthBoxes.reduce(function (m, b) { return b.offsetWidth > m.offsetWidth ? b : m; });
    sp.scrollLeft = widest.offsetLeft + 200;
    var label = widest.querySelector(".tl-month-text");
    if (label === null) { sp.scrollLeft = was; return { fail: "the month box has no .tl-month-text" }; }
    var lr2 = label.getBoundingClientRect();
    var want = gr.getBoundingClientRect().right + 8;
    var fronts = document.elementFromPoint((lr2.left + lr2.right) / 2, (lr2.top + lr2.bottom) / 2);
    var stuck = Math.abs(lr2.left - want) <= 2 && fronts !== null && (fronts === label || label.contains(fronts));
    sp.scrollLeft = pill.offsetLeft + gw / 2;
    var pr = pill.getBoundingClientRect();
    pill.style.pointerEvents = "auto";
    var over = document.elementFromPoint((pr.left + pr.right) / 2, (pr.top + pr.bottom) / 2);
    pill.style.pointerEvents = "";
    var under = over !== null && corner.contains(over);
    var fade = getComputedStyle(gr, "::after");
    sp.scrollLeft = was;
    if (!stuck) return { fail: "the month label sits at " + Math.round(lr2.left) + " px, not " + Math.round(want) + " px, or is covered" };
    if (!under) return { fail: "the TODAY pill paints over the pinned corner: " + (over === null ? "nothing" : over.tagName.toLowerCase() + "." + String(over.className)) + " is in front" };
    if (parseFloat(fade.left) < gr.clientWidth + 1) return { fail: "the chart's left fade starts at " + fade.left + ", on the task column's " + gr.clientWidth + " px border, not past it" };
    if (fade.width !== "28px" || fade.pointerEvents !== "none" || fade.backgroundImage.indexOf("linear-gradient") === -1) {
      return { fail: "the chart's left fade is " + fade.width + ", pointer-events " + fade.pointerEvents + ", " + fade.backgroundImage };
    }
    return { ok: true };
  }
  if (a.nubs !== undefined) {
    if (!matchMedia("(pointer: coarse)").matches) return { fail: "(pointer: coarse) does not match here" };
    var on = document.querySelector(".bar.selected .nub");
    var off = document.querySelector(".bar:not(.selected) .nub");
    if (on === null || off === null) return { fail: "no selected and unselected bar with a .nub" };
    var offEvents = getComputedStyle(off).pointerEvents;
    if (offEvents !== "none") return { fail: "an unselected bar's .nub has pointer-events: " + offEvents + ", not none" };
    var onEvents = getComputedStyle(on).pointerEvents;
    if (onEvents === "none") return { fail: "the selected bar's .nub has pointer-events: none" };
    on.scrollIntoView({ block: "nearest", inline: "nearest" });
    var nb = on.getBoundingClientRect();
    var cx = Math.round((nb.left + nb.right) / 2);
    var cy = (nb.top + nb.bottom) / 2;
    var span = Array.from({ length: 2 * a.nubs + 1 }, function (_, i) { return cx - a.nubs + i; });
    var wide = span.filter(function (x) { return document.elementFromPoint(x, cy) === on; }).length;
    if (wide < 44) return { fail: "the selected bar's .nub takes touches across " + wide + " px at its centre line, under 44" };
    return { ok: true };
  }
  return { fail: "unknown action " + JSON.stringify(a) };
};
`;

class NotMeasured extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tailOf = (text) => (text.length > 4000 ? `…${text.slice(-4000)}` : text);

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.waiting = new Map();
    this.listeners = new Set();
    this.failure = null;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) {
        this.listeners.forEach((cb) => cb(msg));
        return;
      }
      const pending = this.waiting.get(msg.id);
      if (pending === undefined) return;
      this.waiting.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message} (${JSON.stringify(msg.error.data ?? null)})`));
      else pending.resolve(msg.result);
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot open ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  watch(onLost) {
    this.ws.addEventListener("close", () => onLost("the devtools socket closed"));
    this.ws.addEventListener("error", () => onLost("the devtools socket failed"));
  }

  fail(error) {
    if (this.failure === null) this.failure = error;
    const pending = [...this.waiting.values()];
    this.waiting.clear();
    pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(this.failure);
    });
  }

  send(method, params = {}, sessionId) {
    if (this.failure !== null) return Promise.reject(this.failure);
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`devtools gave no answer to ${method} within ${SEND_TIMEOUT_MS / 1000} s`));
      }, SEND_TIMEOUT_MS);
      this.waiting.set(id, { method, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.waiting.delete(id);
        throw e;
      }
    });
  }

  on(cb) {
    this.listeners.add(cb);
  }

  close() {
    this.ws.close();
  }
}

async function exists(file) {
  return stat(file).then(
    () => true,
    (e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );
}

async function revisions(base) {
  if (!(await exists(base))) return [];
  const names = await readdir(base);
  return names.filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse();
}

export async function findShell() {
  for (const base of SHELL_CANDIDATES) {
    for (const rev of await revisions(base)) {
      for (const dir of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"]) {
        const bin = join(base, rev, dir, "chrome-headless-shell");
        if (await exists(bin)) return bin;
      }
    }
  }
  throw new NotMeasured(`no chrome-headless-shell under ${SHELL_CANDIDATES.join(" or ")}; install Playwright's chromium-headless-shell first`);
}

function freshTraffic() {
  return { notFound: [], pageErrors: [], unknownState: null, crash: null };
}

function serve(indexHtml, traffic) {
  const handle = async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const name = url.searchParams.get("state") ?? "";
      const body = indexHtml(name);
      if (body === null) {
        traffic.current.unknownState = name;
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(`unknown probe state ${name}`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
      res.end(body);
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch (e) {
      if (!(e instanceof URIError)) throw e;
      traffic.current.pageErrors.push(`the page requested ${url.pathname}, which is not a valid encoded path (${e.message})`);
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad path");
      return;
    }
    const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    const file = join(DIST, rel);
    if (!file.startsWith(DIST) || !(await exists(file))) {
      traffic.current.notFound.push(url.pathname);
      res.writeHead(404).end("not found");
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (traffic.current.crash === null) traffic.current.crash = e;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const exitOf = (child) => `code ${child.exitCode}, signal ${child.signalCode}`;
const exited = (child) => child.exitCode !== null || child.signalCode !== null;

export async function devtoolsUrl(child, profile, stderrOf, startError) {
  const file = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + DEVTOOLS_MS;
  while (Date.now() < deadline) {
    const failed = startError();
    if (failed !== null) throw new NotMeasured(`chrome-headless-shell did not start: ${failed.message}`);
    if (exited(child)) throw new NotMeasured(`chrome-headless-shell exited (${exitOf(child)}) before devtools came up; its stderr:\n${tailOf(stderrOf())}`);
    if (await exists(file)) {
      const [port, path] = (await readFile(file, "utf8")).split("\n");
      if (/^\d+$/.test(port ?? "") && (path ?? "").startsWith("/devtools/browser/")) return `ws://127.0.0.1:${port}${path}`;
    }
    await sleep(100);
  }
  throw new NotMeasured(`chrome-headless-shell wrote no ${file} within ${DEVTOOLS_MS / 1000} s; its stderr:\n${tailOf(stderrOf())}`);
}

export async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId);
  if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function settle(cdp, sessionId) {
  const expr = String.raw`(async function () {
    await document.fonts.ready;
    var begun = performance.now();
    var ready = false;
    while (!ready && performance.now() - begun < ${READY_MS}) {
      ready = document.querySelector(".app") !== null &&
        (document.querySelector(".plan-head") !== null || document.querySelector(".empty-state") !== null ||
          document.querySelector(".phone-views") !== null);
      if (!ready) await new Promise(function (r) { setTimeout(r, 25); });
    }
    if (!ready) return { ready: false, quiet: false };
    var last = performance.now();
    var watch = new MutationObserver(function () { last = performance.now(); });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    var start = performance.now();
    var quiet = false;
    while (!quiet && performance.now() - start < ${QUIET_MS}) {
      await new Promise(function (r) { setTimeout(r, 30); });
      quiet = performance.now() - last >= 150;
    }
    watch.disconnect();
    await document.fonts.ready;
    await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    return { ready: true, quiet: quiet };
  })()`;
  return evaluate(cdp, sessionId, expr, true);
}

const unsettled = (s) =>
  !s.ready
    ? `app never rendered .app and .plan-head/.empty-state/.phone-views within ${READY_MS / 1000} s`
    : !s.quiet
      ? `DOM still changing after ${QUIET_MS / 1000} s`
      : null;

async function press(cdp, sessionId, k) {
  const base = { key: k.key, code: k.code, modifiers: k.modifiers, windowsVirtualKeyCode: k.key.toUpperCase().charCodeAt(0) };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
}

async function pointer(cdp, sessionId, [x, y]) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, sessionId);
}

const PAIR_GAP_MS = 120;

async function mouseDouble(cdp, sessionId, [x, y, dx]) {
  await pointer(cdp, sessionId, [x, y]);
  await sleep(PAIR_GAP_MS);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
  if (dx !== 0) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + dx, y, button: "left", buttons: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y, button: "left", buttons: 0, clickCount: 1 }, sessionId);
}

async function touchDouble(cdp, sessionId, [x, y]) {
  const once = async () => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] }, sessionId);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sessionId);
  };
  await once();
  await sleep(PAIR_GAP_MS);
  await once();
}

async function touchSwipe(cdp, sessionId, [x, y, dx, dy]) {
  const at = (f) => [{ x: x + dx * f, y: y + dy * f, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) }, sessionId);
  for (const f of [0.25, 0.5, 0.75, 1]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(f) }, sessionId);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sessionId);
}

const describeAction = (a) => JSON.stringify(a);

async function runState(cdp, sessionId, origin, state, errors, traffic) {
  errors.length = 0;
  traffic.current = freshTraffic();
  const seen = () => [...errors, ...traffic.current.pageErrors];
  const unreached = (why) => ({ unreached: why, errors: seen() });
  const checked = () => {
    if (traffic.current.crash !== null) throw traffic.current.crash;
  };
  await cdp.send("Emulation.setEmulatedMedia", { media: "" }, sessionId);
  const nav = await cdp.send("Page.navigate", { url: `${origin}/?state=${encodeURIComponent(state.name)}` }, sessionId);
  checked();
  if (typeof nav.errorText === "string" && nav.errorText !== "") return unreached(`navigation to ${state.name} failed: ${nav.errorText}`);
  if (traffic.current.unknownState !== null) return unreached(`the probe server knows no state ${traffic.current.unknownState} (404 unknown probe state)`);
  const first = unsettled(await settle(cdp, sessionId));
  checked();
  if (first !== null) return unreached(first);
  await evaluate(cdp, sessionId, ACT);
  for (const action of state.actions) {
    if (action.key !== undefined) {
      await press(cdp, sessionId, action.key);
    } else if (action.media !== undefined) {
      await cdp.send("Emulation.setEmulatedMedia", { media: action.media }, sessionId);
    } else {
      const got = await evaluate(cdp, sessionId, `window.__probeAct(${JSON.stringify(action)})`, true);
      if (got.fail !== undefined) return unreached(`${describeAction(action)}: ${got.fail}`);
      if (got.at !== undefined) await pointer(cdp, sessionId, got.at);
      if (got.swipe !== undefined) await touchSwipe(cdp, sessionId, got.swipe);
      if (got.doubleClick !== undefined) await mouseDouble(cdp, sessionId, got.doubleClick);
      if (got.doubleTap !== undefined) await touchDouble(cdp, sessionId, got.doubleTap);
    }
    const after = unsettled(await settle(cdp, sessionId));
    checked();
    if (after !== null) return unreached(`after ${describeAction(action)}: ${after}`);
  }
  const reading = await evaluate(cdp, sessionId, MEASURE);
  checked();
  return { reading, errors: seen(), notFound: [...traffic.current.notFound] };
}

function judge(state, viewport, r, errors, notFound) {
  const problems = [];
  if (r.form !== viewport.form) problems.push(`html[data-form] is ${JSON.stringify(r.form)}, not ${JSON.stringify(viewport.form)}`);
  if (r.stamp.os !== r.stamp.want.os) problems.push(`html[data-os] is ${JSON.stringify(r.stamp.os)}, not the fixture's ${JSON.stringify(r.stamp.want.os)}`);
  if (r.stamp.idiom !== r.stamp.want.idiom) problems.push(`html[data-idiom] is ${JSON.stringify(r.stamp.idiom)}, not the fixture's ${JSON.stringify(r.stamp.want.idiom)}`);
  if (r.doc.overY > 1) problems.push(`document scrolls ${r.doc.overY}px vertically`);
  if (r.doc.overX > 1) problems.push(`document scrolls ${r.doc.overX}px horizontally`);
  if (r.doc.alreadyScrolledTo.top !== 0 || r.doc.alreadyScrolledTo.left !== 0) {
    problems.push(`the document was already scrolled to ${r.doc.alreadyScrolledTo.left},${r.doc.alreadyScrolledTo.top}`);
  }
  Object.entries(r.overflow).forEach(([name, value]) => {
    if (value !== "hidden") problems.push(`${name} computes overflow: ${value}, not hidden`);
  });
  r.scrollableHidden.forEach((s) => problems.push(`${s.path} accepted scrollTop=${s.scrollTop} scrollLeft=${s.scrollLeft}`));
  r.escapees.forEach((e) => problems.push(`${e.count}x ${e.path} is position: absolute with no positioned ancestor, so it escapes .app's clip`));
  r.clipped.forEach((c) => problems.push(`${c.path} clips ${c.byY}px down and ${c.byX}px across of its own content with no scroller${c.culprit === null ? "" : `, furthest is ${c.culprit.path} at ${c.culprit.edge}`}`));
  r.panes
    .filter((p) => !p.reached)
    .forEach((p) =>
      problems.push(`${p.path} scrolled to the end and its last element is still ${p.shortBy}px past the pane (pane bottom ${p.paneBottom}, element bottom ${p.lastBottom}, [${p.lastPosition}] ${p.last})`),
    );
  r.overpaints.forEach((o) => {
    const by = o.by.map((b) => `${b.path} (bottom ${b.bottom}, ${b.spill}px past its box, ${b.covers}px onto it)`).join("; ");
    problems.push(`${o.a} paints ${o.overY}x${o.overX}px over ${o.b}, both children of ${o.parent} — by ${by}`);
  });
  r.covered.forEach((c) => problems.push(`${c.path} is not the topmost thing at its own centre (${c.at}): ${c.on} is, over ${c.stack.join(" / ")}`));
  if (TOOLBAR.includes(viewport)) {
    if (!r.toolbar.found) problems.push("this viewport renders no .toolbar, so nothing was checked for overlap");
    if (r.toolbar.found && r.toolbar.controls.length < 2) problems.push(`the toolbar shows ${r.toolbar.controls.length} control, so nothing was checked for overlap`);
    r.toolbar.overlaps.forEach((o) => problems.push(`toolbar controls overlap by ${o.x}x${o.y}px: ${o.a} and ${o.b}`));
    r.toolbar.controls.filter((c) => c.lines > 1).forEach((c) => problems.push(`toolbar control ${c.name} wraps onto ${c.lines} lines`));
  }
  if (state.clip.length > 0) {
    if (r.names.checked === 0) problems.push("no element shows one of the long names");
    r.names.faults.forEach((f) => problems.push(f));
    r.names.missing.forEach((s) => problems.push(`no ${s} shows one of the long names`));
  }
  if (state.dialog) {
    if (r.dialogs.count !== 1) problems.push(`${r.dialogs.count} elements have role="dialog", not one`);
    r.dialogs.faults.forEach((f) => problems.push(f));
  }
  const unloaded = r.fonts.filter((f) => !f.loaded).map((f) => `${f.family} (${f.faces} faces)`);
  if (unloaded.length > 0) problems.push(`fonts not loaded: ${unloaded.join(", ")}`);
  notFound.forEach((p) => problems.push(`dist has no ${p}: the page asked for it and got 404`));
  state.logs.filter((l) => !errors.includes(l)).forEach((l) => problems.push(`the page did not log the error this state expects: ${l}`));
  errors.filter((e) => !state.logs.includes(e)).forEach((e) => problems.push(`the page reported an error: ${e}`));
  return { ok: problems.length === 0, problems };
}

function report(name, viewport, verdict, r) {
  process.stdout.write(`\n${verdict.ok ? "ok  " : "FAIL"} ${name} @ ${viewport}\n`);
  process.stdout.write(`     doc ${r.doc.scrollHeight}/${r.doc.innerHeight}h ${r.doc.scrollWidth}/${r.doc.innerWidth}w   fonts ${r.fonts.map((f) => `${f.family}=${f.loaded}`).join(" ")}\n`);
  process.stdout.write(`     ${Object.entries(r.overflow).map(([k, v]) => `${k} ${v}`).join(" | ")}\n`);
  verdict.problems.forEach((p) => process.stdout.write(`     ! ${p}\n`));
  r.offenders.forEach((o) => process.stdout.write(`     > past the edge by ${o.over}  [${o.position}]  ${o.path}\n`));
  r.tallest.forEach((t) => process.stdout.write(`     = bottom ${t.bottom} (h ${t.height}) [${t.position}]  ${t.path}${t.clippedBy === null ? "" : ` — but clipped by ${t.clippedBy}`}\n`));
  if (r.names.checked > 0) process.stdout.write(`     long names checked: ${r.names.checked}\n`);
  if (!verdict.ok) {
    r.chain.forEach((c) =>
      process.stdout.write(`     . ${c.name.padEnd(18)} client ${String(c.client).padStart(5)} scroll ${String(c.scroll).padStart(5)} box ${String(c.top).padStart(7)}..${String(c.bottom).padEnd(7)} x ${String(c.left).padStart(7)}..${String(c.right).padEnd(7)}  ${c.css}\n`),
    );
  }
}

function reportUnreached(name, viewport, why, errors) {
  process.stdout.write(`\nUNREACHED ${name} @ ${viewport}\n     ! ${why}\n`);
  errors.forEach((e) => process.stdout.write(`     page error: ${e}\n`));
}

function printTable(rows) {
  const names = [...new Set(rows.map((r) => r.state))];
  const views = [...new Set(rows.map((r) => r.viewport))];
  const width = Math.max(...names.map((n) => n.length));
  process.stdout.write(`\n${"state".padEnd(width)}  ${views.map((v) => v.padStart(11)).join("")}\n`);
  names.forEach((name) => {
    const cells = views.map((v) => {
      const row = rows.find((r) => r.state === name && r.viewport === v);
      if (row === undefined) return "-".padStart(11);
      if (row.unreached !== undefined) return "UNREACHED".padStart(11);
      return (row.ok ? "ok" : "FAIL").padStart(11);
    });
    process.stdout.write(`${name.padEnd(width)}  ${cells.join("")}\n`);
  });
}

const base64 = (bytes) => Buffer.from(bytes).toString("base64");

export async function stopChild(child) {
  if (child.pid === undefined || exited(child)) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function waitExit(child, ms) {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function onFailure(work, cleanup) {
  try {
    return await work();
  } catch (e) {
    await cleanup().catch((c) => process.stderr.write(`layout-probe: cleanup failed too: ${c instanceof Error ? c.stack : String(c)}\n`));
    throw e;
  }
}

async function guarded(work, cleanup) {
  const result = await onFailure(work, cleanup);
  await cleanup();
  return result;
}

async function measureAll(cdp, origin, picked, oneSize, verbose, shotDir, traffic) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Zurich" }, sessionId);
  await cdp.send("Emulation.setLocaleOverride", { locale: "en-GB" }, sessionId);

  const sizes = VIEWPORTS.filter((v) => oneSize === null || nameOf(v) === oneSize);
  if (sizes.length === 0) throw new NotMeasured(`--viewport ${oneSize} is none of the probe's sizes`);
  const rows = [];
  for (const size of sizes) {
    const [w, h] = size.size;
    const [sw, sh] = size.screen;
    const blank = await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
    if (typeof blank.errorText === "string" && blank.errorText !== "") throw new Error(`layout-probe: could not clear the page before ${nameOf(size)}: ${blank.errorText}`);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: w, height: h, deviceScaleFactor: 1, mobile: size.touch, screenWidth: sw, screenHeight: sh },
      sessionId,
    );
    await cdp.send("Emulation.setTouchEmulationEnabled", size.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }, sessionId);
    for (const state of picked.filter((s) => sizesOf(s).includes(nameOf(size)))) {
      const viewport = nameOf(size);
      const run = await runState(cdp, sessionId, origin, state, errors, traffic);
      if (run.unreached !== undefined) {
        rows.push({ state: state.name, viewport, ok: false, unreached: run.unreached, errors: run.errors });
        reportUnreached(state.name, viewport, run.unreached, run.errors);
        continue;
      }
      const r = run.reading;
      const tickets = Object.entries(r.tickets);
      if (tickets.length > 0) process.stdout.write(`tickets ${state.name} @ ${viewport}: ${tickets.map(([doc, n]) => `${doc} ${n}`).join(", ")}\n`);
      const why = !r.scope.found
        ? `measures 3-8 are scoped to ${r.scope.name}, and the page has none`
        : r.missing.length > 0
          ? `the app asked for what no fixture answers: ${r.missing.join(", ")}`
          : r.text === 0
            ? "the app painted no text"
            : null;
      if (why !== null) {
        rows.push({ state: state.name, viewport, ok: false, unreached: why, errors: run.errors, reading: r });
        reportUnreached(state.name, viewport, why, run.errors);
        continue;
      }
      const verdict = judge(state, size, r, run.errors, run.notFound);
      rows.push({ state: state.name, viewport, ...verdict, reading: r });
      if (verbose || !verdict.ok) report(state.name, viewport, verdict, r);
      if (shotDir !== null) {
        if (state.shotMedia !== null) await cdp.send("Emulation.setEmulatedMedia", { media: state.shotMedia }, sessionId);
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        if (state.shotMedia !== null) await cdp.send("Emulation.setEmulatedMedia", { media: "" }, sessionId);
        const file = join(shotDir, `${state.name.replace(/\//g, "-")}-${viewport}.png`);
        await writeFile(file, Buffer.from(data, "base64"));
        process.stdout.write(`shot: ${file}\n`);
      }
    }
  }
  return rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    if (at === -1) return null;
    const v = argv[at + 1];
    if (v === undefined) throw new NotMeasured(`${name} needs a value`);
    return v;
  };
  const only = flag("--only");
  const jsonOut = flag("--json");
  const shotDir = flag("--shot");
  const oneSize = flag("--viewport");
  const verbose = argv.includes("--verbose");

  if (!(await exists(join(DIST, "index.html")))) throw new NotMeasured(`nothing to measure, no index.html under ${DIST}; run npm run build first`);

  const template = await readFile(join(DIST, "index.html"), "utf8");
  if (!template.includes("<head>")) throw new Error("layout-probe: dist/index.html has no <head> to put the shim in");
  const picked = states().filter((s) => only === null || s.name.includes(only));
  if (picked.length === 0) throw new NotMeasured(`--only ${only} matched no state`);
  const homeless = picked.filter((s) => !VIEWPORTS.some((v) => sizesOf(s).includes(nameOf(v))));
  if (homeless.length > 0) {
    homeless.forEach((s) => process.stdout.write(`layout-probe: FAILED, state ${s.name} has no viewport: its sizes "${s.sizes}" name ${sizesOf(s).join(", ")}, none of them a probe viewport\n`));
    return 1;
  }
  if (shotDir !== null) await mkdir(shotDir, { recursive: true });
  const built = buildFixtures();
  const fixtures = new Map(
    [...new Set(picked.map((s) => s.fixture))].map((name) => {
      const f = built[name];
      if (f === undefined) throw new Error(`layout-probe: no fixture ${name}`);
      return [name, { docs: Object.fromEntries(Object.entries(f.docs).map(([id, b]) => [id, base64(b)])), platform: f.platform, ipc: f.ipc, newDoc: f.newDoc === undefined ? null : base64(f.newDoc) }];
    }),
  );

  const indexHtml = (name) => {
    const state = picked.find((s) => s.name === name);
    if (state === undefined) return null;
    const payload = JSON.stringify({
      place: state.place,
      theme: state.theme,
      panes: state.panes,
      fixture: fixtures.get(state.fixture),
      clip: state.clip,
      clipIn: state.clipIn,
      dialog: state.dialog,
      net: state.net,
      fonts: FONTS,
    }).replace(/</g, "\\u003c");
    return template.replace("<head>", `<head>\n    <script>window.__PROBE__ = ${payload};</script>\n    <script>${SHIM}</script>`);
  };
  const bin = await findShell();
  const profile = await mkdtemp(join(tmpdir(), "webboard-layout-probe-"));
  const traffic = { current: freshTraffic() };
  const server = await onFailure(() => serve(indexHtml, traffic), () => rm(profile, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const closeServer = () => {
    server.closeAllConnections();
    return new Promise((resolve, reject) => server.close((e) => (e === undefined ? resolve() : reject(e))));
  };
  const child = await onFailure(
    async () =>
      spawn(
        bin,
        ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars=false", "--force-device-scale-factor=1", "--disable-lcd-text", "about:blank"],
        { stdio: ["ignore", "ignore", "pipe"] },
      ),
    async () => {
      await closeServer();
      await rm(profile, { recursive: true, force: true });
    },
  );
  let stderr = "";
  let startError = null;
  child.once("error", (e) => {
    startError = e;
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  const cleanup = async () => {
    await closeServer();
    await stopChild(child);
    await rm(profile, { recursive: true, force: true });
  };

  const rows = await guarded(async () => {
    const url = await devtoolsUrl(child, profile, () => stderr, () => startError);
    const cdp = await Cdp.open(url);
    const lost = (what) => cdp.fail(new Error(`${what} (chrome-headless-shell ${exited(child) ? exitOf(child) : "still running"}); its stderr:\n${tailOf(stderr)}`));
    child.once("exit", () => lost("chrome-headless-shell exited mid-run"));
    cdp.watch((what) => waitExit(child, 1000).then(() => lost(what)));
    const measured = await measureAll(cdp, origin, picked, oneSize, verbose, shotDir, traffic);
    cdp.close();
    return measured;
  }, cleanup);

  if (rows.length === 0) throw new NotMeasured(`no picked state runs at --viewport ${oneSize}`);
  printTable(rows);
  if (jsonOut !== null) {
    await writeFile(jsonOut, JSON.stringify(rows, null, 1));
    process.stdout.write(`\nwritten: ${jsonOut}\n`);
  }
  const unreached = rows.filter((r) => r.unreached !== undefined);
  const failed = rows.filter((r) => r.unreached === undefined && !r.ok);
  if (failed.length > 0) {
    process.stdout.write(`\nlayout-probe: FAILED, ${failed.length} of ${rows.length} state runs broke the layout:\n`);
    failed.slice(0, 20).forEach((r) => process.stdout.write(`  ${r.state} @ ${r.viewport}: ${r.problems[0]}\n`));
  }
  if (unreached.length > 0) {
    process.stdout.write(`\nlayout-probe: NOT MEASURED, ${unreached.length} state run(s) never reached their state:\n`);
    unreached.slice(0, 20).forEach((r) => process.stdout.write(`  ${r.state} @ ${r.viewport}: ${r.unreached}\n`));
  }
  if (failed.length > 0) return 1;
  if (unreached.length > 0) return 2;
  process.stdout.write(`\nlayout-probe: PASS, ${rows.length} state runs over ${new Set(rows.map((r) => r.state)).size} states, every one contained.\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof NotMeasured) {
        process.stderr.write(`layout-probe: not measured: ${e.message}\n`);
        process.exit(2);
      }
      process.stderr.write(`layout-probe: crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exit(3);
    },
  );
}
