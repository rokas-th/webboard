import * as Y from "yjs";

const LETTER = { own: "o", push: "p", recalendar: "r", undo: "u", revert: "v", resolution: "s" };

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const DAY_MS = 86_400_000;

export const PLAN_IDS = {
  mesa: "planMesa001",
  blank: "planBlank01",
  scale: "planScale01",
  long: "planLong001",
  longRtl: "planLongRtl",
  phone: "planPhone01",
  status: "planStatus1",
  example: "planExample",
};

export const OUT_OF_RANGE = { code: "holidays.out_of_range", message: "OpenHolidays has CH holidays for 2020–2030, not 2031" };

export const UNREADABLE_ID = "badIphone01";

export const UNREADABLE_LINE = `A change from iPhone could not be read: Action ${UNREADABLE_ID} has a malformed lbl. Update WebBoard on this device.`;

const ORDER_LIMIT = 62 + 62 * 62;

const ZH = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const ZH_KEY = "oh:CH:CH-ZH";
const FETCHED_AT = "2026-11-01T07:00:00Z";

const holiday = (date, name, kind = "public", scope = null) => ({ date, name, kind, sourceId: `oh-${date}`, scope });

const HOLIDAYS = {
  2026: [
    holiday("2026-01-01", "New Year's Day"),
    holiday("2026-01-02", "Berchtold's Day"),
    holiday("2026-04-03", "Good Friday"),
    holiday("2026-04-06", "Easter Monday"),
    holiday("2026-04-20", "Sechseläuten", "half", "Municipality of Zürich"),
    holiday("2026-05-01", "Labour Day"),
    holiday("2026-05-14", "Ascension Day"),
    holiday("2026-05-25", "Whit Monday"),
    holiday("2026-08-01", "Swiss National Day"),
    holiday("2026-09-14", "Knabenschiessen", "optional", "Municipality of Zürich"),
    holiday("2026-12-25", "Christmas Day"),
    holiday("2026-12-26", "St. Stephen's Day"),
  ],
  2027: [
    holiday("2027-01-01", "New Year's Day"),
    holiday("2027-01-02", "Berchtold's Day"),
    holiday("2027-03-26", "Good Friday"),
    holiday("2027-03-29", "Easter Monday"),
    holiday("2027-04-19", "Sechseläuten", "half", "Municipality of Zürich"),
    holiday("2027-05-01", "Labour Day"),
    holiday("2027-05-06", "Ascension Day"),
    holiday("2027-05-17", "Whit Monday"),
    holiday("2027-08-01", "Swiss National Day"),
    holiday("2027-09-13", "Knabenschiessen", "optional", "Municipality of Zürich"),
    holiday("2027-12-25", "Christmas Day"),
    holiday("2027-12-26", "St. Stephen's Day"),
  ],
};

const holidayYear = (year) => ({ region: ZH_KEY, year, days: HOLIDAYS[year].map((d) => ({ ...d })), fetchedAt: FETCHED_AT });

const own = (u, v) => ({ u, v, c: "own" });

const q = (name) => `“${name}”`;

const idOf = (prefix, n) => `${prefix}${String(n).padStart(11 - prefix.length, "0")}`;

export function orderKey(n) {
  if (!Number.isInteger(n) || n < 0 || n >= ORDER_LIMIT) throw new Error(`layout fixtures: orderKey ${n} out of range`);
  if (n < 62) return `a${DIGITS[n]}`;
  const m = n - 62;
  return `b${DIGITS[Math.floor(m / 62)]}${DIGITS[m % 62]}`;
}

function letterOf(c) {
  if (!Object.hasOwn(LETTER, c)) throw new Error(`layout fixtures: unknown cause ${c}`);
  return LETTER[c];
}

export function encodeTuple(a) {
  const t = [a.dev, a.ses, a.at, [...a.par], a.lbl, a.w.flatMap((w) => [w.u, w.v, letterOf(w.c)])];
  return a.meta === undefined ? t : [...t, { ...a.meta }];
}

export function encodeLoad(l) {
  const entries = [l.snapshot ?? new Uint8Array(), ...(l.records ?? [])];
  const out = new Uint8Array(13 + entries.reduce((n, e) => n + 4 + e.length, 0));
  const view = new DataView(out.buffer);
  view.setUint8(0, l.torn === true ? 1 : 0);
  view.setBigUint64(1, BigInt(l.lastSeq), true);
  view.setUint32(9, entries.length, true);
  entries.reduce((at, e) => {
    view.setUint32(at, e.length, true);
    out.set(e, at + 4);
    return at + 4 + e.length;
  }, 13);
  return out;
}

