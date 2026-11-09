import { describe, expect, it } from "vitest";
import { fmtShort, localToday, toDay, toIso, weekday, yearOf } from "./dates";

describe("dates", () => {
  it("toDay counts whole days since 1970-01-01", () => {
    expect(toDay("1970-01-01")).toBe(0);
    expect(toDay("2026-11-08")).toBe(20765);
    expect(toDay("2026-12-24")).toBe(20811);
    expect(toDay("1969-12-31")).toBe(-1);
    expect(toDay("2024-02-29")).toBe(19782);
  });

  it("toIso inverts toDay", () => {
    const stepped = Array.from({ length: Math.floor(80800 / 7) + 1 }, (_, i) => -800 + i * 7);
    const dense = Array.from({ length: 21200 - 20765 + 1 }, (_, i) => 20765 + i);
    [...stepped, ...dense].forEach((d) => expect(toDay(toIso(d))).toBe(d));
  });

  it("impossible and malformed dates throw RangeError", () => {
    [
      "2026-02-30",
      "2026-02-29",
      "2100-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-2-3",
      "2026-11-08T00:00",
      " 2026-11-08",
      "",
    ].forEach((s) => {
      expect(() => toDay(s)).toThrow(RangeError);
      expect(() => toDay(s)).toThrow(`not a calendar date: ${JSON.stringify(s)}`);
    });
    expect(() => toDay("2026-02-30")).toThrow('not a calendar date: "2026-02-30"');
  });

  it("toIso and weekday refuse a day that is not a whole number", () => {
    expect(() => toIso(0.5)).toThrow(new RangeError("not a day: 0.5"));
    expect(() => weekday(Number.NaN)).toThrow(new RangeError("not a day: NaN"));
  });

  it("weekday is ISO", () => {
    expect(weekday(toDay("2026-11-09"))).toBe(1);
    expect(weekday(toDay("2026-12-24"))).toBe(4);
    expect(weekday(toDay("2026-11-08"))).toBe(7);
    expect(weekday(-1)).toBe(3);
    expect(yearOf(toDay("2026-12-31"))).toBe(2026);
    expect(yearOf(toDay("2027-01-01"))).toBe(2027);
  });

  it("localToday reads local date parts", () => {
    expect(localToday(new Date(2026, 0, 31, 23, 59))).toBe("2026-01-31");
  });

  it("localToday rejects an invalid Date", () => {
    expect(() => localToday(new Date(NaN))).toThrow(new RangeError("not a date: Invalid Date"));
  });

  it("fmtShort is day and English month", () => {
    expect(fmtShort("2026-11-25")).toBe("25 Nov");
    expect(fmtShort("2026-01-05")).toBe("5 Jan");
    expect(() => fmtShort("2026-02-30")).toThrow(new RangeError('not a calendar date: "2026-02-30"'));
  });
});
