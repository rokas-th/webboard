import { describe, expect, it } from "vitest";
import { linkPath } from "./linkPath";

const pred = { x0: 0, x1: 100, y: 17 };
const succ = { x0: 140, x1: 200, y: 51 };

describe("linkPath", () => {
  it("draws the mockup's paths", () => {
    expect(linkPath("FS", pred, succ)).toBe("M100,17 H108 V51 H138");
    expect(linkPath("FF", pred, succ)).toBe("M100,17 H210 V51 H202");
    expect(linkPath("SS", pred, succ)).toBe("M0,17 H-8 V34 H128 V51 H138");
    expect(linkPath("SF", pred, succ)).toBe("M0,17 H-8 V51 H202");
  });

  it("doglegs a finish-to-start link whose successor starts too close", () => {
    expect(linkPath("FS", pred, { x0: 110, x1: 150, y: 51 })).toBe("M100,17 H108 V34 H98 V51 H108");
    expect(linkPath("FS", { x0: 0, x1: 100, y: 51 }, { x0: 110, x1: 150, y: 17 })).toBe("M100,51 H108 V34 H98 V17 H108");
  });
});
