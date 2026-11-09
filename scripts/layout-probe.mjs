import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { buildFixtures, LONG_NAMES, UNREADABLE_ID } from "./layout-fixtures.mjs";

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

const DESKTOP = [
  [1180, 760],
  [1440, 920],
  [1920, 1080],
  [1024, 700],
];

const DIALOG = [
  [1180, 820],
  [820, 1180],
];

const EMPTY_PLAN = "No items yet. Add one with + Task.";
const CALENDAR_BANNER = "The calendar was changed on two devices. Nothing moves until you choose.";
const UNREADABLE_LINE = `A change from iPhone could not be read: Action ${UNREADABLE_ID} has a malformed lbl. Update WebBoard on this device.`;
const PICKED = "Tracking: review results";
const PICKED_CHOICE = "Tracking: review results and fixes";

const expect = (selector, text) => ({ expect: text === undefined ? [selector] : [selector, text] });
const count = (selector, n) => ({ count: [selector, n] });
const click = (selector, text) => ({ click: [selector, text] });
const tap = (selector, text) => ({ tap: [selector, text] });
const key = (k, code, modifiers) => ({ key: { key: k, code, modifiers } });
const reveal = (selector, text) => ({ reveal: [selector, text] });

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
      clip: o.clip === true,
    });

  add("empty", "empty", {
    place: null,
    actions: [expect(".empty-state button", "New plan"), expect(".empty-state button", "Import plan…"), expect(".toolbar .sync-chip", "Local only")],
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
  VIEWS.filter(([slug]) => slug === "timeline-w" || slug === "board" || slug === "list").forEach(([slug, place]) =>
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
  add("choice-dialog", "choices", {
    sizes: "dialog",
    dialog: true,
    actions: [click(".plan-head button.chip-amber", "1 held"), count('[role="dialog"] .choice-col', 3)],
  });
  add("palette", "mesa", {
    dialog: true,
    actions: [key("k", "KeyK", 4), expect('.palette[role="dialog"]'), expect(".palette-item .palette-label")],
  });
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
    if (last === undefined || (last.expect === undefined && last.count === undefined)) {
      throw new Error(`layout-probe: state ${s.name} does not end with an expect`);
    }
  });
  return out;
}

const sizesOf = (s) => (s.sizes === "desktop" ? DESKTOP : s.sizes === "dialog" ? DIALOG : [...DESKTOP, ...DIALOG]);

const SHIM = String.raw`
(function () {
  var P = window.__PROBE__;
  localStorage.clear();
  if (P.place !== null) localStorage.setItem("webboard.place", JSON.stringify(P.place));
  window.__PROBE_MISSING__ = [];
  var RealDate = Date;
  var pin = new RealDate(2026, 10, 9, 9, 0, 0, 0).getTime();
  var started = performance.now();
  function now() {
    return pin + Math.floor(performance.now() - started);
  }
  class PinnedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now());
      else super(...args);
    }
    static now() {
      return now();
    }
  }
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
  var ipc = P.fixture.ipc;
  function missing(cmd, why) {
    window.__PROBE_MISSING__.push(cmd + ": " + why);
    return Promise.reject({ code: "probe.missing", message: "The layout probe has no answer for " + cmd + " (" + why + ")" });
  }
  function answer(cmd, args) {
    if (cmd === "store_load") {
      var doc = args && args.doc;
      if (!(doc in docs)) return missing(cmd, "doc " + doc);
      return Promise.resolve(docs[doc].slice().buffer);
    }
    if (!(cmd in ipc)) return missing(cmd, "no fixture");
    var a = ipc[cmd];
    if (a !== null && typeof a === "object" && !Array.isArray(a) && typeof a.__byArg === "string") {
      var k = String(args ? args[a.__byArg] : undefined);
      if (!(k in a.map)) return missing(cmd, a.__byArg + " " + k);
      return Promise.resolve(JSON.parse(JSON.stringify(a.map[k])));
    }
    return Promise.resolve(JSON.parse(JSON.stringify(a)));
  }
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
  var FULL_MIN_WIDTH = 1024;
  var P = window.__PROBE__;
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
  var narrow = vw < FULL_MIN_WIDTH;
  function scope() {
    return narrow ? document.querySelector('[role="dialog"]') : document.querySelector(".app");
  }
  function inScope(el) {
    var s = scope();
    return s !== null && s.contains(el);
  }

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
                 narrow ? null : document.querySelector(".app"), narrow ? null : document.querySelector(".app-body")];
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
      if (kids.length < 2 || (narrow && !inScope(parent))) return;
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
      if (narrow && !inScope(el)) return false;
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
    if (long.length === 0) return { checked: 0, faults: [] };
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
    return { checked: hits.length, faults: faults.slice(0, 12) };
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
    narrow: narrow,
    fonts: { mono: document.fonts.check('13px "IBM Plex Mono"'), display: document.fonts.check('600 12px "Chakra Petch"') },
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
    names: names(),
    dialogs: dialogs(),
    text: (app === null ? "" : app.textContent.trim()).length,
    missing: window.__PROBE_MISSING__.slice(),
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
  if (a.count !== undefined) {
    var n = document.querySelectorAll(a.count[0]).length;
    if (n !== a.count[1]) return { fail: a.count[0] + " matches " + n + " elements, not " + a.count[1] };
    return { ok: true };
  }
  return { fail: "unknown action " + JSON.stringify(a) };
};
`;

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.waiting = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) {
        this.listeners.forEach((cb) => cb(msg));
        return;
      }
      const pending = this.waiting.get(msg.id);
      if (pending === undefined) return;
      this.waiting.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? null)})`));
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

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
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
  throw new Error(`no chrome-headless-shell under ${SHELL_CANDIDATES.join(" or ")}; install Playwright's chromium-headless-shell first`);
}

