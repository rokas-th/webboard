import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootDevice, DEFAULT_DEVICE, DESK_TEXT_SIZES, DEVICE_KEY, DEVICE_UNREADABLE, loadDevice, lookOf, PAD_TEXT_SIZES, PHONE_TEXT_SIZES, readDevice, saveDevice, SMALL_TEXT_ZOOM, textSizesOn, type DevicePrefs } from "./device";

const toasted = vi.hoisted((): [string, string | undefined, string | undefined][] => []);

vi.mock("./common/Toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./common/Toast")>()),
  toast: (text: string, tone?: string, details?: string) => {
    toasted.push([text, tone, details]);
  },
}));

beforeEach(() => {
  window.localStorage.clear();
  toasted.length = 0;
});

afterEach(() => window.localStorage.clear());

const toasts = (): readonly [string, string | undefined, string | undefined][] => toasted;

const FULL: DevicePrefs = { v: 1, tab: "list", week: 7, dates: "dmy", density: "compact", text: "small", glow: "reduced", me: { planMesa001: "pDana001", P0000000000: "x_y-z" } };

const reasonOf = (raw: string): string => {
  const read = readDevice(raw);
  if (read.ok) throw new Error(`readDevice accepted ${raw}`);
  return read.reason;
};

describe("device prefs", () => {
  it("defaults to the Timeline, Monday, System dates, comfortable, default text, full glow and nobody", () => {
    expect(DEFAULT_DEVICE).toEqual({ v: 1, tab: "timeline", week: 1, dates: "system", density: "comfortable", text: "default", glow: "full", me: {} });
    expect(SMALL_TEXT_ZOOM).toBe(0.92);
    expect(loadDevice(window.localStorage)).toEqual(DEFAULT_DEVICE);
    expect(toasts()).toEqual([]);
  });

  it("round-trips every field", () => {
    saveDevice(window.localStorage, FULL);
    expect(JSON.parse(window.localStorage.getItem(DEVICE_KEY) ?? "null")).toEqual(FULL);
    expect(readDevice(window.localStorage.getItem(DEVICE_KEY) ?? "")).toEqual({ ok: true, value: FULL });
    expect(loadDevice(window.localStorage)).toEqual(FULL);
  });

  it.each([
    ["{", "it is not JSON"],
    ["[]", "the record is [], not {dates, density, glow, me, tab, text, v, week}"],
    [JSON.stringify({ ...FULL, extra: 1 }), "the record is {v, tab, week, dates, density, text, glow, me, extra}, not {dates, density, glow, me, tab, text, v, week}"],
    [JSON.stringify({ ...FULL, v: 2 }), "v is 2, not 1"],
    [JSON.stringify({ ...FULL, tab: "gantt" }), 'tab is "gantt", not timeline, board or list'],
    [JSON.stringify({ ...FULL, week: 0 }), "week is 0, not 1 or 7"],
    [JSON.stringify({ ...FULL, week: "7" }), 'week is "7", not 1 or 7'],
    [JSON.stringify({ ...FULL, dates: "us" }), 'dates is "us", not system, iso or dmy'],
    [JSON.stringify({ ...FULL, density: "dense" }), 'density is "dense", not comfortable or compact'],
    [JSON.stringify({ ...FULL, text: "huge" }), 'text is "huge", not small or default'],
    [JSON.stringify({ ...FULL, text: "large" }), 'text is "large", not small or default'],
    [JSON.stringify({ ...FULL, glow: false }), "glow is false, not full or reduced"],
    [JSON.stringify({ ...FULL, me: [] }), "me is [], not a map of plans to people"],
    [JSON.stringify({ ...FULL, me: { "ix-space00001": "p1" } }), 'me has the key "ix-space00001", which is not a plan id'],
    [JSON.stringify({ ...FULL, me: { "bad id": "p1" } }), 'me has the key "bad id", which is not a plan id'],
    [JSON.stringify({ ...FULL, me: { planMesa001: 7 } }), "me.planMesa001 is 7, not a person id"],
    [JSON.stringify({ ...FULL, me: { planMesa001: "" } }), 'me.planMesa001 is "", not a person id'],
  ])("refuses %s", (raw, reason) => {
    expect(reasonOf(raw).startsWith(reason)).toBe(true);
  });

  it("resets only its own key with one toast that carries the reason", () => {
    window.localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...FULL, week: 3 }));
    window.localStorage.setItem("webboard.place", "kept");
    expect(loadDevice(window.localStorage)).toEqual(DEFAULT_DEVICE);
    expect([window.localStorage.getItem(DEVICE_KEY), window.localStorage.getItem("webboard.place")]).toEqual([null, "kept"]);
    expect(toasts()).toEqual([[DEVICE_UNREADABLE, "bad", "week is 3, not 1 or 7"]]);
    expect(DEVICE_UNREADABLE).toBe("Saved device settings could not be read; they were reset.");
  });

  it("refuses to save a record it could not read back", () => {
    expect(() => saveDevice(window.localStorage, { ...FULL, me: { "ix-x": "p1" } })).toThrow('Device settings would not read back: me has the key "ix-x", which is not a plan id');
    expect(window.localStorage.getItem(DEVICE_KEY)).toBeNull();
  });

  it("boots: loads the prefs and shows their look, or writes why it could not start into the root and throws", () => {
    const mac = { os: "macos", idiom: null } as const;
    const root = document.createElement("div");
    const shown: unknown[] = [];
    saveDevice(window.localStorage, FULL);
    expect(bootDevice(window.localStorage, mac, (look) => shown.push(look), root)).toEqual(FULL);
    expect([shown, root.textContent]).toEqual([[{ density: "compact", text: "small", glow: "reduced" }], ""]);
    const broken = new Error("storage is gone");
    const storage: Storage = {
      ...window.localStorage,
      length: 0,
      clear: () => undefined,
      key: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      getItem: () => {
        throw broken;
      },
    };
    expect(() => bootDevice(storage, mac, (look) => shown.push(look), root)).toThrow(broken);
    expect([shown.length, root.textContent]).toEqual([1, "WebBoard could not start: its device settings could not be loaded (storage is gone)."]);
  });

  it("caps the look per platform", () => {
    const mac = { os: "macos", idiom: null } as const;
    const linux = { os: "linux", idiom: null } as const;
    const pad = { os: "ios", idiom: "pad" } as const;
    const phone = { os: "ios", idiom: "phone" } as const;
    const small = { ...FULL, density: "compact", text: "small", glow: "reduced" } as const;
    expect([lookOf(small, mac), lookOf(small, linux)]).toEqual([
      { density: "compact", text: "small", glow: "reduced" },
      { density: "compact", text: "small", glow: "reduced" },
    ]);
    expect([lookOf(small, pad), lookOf(small, phone)]).toEqual([
      { density: "comfortable", text: "default", glow: "reduced" },
      { density: "comfortable", text: "default", glow: "reduced" },
    ]);
    expect([textSizesOn(mac), textSizesOn(linux), textSizesOn(pad), textSizesOn(phone)]).toEqual([["small", "default"], ["small", "default"], ["default"], ["default"]]);
    expect([DESK_TEXT_SIZES, PAD_TEXT_SIZES, PHONE_TEXT_SIZES]).toEqual([["small", "default"], ["default"], ["default"]]);
  });
});