const frame = (ydoc) => encodeLoad({ snapshot: Y.encodeStateAsUpdate(ydoc), lastSeq: 1 });

function docOf(entries, notes) {
  const ydoc = new Y.Doc();
  const actions = ydoc.getMap("actions");
  const texts = ydoc.getMap("notes");
  ydoc.transact(() => {
    entries.forEach(([id, raw]) => actions.set(id, raw));
    notes.forEach(([item, text]) => {
      const t = new Y.Text();
      texts.set(item, t);
      if (text !== "") t.insert(0, text);
    });
  });
  return ydoc;
}

class Log {
  constructor(prefix, start) {
    this.prefix = prefix;
    this.at = start;
    this.n = 0;
    this.entries = [];
    this.notes = [];
  }

  act({ dev = "mac", ses = "sesMacSetup", par, lbl, w, notes = [] }) {
    const id = idOf(this.prefix, this.n);
    this.n += 1;
    this.at += 7 * 60_000;
    const parents = par ?? (this.entries.length === 0 ? [] : [this.entries[this.entries.length - 1][0]]);
    this.entries.push([id, encodeTuple({ dev, ses, at: this.at, par: parents, lbl, w })]);
    this.notes.push(...notes);
    return id;
  }

  raw(id, value) {
    this.entries.push([id, value]);
  }

  head() {
    return this.entries[this.entries.length - 1][0];
  }

  doc() {
    return docOf(this.entries, this.notes);
  }

}

function rootWrites(name, region) {
  return [
    own("pn", name),
    own("cr", region === null ? null : { ...region }),
    own("cw", [1, 2, 3, 4, 5]),
    ...(region === null ? [] : [own("ch:2026", holidayYear(2026)), own("ch:2027", holidayYear(2027))]),
  ];
}

function itemWrites(item, order) {
  const kind = item.kind ?? "task";
  const base = [own(`e:${item.id}`, { k: kind, t: false }), own(`n:${item.id}`, item.name), own(`p:${item.id}`, [item.parent ?? null, order])];
  if (kind === "group") return base;
  const dur = kind === "milestone" ? 0 : (item.dur ?? 3);
  return [...base, own(`s:${item.id}`, [item.start ?? null, dur, item.status ?? "todo", item.progress ?? 0, item.horizon ?? "later"])];
}

const linkWrite = (from, to, type = "FS", lag = 0) => own(`l:${from}>${to}`, [type, lag]);

function orders(items) {
  const count = new Map();
  return new Map(
    items.map((item) => {
      const parent = item.parent ?? null;
      const n = count.get(parent) ?? 0;
      count.set(parent, n + 1);
      return [item.id, orderKey(n)];
    }),
  );
}

const T = (id, name, o = {}) => ({ id, name, ...o });
const fs = (from) => ({ from, type: "FS", lag: 0 });

