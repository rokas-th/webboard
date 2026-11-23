import { describe, expect, it } from "vitest";
import { dayOrderOf, FIRST_PLAN_DATE, fmtFull, fmtNear, fmtShort, inPlanWindow, isCalendarDate, LAST_PLAN_DATE, localToday, LOG_STYLE, toDay, toIso, weekday, weekdaysFrom, weekStartOf, yearOf, type DateStyle } from "./dates";

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
      expect([s, isCalendarDate(s)]).toEqual([s, false]);
    });
    expect(["2024-02-29", "2026-11-08"].map(isCalendarDate)).toEqual([true, true]);
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
    expect(fmtShort("2026-11-25", LOG_STYLE)).toBe("25 Nov");
    expect(fmtShort("2026-01-05", LOG_STYLE)).toBe("5 Jan");
    expect(() => fmtShort("2026-02-30", LOG_STYLE)).toThrow(new RangeError('not a calendar date: "2026-02-30"'));
  });
});

describe("the plan window", () => {
  it("runs from 1900-01-01 to 2199-12-31", () => {
    expect([FIRST_PLAN_DATE, LAST_PLAN_DATE]).toEqual(["1900-01-01", "2199-12-31"]);
    expect(["1900-01-01", "2026-11-16", "2199-12-31"].map(inPlanWindow)).toEqual([true, true, true]);
    expect(["1899-12-31", "2200-01-01", "0026-11-16", "9999-12-31", "2026-02-30", "26-11-16"].map(inPlanWindow)).toEqual([false, false, false, false, false, false]);
  });

  it("names the year only when it is not this year", () => {
    expect(fmtNear("2026-11-16", "2026-01-05", LOG_STYLE)).toBe("16 Nov");
    expect(fmtNear("2027-01-04", "2026-12-30", LOG_STYLE)).toBe("4 Jan 2027");
    expect(fmtNear("0026-11-16", "2026-11-10", LOG_STYLE)).toBe("16 Nov 0026");
  });
});

const SYSTEM_DM: DateStyle = { format: "system", order: "dm" };
const SYSTEM_MD: DateStyle = { format: "system", order: "md" };
const ISO: DateStyle = { format: "iso", order: "dm" };
const DMY: DateStyle = { format: "dmy", order: "md" };

describe("date styles", () => {
  it("LOG_STYLE is the day before an English month, the output labels have always had", () => {
    expect(LOG_STYLE).toEqual({ format: "system", order: "dm" });
    expect(Object.isFrozen(LOG_STYLE)).toBe(true);
    expect([fmtShort("2027-03-15", LOG_STYLE), fmtNear("2027-03-15", "2026-11-23", LOG_STYLE), fmtNear("2026-03-05", "2026-11-23", LOG_STYLE)]).toEqual(["15 Mar", "15 Mar 2027", "5 Mar"]);
  });

  it("System follows the locale's order with English months and names the year only when it is not this year", () => {
    expect([fmtShort("2027-03-15", SYSTEM_DM), fmtShort("2027-03-15", SYSTEM_MD)]).toEqual(["15 Mar", "Mar 15"]);
    expect([fmtNear("2027-09-05", "2027-01-01", SYSTEM_MD), fmtNear("2027-09-05", "2026-12-31", SYSTEM_MD)]).toEqual(["Sep 5", "Sep 5 2027"]);
    expect([fmtFull("2027-09-05", SYSTEM_DM), fmtFull("2027-09-05", SYSTEM_MD)]).toEqual(["5 Sep 2027", "Sep 5 2027"]);
  });

  it("ISO and D.M.YYYY always carry the year", () => {
    expect([fmtShort("2027-03-05", ISO), fmtNear("2027-03-05", "2027-01-01", ISO), fmtFull("2027-03-05", ISO)]).toEqual(["2027-03-05", "2027-03-05", "2027-03-05"]);
    expect([fmtShort("2027-03-05", DMY), fmtNear("2027-03-05", "2027-01-01", DMY), fmtFull("2027-12-15", DMY)]).toEqual(["5.3.2027", "5.3.2027", "15.12.2027"]);
  });

  it("every style refuses a date that is not on the calendar", () => {
    [SYSTEM_DM, SYSTEM_MD, ISO, DMY].forEach((style) => {
      expect(() => fmtShort("2027-02-30", style)).toThrow(new RangeError('not a calendar date: "2027-02-30"'));
      expect(() => fmtFull("2027-02-30", style)).toThrow(new RangeError('not a calendar date: "2027-02-30"'));
    });
  });

  it("reads the day order of en-US and en-GB", () => {
    expect([dayOrderOf("en-US"), dayOrderOf("en-GB"), dayOrderOf("de-CH")]).toEqual(["md", "dm", "dm"]);
  });
});

describe("week starts", () => {
  it("a Monday week snaps every day back to its Monday", () => {
    const wednesday = toDay("2027-03-17");
    expect([wednesday, wednesday - 2, wednesday + 4].map((d) => toIso(weekStartOf(d, 1)))).toEqual(["2027-03-15", "2027-03-15", "2027-03-15"]);
    expect(toIso(weekStartOf(wednesday + 5, 1))).toBe("2027-03-22");
  });

  it("a Sunday week starts on Sunday", () => {
    const wednesday = toDay("2027-03-17");
    expect([wednesday, wednesday - 3, wednesday + 3].map((d) => toIso(weekStartOf(d, 7)))).toEqual(["2027-03-14", "2027-03-14", "2027-03-14"]);
    expect(toIso(weekStartOf(wednesday + 4, 7))).toBe("2027-03-21");
    expect(weekday(weekStartOf(toDay("1969-12-31"), 7))).toBe(7);
  });

  it("weekdaysFrom lists the seven days from the first", () => {
    expect(weekdaysFrom(1)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weekdaysFrom(7)).toEqual([7, 1, 2, 3, 4, 5, 6]);
  });
});
