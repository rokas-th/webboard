import { describe, expect, it } from "vitest";
import * as dates from "../domain/dates";
import { calendarSuffix, deviceName, fmtShort, items, pushSuffix, stopText, toastOf, workingDays } from "./copy";

describe("copy", () => {
  it("re-exports fmtShort from domain/dates", () => {
    expect(fmtShort).toBe(dates.fmtShort);
  });

  it("counts items and working days for 0, 1 and 2", () => {
    expect([0, 1, 2].map(items)).toEqual(["0 items", "1 item", "2 items"]);
    expect([0, 1, 2].map(workingDays)).toEqual(["0 working days", "1 working day", "2 working days"]);
    expect([-1, -2].map(workingDays)).toEqual(["−1 working day", "−2 working days"]);
  });

  it("names one stop, and three stops as the first and 2 more", () => {
    expect(stopText([{ reason: "held", name: "Review" }])).toBe("stopped at held “Review”");
    expect(
      stopText([
        { reason: "done", name: "Build" },
        { reason: "doing", name: "Review" },
        { reason: "held", name: "Ship" },
      ]),
    ).toBe("stopped at done “Build”, and 2 more");
    expect(stopText([{ reason: "doing", name: "Review" }])).toBe("stopped at in progress “Review”");
  });

  it("writes the push suffix with and without stops", () => {
    expect(pushSuffix(0, [])).toBe("");
    expect(pushSuffix(1, [])).toBe("; 1 dependent item moved");
    expect(pushSuffix(4, [])).toBe("; 4 dependent items moved");
    expect(pushSuffix(2, [{ reason: "held", name: "Review" }])).toBe("; 2 moved, stopped at held “Review”");
  });

  it("writes the calendar suffix from its non-zero parts", () => {
    expect(calendarSuffix(0, 0)).toBe("");
    expect(calendarSuffix(1, 0)).toBe("; 1 end date changed");
    expect(calendarSuffix(0, 1)).toBe("; 1 item moved later");
    expect(calendarSuffix(3, 2)).toBe("; 3 end dates changed, 2 items moved later");
  });

  it("names a device, or its id prefix when unknown", () => {
    const devices = new Map([["d1", "Mac"]]);
    expect(deviceName(devices, "d1")).toBe("Mac");
    expect(deviceName(devices, "ab12cd34ef5")).toBe("Device ab12");
  });

  it("makes a toast from the label and its sentences", () => {
    expect(toastOf("Moved “Sprint 4” to the Trash", [])).toBe("Moved “Sprint 4” to the Trash.");
    expect(toastOf("Moved “Sprint 4” to the Trash", ["Undo brings it back."])).toBe("Moved “Sprint 4” to the Trash. Undo brings it back.");
  });
});
