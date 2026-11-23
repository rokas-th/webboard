import { describe, expect, it } from "vitest";
import type { Preview } from "../../actions/intents";
import { historyTime, revertImpact, revertText } from "./historyText";
import { LOG_STYLE } from "../../domain/dates";

const NONE: Preview = { itemsChanged: 0, endsChanged: 0, movedLater: 0, stopped: [], conflictsAfter: 0, kept: [] };

describe("historyTime", () => {
  it("reads HH:MM for today", () => {
    expect(historyTime(new Date(2026, 10, 8, 9, 5).getTime(), "2026-11-08", LOG_STYLE)).toBe("09:05");
  });

  it("puts the day before the time on other days", () => {
    expect(historyTime(new Date(2026, 10, 7, 14, 2).getTime(), "2026-11-08", LOG_STYLE)).toBe("7 Nov 14:02");
  });

  it("uses the 24 h clock", () => {
    expect(historyTime(new Date(2026, 10, 8, 23, 59).getTime(), "2026-11-08", LOG_STYLE)).toBe("23:59");
    expect(historyTime(new Date(2026, 10, 8, 0, 0).getTime(), "2026-11-08", LOG_STYLE)).toBe("00:00");
  });
});

describe("revertImpact", () => {
  it("counts items and later moves, dropping zero parts", () => {
    expect(revertImpact({ itemsChanged: 3, movedLater: 2 })).toBe("Changes 3 items; 2 move later");
    expect(revertImpact({ itemsChanged: 1, movedLater: 1 })).toBe("Changes 1 item; 1 moves later");
    expect(revertImpact({ itemsChanged: 2, movedLater: 0 })).toBe("Changes 2 items");
    expect(revertImpact({ itemsChanged: 0, movedLater: 0 })).toBe("No item dates change.");
  });
});

describe("revertText", () => {
  it("is the label, then the impact", () => {
    expect(revertText("Renamed the plan to “Q1”", NONE)).toEqual(["Renamed the plan to “Q1”", "No item dates change."]);
  });

  it("puts each kept line after the impact", () => {
    expect(revertText("Renamed the plan to “Q1”", { ...NONE, kept: ["“A” was changed since on the iPhone — kept"] })).toEqual([
      "Renamed the plan to “Q1”",
      "No item dates change.",
      "“A” was changed since on the iPhone — kept",
    ]);
  });
});
