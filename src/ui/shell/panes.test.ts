import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPAD, IPHONE, LINUX, MAC } from "../../test/platform";
import { clearToasts, COPY_DETAILS, Toasts } from "../common/Toast";
import { PLACE_KEY } from "../state";
import { PANES_KEY, PANES_UNREADABLE, paneDevice, parsePanes, readPanes, seedPanes, usePanes, type PaneDevice, type PaneSet, type PanesRecord } from "./panes";

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearToasts();
  window.localStorage.clear();
});

const SET: PaneSet = { list: { open: false, w: 312 }, outline: { open: true, w: null }, inspector: { open: true, w: 420 } };
const FULL: PanesRecord = { v: 1, desk: SET, padLandscape: { ...SET, list: { open: true, w: null } }, padPortrait: { ...SET, outline: { open: false, w: 180 } } };

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const stored = (): unknown => JSON.parse(window.localStorage.getItem(PANES_KEY) ?? "null");

const DEFAULT_SET: PaneSet = { list: { open: true, w: null }, outline: { open: true, w: null }, inspector: { open: true, w: null } };

describe("parsePanes", () => {
  it("reads a full record", () => {
    expect(parsePanes(JSON.stringify(FULL))).toEqual(FULL);
  });

  it("reads widths beyond the limits; they are clamped on use", () => {
    const wide = { ...FULL, desk: { ...SET, inspector: { open: true, w: 5000 } } };
    expect(parsePanes(JSON.stringify(wide))?.desk.inspector).toEqual({ open: true, w: 5000 });
  });

  it.each<readonly [string, string]>([
    ["an unknown top key", JSON.stringify({ ...FULL, phone: SET })],
    ["an unknown pane key", JSON.stringify({ ...FULL, desk: { ...SET, board: { open: true, w: null } } })],
    ["an unknown state key", JSON.stringify({ ...FULL, desk: { ...SET, list: { open: true, w: null, h: 3 } } })],
    ["a missing device", JSON.stringify({ v: 1, desk: SET, padLandscape: SET })],
    ["a missing pane", JSON.stringify({ ...FULL, desk: { list: SET.list, outline: SET.outline } })],
    ["a missing width", JSON.stringify({ ...FULL, desk: { ...SET, list: { open: true } } })],
    ["v 2", JSON.stringify({ ...FULL, v: 2 })],
    ["no v", JSON.stringify({ desk: SET, padLandscape: SET, padPortrait: SET })],
    ["w 0", JSON.stringify({ ...FULL, desk: { ...SET, list: { open: true, w: 0 } } })],
    ["w −40", JSON.stringify({ ...FULL, desk: { ...SET, list: { open: true, w: -40 } } })],
    ["w 300.5", JSON.stringify({ ...FULL, desk: { ...SET, list: { open: true, w: 300.5 } } })],
    ["w 1e999", `{"v":1,"desk":{"list":{"open":true,"w":1e999},"outline":{"open":true,"w":null},"inspector":{"open":true,"w":null}},"padLandscape":${JSON.stringify(SET)},"padPortrait":${JSON.stringify(SET)}}`],
    ["w \"300\"", JSON.stringify({ ...FULL, desk: { ...SET, list: { open: true, w: "300" } } })],
    ["open \"yes\"", JSON.stringify({ ...FULL, desk: { ...SET, list: { open: "yes", w: null } } })],
    ["an array", JSON.stringify([FULL])],
    ["null", "null"],
    ["broken JSON", "{\"v\":1,"],
  ])("rejects %s", (_, raw) => {
    expect(parsePanes(raw)).toBeNull();
  });

  it.each<readonly [string, string]>([
    ["the record is {v, desk, padLandscape, padPortrait, phone}, not {v, desk, padLandscape, padPortrait}", JSON.stringify({ ...FULL, phone: SET })],
    ["v is 2, not 1", JSON.stringify({ ...FULL, v: 2 })],
    ["padPortrait is {list, outline}, not {list, outline, inspector}", JSON.stringify({ ...FULL, padPortrait: { list: SET.list, outline: SET.outline } })],
    ['desk.list.open is "yes", not true or false', JSON.stringify({ ...FULL, desk: { ...SET, list: { open: "yes", w: null } } })],
    ["desk.outline.w is -40, not null or a whole number of pixels above 0", JSON.stringify({ ...FULL, desk: { ...SET, outline: { open: true, w: -40 } } })],
    ["desk.list is {open}, not {open, w}", JSON.stringify({ ...FULL, desk: { ...SET, list: { open: true } } })],
    ["the record is null, not {v, desk, padLandscape, padPortrait}", "null"],
  ])("names what it rejects: %s", (reason, raw) => {
    expect(readPanes(raw)).toEqual({ ok: false, reason });
  });

  it("names broken JSON as such", () => {
    const read = readPanes('{"v":1,');
    expect(read.ok ? null : read.reason.startsWith("it is not JSON (")).toBe(true);
  });
});

describe("seedPanes", () => {
  it("opens every pane at its default without a place", () => {
    expect(seedPanes(null)).toEqual({ v: 1, desk: DEFAULT_SET, padLandscape: DEFAULT_SET, padPortrait: DEFAULT_SET });
  });

  it("takes every device's list from a readable place", () => {
    const seeded = seedPanes(JSON.stringify({ plan: "p1", view: "board", zoom: "M", collapsed: [], sidebarOpen: false, sidebarWidth: 344 }));
    expect([seeded.desk.list, seeded.padLandscape.list, seeded.padPortrait.list]).toEqual(Array.from({ length: 3 }, () => ({ open: false, w: 344 })));
    expect([seeded.desk.outline, seeded.desk.inspector]).toEqual([DEFAULT_SET.outline, DEFAULT_SET.inspector]);
  });

  it("ignores an unreadable place", () => {
    expect(seedPanes("{not json")).toEqual(seedPanes(null));
    expect(seedPanes(JSON.stringify({ sidebarWidth: -4 }))).toEqual(seedPanes(null));
  });
});