const MESA = [
  T("g1", "Site works · dome and pier", { kind: "group" }),
  T("t1", "Pour the pier and the dome footings", { parent: "g1", start: "2026-11-02", dur: 5, status: "done", progress: 100 }),
  T("t2", "Dome shell delivery, crane and bolts", { parent: "g1", start: "2026-11-03", dur: 4, status: "doing", progress: 80 }),
  T("t6", "Telescope mount model chosen", { parent: "g1", start: "2026-11-02", dur: 4, status: "done", progress: 100 }),
  T("m1", "Dome set", { kind: "milestone", parent: "g1", start: "2026-11-06", deps: [fs("t1"), fs("t2"), fs("t6")] }),
  T("g2", "Commission", { kind: "group" }),
  T("t3", "Tracking: review results", { parent: "g2", start: "2026-11-09", dur: 4, deps: [fs("t2")] }),
  T("t4", "Camera and filter kit", { parent: "g2", start: "2026-11-04", dur: 6, status: "doing", progress: 50 }),
  T("t5", "Image quality check: mirror and camera", { parent: "g2", start: "2026-11-11", dur: 5 }),
  T("t7", "First light: dry runs", {
    parent: "g2",
    start: "2026-11-18",
    dur: 3,
    deps: [fs("t3"), fs("t4"), fs("t5")],
    note: "Plan-only task: the guides run it on the night, and it needs no checklist.",
  }),
  T("m2", "Optics ready", { kind: "milestone", parent: "g2", start: "2026-11-23", deps: [fs("t7")] }),
  T("g3", "Visitor services", { kind: "group" }),
  T("t10", "Website: pick a CMS host", { parent: "g3", start: "2026-11-09", dur: 5, status: "doing", progress: 30 }),
  T("t11", "Website: build the programme pages", { parent: "g3", start: "2026-11-16", dur: 10, deps: [fs("t10")] }),
  T("t8", "Signage: trail maps and safety notes", { parent: "g3", start: "2026-11-16", dur: 8 }),
  T("m3", "Signs placed", { kind: "milestone", parent: "g3", start: "2026-11-30", deps: [fs("t8")] }),
  T("t9", "Volunteers: recruit and train crews", {
    parent: "g3",
    start: "2026-11-23",
    dur: 20,
    status: "doing",
    progress: 55,
    note: "Covers each guided evening of the first season, so its progress follows the bookings made so far.",
  }),
  T("t12", "School visits: draft the class offer", { parent: "g3", start: "2026-11-30", dur: 5 }),
  T("g4", "Debut", { kind: "group" }),
  T("t13", "Permits and insurance papers", {
    parent: "g4",
    start: "2027-01-05",
    dur: 6,
    deps: [fs("t9"), fs("t11"), fs("t12")],
    note: "Plan-only task. Filed by the club treasurer alone.",
  }),
  T("m4", "Opening night", { kind: "milestone", parent: "g4", start: "2027-01-15", deps: [fs("m2"), fs("m3"), fs("t13")] }),
  T("u1", "Kids star parties", { horizon: "next" }),
  T("u2", "Solar telescope add-on", { horizon: "later" }),
  T("u3", "Live-stream the eclipse", { horizon: "later" }),
  T("u4", "Membership and season pass", { horizon: "later" }),
  T("u5", "Gift shop counter", { horizon: "later" }),
];

const LINKED_ON_ADD = new Set(["m2", "m3", "t11"]);

const START = Date.UTC(2026, 10, 2, 7, 0);

const nameOf = (items, id) => {
  const found = items.find((i) => i.id === id);
  if (found === undefined) throw new Error(`layout fixtures: no item ${id}`);
  return found.name;
};

function addItems(log, items, linkedOnAdd) {
  const order = orders(items);
  items.forEach((item) => {
    const links = linkedOnAdd.has(item.id) ? (item.deps ?? []).map((d) => linkWrite(d.from, item.id, d.type, d.lag)) : [];
    log.act({
      lbl: `Added ${item.kind ?? "task"} ${q(item.name)}`,
      w: [...itemWrites(item, order.get(item.id)), ...links],
      notes: [[item.id, item.note ?? ""]],
    });
  });
  items
    .filter((item) => !linkedOnAdd.has(item.id))
    .flatMap((item) => (item.deps ?? []).map((d) => ({ ...d, to: item.id })))
    .forEach((d) =>
      log.act({ lbl: `Linked ${q(nameOf(items, d.from))} → ${q(nameOf(items, d.to))} (${d.type})`, w: [linkWrite(d.from, d.to, d.type, d.lag)] }),
    );
}

function mesaLog(prefix) {
  const log = new Log(prefix, START);
  log.act({ lbl: `Created the plan ${q("MESA 1.0")}`, w: rootWrites("MESA 1.0", ZH) });
  addItems(log, MESA, LINKED_ON_ADD);
  return log;
}

const sched = (start, dur, status = "todo", progress = 0, horizon = "later") => [start, dur, status, progress, horizon];

