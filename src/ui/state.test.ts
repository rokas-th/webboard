import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearToasts } from "./common/Toast";
import { parsePlace, PLACE_KEY, useUi } from "./state";

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  clearToasts();
  window.localStorage.clear();
});

const OLD = { plan: "p1", view: "list", zoom: "M", collapsed: ["g1"] };

describe("parsePlace and the plan list", () => {
  it("reads a place saved before the plan list could hide with the list shown at the stylesheet's width", () => {
    const place = parsePlace(JSON.stringify(OLD));
    expect(place).not.toBeNull();
    expect([place?.sidebarOpen, place?.sidebarWidth]).toEqual([true, null]);
    expect(place?.view).toBe("list");
  });

  it("reads a hidden list and a stored width", () => {
    const place = parsePlace(JSON.stringify({ ...OLD, sidebarOpen: false, sidebarWidth: 312 }));
    expect([place?.sidebarOpen, place?.sidebarWidth]).toEqual([false, 312]);
    expect(parsePlace(JSON.stringify({ ...OLD, sidebarWidth: null }))?.sidebarWidth).toBeNull();
  });

  it.each([
    ["sidebarOpen", "yes"],
    ["sidebarOpen", 1],
    ["sidebarOpen", null],
    ["sidebarWidth", "300"],
    ["sidebarWidth", true],
    ["sidebarWidth", 0],
    ["sidebarWidth", -40],
    ["sidebarWidth", 300.5],
  ])("finds a place with %s %o unreadable", (key, value) => {
    expect(parsePlace(JSON.stringify({ ...OLD, [key]: value }))).toBeNull();
  });

  it("finds a non-finite width unreadable", () => {
    expect(parsePlace(`{"plan":null,"sidebarWidth":1e999}`)).toBeNull();
  });

  it("saves both fields and reads them back", () => {
    const first = renderHook(() => useUi());
    act(() => first.result.current[1]({ sidebarOpen: false, sidebarWidth: 344 }));
    const saved: unknown = JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null");
    expect(saved).toEqual({ plan: null, view: "timeline", zoom: "W", collapsed: [], sidebarOpen: false, sidebarWidth: 344 });
    first.unmount();
    const second = renderHook(() => useUi());
    expect([second.result.current[0].sidebarOpen, second.result.current[0].sidebarWidth]).toEqual([false, 344]);
    act(() => second.result.current[1]({ sidebarOpen: true, sidebarWidth: null }));
    expect(JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null")).toMatchObject({ sidebarOpen: true, sidebarWidth: null });
  });

  it("starts with the list shown at the stylesheet's width without a saved place", () => {
    const { result } = renderHook(() => useUi());
    expect([result.current[0].sidebarOpen, result.current[0].sidebarWidth]).toEqual([true, null]);
  });
});

describe("the search query", () => {
  it("starts blank, is never saved with the place, and clears when the plan changes", () => {
    const { result } = renderHook(() => useUi());
    expect([result.current[0].query, result.current[0].searchAsk]).toEqual(["", 0]);
    act(() => result.current[1]({ plan: "p1", query: "dome", searchAsk: 2 }));
    expect([result.current[0].query, result.current[0].searchAsk]).toEqual(["dome", 2]);
    expect(JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null")).toEqual({ plan: "p1", view: "timeline", zoom: "W", collapsed: [], sidebarOpen: true, sidebarWidth: null });
    act(() => result.current[1]({ view: "board" }));
    expect(result.current[0].query).toBe("dome");
    act(() => result.current[1]({ plan: "p1" }));
    expect(result.current[0].query).toBe("dome");
    act(() => result.current[1]({ plan: "p2" }));
    expect([result.current[0].query, result.current[0].searchAsk]).toEqual(["", 2]);
  });
});
