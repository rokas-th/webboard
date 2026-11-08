import { describe, expect, it } from "vitest";
import { regionKey, workCalendar, type Calendar, type Closure, type ListedDay, type Tuning } from "./calendar";
import { toDay, toIso, type Day, type IsoDate, type Weekday } from "./dates";
import { CH_ZH, CH_ZH_2026, CH_ZH_OFF, holidayDay, holidayYear } from "../test/fixtures/calendars";
import { mockupRef } from "../test/fixtures/mockupRef";

const d = toDay;

const withTuning = (cal: Calendar, entries: readonly (readonly [IsoDate, Tuning])[]): Calendar => ({
  ...cal,
  tuning: new Map([...cal.tuning, ...entries]),
});

const withClosures = (cal: Calendar, list: readonly Closure[]): Calendar => ({
  ...cal,
  closures: new Map([...cal.closures, ...list.map((c) => [c.id, c] as const)]),
});

const C1: Closure = { id: "c1", from: "2026-12-28", to: "2026-12-29", name: "Year-end" };

const row = (l: ListedDay) => `${l.date} ${l.kind} ${l.counted ? "t" : "f"} ${l.tuned ? "t" : "f"}`;

describe("regionKey", () => {
  it("names each source form", () => {
    expect(regionKey({ src: "openholidays", country: "CH", subdivision: "CH-ZH" })).toBe("oh:CH:CH-ZH");
    expect(regionKey({ src: "openholidays", country: "AT", subdivision: null })).toBe("oh:AT");
    expect(regionKey({ src: "govuk", division: "scotland" })).toBe("govuk:scotland");
    expect(regionKey({ src: "opm" })).toBe("opm");
    expect(regionKey({ src: "ics", url: "https://example.com/h.ics", name: "Team" })).toBe("ics:https://example.com/h.ics");
  });
});

describe("CH_ZH", () => {
  const wc = workCalendar(CH_ZH);

  it("is off on public holidays and working on half days", () => {
    expect(wc.isWork(d("2026-12-25"))).toBe(false);
    expect(wc.isWork(d("2026-12-26"))).toBe(false);
    expect(wc.isWork(d("2027-01-01"))).toBe(false);
    expect(wc.isWork(d("2026-12-24"))).toBe(true);
    expect(wc.isWork(d("2026-12-28"))).toBe(true);
  });

  it("names why a working weekday is off", () => {
    expect(wc.off(d("2026-12-25"))).toEqual({ date: "2026-12-25", name: "Christmas Day", origin: "official", source: "OpenHolidays" });
    expect(wc.off(d("2026-12-26"))).toBeNull();
    expect(wc.off(d("2026-12-24"))).toBeNull();
  });

  it("names the source of other regions", () => {
    const of = (region: Calendar["region"], key: string) =>
      workCalendar({ ...CH_ZH, region, holidays: new Map([[2026, holidayYear(key, 2026, CH_ZH_2026.days)]]) }).off(d("2026-12-25"))?.source;
    expect(of({ src: "govuk", division: "england-and-wales" }, "govuk:england-and-wales")).toBe("GOV.UK");
    expect(of({ src: "opm" }, "opm")).toBe("OPM");
    expect(of({ src: "ics", url: "https://example.com/h.ics", name: "Team days" }, "ics:https://example.com/h.ics")).toBe("Team days");
  });
});

