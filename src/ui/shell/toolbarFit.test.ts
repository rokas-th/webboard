import { describe, expect, it } from "vitest";
import { nextTight, SEARCH_FIELD_SLACK, searchFieldFits, TIGHT_SLACK, toolbarFit } from "./toolbarFit";

describe("the toolbar's tight switch", () => {
  it("turns tight only once the toolbar's natural width passes its room", () => {
    expect([nextTight(false, 1000, 1000), nextTight(false, 1000.5, 1000), nextTight(false, 1001, 1000)]).toEqual([false, false, true]);
  });

  it("stays tight until the natural width is back under the room by the slack, so it cannot flip on rounding", () => {
    expect([nextTight(true, 1000, 1000), nextTight(true, 1000 - TIGHT_SLACK + 1, 1000), nextTight(true, 1000 - TIGHT_SLACK, 1000)]).toEqual([true, true, false]);
  });

  it("measures nothing while the toolbar is not the centring grid", () => {
    const bar = document.createElement("header");
    document.body.append(bar);
    expect(toolbarFit(bar)).toBeNull();
    bar.remove();
  });
});

describe("searchFieldFits", () => {
  const glassed = { start: 300, middle: 360, end: 400, gap: 10, glass: 28, field: 180 };
  const fielded = { ...glassed, end: 552 };

  it("lets the field in once the wider end group, doubled for the centred tabs, fits with 8 px to spare", () => {
    expect(searchFieldFits(false, { ...glassed, room: 1492 })).toBe(true);
    expect(searchFieldFits(false, { ...glassed, room: 1491 })).toBe(false);
  });

  it("measures against the start group when it is the wider side", () => {
    const wideStart = { ...glassed, start: 600 };
    expect(searchFieldFits(false, { ...wideStart, room: 2 * 600 + 360 + 20 + 8 })).toBe(true);
    expect(searchFieldFits(false, { ...wideStart, room: 2 * 600 + 360 + 20 + 7 })).toBe(false);
  });

  it("keeps the field while the toolbar as drawn still fits, without the 8 px", () => {
    expect(searchFieldFits(true, { ...fielded, room: 1484 })).toBe(true);
    expect(searchFieldFits(true, { ...fielded, room: 1483 })).toBe(false);
  });

  it("does not flip between 1484 and 1491 px: the glass stays the glass and the field stays the field", () => {
    [1484, 1488, 1491].forEach((room) => {
      expect([searchFieldFits(false, { ...glassed, room }), searchFieldFits(true, { ...fielded, room })]).toEqual([false, true]);
    });
  });

  it("keeps the glass on the Mac List at 1440, where the row with the field would fit but its tabs would sit 133.4 px off the centre", () => {
    const m = { start: 291.8, middle: 346, end: 494.4, gap: 10, glass: 28, field: 180, room: 1392 };
    const fieldEnd = m.end - m.glass + m.field;
    const sides = m.middle + 2 * m.gap;
    expect(m.start + fieldEnd + sides + SEARCH_FIELD_SLACK).toBeCloseTo(1312.2, 6);
    expect(fieldEnd - (m.room - sides) / 2).toBeCloseTo(133.4, 6);
    expect([searchFieldFits(false, m), searchFieldFits(true, { ...m, end: fieldEnd })]).toEqual([false, false]);
  });
});
