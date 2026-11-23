import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DEVICE, DEVICE_KEY, loadDevice } from "./device";
import { DeviceProvider, useDateStyle, useDevice } from "./DeviceProvider";

beforeEach(() => window.localStorage.clear());

afterEach(() => window.localStorage.clear());

const wrapper =
  (locale: string) =>
  ({ children }: { children: ReactNode }) => (
    <DeviceProvider storage={window.localStorage} locale={locale} initial={loadDevice(window.localStorage)}>
      {children}
    </DeviceProvider>
  );

describe("DeviceProvider", () => {
  it("useDevice and useDateStyle throw outside it", () => {
    expect(() => renderHook(() => useDevice())).toThrow("useDevice needs a DeviceProvider");
    expect(() => renderHook(() => useDateStyle())).toThrow("useDateStyle needs a DeviceProvider");
  });

  it("gives the date style from the format and the locale's day order", () => {
    const gb = renderHook(() => [useDevice(), useDateStyle()] as const, { wrapper: wrapper("en-GB") });
    expect(gb.result.current[1]).toEqual({ format: "system", order: "dm" });
    act(() => gb.result.current[0].set({ dates: "iso" }));
    expect(gb.result.current[1]).toEqual({ format: "iso", order: "dm" });
    gb.unmount();
    const us = renderHook(() => useDateStyle(), { wrapper: wrapper("en-US") });
    expect(us.result.current).toEqual({ format: "iso", order: "md" });
  });

  it("saves each change and keeps the other fields", () => {
    const { result } = renderHook(() => useDevice(), { wrapper: wrapper("en-GB") });
    act(() => result.current.set({ tab: "board", week: 7 }));
    act(() => result.current.setMe("planMesa001", "pDana001"));
    act(() => result.current.setMe("planOther01", "pLee00001"));
    act(() => result.current.setMe("planMesa001", null));
    const want = { ...DEFAULT_DEVICE, tab: "board", week: 7, me: { planOther01: "pLee00001" } };
    expect(result.current.prefs).toEqual(want);
    expect(JSON.parse(window.localStorage.getItem(DEVICE_KEY) ?? "null")).toEqual(want);
  });

  it("refuses a me that is not a plan id and saves nothing", () => {
    const { result } = renderHook(() => useDevice(), { wrapper: wrapper("en-GB") });
    expect(() => result.current.setMe("ix-space", "pDana001")).toThrow('Device settings would not read back: me has the key "ix-space", which is not a plan id');
    expect([result.current.prefs, window.localStorage.getItem(DEVICE_KEY)]).toEqual([DEFAULT_DEVICE, null]);
  });
});