function choicesLog() {
  const log = mesaLog("mesaC");
  const head = log.head();
  const m0 = log.act({ ses: "sesMacOne01", par: [head], lbl: `Renamed ${q("Tracking: review results")} to ${q("Tracking: review results and fixes")}`, w: [own("n:t3", "Tracking: review results and fixes")] });
  const m1 = log.act({ ses: "sesMacOne01", par: [m0], lbl: `Scheduled ${q("Tracking: review results and fixes")} from 10 Nov`, w: [own("s:t3", sched("2026-11-10", 4))] });
  const mDel = log.act({ ses: "sesMacOne01", par: [m1], lbl: `Moved ${q("Gift shop counter")} to the Trash`, w: [own("e:u5", { k: "task", t: true })] });
  log.act({ ses: "sesMacOne01", par: [mDel], lbl: "Changed the calendar", w: [own("ct:2026-12-24", { kind: "off" })] });
  const i1 = log.act({ dev: "iphone", ses: "sesIphone01", par: [m0], lbl: `Scheduled ${q("Tracking: review results and fixes")} from 11 Nov`, w: [own("s:t3", sched("2026-11-11", 4))] });
  const iDel = log.act({ dev: "iphone", ses: "sesIphone01", par: [i1], lbl: `Renamed ${q("Gift shop counter")} to ${q("Gift shop counter v2")}`, w: [own("n:u5", "Gift shop counter v2")] });
  log.act({ dev: "iphone", ses: "sesIphone01", par: [iDel], lbl: "Changed the calendar", w: [own("ct:2026-12-24", { kind: "add", name: "Christmas Eve" })] });
  log.act({ ses: "sesMacBack1", par: [head], lbl: `Scheduled ${q("Tracking: review results")} from 12 Nov`, w: [own("s:t3", sched("2026-11-12", 4))] });
  return log;
}

function twoChoicesLog() {
  const log = mesaLog("mesaT");
  const head = log.head();
  const mN = log.act({ ses: "sesMacOne01", par: [head], lbl: `Renamed ${q("Image quality check: mirror and camera")} to ${q("Image quality check: mirrors")}`, w: [own("n:t5", "Image quality check: mirrors")] });
  log.act({ ses: "sesMacOne01", par: [mN], lbl: "Changed the calendar", w: [own("ct:2026-12-31", { kind: "off" })] });
  const iN = log.act({ dev: "iphone", ses: "sesIphone01", par: [head], lbl: `Renamed ${q("Image quality check: mirror and camera")} to ${q("Image quality: mirror and camera")}`, w: [own("n:t5", "Image quality: mirror and camera")] });
  log.act({ dev: "iphone", ses: "sesIphone01", par: [iN], lbl: "Changed the calendar", w: [own("ct:2026-12-31", { kind: "add", name: "Year-end close" })] });
  return log;
}

const SPRINT = [
  T("S", "Sprint 4", { kind: "group" }),
  T("Review", "Review", { parent: "S", start: "2026-11-12", dur: 2 }),
  T("Ship", "Ship", { parent: "S", start: "2026-11-12", dur: 1 }),
  T("Build", "Build", { parent: "S", start: "2026-11-16", dur: 1, deps: [fs("Review")] }),
];

const PHONE_MOVE_LABEL = (days) => `Moved 2 items later by ${days} working days; 1 dependent item moved`;

function phoneChoiceLog() {
  const log = new Log("phone", START);
  log.act({ lbl: `Created the plan ${q("Sprint plan")}`, w: rootWrites("Sprint plan", null) });
  addItems(log, SPRINT, new Set(["Build"]));
  const head = log.head();
  const moved = (start, build) => [own("s:Review", sched(start, 2)), own("s:Ship", sched(start, 1)), { u: "s:Build", v: sched(build, 1), c: "push" }];
  log.act({ ses: "sesMacOne01", par: [head], lbl: PHONE_MOVE_LABEL(2), w: moved("2026-11-16", "2026-11-18") });
  log.act({ dev: "iphone", ses: "sesIphone01", par: [head], lbl: PHONE_MOVE_LABEL(5), w: moved("2026-11-19", "2026-11-23") });
  return log;
}

function unreadableLog() {
  const log = mesaLog("mesaU");
  const head = log.head();
  log.raw(UNREADABLE_ID, ["iphone", "sesIphone01", START + 9 * DAY_MS, [head], 7, ["n:u1", "Kids star parties (iPhone)", "o"]]);
  log.raw("kidIphone01", encodeTuple({ dev: "iphone", ses: "sesIphone01", at: START + 9 * DAY_MS + 60_000, par: [UNREADABLE_ID], lbl: `Moved ${q("Kids star parties")} to Now`, w: [own("s:u1", sched(null, 3, "todo", 0, "now"))] }));
  return log;
}

const EPOCH_WEEKDAY_OFFSET = 3;

const dayOf = (iso) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const isoOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const isWeekend = (day) => ((day + EPOCH_WEEKDAY_OFFSET) % 7) + 1 > 5;

