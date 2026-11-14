import { describe, expect, it } from "vitest";
import { appliedWidth, clampToMax, clampWidth, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_STEP, sidebarMax, widthForKey } from "./sidebarWidth";

describe("sidebar width limits", () => {
  it("holds the design's numbers", () => {
    expect([SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_STEP]).toEqual([200, 480, 16]);
  });

  it.each([
    [1920, 480],
    [1440, 480],
    [1200, 480],
    [1199, 479],
    [1180, 472],
    [1000, 400],
    [600, 240],
    [500, 200],
    [400, 200],
  ])("window %i px wide allows at most %i px", (windowWidth, max) => {
    expect(sidebarMax(windowWidth)).toBe(max);
  });

  it("clamps into min..max for the window", () => {
    expect(clampWidth(100, 1440)).toBe(200);
    expect(clampWidth(200, 1440)).toBe(200);
    expect(clampWidth(333, 1440)).toBe(333);
    expect(clampWidth(480, 1440)).toBe(480);
    expect(clampWidth(900, 1440)).toBe(480);
    expect(clampWidth(480, 1180)).toBe(472);
    expect(clampWidth(300, 400)).toBe(200);
  });

  it("rounds a fractional pointer width to whole pixels", () => {
    expect(clampWidth(300.4, 1440)).toBe(300);
    expect(clampWidth(300.6, 1440)).toBe(301);
  });

  it("throws on a width that is not a finite number", () => {
    expect(() => clampWidth(Number.NaN, 1440)).toThrow("sidebar: width NaN is not a finite number");
    expect(() => clampWidth(Number.POSITIVE_INFINITY, 1440)).toThrow("sidebar: width Infinity is not a finite number");
  });
});

describe("the applied sidebar width", () => {
  it("keeps the stylesheet's width for no stored width", () => {
    expect(appliedWidth(null, 480)).toBeNull();
  });

  it("clamps a stored width into min..max", () => {
    expect(appliedWidth(300, 480)).toBe(300);
    expect(appliedWidth(478, 472)).toBe(472);
    expect(appliedWidth(150, 480)).toBe(200);
    expect(clampToMax(478, 472)).toBe(472);
  });

  it("throws on a stored width that is not a finite number", () => {
    expect(() => appliedWidth(Number.NaN, 480)).toThrow("sidebar: width NaN is not a finite number");
  });
});

describe("sidebar width keys", () => {
  it("steps 16 px with the arrows, clamped", () => {
    expect(widthForKey("ArrowRight", 300, 1440)).toEqual({ width: 316 });
    expect(widthForKey("ArrowLeft", 300, 1440)).toEqual({ width: 284 });
    expect(widthForKey("ArrowLeft", 210, 1440)).toEqual({ width: 200 });
    expect(widthForKey("ArrowRight", 470, 1440)).toEqual({ width: 480 });
    expect(widthForKey("ArrowRight", 470, 1180)).toEqual({ width: 472 });
  });

  it("goes to min on Home and to the window's max on End", () => {
    expect(widthForKey("Home", 300, 1440)).toEqual({ width: 200 });
    expect(widthForKey("End", 300, 1440)).toEqual({ width: 480 });
    expect(widthForKey("End", 300, 1180)).toEqual({ width: 472 });
  });

  it("resets to the stylesheet's width on Enter", () => {
    expect(widthForKey("Enter", 300, 1440)).toEqual({ width: null });
  });

  it("leaves every other key alone", () => {
    expect(widthForKey("ArrowUp", 300, 1440)).toBeNull();
    expect(widthForKey("ArrowDown", 300, 1440)).toBeNull();
    expect(widthForKey(" ", 300, 1440)).toBeNull();
    expect(widthForKey("Escape", 300, 1440)).toBeNull();
    expect(widthForKey("a", 300, 1440)).toBeNull();
  });
});
