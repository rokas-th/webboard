import { describe, expect, it } from "vitest";
import { nextTight, TIGHT_SLACK, toolbarFit } from "./toolbarFit";

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
