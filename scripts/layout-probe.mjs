import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { buildFixtures, LONG_NAMES, PLAN_IDS, UNREADABLE_LINE, UPDATE_CHECK_FAILED, UPDATE_VERSION } from "./layout-fixtures.mjs";

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

const DESKTOP = [desk(1180, 760), desk(1440, 920), desk(1920, 1080), desk(1024, 700)];
const PHONE = [touch(390, 844, "phone")];
const PORTRAIT = [touch(820, 1180, "compact")];
const LANDSCAPE = [touch(1180, 820, "full"), touch(1366, 1024, "full")];
const NARROW = [{ size: [500, 820], screen: [820, 1180], touch: true, form: "compact" }];
const VIEWPORTS = [...DESKTOP, ...PHONE, ...PORTRAIT, ...LANDSCAPE, ...NARROW];
const TOOLBAR = [...DESKTOP, ...PORTRAIT, ...LANDSCAPE, ...NARROW];
const LOAD_MS = 2000;

const nameOf = (v) => `${v.size[0]}x${v.size[1]}`;
const READY_MS = 5000;
const QUIET_MS = 4000;
const SEND_TIMEOUT_MS = 30_000;
const DEVTOOLS_MS = 10_000;
const FONTS = [
  ["IBM Plex Mono", '13px "IBM Plex Mono"'],
  ["Chakra Petch", '600 12px "Chakra Petch"'],
];

const EMPTY_PLAN = "No items yet. Add one with + Task.";
const EXAMPLE_PLAN = "Example: Website relaunch";
const CALENDAR_BANNER = "The calendar was changed on two devices. Nothing moves until you choose.";
const PICKED = "Tracking: review results";
const PICKED_CHOICE = "Tracking: review results and fixes";
const STATUS_FIRST = "Holidays for 2031 not loaded — load";
const STATUS_REFUSED = "Holidays for 2031 not available — open calendar";

const expect = (selector, text) => ({ expect: text === undefined ? [selector] : [selector, text] });
const count = (selector, n) => ({ count: [selector, n] });
const loaded = (selector) => ({ loaded: selector });
const click = (selector, text) => ({ click: [selector, text] });
const tap = (selector, text) => ({ tap: [selector, text] });
const none = (selector, text) => ({ none: [selector, text] });
const key = (k, code, modifiers) => ({ key: { key: k, code, modifiers } });
const reveal = (selector, text) => ({ reveal: [selector, text] });
const nubs = (reach) => ({ nubs: reach });
const todayShown = () => ({ today: true });
const edges = () => ({ edges: true });

