import { describe, expect, it } from "vitest";
import type { Codec, UnitKind } from "./units";
import {
  activity,
  baseline,
  closure,
  codecOf,
  decodeHolidayYear,
  existence,
  holidayYear,
  key,
  link,
  linkEnds,
  name,
  parseKey,
  place,
  refs,
  region,
  sched,
  stateWrites,
  step,
  stepRef,
  tuning,
  validateWrite,
  weekdays,
} from "./units";
import type { PlanState } from "../domain/model";
import { LogState } from "../log/state";
import type { Write } from "../log/types";
import { act } from "../test/act";
import { projectPlan } from "./project";
import { planRules } from "./rules";

const zh = { region: "oh:CH:CH-ZH", year: 2027, days: [{ date: "2027-01-01", name: "Neujahrstag", kind: "public", sourceId: "oh-1", scope: null }], fetchedAt: "2026-11-01" };

const roundTrips: [string, Codec<unknown>, unknown, unknown][] = [
  ["name", name as Codec<unknown>, "Review", "Review"],
  ["existence", existence as Codec<unknown>, { k: "task", t: false }, { k: "task", t: false }],
  [
    "sched",
    sched as Codec<unknown>,
    { start: "2026-11-16", dur: 3, status: "doing", progress: 40, horizon: "now" },
    ["2026-11-16", 3, "doing", 40, "now"],
  ],
  ["sched unscheduled", sched as Codec<unknown>, { start: null, dur: 0, status: "done", progress: 100, horizon: "later" }, [null, 0, "done", 100, "later"]],
  ["place", place as Codec<unknown>, { parent: "G", order: "a0" }, ["G", "a0"]],
  ["place top", place as Codec<unknown>, { parent: null, order: "Zz9" }, [null, "Zz9"]],
  ["refs", refs as Codec<unknown>, { jira: "WB-1" }, { jira: "WB-1" }],
  ["link", link as Codec<unknown>, { type: "SS", lag: -2 }, ["SS", -2]],
  ["link removed", link as Codec<unknown>, null, null],
  ["region oh", region as Codec<unknown>, { src: "openholidays", country: "CH", subdivision: "CH-ZH" }, { src: "openholidays", country: "CH", subdivision: "CH-ZH" }],
  ["region govuk", region as Codec<unknown>, { src: "govuk", division: "scotland" }, { src: "govuk", division: "scotland" }],
  ["region opm", region as Codec<unknown>, { src: "opm" }, { src: "opm" }],
  ["region ics", region as Codec<unknown>, { src: "ics", url: "https://x.test/a.ics", name: "Team" }, { src: "ics", url: "https://x.test/a.ics", name: "Team" }],
  ["region none", region as Codec<unknown>, null, null],
  ["weekdays", weekdays as Codec<unknown>, [1, 2, 3, 4, 5], [1, 2, 3, 4, 5]],
  ["closure", closure as Codec<unknown>, { from: "2026-12-24", to: "2026-12-31", name: "Offsite" }, ["2026-12-24", "2026-12-31", "Offsite"]],
  ["closure one day", closure as Codec<unknown>, { from: "2026-12-24", to: "2026-12-24", name: "X" }, ["2026-12-24", "2026-12-24", "X"]],
  ["closure removed", closure as Codec<unknown>, null, null],
  ["tuning off", tuning as Codec<unknown>, { kind: "off" }, { kind: "off" }],
  ["tuning add", tuning as Codec<unknown>, { kind: "add", name: "Closing" }, { kind: "add", name: "Closing" }],
  ["tuning removed", tuning as Codec<unknown>, null, null],
  ["holidayYear", holidayYear as Codec<unknown>, zh, zh],
  ["holidayYear removed", holidayYear as Codec<unknown>, null, null],
  [
    "baseline",
    baseline as Codec<unknown>,
    { name: "Before", at: "2026-11-08", dates: { A: { start: "2026-11-16", dur: 3 } } },
    { name: "Before", at: "2026-11-08", dates: { A: { start: "2026-11-16", dur: 3 } } },
  ],
  ["baseline removed", baseline as Codec<unknown>, null, null],
  ["activity", activity as Codec<unknown>, false, false],
];