describe("tuning", () => {
  it("turns half, public, added and closure days on and off", () => {
    const halfOff = workCalendar(withTuning(CH_ZH, [["2026-12-24", { kind: "off" }]]));
    expect(halfOff.off(d("2026-12-24"))).toEqual({ date: "2026-12-24", name: "Christmas Eve", origin: "half-on", source: "OpenHolidays" });

    const publicWork = workCalendar(withTuning(CH_ZH, [["2026-12-25", { kind: "work" }]]));
    expect(publicWork.isWork(d("2026-12-25"))).toBe(true);
    expect(publicWork.off(d("2026-12-25"))).toBeNull();

    const added = workCalendar(withTuning(CH_ZH, [["2026-12-31", { kind: "add", name: "Office closed" }]]));
    expect(added.off(d("2026-12-31"))).toEqual({ date: "2026-12-31", name: "Office closed", origin: "added", source: null });

    const closed = withClosures(CH_ZH, [C1]);
    expect(workCalendar(closed).off(d("2026-12-28"))).toEqual({ date: "2026-12-28", name: "Year-end", origin: "closure", source: null });
    expect(workCalendar(closed).off(d("2026-12-29"))?.origin).toBe("closure");
    const closedWork = workCalendar(withTuning(closed, [["2026-12-28", { kind: "work" }]]));
    expect(closedWork.isWork(d("2026-12-28"))).toBe(false);
    expect(closedWork.off(d("2026-12-28"))?.origin).toBe("closure");
  });

  it("counts an optional day only when tuned off", () => {
    const epiphany = holidayDay("2027-01-06", "Epiphany", "optional");
    const cal: Calendar = {
      ...CH_ZH,
      holidays: new Map([...CH_ZH.holidays, [2027, { ...CH_ZH.holidays.get(2027)!, days: [...CH_ZH.holidays.get(2027)!.days, epiphany] }]]),
    };
    expect(workCalendar(cal).isWork(d("2027-01-06"))).toBe(true);
    const tuned = workCalendar(withTuning(cal, [["2027-01-06", { kind: "off" }]]));
    expect(tuned.off(d("2027-01-06"))).toEqual({ date: "2027-01-06", name: "Epiphany", origin: "optional-on", source: "OpenHolidays" });
  });

  it("puts add before a fetched day and closures in (from, id) order", () => {
    const cal = withTuning(
      withClosures(CH_ZH, [
        { id: "z", from: "2026-12-30", to: "2026-12-31", name: "Later id" },
        { id: "a", from: "2026-12-30", to: "2026-12-30", name: "Earlier id" },
        { id: "b", from: "2026-12-29", to: "2026-12-31", name: "Earlier from" },
      ]),
      [["2026-12-25", { kind: "add", name: "Own day" }]],
    );
    const wc = workCalendar(cal);
    expect(wc.off(d("2026-12-25"))?.origin).toBe("added");
    expect(wc.off(d("2026-12-30"))?.name).toBe("Earlier from");
    expect(wc.off(d("2026-12-29"))?.name).toBe("Earlier from");
  });

  it("does nothing on a non-working weekday", () => {
    const wc = workCalendar(withTuning(withClosures(CH_ZH, [{ id: "w", from: "2027-01-09", to: "2027-01-10", name: "Weekend" }]), [["2027-01-09", { kind: "add", name: "Sat" }]]));
    expect(wc.off(d("2027-01-09"))).toBeNull();
    expect(wc.off(d("2027-01-10"))).toBeNull();
  });
});

describe("a year from another region does not count", () => {
  const cal: Calendar = {
    ...CH_ZH,
    holidays: new Map([
      [2026, CH_ZH_2026],
      [2027, holidayYear("oh:DE:DE-BY", 2027, [holidayDay("2027-01-01", "New Year's Day", "public"), holidayDay("2027-01-06", "Epiphany", "public")])],
    ]),
  };
  const wc = workCalendar(cal);

  it("ignores its days and reports the year missing", () => {
    expect(wc.isWork(d("2027-01-01"))).toBe(true);
    expect(wc.isWork(d("2027-01-06"))).toBe(true);
    expect(wc.off(d("2027-01-01"))).toBeNull();
    expect(wc.off(d("2027-01-06"))).toBeNull();
    expect(wc.missingYears(d("2026-12-01"), d("2027-02-01"))).toEqual([2027]);
    expect(wc.listed(d("2027-01-01"), d("2027-01-31"))).toEqual([]);
  });
});

describe("missingYears", () => {
  it("lists years in range without a HolidayYear", () => {
    expect(workCalendar(CH_ZH).missingYears(d("2026-12-01"), d("2028-01-10"))).toEqual([2028]);
    expect(workCalendar(CH_ZH).missingYears(d("2026-12-01"), d("2027-01-10"))).toEqual([]);
  });

  it("is empty without a region, and counts no year then", () => {
    const wc = workCalendar({ ...CH_ZH, region: null });
    expect(wc.missingYears(d("2026-12-01"), d("2028-01-10"))).toEqual([]);
    expect(wc.isWork(d("2026-12-25"))).toBe(true);
  });
});