const VIEWS = [
  ["timeline-w", { view: "timeline", zoom: "W" }, ".tl-row .name"],
  ["timeline-m", { view: "timeline", zoom: "M" }, ".tl-row .name"],
  ["timeline-q", { view: "timeline", zoom: "Q" }, ".tl-row .name"],
  ["board", { view: "board", zoom: "W" }, ".card .card-name"],
  ["list", { view: "list", zoom: "W" }, ".list .list-name"],
];

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
    add(`mesa/${slug}/plan`, "mesa", { place, actions: [viewExpect(place.view), expect(".slot-panel .panel h2", "Plan")] });
    add(`mesa/${slug}/item`, "mesa", {
      place,
      actions: [viewExpect(place.view), tap(names, PICKED), expect(".slot-panel .panel .kind", "TASK")],
    });
  });
  add("scale", "scale", { actions: [expect(".tl-row .name", "WS01 task 01"), expect(".plan-head h1", "Scale: 1,000 items")] });
  VIEWS.forEach(([slug, place]) =>
    add(`long-names/${slug}`, "long-names", { place, clip: true, actions: [viewExpect(place.view), count(".sidebar .entry", 2)] }),
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
    ],
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
    actions: [click(".slot-panel button", "Change calendar…"), expect('.modal-wide[role="dialog"] h3', "Calendar · MESA 1.0"), expect(".cal-grid select")],
  });
  const calendarFromSheet = [
    click(".toolbar button", "Plan"),
    click('.sheet[role="dialog"] button', "Change calendar…"),
    expect('.modal-wide[role="dialog"] h3', "Calendar · MESA 1.0"),
    expect(".cal-grid select"),
  ];
  add("calendar-dialog/compact", "mesa", { sizes: "portrait", dialog: true, actions: calendarFromSheet });
  add("choice-dialog", "choices", {
    sizes: "dialog",
    dialog: true,
    actions: [click(".plan-head button.chip-amber", "1 held"), count('[role="dialog"] .choice-col', 3)],
  });
  add("palette", "mesa", {
    dialog: true,
    actions: [key("k", "KeyK", 4), expect('.palette[role="dialog"]'), expect(".palette-item .palette-label")],
  });
  add("about", "mesa", {
    dialog: true,
    actions: [
      key("k", "KeyK", 4),
      tap(".palette-item .palette-label", "About WebBoard"),
      expect('.modal[role="dialog"] h3', "About WebBoard"),
      count('.modal[role="dialog"] img.about-mark', 1),
      loaded('.modal[role="dialog"] img.about-mark'),
    ],
  });
  add("linux-toolbar", "mesa-linux", {
    sizes: "smallest",
    actions: [viewExpect("timeline"), expect("header.toolbar .wordmark", "WebBoard"), count(".toolbar-mac", 0)],
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
  const exampleHead = expect(".plan-head h1", EXAMPLE_PLAN);
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
      expect(".tl-row .name", "Visual design"),
    ],
  });
  add("update/current", "mesa", { actions: [viewExpect("timeline"), expect(".sidebar .update-line .update-status", "Up to date · checked 09:00")] });
  add("update/available", "update-available", {
    clip: [UPDATE_AVAILABLE],
    actions: [viewExpect("timeline"), expect(".sidebar .update-line button", "Install and restart"), expect(".sidebar .update-line .update-status.amber", UPDATE_AVAILABLE)],
  });
  add("update/check-failed", "update-check-failed", {
    clip: [UPDATE_FAILED],
    logs: [UPDATE_CHECK_FAILED],
    actions: [viewExpect("timeline"), expect(".sidebar .update-line button", "Try again"), expect(".sidebar .update-line .update-status.bad", UPDATE_FAILED)],
  });
  add("update/downloading", "update-downloading", {
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
      expect(".plan-sheet button.about-row", "About WebBoard"),
    ],
  });
  add("phone-about", "mesa", {
    sizes: "phone",
    dialog: true,
    actions: [
      click(".phone-head button.phone-more", "⋯"),
      click(".plan-sheet button.about-row", "About WebBoard"),
      expect('.sheet[role="dialog"] .sheet-title', "About WebBoard"),
      count('.sheet[role="dialog"] .about-sheet img.about-mark', 1),
      loaded('.sheet[role="dialog"] .about-sheet img.about-mark'),
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
  add("touch/full", "mesa", {
    sizes: "landscape",
    actions: [viewExpect("timeline"), expect(".sidebar"), expect(".slot-panel .panel h2", "Plan")],
  });
  add("touch/nub", "mesa", {
    sizes: "ipad-pro",
    actions: [viewExpect("timeline"), click(".tl-row .name", PICKED), expect(".bar.selected .nub"), nubs(60), expect(".slot-panel .panel .kind", "TASK")],
  });
  add("compact/shell", "mesa", {
    sizes: "portrait",
    actions: [
      viewExpect("timeline"),
      expect(".toolbar button", "Plans"),
      expect(".toolbar button", "Plan"),
      count(".sidebar", 0),
      count(".slot-panel", 0),
      count('[role="dialog"]', 0),
    ],
  });
  add("compact/plan-sheet", "mesa", { sizes: "portrait", dialog: true, actions: planSheet });
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
    ],
    sizes: "portrait",
  });
  add("narrow-shell", "mesa", { sizes: "narrow", actions: [viewExpect("timeline"), expect(".toolbar button", "Plans"), expect(".toolbar button", "Plan")] });
  add("narrow-sheet", "mesa", { sizes: "narrow", dialog: true, actions: planSheet });
  add("narrow-dialog", "mesa", { sizes: "narrow", dialog: true, actions: calendarFromSheet });
  add("narrow-sync-dialog", "sync-dialog", {
    sizes: "narrow",
    dialog: true,
    actions: [click(".toolbar .sync-chip", "Local only"), expect('[role="dialog"] [role="tab"][aria-selected="true"]', "Set up sync"), expect('[role="dialog"] button', "Create or join space")],
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
  add("history", "mesa", { actions: [reveal(".slot-panel .panel h2", "History"), count(".slot-panel .history li", 40)] });
  add("revert-preview", "mesa", {
    dialog: true,
    actions: [click(".slot-panel .history button", "Revert this action"), expect('[role="dialog"] h3', "Revert this action"), expect(".revert-text p")],
  });

  const names = new Set();
  out.forEach((s) => {
    if (names.has(s.name)) throw new Error(`layout-probe: two states are named ${s.name}`);
    names.add(s.name);
    const last = s.actions[s.actions.length - 1];
    if (last === undefined || (last.expect === undefined && last.count === undefined && last.loaded === undefined)) {
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
  smallest: ["1024x700"],
  standard: ["1440x920"],
  phone: namesOf(PHONE),
  portrait: namesOf(PORTRAIT),
  landscape: namesOf(LANDSCAPE),
  "ipad-pro": ["1366x1024"],
  narrow: namesOf(NARROW),
  "touch-wide": namesOf([...PORTRAIT, ...LANDSCAPE, ...NARROW]),
  timeline: namesOf([...DESKTOP, ...PORTRAIT, ...LANDSCAPE, ...NARROW]),
};

const sizesOf = (s) => {
  const sizes = SIZES[s.sizes];
  if (sizes === undefined) throw new Error(`layout-probe: state ${s.name} names no known sizes: ${s.sizes}`);
  return sizes;
};

const SHIM = String.raw`
(function () {
  var P = window.__PROBE__;
  localStorage.clear();
  if (P.place !== null) localStorage.setItem("webboard.place", JSON.stringify(P.place));
  window.__PROBE_MISSING__ = [];
  window.__PROBE_TICKETS__ = {};
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

  var POPUPS = ".overlay, .choice-list, .plan-menu-list";
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
      if (front !== null && front.closest(".tl-corner") !== null && el.closest(".tl-scale") !== null) continue;
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
    var picked = Array.prototype.slice.call(bar.querySelectorAll("button, .seg, .wordmark, .toolbar-plan")).filter(rendered);
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

const ACT = String.raw`
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
  if (a.reveal !== undefined) {
    var v = matching(a.reveal[0], a.reveal[1]);
    if (v.hit === undefined) return { fail: missed(a.reveal[0], a.reveal[1], v.nodes) };
    v.hit.scrollIntoView({ block: "start" });
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

class Cdp {
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

async function findShell() {
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

async function devtoolsUrl(child, profile, stderrOf, startError) {
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

async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
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

const describeAction = (a) => JSON.stringify(a);

async function runState(cdp, sessionId, origin, state, errors, traffic) {
  errors.length = 0;
  traffic.current = freshTraffic();
  const seen = () => [...errors, ...traffic.current.pageErrors];
  const unreached = (why) => ({ unreached: why, errors: seen() });
  const checked = () => {
    if (traffic.current.crash !== null) throw traffic.current.crash;
  };
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
    } else {
      const got = await evaluate(cdp, sessionId, `window.__probeAct(${JSON.stringify(action)})`, true);
      if (got.fail !== undefined) return unreached(`${describeAction(action)}: ${got.fail}`);
      if (got.at !== undefined) await pointer(cdp, sessionId, got.at);
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

async function stopChild(child) {
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
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
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
      return [name, { docs: Object.fromEntries(Object.entries(f.docs).map(([id, b]) => [id, base64(b)])), ipc: f.ipc, newDoc: f.newDoc === undefined ? null : base64(f.newDoc) }];
    }),
  );

  const indexHtml = (name) => {
    const state = picked.find((s) => s.name === name);
    if (state === undefined) return null;
    const payload = JSON.stringify({
      place: state.place,
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