const validWrites: Write[] = [
  { u: "pn", v: "Launch plan", c: "own" },
  { u: "cr", v: { src: "opm" }, c: "own" },
  { u: "cw", v: [1, 2, 3, 4, 5], c: "own" },
  { u: "e:A", v: { k: "milestone", t: true }, c: "own" },
  { u: "n:A", v: "Ship", c: "resolution" },
  { u: "s:A", v: ["2026-11-16", 0, "todo", 0, "later"], c: "push" },
  { u: "p:A", v: [null, "a0"], c: "own" },
  { u: "r:A", v: {}, c: "own" },
  { u: "l:A>B", v: ["FS", 0], c: "own" },
  { u: "cc:X", v: ["2026-12-24", "2026-12-31", "Offsite"], c: "own" },
  { u: "ct:2026-12-24", v: { kind: "work" }, c: "own" },
  { u: "ch:2027", v: zh, c: "own" },
  { u: "b:B1", v: null, c: "own" },
  { u: "a:x1", v: false, c: "undo" },
];

describe("unit keys", () => {
  it("builds and parses every kind", () => {
    const built = [
      key.pn,
      key.cr,
      key.cw,
      key.e("A"),
      key.n("A"),
      key.s("A"),
      key.p("A"),
      key.r("A"),
      key.l("A", "B"),
      key.cc("X"),
      key.ct("2026-12-24"),
      key.ch(2027),
      key.b("B1"),
      key.a("x1"),
    ];
    expect(built).toEqual(validWrites.map((w) => w.u));
    expect(built.map(parseKey)).toEqual([
      { kind: "pn", arg: "" },
      { kind: "cr", arg: "" },
      { kind: "cw", arg: "" },
      { kind: "e", arg: "A" },
      { kind: "n", arg: "A" },
      { kind: "s", arg: "A" },
      { kind: "p", arg: "A" },
      { kind: "r", arg: "A" },
      { kind: "l", arg: "A", to: "B" },
      { kind: "cc", arg: "X" },
      { kind: "ct", arg: "2026-12-24" },
      { kind: "ch", arg: "2027" },
      { kind: "b", arg: "B1" },
      { kind: "a", arg: "x1" },
    ]);
  });

  it("refuses unknown and malformed keys", () => {
    expect(() => parseKey("x:1")).toThrow("Unknown unit key “x:1”");
    expect(() => parseKey("l:abc")).toThrow("l:abc");
    expect(() => parseKey("l:A>B>C")).toThrow("l:A>B>C");
    expect(() => parseKey("pn:x")).toThrow("pn:x");
    expect(() => parseKey("n:")).toThrow("n:");
    expect(() => parseKey("ct:2026-02-30")).toThrow("ct:2026-02-30");
    expect(() => parseKey("ct:0026-12-24")).toThrow("Unit key “ct:0026-12-24” names a date outside 1900-01-01 to 2199-12-31");
    expect(() => parseKey("ct:2200-01-01")).toThrow("Unit key “ct:2200-01-01” names a date outside 1900-01-01 to 2199-12-31");
    expect(parseKey("ct:2199-12-31")).toEqual({ kind: "ct", arg: "2199-12-31" });
    expect(() => parseKey("ch:20x6")).toThrow("ch:20x6");
    expect(() => key.ch(2026.5)).toThrow("ch:2026.5");
  });

  it("reads a link key's two ends and refuses any other key", () => {
    expect(linkEnds("l:A>B")).toEqual({ from: "A", to: "B" });
    expect(() => linkEnds("n:A")).toThrow("Unit n:A is not a link");
    expect(() => linkEnds("l:A")).toThrow("Malformed unit key “l:A”");
  });

  it("decodes a holiday year only under its own year's key", () => {
    expect(decodeHolidayYear("ch:2027", zh)).toEqual(zh);
    expect(decodeHolidayYear("ch:2027", null)).toBeNull();
    expect(() => decodeHolidayYear("ch:2026", zh)).toThrow("ch:2026: year 2027 does not match the key");
    expect(() => validateWrite({ u: "ch:2026", v: zh, c: "own" })).toThrow("ch:2026: year 2027 does not match the key");
    expect(() => decodeHolidayYear("cr", zh)).toThrow("Unit cr is not a holiday year");
  });
});