describe("paneDevice", () => {
  it("paneDevice", () => {
    expect([paneDevice(MAC, 1440, 900), paneDevice(LINUX, 800, 1200), paneDevice(MAC, 390, 844)]).toEqual(["desk", "desk", "desk"]);
    expect([paneDevice(IPAD, 1194, 834), paneDevice(IPAD, 1366, 1024), paneDevice(IPAD, 834, 1194), paneDevice(IPAD, 700, 1000), paneDevice(IPAD, 1000, 1000)]).toEqual([
      "padLandscape",
      "padLandscape",
      "padPortrait",
      "padPortrait",
      "padLandscape",
    ]);
    expect([paneDevice(IPHONE, 390, 844), paneDevice(IPHONE, 844, 390)]).toEqual(["phone", "phone"]);
  });
});

describe("usePanes", () => {
  it("seeds every list from the place once", () => {
    const place = JSON.stringify({ plan: null, view: "timeline", zoom: "W", collapsed: [], sidebarOpen: false, sidebarWidth: 330 });
    window.localStorage.setItem(PLACE_KEY, place);
    const first = renderHook(() => usePanes("padPortrait"));
    expect(first.result.current.panes.list).toEqual({ open: false, w: 330 });
    expect(stored()).toEqual(seedPanes(place));
    first.unmount();
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: null, view: "timeline", zoom: "W", collapsed: [], sidebarOpen: true, sidebarWidth: 250 }));
    const second = renderHook(() => usePanes("desk"));
    expect(second.result.current.panes.list).toEqual({ open: false, w: 330 });
    expect(stored()).toEqual(seedPanes(place));
    expect(window.localStorage.getItem(PLACE_KEY)).toBe(JSON.stringify({ plan: null, view: "timeline", zoom: "W", collapsed: [], sidebarOpen: true, sidebarWidth: 250 }));
  });

  it("reads the device's own set and writes one pane without touching the others", () => {
    window.localStorage.setItem(PANES_KEY, JSON.stringify(FULL));
    const { result } = renderHook(() => usePanes("padPortrait"));
    expect(result.current.panes).toEqual(FULL.padPortrait);
    act(() => result.current.setPane("inspector", { open: false, w: 400 }));
    expect(result.current.panes.inspector).toEqual({ open: false, w: 400 });
    expect(stored()).toEqual({ ...FULL, padPortrait: { ...FULL.padPortrait, inspector: { open: false, w: 400 } } });
    expect(window.localStorage.getItem(PLACE_KEY)).toBeNull();
  });

  it("follows the device it is given", () => {
    window.localStorage.setItem(PANES_KEY, JSON.stringify(FULL));
    const { result, rerender } = renderHook((p: { device: PaneDevice }) => usePanes(p.device), { initialProps: { device: "desk" } });
    expect(result.current.panes).toEqual(FULL.desk);
    rerender({ device: "padLandscape" });
    expect(result.current.panes).toEqual(FULL.padLandscape);
  });

  it("an unreadable record resets only its key, toasts once", () => {
    const place = JSON.stringify({ plan: null, view: "timeline", zoom: "W", collapsed: [], sidebarOpen: false, sidebarWidth: 330 });
    window.localStorage.setItem(PLACE_KEY, place);
    window.localStorage.setItem(PANES_KEY, JSON.stringify({ ...FULL, v: 2 }));
    render(createElement(Toasts));
    const { result, rerender } = renderHook(() => usePanes("desk"));
    rerender();
    expect(result.current.panes).toEqual(DEFAULT_SET);
    expect(stored()).toEqual(seedPanes(null));
    expect(window.localStorage.getItem(PLACE_KEY)).toBe(place);
    expect(toastTexts().filter((t) => t === PANES_UNREADABLE)).toHaveLength(1);
    expect(document.querySelector(".toasts .toast")?.className).toBe("toast bad");
  });

  it("writes the seed once, after render, even when React renders twice", () => {
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => usePanes("desk"), { reactStrictMode: true });
    expect(result.current.panes).toEqual(DEFAULT_SET);
    expect(writes.mock.calls.filter((c) => c[0] === PANES_KEY)).toEqual([[PANES_KEY, JSON.stringify(seedPanes(null))]]);
  });

  it("gives the reason and the rejected record as the toast's details", async () => {
    const raw = JSON.stringify({ ...FULL, desk: { ...SET, inspector: { open: true, w: 300.5 } } });
    window.localStorage.setItem(PANES_KEY, raw);
    const written: string[] = [];
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: (text: string) => Promise.resolve(void written.push(text)) } });
    render(createElement(Toasts));
    renderHook(() => usePanes("desk"));
    fireEvent.click(screen.getByRole("button", { name: COPY_DETAILS }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(written).toEqual([`desk.inspector.w is 300.5, not null or a whole number of pixels above 0. The record was: ${raw}`]);
  });

  it("lets storage errors propagate", () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    try {
      expect(() => renderHook(() => usePanes("desk"))).toThrow("full");
    } finally {
      Storage.prototype.setItem = real;
    }
  });
});
