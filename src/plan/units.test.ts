import { describe, expect, it } from "vitest";
import type { Codec, UnitKind } from "./units";
import {
  activity,
  baseline,
  closure,
  codecOf,
  existence,
  holidayYear,
  key,
  link,
  name,
  parseKey,
  place,
  refs,
  region,
  sched,
  tuning,
  validateWrite,
  weekdays,
} from "./units";
import type { Write } from "../log/types";

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
  { u: "ch:2027", v: zh, c: "recalendar" },
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
    expect(() => parseKey("ch:20x6")).toThrow("ch:20x6");
    expect(() => key.ch(2026.5)).toThrow("ch:2026.5");
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

  it("refuses a closure that ends before it starts", () => {
    expect(() => closure.dec(["2026-12-31", "2026-12-24", "X"])).toThrow("cc: closure ends before it starts");
    expect(() => closure.dec({ name: "X", from: "2026-12-31", to: "2026-12-24" })).toThrow("cc:");
    expect(() => validateWrite({ u: "cc:Z", v: ["2026-12-31", "2026-12-24", "X"], c: "own" })).toThrow("cc:Z: closure ends before it starts");
  });

  it("refuses an encode of a malformed value", () => {
    expect(() => sched.enc({ start: "2026-11-16", dur: 3, status: "done", progress: 40, horizon: "now" })).toThrow("s: progress");
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