describe("codecs", () => {
  it.each(roundTrips)("round-trips %s", (_, codec, value, wire) => {
    expect(codec.enc(value)).toEqual(wire);
    expect(codec.dec(wire)).toEqual(value);
    expect(codec.dec(codec.enc(value))).toEqual(value);
  });

  it("throws on malformed values, naming the field", () => {
    expect(() => sched.dec(["2026-02-30", 3, "todo", 0, "later"])).toThrow("s: start");
    expect(() => sched.dec(["2026-11-12", 3, "done", 40, "now"])).toThrow("s: progress");
    expect(() => sched.dec(["2026-11-12", 1.5, "todo", 0, "now"])).toThrow("s: dur");
    expect(() => sched.dec(["2026-11-12", -1, "todo", 0, "now"])).toThrow("s: dur");
    expect(() => sched.dec(["2026-11-12", 1, "todo", 101, "now"])).toThrow("s: progress");
    expect(() => sched.dec(["2026-11-12", 1, "todo", 0, "soon"])).toThrow("s: horizon");
    expect(() => sched.dec(["2026-11-12", 1, "todo", 0])).toThrow("s:");
    expect(() => name.dec(" Review")).toThrow("name");
    expect(() => name.dec("Review ")).toThrow("name");
    expect(() => name.dec("")).toThrow("name");
    expect(() => name.dec("Re\nview")).toThrow("name");
    expect(() => name.dec("Re\rview")).toThrow("name");
    expect(() => weekdays.dec([])).toThrow("cw:");
    expect(() => weekdays.dec([1, 1])).toThrow("cw:");
    expect(() => weekdays.dec([0])).toThrow("cw:");
    expect(() => weekdays.dec([8])).toThrow("cw:");
    expect(() => place.dec([null, "a-0"])).toThrow("p: order");
    expect(() => place.dec([null, ""])).toThrow("p: order");
    expect(() => link.dec(["FS", 0.5])).toThrow("l: lag");
    expect(() => link.dec(["XX", 0])).toThrow("l: type");
    expect(() => existence.dec({ k: "task" })).toThrow("e:");
    expect(() => existence.dec({ k: "task", t: false, x: 1 })).toThrow("e:");
    expect(() => tuning.dec({ kind: "add", name: " Closing" })).toThrow("ct: name");
    expect(() => baseline.dec({ name: "B", at: "2026-11-08", dates: { A: { start: "2026-11-16", dur: -1 } } })).toThrow("b: dates");
    expect(() => refs.dec({ jira: 1 })).toThrow("r:");
    expect(() => region.dec({ src: "govuk", division: "wales" })).toThrow("cr:");
    expect(() => activity.dec(1)).toThrow("a:");
  });

  it("bounds plan dates to 1900..2199, durations to 3650 and lags to 1000", () => {
    const WINDOW = "is not a date from 1900-01-01 to 2199-12-31";
    expect(() => sched.dec(["0026-11-16", 3, "todo", 0, "later"])).toThrow(`s: start ${WINDOW}: "0026-11-16"`);
    expect(() => sched.dec(["1899-12-31", 3, "todo", 0, "later"])).toThrow(`s: start ${WINDOW}`);
    expect(() => sched.dec(["2200-01-01", 3, "todo", 0, "later"])).toThrow(`s: start ${WINDOW}`);
    expect(sched.dec(["1900-01-01", 3650, "todo", 0, "later"])).toMatchObject({ start: "1900-01-01", dur: 3650 });
    expect(sched.dec(["2199-12-31", 0, "todo", 0, "later"])).toMatchObject({ start: "2199-12-31", dur: 0 });
    expect(() => sched.dec(["2026-11-16", 3651, "todo", 0, "later"])).toThrow("s: dur is not a whole number from 0 to 3650: 3651");
    expect(() => sched.dec(["2026-11-16", 200_000_000, "todo", 0, "later"])).toThrow("s: dur is not a whole number from 0 to 3650");
    expect(() => sched.enc({ start: "9999-12-31", dur: 3, status: "todo", progress: 0, horizon: "later" })).toThrow(`s: start ${WINDOW}`);
    expect(link.dec(["FS", -1000])).toEqual({ type: "FS", lag: -1000 });
    expect(link.dec(["SS", 1000])).toEqual({ type: "SS", lag: 1000 });
    expect(() => link.dec(["FS", 1001])).toThrow("l: lag is not a whole number from -1000 to 1000: 1001");
    expect(() => link.dec(["FS", -5_000_000])).toThrow("l: lag is not a whole number from -1000 to 1000");
    expect(() => closure.dec(["2199-12-31", "2200-01-02", "X"])).toThrow(`cc: to ${WINDOW}`);
    expect(() => closure.dec(["1899-12-30", "1900-01-02", "X"])).toThrow(`cc: from ${WINDOW}`);
    expect(() => baseline.dec({ name: "B", at: "2026-11-08", dates: { A: { start: "3026-11-16", dur: 2 } } })).toThrow(`b: dates.A.start ${WINDOW}`);
    expect(() => baseline.dec({ name: "B", at: "0026-11-08", dates: {} })).toThrow(`b: at ${WINDOW}`);
    expect(() => baseline.dec({ name: "B", at: "2026-11-08", dates: { A: { start: "2026-11-16", dur: 3651 } } })).toThrow("b: dates.A.dur is not a whole number from 0 to 3650");
  });

  it("refuses a closure that ends before it starts", () => {
    expect(() => closure.dec(["2026-12-31", "2026-12-24", "X"])).toThrow("cc: closure ends before it starts");
    expect(() => validateWrite({ u: "cc:Z", v: ["2026-12-31", "2026-12-24", "X"], c: "own" })).toThrow("cc:Z: closure ends before it starts");
  });

  it("reads a closure longer than 366 days, which only the build path refuses", () => {
    expect(closure.dec(["2026-12-24", "2027-12-24", "X"])).toEqual({ from: "2026-12-24", to: "2027-12-24", name: "X" });
    expect(closure.dec(["2026-12-24", "2027-12-25", "X"])).toEqual({ from: "2026-12-24", to: "2027-12-25", name: "X" });
    expect(() => validateWrite({ u: "cc:Z", v: ["2026-01-01", "2027-02-04", "X"], c: "own" })).not.toThrow();
  });

  it("refuses an encode of a malformed value", () => {
    expect(() => sched.enc({ start: "2026-11-16", dur: 3, status: "done", progress: 40, horizon: "now" })).toThrow("s: progress");
    expect(() => (sched as Codec<unknown>).enc(null)).toThrow(/^s: cannot encode null: /);
    expect(() => codecOf("ch").enc({})).toThrow(/^ch: cannot encode \{\}: /);
    expect(() => codecOf("cw").enc(5)).toThrow(/^cw: cannot encode 5: /);
    expect(() => codecOf("e").enc("x")).toThrow("e: k is not one of");
  });

  it("labels name errors without claiming a unit", () => {
    expect(() => name.dec(" Plan")).toThrow(/^name: name has spaces/);
    expect(() => validateWrite({ u: "pn", v: " Plan", c: "own" })).toThrow(/^pn: name has spaces/);
  });

  it("finds the codec of every kind", () => {
    const kinds: [UnitKind, Codec<unknown>][] = [
      ["pn", name as Codec<unknown>],
      ["n", name as Codec<unknown>],
      ["e", existence as Codec<unknown>],
      ["s", sched as Codec<unknown>],
      ["p", place as Codec<unknown>],
      ["r", refs as Codec<unknown>],
      ["l", link as Codec<unknown>],
      ["cr", region as Codec<unknown>],
      ["cw", weekdays as Codec<unknown>],
      ["cc", closure as Codec<unknown>],
      ["ct", tuning as Codec<unknown>],
      ["ch", holidayYear as Codec<unknown>],
      ["b", baseline as Codec<unknown>],
      ["a", activity as Codec<unknown>],
    ];
    kinds.forEach(([kind, codec]) => expect(codecOf(kind)).toBe(codec));
  });
});

