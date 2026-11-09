import { describe, expect, it } from "vitest";
import type { ListedDay, RegionRef } from "../../domain/calendar";
import { originLabel } from "./origin";

const OH: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const GOVUK: RegionRef = { src: "govuk", division: "scotland" };
const OPM: RegionRef = { src: "opm" };
const ICS: RegionRef = { src: "ics", url: "https://calendar.example.com/team.ics", name: "Team calendar" };

const day = (kind: ListedDay["kind"], counted: boolean, tuned: boolean): ListedDay => ({ date: "2026-12-25", name: "Day", kind, counted, tuned });

describe("originLabel", () => {
  it("names the source of a counted public day", () => {
    const pub = day("public", true, false);
    expect(originLabel(pub, OH, null)).toBe("Official · OpenHolidays");
    expect(originLabel(pub, GOVUK, null)).toBe("Official · GOV.UK");
    expect(originLabel(pub, OPM, null)).toBe("Official · US OPM");
    expect(originLabel(pub, ICS, null)).toBe("From Team calendar");
  });

  it("says when the owner works a public day", () => {
    expect(originLabel(day("public", false, true), OH, null)).toBe("Official · OpenHolidays — you work this day");
  });

  it("labels optional, half, added and closure days", () => {
    expect(originLabel(day("optional", false, false), OH, null)).toBe("Optional");
    expect(originLabel(day("optional", true, true), OH, null)).toBe("Optional, turned on");
    expect(originLabel(day("half", false, false), OH, null)).toBe("Half day");
    expect(originLabel(day("half", true, true), OH, null)).toBe("Half day, turned on");
    expect(originLabel(day("added", true, true), OH, null)).toBe("Added by you");
    expect(originLabel(day("closure", true, false), OH, null)).toBe("Closure");
    expect(originLabel(day("added", true, true), null, null)).toBe("Added by you");
    expect(originLabel(day("closure", true, false), null, null)).toBe("Closure");
  });

  it("adds the scope of a day below the plan's subdivision", () => {
    expect(originLabel(day("optional", false, false), OH, "City of Zürich")).toBe("Optional · City of Zürich");
    const sechselaeuten: ListedDay = { date: "2026-04-20", name: "Sechseläuten", kind: "half", counted: false, tuned: false };
    const knabenschiessen: ListedDay = { date: "2026-09-14", name: "Knabenschiessen", kind: "half", counted: true, tuned: true };
    expect(originLabel(sechselaeuten, OH, "City of Zürich")).toBe("Half day · City of Zürich");
    expect(originLabel(knabenschiessen, OH, "City of Zürich")).toBe("Half day, turned on · City of Zürich");
  });

  it("throws for a fetched day with no region", () => {
    expect(() => originLabel(day("public", true, false), null, null)).toThrow("A fetched day on 2026-12-25 needs a holiday region");
  });
});
