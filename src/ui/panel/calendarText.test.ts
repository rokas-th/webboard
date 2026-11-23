import { describe, expect, it } from "vitest";
import type { Calendar } from "../../domain/calendar";
import { calendarSummary, regionText, weekdaysText } from "./calendarText";

const cal = (over: Partial<Calendar>): Calendar => ({
  region: null,
  workdays: [1, 2, 3, 4, 5],
  closures: new Map(),
  tuning: new Map(),
  holidays: new Map(),
  ...over,
});

describe("regionText", () => {
  it("names each source's region", () => {
    expect(regionText({ src: "openholidays", country: "CH", subdivision: "CH-ZH" })).toBe("CH-ZH");
    expect(regionText({ src: "openholidays", country: "CH", subdivision: null })).toBe("CH");
    expect(regionText({ src: "govuk", division: "england-and-wales" })).toBe("England and Wales");
    expect(regionText({ src: "govuk", division: "scotland" })).toBe("Scotland");
    expect(regionText({ src: "govuk", division: "northern-ireland" })).toBe("Northern Ireland");
    expect(regionText({ src: "opm" })).toBe("US federal (OPM)");
    expect(regionText({ src: "ics", url: "https://x.example/a.ics", name: "Team" })).toBe("“Team”");
  });
});

describe("weekdaysText", () => {
  it("joins a run of three or more with a dash, anything else with commas", () => {
    expect(weekdaysText([1, 2, 3, 4, 5], 1)).toBe("Mon–Fri");
    expect(weekdaysText([1, 2, 3, 4], 1)).toBe("Mon–Thu");
    expect(weekdaysText([1, 3, 5], 1)).toBe("Mon, Wed, Fri");
    expect(weekdaysText([1, 2], 1)).toBe("Mon, Tue");
    expect(weekdaysText([7], 1)).toBe("Sun");
    expect(weekdaysText([5, 1, 2, 3, 4], 1)).toBe("Mon–Fri");
  });

  it("a Sunday week starts on Sunday", () => {
    expect([weekdaysText([7, 1, 2, 3, 4], 7), weekdaysText([7, 1, 2, 3, 4], 1)]).toEqual(["Sun–Thu", "Mon, Tue, Wed, Thu, Sun"]);
    expect([weekdaysText([6, 7], 7), weekdaysText([6, 7], 1)]).toEqual(["Sun, Sat", "Sat, Sun"]);
    expect(weekdaysText([1, 2, 3, 4, 5], 7)).toBe("Mon–Fri");
    expect(calendarSummary(cal({ workdays: [7, 1, 2, 3, 4] }), 7)).toBe("No holiday region · Sun–Thu · no closures");
  });
});

describe("calendarSummary", () => {
  it("reads region, week and closures on one line", () => {
    const one = cal({
      region: { src: "openholidays", country: "CH", subdivision: "CH-ZH" },
      closures: new Map([["c1", { id: "c1", from: "2026-12-28", to: "2026-12-31", name: "Year-end" }]]),
    });
    expect(calendarSummary(one, 1)).toBe("CH-ZH · Mon–Fri · 1 closure");
    expect(calendarSummary(cal({ workdays: [1, 2, 3, 4] }), 1)).toBe("No holiday region · Mon–Thu · no closures");
    const two = cal({
      closures: new Map([
        ["c1", { id: "c1", from: "2026-12-28", to: "2026-12-31", name: "Year-end" }],
        ["c2", { id: "c2", from: "2027-08-02", to: "2027-08-06", name: "Summer" }],
      ]),
    });
    expect(calendarSummary(two, 1)).toBe("No holiday region · Mon–Fri · 2 closures");
  });
});