describe("steps", () => {
  it("ws round-trips each field; d and l are optional", () => {
    const full = { n: "Review", c: "violet", o: "a1", d: true, l: 5 };
    expect(step.enc({ n: "Review", c: "violet", o: "a1", d: true, l: 5 })).toEqual(full);
    expect(step.dec(full)).toEqual(full);
    expect(step.enc({ n: "Review", c: "violet", o: "a1" })).toEqual({ n: "Review", c: "violet", o: "a1" });
    expect(step.dec({ n: "Review", c: "violet", o: "a1" })).toEqual({ n: "Review", c: "violet", o: "a1" });
    expect(step.dec({ n: "QA", c: "lime", o: "Zz9", l: 99 })).toEqual({ n: "QA", c: "lime", o: "Zz9", l: 99 });
    expect(step.dec(null)).toBeNull();
    expect(step.enc(null)).toBeNull();
    expect(codecOf("ws")).toBe(step);
    expect(codecOf("wi")).toBe(stepRef);
    expect(() => validateWrite({ u: "ws:review", v: full, c: "own" })).not.toThrow();
    expect(() => validateWrite({ u: "ws:now", v: null, c: "own" })).not.toThrow();
    expect(() => validateWrite({ u: "ws:review", v: full, c: "push" })).toThrow(new Error("ws:review: push cannot write this unit"));
  });

  it("ws rejects", () => {
    const ok = { n: "Review", c: "cyan", o: "a0" };
    expect(() => step.dec({ ...ok, x: 1 })).toThrow("ws: value has unknown fields x");
    expect(() => step.dec({ n: "Review", c: "cyan" })).toThrow("ws: value lacks o");
    expect(() => step.dec({ ...ok, c: "#00ffff" })).toThrow('ws: c is not one of cyan, violet, magenta, lime, amber, coral, sky, slate: "#00ffff"');
    expect(() => step.dec({ ...ok, n: "" })).toThrow("ws: n is empty");
    expect(() => step.dec({ ...ok, n: "x".repeat(33) })).toThrow("ws: n is longer than 32 characters");
    expect(step.dec({ ...ok, n: "x".repeat(32) })).toEqual({ ...ok, n: "x".repeat(32) });
    expect(step.dec({ ...ok, n: "🔭".repeat(32) })).toEqual({ ...ok, n: "🔭".repeat(32) });
    expect(() => step.dec({ ...ok, d: false })).toThrow("ws: d is not true: false");
    expect(() => step.dec({ ...ok, l: 0 })).toThrow("ws: l is not a whole number from 1 to 99: 0");
    expect(() => step.dec({ ...ok, l: 100 })).toThrow("ws: l is not a whole number from 1 to 99: 100");
    expect(() => step.dec({ ...ok, o: "a.0" })).toThrow('ws: o is not made of 0-9, A-Z and a-z: "a.0"');
    expect(() => validateWrite({ u: "ws:review", v: { ...ok, x: 1 }, c: "own" })).toThrow("ws:review: value has unknown fields x");
  });

  it("wi takes a step id or null and rejects `a b`", () => {
    expect(stepRef.dec("review")).toBe("review");
    expect(stepRef.dec(null)).toBeNull();
    expect(stepRef.enc("now")).toBe("now");
    expect(() => stepRef.dec("a b")).toThrow('wi: value is not an id: "a b"');
    expect(() => stepRef.dec(3)).toThrow("wi: value is not a string: 3");
    expect(() => validateWrite({ u: "wi:T1", v: "a b", c: "own" })).toThrow('wi:T1: value is not an id: "a b"');
    expect(() => validateWrite({ u: "wi:T1", v: "later", c: "own" })).not.toThrow();
  });

  it("parseKey reads ws:<id> and wi:<id> and refuses ws:", () => {
    expect(key.ws("review")).toBe("ws:review");
    expect(key.wi("T1")).toBe("wi:T1");
    expect(parseKey("ws:review")).toEqual({ kind: "ws", arg: "review" });
    expect(parseKey("wi:T1")).toEqual({ kind: "wi", arg: "T1" });
    expect(() => parseKey("ws:")).toThrow("Malformed unit key “ws:”");
    expect(() => parseKey("wi:a b")).toThrow("Malformed unit key “wi:a b”");
    expect(() => parseKey("ws")).toThrow("Unknown unit key “ws”");
    expect(() => key.ws("a.b")).toThrow("ws:a.b");
  });

  it("stateWrites writes no ws or wi for a plan without them", () => {
    const log = new LogState(planRules);
    log.add([
      act("a0", [], [
        { u: "pn", v: "Plan", c: "own" },
        { u: "cr", v: null, c: "own" },
        { u: "cw", v: [1, 2, 3, 4, 5], c: "own" },
        { u: "e:T1", v: { k: "task", t: false }, c: "own" },
        { u: "n:T1", v: "Survey", c: "own" },
        { u: "s:T1", v: ["2026-11-09", 3, "todo", 0, "now"], c: "own" },
        { u: "p:T1", v: [null, "a0"], c: "own" },
      ]),
    ]);
    const plan = projectPlan("P", log);
    const kinds = stateWrites(plan, "own", () => false).map((w) => parseKey(w.u).kind);
    expect(kinds).not.toContain("ws");
    expect(kinds).not.toContain("wi");
    const withSteps: PlanState = {
      ...plan,
      workflow: { steps: new Map([["review", { n: "Review", c: "violet", o: "a1" }], ["later", null]]), items: new Map([["T1", "review"]]) },
    };
    expect(stateWrites(withSteps, "own", () => false).filter((w) => ["ws", "wi"].includes(parseKey(w.u).kind))).toEqual([
      { u: "ws:review", v: { n: "Review", c: "violet", o: "a1" }, c: "own" },
      { u: "ws:later", v: null, c: "own" },
      { u: "wi:T1", v: "review", c: "own" },
    ]);
  });
});