describe("listed", () => {
  const base = withClosures(withTuning(CH_ZH, [["2026-12-24", { kind: "off" }], ["2026-12-31", { kind: "add", name: "Office closed" }]]), [C1]);

  it("lists every fetched, added and closure day in range", () => {
    expect(workCalendar(base).listed(d("2026-12-20"), d("2027-01-03")).map(row)).toEqual([
      "2026-12-24 half t t",
      "2026-12-25 public t f",
      "2026-12-26 public f f",
      "2026-12-28 closure t f",
      "2026-12-29 closure t f",
      "2026-12-31 added t t",
      "2027-01-01 public t f",
      "2027-01-02 optional f f",
    ]);
    expect(workCalendar(base).listed(d("2026-12-24"), d("2026-12-24"))).toEqual([
      { date: "2026-12-24", name: "Christmas Eve", kind: "half", counted: true, tuned: true },
    ]);
  });

  it("marks work tuning on a fetched day, not on a closure day", () => {
    const cal = withTuning(base, [["2026-12-25", { kind: "work" }], ["2026-12-28", { kind: "work" }]]);
    expect(workCalendar(cal).listed(d("2026-12-20"), d("2027-01-03")).map(row)).toEqual([
      "2026-12-24 half t t",
      "2026-12-25 public f t",
      "2026-12-26 public f f",
      "2026-12-28 closure t f",
      "2026-12-29 closure t f",
      "2026-12-31 added t t",
      "2027-01-01 public t f",
      "2027-01-02 optional f f",
    ]);
  });

  it("does not list off or work tuning without a fetched day", () => {
    const cal = withTuning(CH_ZH, [["2026-12-30", { kind: "off" }], ["2026-12-31", { kind: "work" }]]);
    expect(workCalendar(cal).listed(d("2026-12-30"), d("2026-12-31"))).toEqual([]);
  });

  it("orders one date's entries as off() ranks them", () => {
    const cal = withClosures(CH_ZH, [{ id: "c2", from: "2026-12-25", to: "2026-12-25", name: "Office move" }]);
    expect(workCalendar(cal).listed(d("2026-12-25"), d("2026-12-25"))).toEqual([
      { date: "2026-12-25", name: "Christmas Day", kind: "public", counted: true, tuned: false },
      { date: "2026-12-25", name: "Office move", kind: "closure", counted: false, tuned: false },
    ]);
    const worked = withTuning(cal, [["2026-12-25", { kind: "work" }]]);
    expect(workCalendar(worked).listed(d("2026-12-25"), d("2026-12-25"))).toEqual([
      { date: "2026-12-25", name: "Christmas Day", kind: "public", counted: false, tuned: true },
      { date: "2026-12-25", name: "Office move", kind: "closure", counted: true, tuned: false },
    ]);
    const added = withTuning(cal, [["2026-12-25", { kind: "add", name: "Own day" }]]);
    expect(workCalendar(added).listed(d("2026-12-25"), d("2026-12-25")).map((l) => `${l.kind} ${l.counted}`)).toEqual([
      "added true",
      "public false",
      "closure false",
    ]);
  });
});

describe("exact walks", () => {
  const wc = workCalendar(CH_ZH);
  const iso = (x: Day) => toIso(x);

  it("follows the mockup on CH_ZH", () => {
    expect([0, 1, 2, 3, 5, -1, -3].map((n) => iso(wc.addWork(d("2026-12-24"), n)))).toEqual([
      "2026-12-24",
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2027-01-04",
      "2026-12-23",
      "2026-12-21",
    ]);
    expect(iso(wc.snapF(d("2026-12-25")))).toBe("2026-12-28");
    expect(iso(wc.snapB(d("2026-12-25")))).toBe("2026-12-24");
    expect(iso(wc.after(d("2026-12-31")))).toBe("2027-01-04");
    expect(iso(wc.subWork(d("2027-01-04"), 1))).toBe("2026-12-31");
    expect(iso(wc.subWork(d("2027-01-03"), 0))).toBe("2026-12-31");
    expect(wc.workBetween(d("2026-12-24"), d("2027-01-04"))).toBe(6);
    expect(wc.workBetween(d("2027-01-04"), d("2026-12-24"))).toBe(0);
    expect(iso(wc.addWork(d("2027-03-25"), 2))).toBe("2027-03-31");
  });
});

describe("parity with the mockup", () => {
  const days = Array.from({ length: d("2027-04-30") - d("2026-10-01") + 1 }, (_, i) => d("2026-10-01") + i);
  const ns = Array.from({ length: 21 }, (_, i) => i - 10);
  const ks = Array.from({ length: 46 }, (_, i) => i - 5);

  const trace = (w: {
    snapF(x: Day): Day; snapB(x: Day): Day; after(x: Day): Day;
    addWork(x: Day, n: number): Day; subWork(x: Day, n: number): Day; workBetween(a: Day, b: Day): number;
  }) =>
    days.map((x) => [
      w.snapF(x),
      w.snapB(x),
      w.after(x),
      ...ns.map((n) => w.addWork(x, n)),
      ...ns.map((n) => w.subWork(x, Math.abs(n))),
      ...ks.map((k) => w.workBetween(x, x + k)),
    ]);

  ([[1, 2, 3, 4, 5], [1, 3, 5]] as const satisfies readonly (readonly Weekday[])[]).forEach((workdays) => {
    it(`matches every walk with workdays ${workdays.join(",")}`, () => {
      expect(trace(workCalendar({ ...CH_ZH, workdays }))).toEqual(trace(mockupRef(workdays, CH_ZH_OFF)));
    });
  });

  it("checks a trace that can fail", () => {
    expect(trace(workCalendar(CH_ZH))).not.toEqual(trace(mockupRef([1, 2, 3, 4, 5], new Set())));
  });
});

describe("empty workdays", () => {
  it("throws the engine guard", () => {
    expect(() => workCalendar({ ...CH_ZH, workdays: [] })).toThrow(new RangeError("a calendar needs at least one working weekday"));
  });
});
