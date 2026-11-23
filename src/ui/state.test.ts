import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearToasts } from "./common/Toast";
import { forgetLastPlan, parsePlace, PLACE_KEY, useUi } from "./state";

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  clearToasts();
  window.localStorage.clear();
});

const OLD = { plan: "p1", view: "list", zoom: "M", collapsed: ["g1"] };

describe("parsePlace and the plan list", () => {
  it("reads a place saved before the plan list could hide with the list shown at the stylesheet's width", () => {
    const place = parsePlace(JSON.stringify(OLD), "timeline");
    expect(place).not.toBeNull();
    expect([place?.sidebarOpen, place?.sidebarWidth]).toEqual([true, null]);
    expect(place?.view).toBe("list");
  });

  it("reads a hidden list and a stored width", () => {
    const place = parsePlace(JSON.stringify({ ...OLD, sidebarOpen: false, sidebarWidth: 312 }), "timeline");
    expect([place?.sidebarOpen, place?.sidebarWidth]).toEqual([false, 312]);
    expect(parsePlace(JSON.stringify({ ...OLD, sidebarWidth: null }), "timeline")?.sidebarWidth).toBeNull();
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
    expect(parsePlace(JSON.stringify({ ...OLD, [key]: value }), "timeline")).toBeNull();
  });

  it("finds a non-finite width unreadable", () => {
    expect(parsePlace(`{"plan":null,"sidebarWidth":1e999}`, "timeline")).toBeNull();
  });

  it("saves both fields and reads them back", () => {
    const first = renderHook(() => useUi("timeline"));
    act(() => first.result.current[1]({ sidebarOpen: false, sidebarWidth: 344 }));
    const saved: unknown = JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null");
    expect(saved).toEqual({ plan: null, view: "timeline", zoom: "W", collapsed: [], sidebarOpen: false, sidebarWidth: 344 });
    first.unmount();
    const second = renderHook(() => useUi("timeline"));
    expect([second.result.current[0].sidebarOpen, second.result.current[0].sidebarWidth]).toEqual([false, 344]);
    act(() => second.result.current[1]({ sidebarOpen: true, sidebarWidth: null }));
    expect(JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null")).toMatchObject({ sidebarOpen: true, sidebarWidth: null });
  });

  it("starts with the list shown at the stylesheet's width without a saved place", () => {
    const { result } = renderHook(() => useUi("timeline"));
    expect([result.current[0].sidebarOpen, result.current[0].sidebarWidth]).toEqual([true, null]);
  });
});

describe("the default tab", () => {
  it("the stored view beats the default tab", () => {
    expect(parsePlace(JSON.stringify(OLD), "board")?.view).toBe("list");
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ ...OLD, view: "timeline" }));
    const { result } = renderHook(() => useUi("board"));
    expect(result.current[0].view).toBe("timeline");
  });

  it("the default tab opens without a place, after an unreadable place, and without a view", () => {
    const fresh = renderHook(() => useUi("list"));
    expect(fresh.result.current[0].view).toBe("list");
    fresh.unmount();
    window.localStorage.setItem(PLACE_KEY, "{not json");
    const unreadable = renderHook(() => useUi("board"));
    expect(unreadable.result.current[0].view).toBe("board");
    unreadable.unmount();
    const noView = Object.fromEntries(Object.entries(OLD).filter(([k]) => k !== "view"));
    expect(parsePlace(JSON.stringify(noView), "board")).toMatchObject({ plan: "p1", view: "board", zoom: "M" });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(noView));
    const viewless = renderHook(() => useUi("list"));
    expect([viewless.result.current[0].view, viewless.result.current[0].plan]).toEqual(["list", "p1"]);
  });

  it("forgetting the last plan keeps a viewless place viewless, so the default tab still applies", () => {
    const noView = Object.fromEntries(Object.entries(OLD).filter(([k]) => k !== "view"));
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(noView));
    forgetLastPlan();
    expect(JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null")).toEqual({ plan: null, zoom: "M", collapsed: ["g1"], sidebarOpen: true, sidebarWidth: null });
    const { result } = renderHook(() => useUi("board"));
    expect([result.current[0].view, result.current[0].plan]).toEqual(["board", null]);
  });

  it("forgetting the last plan keeps a stored view, and a null view is still unreadable", () => {
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(OLD));
    forgetLastPlan();
    expect(JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null")).toEqual({ plan: null, view: "list", zoom: "M", collapsed: ["g1"], sidebarOpen: true, sidebarWidth: null });
    expect(parsePlace(JSON.stringify({ ...OLD, view: null }), "board")).toBeNull();
  });
});

describe("the search query", () => {
  it("starts blank, is never saved with the place, and clears when the plan changes", () => {
    const { result } = renderHook(() => useUi("timeline"));
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

describe("the Columns ask", () => {
  it("starts at 0 and is neither saved with the place nor a reason to save it", () => {
    const { result } = renderHook(() => useUi("timeline"));
    expect(result.current[0].columnsAsk).toBe(0);
    act(() => result.current[1]({ plan: "p1", columnsAsk: 1 }));
    expect([result.current[0].columnsAsk, JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null")]).toEqual([
      1,
      { plan: "p1", view: "timeline", zoom: "W", collapsed: [], sidebarOpen: true, sidebarWidth: null },
    ]);
    window.localStorage.setItem(PLACE_KEY, "untouched");
    act(() => result.current[1]({ columnsAsk: 2 }));
    expect([result.current[0].columnsAsk, window.localStorage.getItem(PLACE_KEY)]).toEqual([2, "untouched"]);
  });
});
