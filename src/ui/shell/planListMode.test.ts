import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Platform } from "../../platform";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../../test/platform";
import { setScreen } from "../../test/setup";
import { formFactor } from "./formFactor";
import { DESK_MIN_WIDTH, DESK_ROOMY_BELOW, MEDIUM_MIN, planListMode, REGULAR_MIN_WIDTH, ROOMY_MIN, toolbarTier, useShellShape, type PlanListMode, type ToolbarTier } from "./planListMode";

const at = (platform: Platform, width: number, screenShort: number): PlanListMode =>
  planListMode({ form: formFactor({ width, screenShort }), width, platform });

describe("planListMode", () => {
  it("names 700 as the regular width", () => {
    expect(REGULAR_MIN_WIDTH).toBe(700);
  });

  it("names 1024 as the desk minimum", () => {
    expect(DESK_MIN_WIDTH).toBe(1024);
  });

  const ipad: readonly (readonly [number, PlanListMode])[] = [
    [1194, "column"],
    [1180, "column"],
    [1179, "overlay"],
    [834, "overlay"],
    [700, "overlay"],
    [699, "sheet"],
  ];

  it.each(ipad)("on an iPad at width %i → %s", (width, want) => {
    expect(at(IPAD, width, 834)).toBe(want);
  });

  it.each<readonly [string, Platform]>([
    ["macOS", MAC],
    ["Linux", LINUX],
  ])("on %s keeps the sheet below 1024 and the column from 1024", (_, platform) => {
    expect([at(platform, 834, 834), at(platform, 699, 834), at(platform, 1023, 820), at(platform, 1024, 820), at(platform, 1179, 820), at(platform, 1180, 820)]).toEqual(["sheet", "sheet", "sheet", "column", "column", "column"]);
  });

  it.each<readonly [string, Platform]>([
    ["an iPhone", IPHONE],
    ["an iPad", IPAD],
    ["macOS", MAC],
    ["Linux", LINUX],
  ])("on a phone screen it is the phone shell on %s", (_, platform) => {
    expect([at(platform, 834, 390), at(platform, 390, 390)]).toEqual(["phone", "phone"]);
  });

  it("answers from the form it is given, not from the width alone", () => {
    expect(planListMode({ form: "full", width: 834, platform: IPAD })).toBe("column");
    expect(planListMode({ form: "phone", width: 1194, platform: IPAD })).toBe("phone");
    expect(planListMode({ form: "compact", width: 1300, platform: MAC })).toBe("column");
  });
});

describe("useShellShape().mode", () => {
  it("follows the window width across 700 on an iPad", () => {
    setPlatform(IPAD);
    setScreen(834, 1194);
    const { result } = renderHook(() => useShellShape().mode);
    expect([result.current, document.documentElement.dataset.width]).toEqual(["overlay", "regular"]);
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 699 });
      window.dispatchEvent(new Event("resize"));
    });
    expect([result.current, document.documentElement.dataset.width]).toEqual(["sheet", "compact"]);
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: REGULAR_MIN_WIDTH });
      window.dispatchEvent(new Event("resize"));
    });
    expect([result.current, document.documentElement.dataset.width]).toEqual(["overlay", "regular"]);
  });

  it("stamps the width class from the same 700 on every platform", () => {
    setPlatform(MAC);
    setScreen(834, 1194);
    const { result } = renderHook(() => useShellShape().mode);
    expect([result.current, document.documentElement.dataset.width]).toEqual(["sheet", "regular"]);
  });

  it("turns into the column at the full form and stamps the form", () => {
    setPlatform(IPAD);
    setScreen(834, 1194);
    const { result } = renderHook(() => useShellShape().mode);
    expect([result.current, document.documentElement.dataset.form]).toEqual(["overlay", "compact"]);
    act(() => setScreen(1194, 834));
    expect([result.current, document.documentElement.dataset.form]).toEqual(["column", "full"]);
  });
});

const tierAt = (platform: Platform, width: number, screenShort: number): ToolbarTier | null =>
  toolbarTier({ form: formFactor({ width, screenShort }), width, platform });

describe("toolbarTier", () => {
  it("puts the medium tier above the iPad's portrait width, which the Inspector button fills, and the roomy one inside the compact form", () => {
    expect(MEDIUM_MIN).toBeGreaterThan(834);
    expect(MEDIUM_MIN).toBeGreaterThan(560);
    expect(ROOMY_MIN).toBeGreaterThan(MEDIUM_MIN);
    expect(ROOMY_MIN).toBeLessThan(1180);
    expect([MEDIUM_MIN % 10, ROOMY_MIN % 10]).toEqual([0, 0]);
  });

  const ipad: readonly (readonly [string, number, ToolbarTier | null])[] = [
    ["1180", 1180, null],
    ["1179", 1179, "roomy"],
    ["ROOMY_MIN", ROOMY_MIN, "roomy"],
    ["ROOMY_MIN - 1", ROOMY_MIN - 1, "medium"],
    ["MEDIUM_MIN", MEDIUM_MIN, "medium"],
    ["MEDIUM_MIN - 1", MEDIUM_MIN - 1, "narrow"],
    ["834", 834, "narrow"],
    ["700", 700, "narrow"],
    ["699", 699, "narrow"],
    ["560", 560, "narrow"],
  ];

  it.each(ipad)("on an iPad at %s → %s", (_, width, want) => {
    expect(tierAt(IPAD, width, 834)).toBe(want);
  });

  it.each<readonly [string, Platform]>([
    ["macOS", MAC],
    ["Linux", LINUX],
  ])("on %s trims the column toolbar from 1024 up to 1179, and has no tier elsewhere", (_, platform) => {
    expect(DESK_ROOMY_BELOW).toBe(1180);
    expect([1920, 1180, 1179, 1100, DESK_MIN_WIDTH, DESK_MIN_WIDTH - 1, ROOMY_MIN, 834, 560].map((w) => tierAt(platform, w, 820))).toEqual([
      null,
      null,
      "roomy",
      "roomy",
      "roomy",
      null,
      null,
      null,
      null,
    ]);
  });

  it.each<readonly [string, Platform]>([["an iPhone", IPHONE]])("has no tier on %s at any width", (_, platform) => {
    expect([1179, ROOMY_MIN, ROOMY_MIN - 1, 834, MEDIUM_MIN, MEDIUM_MIN - 1, 700, 560, 390].map((w) => tierAt(platform, w, 834))).toEqual(Array.from({ length: 9 }, () => null));
    expect(tierAt(platform, 390, 390)).toBeNull();
  });

  it("has no tier on an iPad's phone-sized screen or in the full form", () => {
    expect(toolbarTier({ form: "phone", width: 834, platform: IPAD })).toBeNull();
    expect(toolbarTier({ form: "full", width: 834, platform: IPAD })).toBeNull();
  });
});

describe("useShellShape", () => {
  it("follows the window width on an iPad", () => {
    setPlatform(IPAD);
    setScreen(834, 1194);
    const { result } = renderHook(() => useShellShape().tier);
    expect(result.current).toBe("narrow");
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: MEDIUM_MIN });
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe("medium");
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: ROOMY_MIN });
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe("roomy");
    act(() => setScreen(1194, 834));
    expect(result.current).toBeNull();
  });

  it("is null on macOS at the same width", () => {
    setPlatform(MAC);
    setScreen(834, 1194);
    const { result } = renderHook(() => useShellShape().tier);
    expect(result.current).toBeNull();
  });
});
