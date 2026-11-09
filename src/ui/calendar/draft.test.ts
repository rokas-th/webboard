import { describe, expect, it } from "vitest";
import { Refused } from "../../actions/intents";
import type { Calendar, HolidayYear } from "../../domain/calendar";
import { CH_ZH, CH_ZH_2027 } from "../../test/fixtures/calendars";
import { addClosure, removeClosure, sameCalendar, setWorkday, tune } from "./draft";

const plain = (over: Partial<Calendar> = {}): Calendar => ({
  region: null,
  workdays: [1, 2, 3, 4, 5],
  closures: new Map(),
  tuning: new Map(),
  holidays: new Map(),
  ...over,
});

const copy = (c: Calendar): Calendar => ({
  region: c.region === null ? null : { ...c.region },
  workdays: [...c.workdays],
  closures: new Map([...c.closures].map(([k, v]) => [k, { ...v }])),
  tuning: new Map([...c.tuning].map(([k, v]) => [k, { ...v }])),
  holidays: new Map([...c.holidays].map(([k, v]) => [k, { ...v, days: v.days.map((d) => ({ ...d })) }])),
});

describe("setWorkday", () => {
  it("refuses to remove the last working day", () => {
    const one = plain({ workdays: [1] });
    expect(() => setWorkday(one, 1, false)).toThrow(Refused);
    expect(() => setWorkday(one, 1, false)).toThrow("A calendar needs at least one working day.");
  });

  it("adds and removes a weekday, sorted", () => {
    expect(setWorkday(plain(), 5, false).workdays).toEqual([1, 2, 3, 4]);
    expect(setWorkday(plain({ workdays: [3, 1] }), 2, true).workdays).toEqual([1, 2, 3]);
    expect(setWorkday(plain(), 3, true).workdays).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("closures", () => {
  it("adds a closure under a new id and removes it by id", () => {
    const added = addClosure(plain(), { from: "2026-11-17", to: "2026-11-18", name: "Offsite" });
    const [c] = [...added.closures.values()];
    expect(c).toEqual({ id: c.id, from: "2026-11-17", to: "2026-11-18", name: "Offsite" });
    expect(c.id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(added.closures.get(c.id)).toBe(c);
    expect(removeClosure(added, c.id).closures.size).toBe(0);
    expect(() => removeClosure(added, "nope")).toThrow("No closure nope in the draft");
  });
});

describe("sameCalendar", () => {
  it("is true for a calendar and its copy", () => {
    expect(sameCalendar(CH_ZH, copy(CH_ZH))).toBe(true);
  });

  it("compares workdays as a set", () => {
    expect(sameCalendar(plain({ workdays: [1, 2, 3, 4, 5] }), plain({ workdays: [5, 4, 3, 2, 1] }))).toBe(true);
    expect(sameCalendar(CH_ZH, setWorkday(CH_ZH, 5, false))).toBe(false);
  });

  it("is true again once a tuning is taken back", () => {
    const tuned = tune(CH_ZH, "2026-11-17", { kind: "add", name: "Away" });
    expect(sameCalendar(tuned, CH_ZH)).toBe(false);
    expect(sameCalendar(tune(tuned, "2026-11-17", null), CH_ZH)).toBe(true);
  });

  it("ignores fetchedAt on holiday years", () => {
    const later: HolidayYear = { ...CH_ZH_2027, fetchedAt: "2026-12-01T00:00:00Z" };
    expect(sameCalendar(CH_ZH, { ...CH_ZH, holidays: new Map([...CH_ZH.holidays, [2027, later]]) })).toBe(true);
  });

  it("sees a changed region, closure, tuning value or holiday year", () => {
    expect(sameCalendar(CH_ZH, { ...CH_ZH, region: { src: "openholidays", country: "CH", subdivision: "CH-BE" } })).toBe(false);
    expect(sameCalendar(CH_ZH, { ...CH_ZH, region: null })).toBe(false);
    const closed = addClosure(CH_ZH, { from: "2026-11-17", to: "2026-11-18", name: "Offsite" });
    const [c] = [...closed.closures.values()];
    expect(sameCalendar(closed, CH_ZH)).toBe(false);
    expect(sameCalendar(closed, { ...closed, closures: new Map([[c.id, { ...c, name: "Move" }]]) })).toBe(false);
    expect(sameCalendar(tune(CH_ZH, "2027-01-02", { kind: "off" }), tune(CH_ZH, "2027-01-02", { kind: "work" }))).toBe(false);
    const fewer: HolidayYear = { ...CH_ZH_2027, days: CH_ZH_2027.days.slice(1) };
    expect(sameCalendar(CH_ZH, { ...CH_ZH, holidays: new Map([...CH_ZH.holidays, [2027, fewer]]) })).toBe(false);
    expect(sameCalendar(CH_ZH, { ...CH_ZH, holidays: new Map([...CH_ZH.holidays].slice(0, 1)) })).toBe(false);
    expect(sameCalendar(CH_ZH, { ...CH_ZH, holidays: new Map([...CH_ZH.holidays, [2027, { ...CH_ZH_2027, region: "oh:CH:CH-BE" }]]) })).toBe(false);
  });
});