function addWorkdays(iso, n) {
  const step = (day, left) => (isWeekend(day) ? step(day + 1, left) : left === 0 ? day : step(day + 1, left - 1));
  return isoOf(step(dayOf(iso), n));
}

const HORIZONS = ["now", "next", "later"];

function scaleLog() {
  const log = new Log("scale", START);
  log.act({ lbl: `Created the plan ${q("Scale: 1,000 items")}`, w: rootWrites("Scale: 1,000 items", null) });
  const groups = Array.from({ length: 20 }, (_, g) => {
    const gid = `sg${String(g + 1).padStart(2, "0")}`;
    const kids = Array.from({ length: 49 }, (_, j) => {
      const milestone = j % 10 === 9;
      return {
        id: `${gid}k${String(j + 1).padStart(2, "0")}`,
        name: `WS${String(g + 1).padStart(2, "0")} ${milestone ? "gate" : "task"} ${String(j + 1).padStart(2, "0")}`,
        kind: milestone ? "milestone" : "task",
        parent: gid,
        start: addWorkdays("2026-11-02", 2 * j),
        dur: milestone ? 0 : 1,
        horizon: HORIZONS[j % 3],
      };
    });
    return { group: { id: gid, name: `Workstream ${String(g + 1).padStart(2, "0")}`, kind: "group" }, kids };
  });
  const order = orders(groups.flatMap((g) => [g.group, ...g.kids]));
  groups.forEach((g) =>
    log.act({
      lbl: `Added group ${q(g.group.name)}`,
      w: [g.group, ...g.kids].flatMap((item) => itemWrites(item, order.get(item.id))),
      notes: [g.group, ...g.kids].map((item) => [item.id, ""]),
    }),
  );
  const links = [1, 2, 3]
    .flatMap((k) => groups.flatMap((g) => g.kids.slice(k).map((kid, j) => linkWrite(g.kids[j].id, kid.id))))
    .slice(0, 2000);
  log.act({ lbl: "Linked the workstreams", w: links });
  return log;
}

const PHRASE =
  "On the first clear evening, the volunteers roll back the dome, slew the new telescope across the southern sky, read the seeing off the guide camera, note which eyepieces the children reach easily and pack the red torches before the final bus leaves the hill ";

function long(prefix) {
  const cut = `${prefix} ${PHRASE.repeat(3)}`.slice(0, 300);
  return cut.endsWith(" ") ? `${cut.slice(0, 299)}s` : cut;
}

const normalizeName = (raw) => raw.replace(/\s+/g, (run) => (/[\n\r\t]/.test(run) ? " " : run)).trim();

const LONG = {
  plan: long("Plan"),
  group: long("Group"),
  task: long("Task"),
  milestone: long("Milestone"),
  later: long("Later"),
  emoji: "🚀 Launch ✨ review 👩‍💻 with the whole team 🎉 and the 🇨🇭 partners 🔭🌌",
  emojiReversed: "🔭🌌 partners 🇨🇭 the and 🎉 team whole the with 👩‍💻 review ✨ Launch 🚀",
  arabic: "تركيب قبة المرصد وضبط التلسكوب قبل ليلة الافتتاح مع فريق النادي",
  hebrew: "הכנת מפת השמים לקראת ערב הפתיחה במצפה",
  multi: normalizeName("Kick-off notes\nfrom the vendor workshop\r\n\tsecond line kept"),
  rtlPlan: "خطة الافتتاح ١٫٠ 🔭 First night",
};

export const LONG_NAMES = Object.values(LONG);

const LONG_ITEMS = [
  T("lg1", LONG.group, { kind: "group" }),
  T("lt1", LONG.task, { parent: "lg1", start: "2026-11-10", dur: 5, status: "doing", progress: 40, horizon: "now" }),
  T("lt2", LONG.emoji, { parent: "lg1", start: "2026-11-12", dur: 4, horizon: "now", deps: [fs("lt1")] }),
  T("lt3", LONG.arabic, { parent: "lg1", start: "2026-11-18", dur: 3, horizon: "next", deps: [fs("lt2")] }),
  T("lt4", LONG.hebrew, { start: "2026-11-16", dur: 6, horizon: "next" }),
  T("lt5", LONG.multi, { start: "2026-11-11", dur: 2, horizon: "now" }),
  T("lm1", LONG.milestone, { kind: "milestone", parent: "lg1", start: "2026-11-25", deps: [fs("lt3")] }),
  T("lu1", LONG.later, { horizon: "later" }),
  T("lu2", LONG.emojiReversed, { horizon: "now" }),
];

