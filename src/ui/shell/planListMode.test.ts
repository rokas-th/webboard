import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Platform } from "../../platform";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../../test/platform";
import { setScreen } from "../../test/setup";
import { formFactor } from "./formFactor";
import { planListMode, REGULAR_MIN_WIDTH, usePlanListMode, type PlanListMode } from "./planListMode";

const at = (platform: Platform, width: number, screenShort: number): PlanListMode =>
  planListMode({ form: formFactor({ width, screenShort }), width, platform });

describe("planListMode", () => {
  it("names 700 as the regular width", () => {
    expect(REGULAR_MIN_WIDTH).toBe(700);
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
  ])("on %s keeps the sheet in the compact form at 834 and the column in the full form", (_, platform) => {
    expect([at(platform, 834, 834), at(platform, 699, 834), at(platform, 1179, 820), at(platform, 1180, 820)]).toEqual(["sheet", "sheet", "sheet", "column"]);
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
    expect(planListMode({ form: "compact", width: 1300, platform: MAC })).toBe("sheet");
  });
});

describe("usePlanListMode", () => {
  it("follows the window width across 700 on an iPad", () => {
    setPlatform(IPAD);
    setScreen(834, 1194);
    const { result } = renderHook(() => usePlanListMode());
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
    const { result } = renderHook(() => usePlanListMode());
    expect([result.current, document.documentElement.dataset.width]).toEqual(["sheet", "regular"]);
  });

  it("turns into the column at the full form and stamps the form", () => {
    setPlatform(IPAD);
    setScreen(834, 1194);
    const { result } = renderHook(() => usePlanListMode());
    expect([result.current, document.documentElement.dataset.form]).toEqual(["overlay", "compact"]);
    act(() => setScreen(1194, 834));
    expect([result.current, document.documentElement.dataset.form]).toEqual(["column", "full"]);
  });
});
