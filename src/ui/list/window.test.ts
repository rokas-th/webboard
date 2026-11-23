import { describe, expect, it } from "vitest";
import { listWindow, ROW_PX } from "./window";

describe("listWindow", () => {
  it("rows are 34 px", () => {
    expect(ROW_PX).toBe(34);
  });

  it("mounts the visible rows plus ten on each side, padding the rest", () => {
    expect(listWindow(3400, 680, 1000)).toEqual({ first: 90, last: 130, top: 90 * 34, bottom: (1000 - 130) * 34 });
  });

  it("stops at the top and at the bottom", () => {
    expect(listWindow(0, 680, 1000)).toEqual({ first: 0, last: 30, top: 0, bottom: 970 * 34 });
    expect(listWindow(1000 * 34 - 680, 680, 1000)).toEqual({ first: 970, last: 1000, top: 970 * 34, bottom: 0 });
  });

  it("mounts every row of a short list", () => {
    expect(listWindow(0, 680, 7)).toEqual({ first: 0, last: 7, top: 0, bottom: 0 });
  });

  it("mounts only the overscan before a height is known, and nothing of an empty list", () => {
    expect(listWindow(0, 0, 1000)).toEqual({ first: 0, last: 10, top: 0, bottom: 990 * 34 });
    expect(listWindow(0, 680, 0)).toEqual({ first: 0, last: 0, top: 0, bottom: 0 });
  });

  it("clamps a scroll position past the end", () => {
    expect(listWindow(1e6, 680, 100)).toEqual({ first: 70, last: 100, top: 70 * 34, bottom: 0 });
  });

  it("takes another row height and overscan", () => {
    expect(listWindow(440, 220, 100, 44, 2)).toEqual({ first: 8, last: 17, top: 8 * 44, bottom: 83 * 44 });
  });

  it("refuses a negative or broken input", () => {
    expect(() => listWindow(-1, 680, 10)).toThrow("listWindow: scrollTop -1");
    expect(() => listWindow(0, Number.NaN, 10)).toThrow("listWindow: height NaN");
    expect(() => listWindow(0, 680, 1.5)).toThrow("listWindow: count 1.5");
  });
});