function longLog() {
  const log = new Log("longN", START);
  log.act({ lbl: `Created the plan ${q(LONG.plan)}`, w: rootWrites(LONG.plan, ZH) });
  addItems(log, LONG_ITEMS, new Set());
  return log;
}

function rtlLog() {
  const log = new Log("longR", START);
  log.act({ lbl: `Created the plan ${q(LONG.rtlPlan)}`, w: rootWrites(LONG.rtlPlan, ZH) });
  return log;
}

const EMPTY_YEARS = [2028, 2029, 2030];

const STATUS_ITEMS = [
  T("A", "Design review", { start: "2026-11-16", dur: 3, horizon: "now" }),
  T("B", "Build", { start: "2026-11-17", dur: 2, horizon: "now", deps: [fs("A")] }),
  T("C", "Long-term support review", { start: "2031-03-04", dur: 2, horizon: "later" }),
];

function statusLog() {
  const log = new Log("statS", START);
  log.act({
    lbl: `Created the plan ${q(LONG.plan)}`,
    w: [...rootWrites(LONG.plan, ZH), ...EMPTY_YEARS.map((year) => own(`ch:${year}`, { region: ZH_KEY, year, days: [], fetchedAt: FETCHED_AT }))],
  });
  addItems(log, STATUS_ITEMS, new Set());
  return log;
}

function exampleLog() {
  const log = new Log("exmpl", START);
  log.act({ lbl: "Created the example plan", w: rootWrites("Example: Website relaunch", ZH) });
  return log;
}

function blankLog() {
  const log = new Log("blank", START);
  log.act({ lbl: `Created the plan ${q("Blank plan")}`, w: rootWrites("Blank plan", ZH) });
  return log;
}

function localIndex(plans, trashed) {
  const log = new Log("ixLoc", START);
  log.act({ lbl: "Name device", w: [own("dn:mac", "Mac"), own("dn:iphone", "iPhone")] });
  plans.forEach((id) => log.act({ lbl: "Add plan", w: [own(`ip:${id}`, { t: false })] }));
  const gone = trashed === true ? plans : trashed === false ? [] : trashed;
  gone.forEach((id) => log.act({ lbl: "Move plan to Trash", w: [own(`ip:${id}`, { t: true })] }));
  return log.doc();
}

const yearAnswer = (year) => ({ days: HOLIDAYS[year].map((d) => ({ ...d })), fetchedAt: FETCHED_AT, fromCache: true, coverage: [2020, 2030] });

const emptyYearAnswer = () => ({ days: [], fetchedAt: FETCHED_AT, fromCache: true, coverage: [2020, 2030] });

const withStatusYears = (f) => ({
  ...f,
  ipc: {
    ...f.ipc,
    holidays_year: {
      __byArg: "year",
      map: {
        2026: yearAnswer(2026),
        2027: yearAnswer(2027),
        ...Object.fromEntries(EMPTY_YEARS.map((y) => [y, emptyYearAnswer()])),
        2031: { __reject: { ...OUT_OF_RANGE } },
      },
    },
  },
});

const COUNTRIES = [
  { code: "AT", name: "Austria", src: "openholidays" },
  { code: "CH", name: "Switzerland", src: "openholidays" },
  { code: "DE", name: "Germany", src: "openholidays" },
  { code: "GB", name: "United Kingdom", src: "govuk" },
  { code: "US", name: "United States", src: "opm" },
];

const SUBDIVISIONS = {
  CH: [
    { code: "CH-BE", name: "Bern", children: [] },
    { code: "CH-LU", name: "Lucerne", children: [] },
    { code: "CH-ZH", name: "Zürich", children: [{ code: "CH-ZH-ZH-ZH", name: "Zürich", children: [] }] },
  ],
};

function fixtureOf(plans, o = { trashed: false }) {
  const docs = {
    local: frame(localIndex(plans.map((p) => p.id), o.trashed)),
    ...Object.fromEntries(plans.map((p) => [p.id, frame(p.log.doc())])),
  };
  return {
    docs,
    ipc: {
      device_info: { deviceId: "mac", platform: "macos" },
      settings_read: { v: 1, lastRegion: { ...ZH }, names: Object.fromEntries(plans.map((p) => [p.id, p.name])), exampleOffered: true },
      settings_write: null,
      store_list: Object.keys(docs),
      store_append: null,
      store_compact: null,
      holidays_year: { __byArg: "year", map: { 2026: yearAnswer(2026), 2027: yearAnswer(2027) } },
      holidays_countries: COUNTRIES,
      holidays_subdivisions: { __byArg: "country", map: SUBDIVISIONS },
      "plugin:event|listen": 1,
      "plugin:event|unlisten": null,
    },
  };
}