describe("validateWrite", () => {
  it("passes a valid write of every kind", () => {
    validWrites.forEach((w) => expect(() => validateWrite(w)).not.toThrow());
  });

  it("throws for bad names, causes and activity values", () => {
    expect(() => validateWrite({ u: "n:A", v: " x", c: "own" })).toThrow("n:A: name");
    expect(() => validateWrite({ u: "n:A", v: "x", c: "x" as Write["c"] })).toThrow("cause");
    expect(() => validateWrite({ u: "a:b", v: 1, c: "undo" })).toThrow("a:b");
    expect(() => validateWrite({ u: "x:1", v: 1, c: "own" })).toThrow("Unknown unit key “x:1”");
  });

  it("refuses derived writes it cannot merge", () => {
    const s = (start: string | null) => [start, 3, "todo", 0, "later"];
    expect(() => validateWrite({ u: "s:A", v: s("2026-11-16"), c: "recalendar" })).not.toThrow();
    expect(() => validateWrite({ u: "n:A", v: "Ship", c: "push" })).toThrow(new Error("n:A: push cannot write this unit"));
    expect(() => validateWrite({ u: "ch:2027", v: zh, c: "recalendar" })).toThrow(new Error("ch:2027: recalendar cannot write this unit"));
    expect(() => validateWrite({ u: "s:A", v: s(null), c: "push" })).toThrow(new Error("s:A: push cannot write this unit"));
    expect(() => validateWrite({ u: "s:A", v: s(null), c: "recalendar" })).toThrow(new Error("s:A: recalendar cannot write this unit"));
  });

  it("checks that a holiday year matches its key", () => {
    const w: Write = { u: "ch:2031", v: { region: "oh:CH:CH-ZH", year: 2030, days: [], fetchedAt: "2026-11-01" }, c: "own" };
    expect(() => validateWrite(w)).toThrow(/ch:2031.*year/);
    expect(() => validateWrite({ u: "ch:2030", v: w.v, c: "own" })).not.toThrow();
    expect(() => validateWrite({ u: "ch:2031", v: null, c: "own" })).not.toThrow();
  });

  it("stores holiday day names as fetched", () => {
    const v = { ...zh, days: [{ ...zh.days[0], name: " Neujahrstag " }] };
    const w: Write = { u: "ch:2027", v, c: "own" };
    expect(() => validateWrite(w)).not.toThrow();
    expect(holidayYear.dec(v)?.days[0].name).toBe(" Neujahrstag ");
    expect(() => holidayYear.dec({ ...zh, days: [{ ...zh.days[0], name: 1 }] })).toThrow("ch: days");
    expect(() => holidayYear.dec({ ...zh, days: [{ ...zh.days[0], scope: 3 }] })).toThrow("ch: days");
  });
});