function serve(indexHtml) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const body = indexHtml(url.searchParams.get("state") ?? "");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
      res.end(body);
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(DIST, rel);
    if (!file.startsWith(DIST) || !(await exists(file))) {
      res.writeHead(404).end("not found");
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function waitForDevtools(port) {
  for (let i = 0; i < 100; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`).then(
      (r) => r,
      () => null,
    );
    if (res !== null && res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`devtools never came up on port ${port}`);
}

async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId);
  if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function settle(cdp, sessionId) {
  const expr = String.raw`(async function () {
    await document.fonts.ready;
    for (var i = 0; i < 200; i++) {
      var ready = document.querySelector(".app") !== null &&
        (document.querySelector(".plan-head") !== null || document.querySelector(".empty-state") !== null);
      if (ready) break;
      await new Promise(function (r) { setTimeout(r, 25); });
    }
    var last = performance.now();
    var watch = new MutationObserver(function () { last = performance.now(); });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    var start = performance.now();
    while (performance.now() - last < 150 && performance.now() - start < 4000) {
      await new Promise(function (r) { setTimeout(r, 30); });
    }
    watch.disconnect();
    await document.fonts.ready;
    await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    return true;
  })()`;
  await evaluate(cdp, sessionId, expr, true);
}

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

async function runState(cdp, sessionId, origin, state, errors) {
  errors.length = 0;
  await cdp.send("Page.navigate", { url: `${origin}/?state=${encodeURIComponent(state.name)}` }, sessionId);
  await settle(cdp, sessionId);
  await evaluate(cdp, sessionId, ACT);
  for (const action of state.actions) {
    if (action.key !== undefined) {
      await press(cdp, sessionId, action.key);
      await settle(cdp, sessionId);
      continue;
    }
    const got = await evaluate(cdp, sessionId, `window.__probeAct(${JSON.stringify(action)})`);
    if (got.fail !== undefined) return { unreached: `${describeAction(action)}: ${got.fail}` };
    if (got.at !== undefined) await pointer(cdp, sessionId, got.at);
    await settle(cdp, sessionId);
  }
  const reading = await evaluate(cdp, sessionId, MEASURE);
  return { reading, errors: [...errors] };
}

function judge(state, r, errors) {
  const problems = [];
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
  if (state.clip) {
    if (r.names.checked === 0) problems.push("no element shows one of the long names");
    r.names.faults.forEach((f) => problems.push(f));
  }
  if (state.dialog) {
    if (r.dialogs.count !== 1) problems.push(`${r.dialogs.count} elements have role="dialog", not one`);
    r.dialogs.faults.forEach((f) => problems.push(f));
  }
  errors.forEach((e) => problems.push(`the page reported an error: ${e}`));
  return { ok: problems.length === 0, problems };
}

function report(name, viewport, verdict, r) {
  process.stdout.write(`\n${verdict.ok ? "ok  " : "FAIL"} ${name} @ ${viewport}\n`);
  process.stdout.write(`     doc ${r.doc.scrollHeight}/${r.doc.innerHeight}h ${r.doc.scrollWidth}/${r.doc.innerWidth}w   fonts mono=${r.fonts.mono} display=${r.fonts.display}\n`);
  process.stdout.write(`     ${Object.entries(r.overflow).map(([k, v]) => `${k} ${v}`).join(" | ")}\n`);
  verdict.problems.forEach((p) => process.stdout.write(`     ! ${p}\n`));
  r.offenders.forEach((o) => process.stdout.write(`     > past the edge by ${o.over}  [${o.position}]  ${o.path}\n`));
  r.tallest.forEach((t) => process.stdout.write(`     = bottom ${t.bottom} (h ${t.height}) [${t.position}]  ${t.path}${t.clippedBy === null ? "" : ` — but clipped by ${t.clippedBy}`}\n`));
  if (r.narrow) process.stdout.write(`     measures 3-8 judge only the dialog below 1024 px; Task 5.3's compact form brings the shell under them
`);
  if (r.names.checked > 0) process.stdout.write(`     long names checked: ${r.names.checked}\n`);
  if (!verdict.ok) {
    r.chain.forEach((c) =>
      process.stdout.write(`     . ${c.name.padEnd(18)} client ${String(c.client).padStart(5)} scroll ${String(c.scroll).padStart(5)} box ${String(c.top).padStart(7)}..${String(c.bottom).padEnd(7)} x ${String(c.left).padStart(7)}..${String(c.right).padEnd(7)}  ${c.css}\n`),
    );
  }
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
  if (child.exitCode !== null || child.signalCode !== null) return;
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

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    if (at === -1) return null;
    const v = argv[at + 1];
    if (v === undefined) throw new Error(`layout-probe: ${name} needs a value`);
    return v;
  };
  const only = flag("--only");
  const jsonOut = flag("--json");
  const shotDir = flag("--shot");
  const oneSize = flag("--viewport");
  const verbose = argv.includes("--verbose");

  if (!(await exists(join(DIST, "index.html")))) {
    process.stderr.write(`layout-probe: nothing to measure, no index.html under ${DIST}; run npm run build first.\n`);
    process.exit(2);
  }

  const template = await readFile(join(DIST, "index.html"), "utf8");
  if (!template.includes("<head>")) throw new Error("layout-probe: dist/index.html has no <head> to put the shim in");
  const picked = states().filter((s) => only === null || s.name.includes(only));
  if (picked.length === 0) {
    process.stderr.write(`layout-probe: --only ${only} matched no state\n`);
    process.exit(2);
  }
  const built = buildFixtures();
  const fixtures = new Map(
    [...new Set(picked.map((s) => s.fixture))].map((name) => {
      const f = built[name];
      if (f === undefined) throw new Error(`layout-probe: no fixture ${name}`);
      return [name, { docs: Object.fromEntries(Object.entries(f.docs).map(([id, b]) => [id, base64(b)])), ipc: f.ipc }];
    }),
  );

  const indexHtml = (name) => {
    const state = picked.find((s) => s.name === name);
    if (state === undefined) return template;
    const payload = JSON.stringify({ place: state.place, fixture: fixtures.get(state.fixture), clip: state.clip ? LONG_NAMES : [] }).replace(/</g, "\\u003c");
    return template.replace("<head>", `<head>\n    <script>window.__PROBE__ = ${payload};</script>\n    <script>${SHIM}</script>`);
  };
  const server = await serve(indexHtml);
  const origin = `http://127.0.0.1:${server.address().port}`;

  const bin = await findShell();
  const profile = await mkdtemp(join(tmpdir(), "webboard-layout-probe-"));
  const debugPort = 9300 + (process.pid % 500);
  const child = spawn(
    bin,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars=false", "--force-device-scale-factor=1", "--disable-lcd-text", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const cleanup = async () => {
    server.close();
    await stopChild(child);
    await rm(profile, { recursive: true, force: true });
  };

  let version;
  try {
    version = await waitForDevtools(debugPort);
  } catch (e) {
    await cleanup();
    process.stderr.write(`layout-probe: ${e.message}\n${stderr}\n`);
    process.exit(2);
  }

  const rows = [];
  try {
    const cdp = await Cdp.open(version.webSocketDebuggerUrl);
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

    const sizes = [...DESKTOP, ...DIALOG].filter(([w, h]) => oneSize === null || `${w}x${h}` === oneSize);
    if (sizes.length === 0) throw new Error(`layout-probe: --viewport ${oneSize} is none of the probe's sizes`);
    for (const [w, h] of sizes) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
      for (const state of picked.filter((s) => sizesOf(s).some(([sw, sh]) => sw === w && sh === h))) {
        const viewport = `${w}x${h}`;
        const run = await runState(cdp, sessionId, origin, state, errors);
        if (run.unreached !== undefined) {
          rows.push({ state: state.name, viewport, ok: false, unreached: run.unreached });
          process.stdout.write(`\nUNREACHED ${state.name} @ ${viewport}\n     ! ${run.unreached}\n`);
          continue;
        }
        const r = run.reading;
        if (r.missing.length > 0 || r.text === 0) {
          const why = r.missing.length > 0 ? `the app asked for what no fixture answers: ${r.missing.join(", ")}` : "the app painted no text";
          rows.push({ state: state.name, viewport, ok: false, unreached: why, reading: r });
          process.stdout.write(`\nUNREACHED ${state.name} @ ${viewport}\n     ! ${why}\n`);
          continue;
        }
        const verdict = judge(state, r, run.errors);
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
    cdp.close();
  } finally {
    await cleanup();
  }

  printTable(rows);
  const narrowRuns = rows.filter((r) => r.reading !== undefined && r.reading.narrow);
  if (narrowRuns.length > 0) {
    process.stdout.write(`
${narrowRuns.length} run(s) below 1024 px judged measures 3-8 on the dialog only; the desktop shell has no layout there until Task 5.3.
`);
  }
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
    process.stdout.write(`\nlayout-probe: ${unreached.length} state run(s) never reached their state:\n`);
    unreached.slice(0, 20).forEach((r) => process.stdout.write(`  ${r.state} @ ${r.viewport}: ${r.unreached}\n`));
    process.exit(2);
  }
  if (failed.length > 0) process.exit(1);
  process.stdout.write(`\nlayout-probe: PASS, ${rows.length} state runs over ${new Set(rows.map((r) => r.state)).size} states, every one contained.\n`);
}

await main();