function firstStart() {
  const f = fixtureOf([]);
  const settings = Object.fromEntries(Object.entries(f.ipc.settings_read).filter(([k]) => k !== "exampleOffered"));
  return { ...f, newDoc: encodeLoad({ lastSeq: 0 }), ipc: { ...f.ipc, settings_read: settings } };
}

const copyOf = (f) => ({ docs: Object.fromEntries(Object.entries(f.docs).map(([id, b]) => [id, b.slice()])), ipc: JSON.parse(JSON.stringify(f.ipc)) });

const mesa = (log) => ({ id: PLAN_IDS.mesa, name: "MESA 1.0", log });

const onLinux = (f) => ({ ...f, ipc: { ...f.ipc, device_info: { deviceId: "linux", platform: "linux" } } });

const PROBE_SPACE = { server: "https://probe.invalid", spaceId: "sp000000000", deviceId: "mac", deviceName: "Mac" };
const SPACE_INDEX = "ix-sp000000000";
const SYNC_OFF = { space: null, revoked: false };
const PROBE_TICKET = { ticket: "tk_probe", expiresAt: new Date(2026, 10, 9, 10, 0, 0, 0).getTime() };

export const UPDATE_VERSION = "0.1.1";
export const UPDATE_CHECK_FAILED =
  "error sending request for url (https://webboard.rokass.org/releases/latest.json): client error (Connect): dns error: failed to lookup address information: nodename nor servname provided, or not known";
const UPDATE_SIZE = 24 * 1024 * 1024;
const UPDATE_FOUND = {
  rid: 1,
  currentVersion: "0.1.0",
  version: UPDATE_VERSION,
  date: "2026-11-09 08:00:00.0 +00:00:00",
  body: "",
  rawJson: {},
};

const withUpdate = (f, answers) => ({ docs: copyOf(f).docs, ipc: { ...copyOf(f).ipc, ...answers } });

function spaceIndex(plans) {
  const log = new Log("ixSpc", START);
  log.act({ lbl: "Name device", w: [own("dn:mac", "Mac"), own("dn:iphone", "iPhone")] });
  plans.forEach((id) => log.act({ lbl: "Add plan", w: [own(`ip:${id}`, { t: false })] }));
  return log.doc();
}

export const CONVERTED_FILE = "Probe plan 20260901.gantt";

const ganttTask = (id, name, start, end, dur, extra = {}) => ({
  TaskID: id,
  TaskName: name,
  StartDate: `${start}T06:00:00.000Z`,
  EndDate: `${end}T15:00:00.000Z`,
  Duration: dur,
  DurationUnit: "day",
  Progress: 0,
  Predecessor: "",
  resources: [],
  color: "#3366ff",
  info: "",
  subtasks: [],
  ...extra,
});

const GANTT_SOURCE = {
  data: [
    ganttTask(1, "Phase", "2026-09-07", "2026-09-18", 10, {
      Predecessor: null,
      color: "#999999",
      subtasks: [
        ganttTask(2, "Survey", "2026-09-07", "2026-09-11", 5, { Progress: 100, info: "<p>Site &amp; access</p>" }),
        ganttTask(3, "Build", "2026-09-14", "2026-09-18", 5, { Progress: 40, Predecessor: "2FS" }),
        ganttTask(4, "Handover", "2026-09-18", "2026-09-18", 0, { Predecessor: "3FF" }),
      ],
    }),
  ],
  resources: [],
  projectStartDate: null,
  projectEndDate: null,
  advanced: {
    timezone: "Europe/Zurich",
    timezoneOffset: -60,
    dependencyConflict: "Add Offset to Dependency",
    workWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    workTime: [
      { from: 8, to: 12 },
      { from: 13, to: 17 },
    ],
    holidays: [],
  },
};

