import { describe, expect, it } from "vitest";
import { impactText } from "./impact";

const CLOSE = "Done items keep their dates, and nothing moves earlier on its own.";

describe("impactText", () => {
  it("counts changed ends and later moves", () => {
    expect(impactText({ endsChanged: 3, movedLater: 2 })).toBe(`Applying changes the end date of 3 items; 2 move later to keep their dependencies. ${CLOSE}`);
    expect(impactText({ endsChanged: 1, movedLater: 1 })).toBe(`Applying changes the end date of 1 item; 1 moves later to keep its dependencies. ${CLOSE}`);
    expect(impactText({ endsChanged: 2, movedLater: 0 })).toBe(`Applying changes the end date of 2 items. ${CLOSE}`);
  });

  it("says when no dates change", () => {
    expect(impactText({ endsChanged: 0, movedLater: 0 })).toBe("Applying changes no dates in this plan.");
  });
});
