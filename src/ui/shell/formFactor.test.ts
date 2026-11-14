import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formFactor, type FormFactor } from "./formFactor";
import { usePlanListMode } from "./planListMode";

describe("formFactor", () => {
  const cases: readonly (readonly [number, number, FormFactor])[] = [
    [390, 390, "phone"],
    [844, 390, "phone"],
    [820, 820, "compact"],
    [1023, 834, "compact"],
    [1024, 834, "compact"],
    [1100, 760, "compact"],
    [1179, 820, "compact"],
    [1180, 820, "full"],
    [1366, 1024, "full"],
    [900, 1080, "compact"],
  ];

  it.each(cases)("width %i, short screen side %i → %s", (width, screenShort, want) => {
    expect(formFactor({ width, screenShort })).toBe(want);
  });
});

describe("the window measure behind usePlanListMode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("observes the document element and re-measures when it resizes", () => {
    const observed: Element[] = [];
    const callbacks: (() => void)[] = [];
    class Watch {
      constructor(cb: () => void) {
        callbacks.push(cb);
      }
      observe(el: Element): void {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", Watch);
    expect(document.getElementById("root")).toBeNull();
    const { result } = renderHook(() => usePlanListMode());
    expect(result.current).toBe("column");
    expect(observed).toEqual([document.documentElement]);
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 820 });
    act(() => callbacks.forEach((cb) => cb()));
    expect(result.current).toBe("sheet");
    expect(document.documentElement.dataset.form).toBe("compact");
  });
});
