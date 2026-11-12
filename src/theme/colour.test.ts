import { describe, expect, it } from "vitest";
import { channels, contrast, hexToRgb, hslToHex, hueGap, isHex, isRedish, luminance, mix, rgba, rgbToHex, rgbToHsl } from "./colour";
import { PRESETS } from "./presets";

describe("colour maths", () => {
  it("measures WCAG contrast", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 2);
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 2);
    expect(Math.abs(contrast("#7485A0", "#16162A") - 4.74)).toBeLessThanOrEqual(0.01);
  });

  it("computes relative luminance", () => {
    expect(luminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(luminance("#000000")).toBe(0);
  });

  it("mixes linearly in sRGB, rounded per channel", () => {
    expect(mix("#000000", "#FFFFFF", 0.5)).toBe("#808080");
    expect(mix("#0A0A14", "#000000", 0.6)).toBe("#040408");
    expect(mix("#123456", "#ABCDEF", 0)).toBe("#123456");
    expect(mix("#123456", "#ABCDEF", 1)).toBe("#ABCDEF");
  });

  it("round-trips every preset seed through HSL", () => {
    const seeds = PRESETS.flatMap((t) => Object.values(t.seeds));
    expect(seeds).toHaveLength(75);
    expect(seeds.filter((h) => hslToHex(rgbToHsl(h)) !== h)).toEqual([]);
    expect(hslToHex(rgbToHsl("#24E0FF"))).toBe("#24E0FF");
  });

  it("measures hue gaps across 0 degrees", () => {
    expect(Math.abs(hueGap("#FF3B6B", "#FFB000") - 56)).toBeLessThanOrEqual(1);
    expect(hueGap("#FF0000", "#FF0000")).toBe(0);
    expect(hueGap("#FF0000", "#00FFFF")).toBeCloseTo(180, 6);
  });

  it("knows what is red-ish", () => {
    expect(isRedish("#FF3B6B")).toBe(true);
    expect(isRedish("#F67B2E")).toBe(false);
    expect(isRedish("#808080")).toBe(false);
    expect(isRedish("#FF0000")).toBe(true);
  });

  it("formats rgba and channel strings", () => {
    expect(rgba("#FFB000", 0.45)).toBe("rgba(255, 176, 0, 0.45)");
    expect(channels("#FFB000")).toBe("255, 176, 0");
  });

  it("accepts only uppercase #RRGGBB", () => {
    expect(isHex("#ffb000")).toBe(false);
    expect(isHex("#FFB000")).toBe(true);
    expect(isHex("#FFF")).toBe(false);
    expect(isHex("FFB000")).toBe(false);
    expect(isHex(255)).toBe(false);
    expect(isHex(undefined)).toBe(false);
  });

  it("converts between hex and rgb, clamping and rounding", () => {
    expect(hexToRgb("#FFB000")).toEqual([255, 176, 0]);
    expect(rgbToHex([300, -4, 15.6])).toBe("#FF0010");
    expect(rgbToHex([10, 11, 12])).toBe("#0A0B0C");
  });

  it("throws on malformed input instead of guessing", () => {
    expect(() => hexToRgb("#ffb000")).toThrow();
    expect(() => hexToRgb("nope")).toThrow();
    expect(() => rgbToHex([1, 2])).toThrow();
    expect(() => rgbToHex([1, 2, Number.NaN])).toThrow();
  });
});