function converted() {
  const f = fixtureOf([]);
  return {
    ...f,
    ipc: {
      ...f.ipc,
      "plugin:dialog|open": `/probe/${CONVERTED_FILE}`,
      file_read: { __bytes: Buffer.from(JSON.stringify(GANTT_SOURCE)).toString("base64") },
    },
  };
}

function syncLocal() {
  const space = mesa(mesaLog("mesaS"));
  const f = fixtureOf([
    { id: PLAN_IDS.example, name: "Example: Website relaunch", log: exampleLog() },
    { id: PLAN_IDS.long, name: LONG.plan, log: longLog() },
    { id: PLAN_IDS.longRtl, name: LONG.rtlPlan, log: rtlLog() },
  ]);
  const names = { ...f.ipc.settings_read.names, [space.id]: space.name };
  const withSpacePlan = { docs: { ...f.docs, [space.id]: frame(space.log.doc()) }, ipc: { ...f.ipc, settings_read: { ...f.ipc.settings_read, names } } };
  return inSpace(withSpacePlan, false, [space.id]);
}

function inSpace(f, revoked, plans = []) {
  const docs = { ...f.docs, [SPACE_INDEX]: frame(spaceIndex(plans)) };
  return {
    docs,
    ipc: { ...f.ipc, store_list: Object.keys(docs), sync_status: { space: { ...PROBE_SPACE }, revoked }, sync_ticket: { ...PROBE_TICKET } },
  };
}

export function buildFixtures() {
  const mesaOnMac = fixtureOf([mesa(mesaLog("mesaM"))]);
  const unreadable = fixtureOf([mesa(unreadableLog())]);
  const fixtures = {
    empty: fixtureOf([]),
    example: firstStart(),
    "all-trashed": fixtureOf([mesa(mesaLog("mesaT"))], { trashed: true }),
    "blank-plan": fixtureOf([{ id: PLAN_IDS.blank, name: "Blank plan", log: blankLog() }]),
    mesa: mesaOnMac,
    "mesa-linux": onLinux(mesaOnMac),
    scale: fixtureOf([{ id: PLAN_IDS.scale, name: "Scale: 1,000 items", log: scaleLog() }]),
    choices: fixtureOf([mesa(choicesLog())]),
    "long-names": fixtureOf([
      { id: PLAN_IDS.long, name: LONG.plan, log: longLog() },
      { id: PLAN_IDS.longRtl, name: LONG.rtlPlan, log: rtlLog() },
    ]),
    unreadable,
    "two-choices": fixtureOf([mesa(twoChoicesLog())]),
    "phone-choice": fixtureOf([{ id: PLAN_IDS.phone, name: "Sprint plan", log: phoneChoiceLog() }]),
    "phone-status": withStatusYears(fixtureOf([{ id: PLAN_IDS.status, name: LONG.plan, log: statusLog() }])),
    "phone-plans": fixtureOf(
      [mesa(mesaLog("mesaP")), { id: PLAN_IDS.long, name: LONG.plan, log: longLog() }, { id: PLAN_IDS.blank, name: "Blank plan", log: blankLog() }],
      { trashed: [PLAN_IDS.blank] },
    ),
    "sync-dialog": copyOf(mesaOnMac),
    "sync-space": inSpace(mesaOnMac, false),
    "sync-local": syncLocal(),
    converted: converted(),
    "sync-receiving": inSpace(unreadable, false),
    "sync-removed": inSpace(mesaOnMac, true),
    "phone-sync-sheet": copyOf(mesaOnMac),
    "phone-removed-banner": inSpace(mesaOnMac, true, [PLAN_IDS.mesa]),
    "update-available": withUpdate(mesaOnMac, { "plugin:updater|check": { ...UPDATE_FOUND } }),
    "update-check-failed": withUpdate(mesaOnMac, { "plugin:updater|check": { __reject: UPDATE_CHECK_FAILED } }),
    "update-downloading": withUpdate(mesaOnMac, {
      "plugin:updater|check": { ...UPDATE_FOUND },
      "plugin:updater|download_and_install": {
        __channel: "onEvent",
        messages: [
          { event: "Started", data: { contentLength: UPDATE_SIZE } },
          { event: "Progress", data: { chunkLength: UPDATE_SIZE / 2 } },
        ],
      },
    }),
  };
  return Object.fromEntries(
    Object.entries(fixtures).map(([name, f]) => [name, { ...f, ipc: { sync_status: { ...SYNC_OFF }, "plugin:updater|check": null, ...f.ipc } }]),
  );
}
