import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPlatform } from "../test/platform";
import { emitFromRust, hold, pickTab, resetTauri, tauri } from "../test/tauriMock";
import ProbeApp from "./ProbeApp";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../test/tauriMock"));

const ORIGINAL_VIEWPORT = "width=device-width, initial-scale=2.0, user-scalable=no";

const loadAnswer = (): ArrayBuffer => {
  const bytes = new Uint8Array(17);
  new DataView(bytes.buffer).setUint32(9, 1, true);
  return bytes.buffer;
};

const logged = (): string[] => tauri.calls.filter((c) => c.cmd === "probe_log").map((c) => (c.args as { line: string }).line);

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const mount = (): void => {
  render(<ProbeApp />, { container: document.getElementById("root") as HTMLElement });
};

const touch = (el: Element, type: string, fingers: number): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: Array.from({ length: fingers }, (_, i) => ({ clientX: 20 + i * 40, clientY: 20 })) });
  el.dispatchEvent(e);
  return e;
};

const resizeLines = (): string[] => logged().filter((l) => l.startsWith('window {"on":"resize"'));

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const meta = document.createElement("meta");
  meta.setAttribute("name", "viewport");
  meta.setAttribute("content", ORIGINAL_VIEWPORT);
  document.head.append(meta);
  resetTauri({
    probe_log: () => null,
    store_load: loadAnswer,
    store_append: () => null,
    store_list: () => ["probe"],
    holidays_year: () => ({ days: [{ date: "2027-01-01" }], fetchedAt: "x", fromCache: true, coverage: null }),
    menu_dismiss: (args) => {
      emitFromRust("menu-ended", { token: (args as { token: string }).token });
      return null;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.head.querySelectorAll('meta[name="viewport"]').forEach((m) => m.remove());
});

describe("ProbeApp", () => {
  it("logs ready and the window first, then paths and holidays, through probe_log", async () => {
    mount();
    await settle();
    const lines = logged();
    expect(lines[0]).toMatch(/^ready \{"userAgent":/);
    expect(lines[1]).toMatch(/^window \{"on":"mount","inner":\[/);
    expect(lines.indexOf('paths {"appended":1,"docs":["probe"],"listed":true}')).toBeGreaterThan(1);
    expect(lines.indexOf('holidays {"days":1,"fromCache":true,"first":"2027-01-01"}')).toBeGreaterThan(1);
    expect(lines).toHaveLength(4);
  });

  it("reports the injected platform global in its ready line", async () => {
    setPlatform({ os: "ios", idiom: "pad" });
    mount();
    await settle();
    expect(logged()[0]).toMatch(/^ready \{"userAgent":.*"platform":\{"os":"ios","idiom":"pad"\}\}$/);
  });

  it("on iOS asks the probe alert by itself and logs its answer", async () => {
    setPlatform({ os: "ios", idiom: "pad" });
    tauri.answers.alert_ask = () => "confirm";
    mount();
    await settle();
    expect(tauri.calls.filter((c) => c.cmd === "alert_ask").map((c) => c.args)).toEqual([
      { ask: { title: "WebBoard probe alert", message: "Nothing is changed. Tap either button.", confirm: { label: "Confirm", destructive: false }, cancel: "Cancel" } },
    ]);
    expect(logged()).toContain('alert {"answer":"confirm"}');
  });

  it("on iOS logs a failed probe alert as a bad line", async () => {
    setPlatform({ os: "ios", idiom: "phone" });
    tauri.answers.alert_ask = () => {
      throw { code: "alert.no_controller", message: "no controller" };
    };
    mount();
    await settle();
    const line = 'alert {"error":"alert.no_controller","message":"no controller"}';
    expect(screen.getByText(line)).toHaveProperty("className", "probe-bad");
    expect(logged()).toContain(line);
  });

  it("on iOS shows and dismisses the probe menu after the haptic and before the alert, logging both ends", async () => {
    setPlatform({ os: "ios", idiom: "pad" });
    tauri.answers.alert_ask = () => "cancel";
    mount();
    await settle();
    await settle();
    const native = tauri.calls.map((c) => c.cmd).filter((c) => ["appearance_set", "haptic", "menu_show", "menu_dismiss", "alert_ask"].includes(c));
    expect(native).toEqual(["appearance_set", "haptic", "menu_show", "menu_dismiss", "alert_ask"]);
    const lines = logged();
    expect(lines.indexOf("menu ended")).toBeGreaterThan(lines.indexOf("menu shown"));
    expect(lines.indexOf("menu shown")).toBeGreaterThan(lines.indexOf('haptic {"sent":"selection"}'));
    expect(lines.indexOf('alert {"answer":"cancel"}')).toBeGreaterThan(lines.indexOf("menu ended"));
  });

  it("on iOS logs a refused probe menu as a bad line and still asks the alert", async () => {
    setPlatform({ os: "ios", idiom: "phone" });
    tauri.answers.alert_ask = () => "cancel";
    tauri.answers.menu_show = () => {
      throw { code: "menu.not_shown", message: "not shown" };
    };
    mount();
    await settle();
    await settle();
    const line = 'menu {"error":"menu.not_shown","message":"not shown"}';
    expect(screen.getByText(line)).toHaveProperty("className", "probe-bad");
    expect(logged()).toContain(line);
    expect(tauri.calls.filter((c) => c.cmd === "alert_ask")).toHaveLength(1);
  });

  it("on the iPhone installs the tab bar after the haptic and before the menu and the alert, then logs each geometry and pick", async () => {
    setPlatform({ os: "ios", idiom: "phone" });
    tauri.answers.alert_ask = () => "cancel";
    mount();
    await settle();
    await settle();
    const native = tauri.calls.map((c) => c.cmd).filter((c) => ["haptic", "tabbar_install", "tabbar_set", "menu_show", "alert_ask"].includes(c));
    expect(native).toEqual(["haptic", "tabbar_install", "tabbar_set", "menu_show", "alert_ask"]);
    await act(async () => {
      emitFromRust("tabbar-geometry", { height: 64 });
      pickTab("list");
      pickTab("list", true);
    });
    await settle();
    const lines = logged();
    expect(lines.indexOf('tabbar installed {"hidden":true,"height":83}')).toBeGreaterThan(lines.indexOf('haptic {"sent":"selection"}'));
    expect(lines.indexOf("menu shown")).toBeGreaterThan(lines.indexOf('tabbar installed {"hidden":true,"height":83}'));
    expect(lines.slice(-3)).toEqual(['tabbar geometry {"height":64}', 'tabbar picked {"id":"list","again":false}', 'tabbar picked {"id":"list","again":true}']);
  });

  it("on the iPad logs the tab bar as skipped between the haptic and the alert and sends no tabbar call", async () => {
    setPlatform({ os: "ios", idiom: "pad" });
    tauri.answers.alert_ask = () => "cancel";
    mount();
    await settle();
    await settle();
    const lines = logged();
    expect(lines.filter((l) => l.startsWith("tabbar "))).toEqual(['tabbar skipped {"idiom":"pad"}']);
    expect(lines.indexOf('tabbar skipped {"idiom":"pad"}')).toBeGreaterThan(lines.indexOf('haptic {"sent":"selection"}'));
    expect(lines.indexOf('alert {"answer":"cancel"}')).toBeGreaterThan(lines.indexOf('tabbar skipped {"idiom":"pad"}'));
    expect(tauri.calls.filter((c) => c.cmd.startsWith("tabbar_"))).toEqual([]);
  });

  it("on the iPhone logs a refused tab bar install as a bad line with its code and still shows the menu and asks the alert", async () => {
    setPlatform({ os: "ios", idiom: "phone" });
    tauri.answers.alert_ask = () => "cancel";
    tauri.answers.tabbar_install = () => {
      throw { code: "tabbar.no_image", message: "The system image calendar.day.timeline.left does not exist." };
    };
    mount();
    await settle();
    await settle();
    const line = 'tabbar {"error":"tabbar.no_image","message":"The system image calendar.day.timeline.left does not exist."}';
    expect(screen.getByText(line)).toHaveProperty("className", "probe-bad");
    expect(logged()).toContain(line);
    expect(tauri.calls.filter((c) => c.cmd === "menu_show")).toHaveLength(1);
    expect(tauri.calls.filter((c) => c.cmd === "alert_ask")).toHaveLength(1);
  });

  it("on iOS sets the dark appearance and plays the selection haptic before it asks the alert", async () => {
    setPlatform({ os: "ios", idiom: "pad" });
    tauri.answers.alert_ask = () => "cancel";
    mount();
    await settle();
    await settle();
    const native = tauri.calls.map((c) => c.cmd).filter((c) => c === "appearance_set" || c === "haptic" || c === "alert_ask");
    expect(native).toEqual(["appearance_set", "haptic", "alert_ask"]);
    expect(tauri.calls.filter((c) => c.cmd === "appearance_set").map((c) => c.args)).toEqual([{ scheme: "dark" }]);
    expect(tauri.calls.filter((c) => c.cmd === "haptic").map((c) => c.args)).toEqual([{ kind: "selection" }]);
    expect(logged()).toContain('appearance {"set":"dark"}');
    expect(logged()).toContain('haptic {"sent":"selection"}');
  });

  it("on iOS sends the haptic only after the appearance answered, and asks the alert only after the haptic answered", async () => {
    setPlatform({ os: "ios", idiom: "pad" });
    tauri.answers.alert_ask = () => "cancel";
    const appearance = hold("appearance_set");
    const played = hold("haptic");
    const native = (): string[] => tauri.calls.map((c) => c.cmd).filter((c) => c === "appearance_set" || c === "haptic" || c === "alert_ask");
    mount();
    await settle();
    expect(native()).toEqual(["appearance_set"]);
    await act(async () => {
      appearance.reject({ code: "appearance.no_window", message: "no window" });
    });
    await settle();
    expect(native()).toEqual(["appearance_set", "haptic"]);
    await act(async () => {
      played.resolve(null);
    });
    await settle();
    expect(native()).toEqual(["appearance_set", "haptic", "alert_ask"]);
  });

  it("on iOS logs a failed appearance or haptic as a bad line", async () => {
    setPlatform({ os: "ios", idiom: "phone" });
    tauri.answers.alert_ask = () => "cancel";
    tauri.answers.appearance_set = () => {
      throw { code: "appearance.no_controller", message: "no controller" };
    };
    tauri.answers.haptic = () => {
      throw { code: "haptic.no_view", message: "no view" };
    };
    mount();
    await settle();
    const lines = ['appearance {"error":"appearance.no_controller","message":"no controller"}', 'haptic {"error":"haptic.no_view","message":"no view"}'];
    lines.forEach((line) => {
      expect(screen.getByText(line)).toHaveProperty("className", "probe-bad");
      expect(logged()).toContain(line);
    });
  });

  it("does not ask the probe alert off iOS", async () => {
    tauri.answers.alert_ask = () => "confirm";
    mount();
    await settle();
    expect(tauri.calls.filter((c) => c.cmd === "alert_ask")).toEqual([]);
    expect(logged().filter((l) => l.startsWith("alert "))).toEqual([]);
    expect(tauri.calls.filter((c) => c.cmd === "appearance_set" || c.cmd === "haptic")).toEqual([]);
    expect(logged().filter((l) => l.startsWith("appearance ") || l.startsWith("haptic "))).toEqual([]);
    expect(tauri.calls.filter((c) => c.cmd.startsWith("tabbar_"))).toEqual([]);
    expect(logged().filter((l) => l.startsWith("tabbar"))).toEqual([]);
  });

  it("logs a keydown with its modifiers", async () => {
    mount();
    await settle();
    fireEvent.keyDown(screen.getByLabelText("Key probe input"), { key: "k", code: "KeyK", metaKey: true });
    await settle();
    expect(logged()).toContain('keys {"key":"k","code":"KeyK","metaKey":true,"ctrlKey":false,"shiftKey":false,"altKey":false,"target":"input"}');
  });

  it("shows a failed probe_log on screen", async () => {
    tauri.answers.probe_log = () => {
      throw { code: "probe.io", message: "Could not append to probe.log: disk full" };
    };
    mount();
    await settle();
    expect(screen.getAllByText('probe_log {"error":"probe.io","message":"Could not append to probe.log: disk full"}').length).toBeGreaterThan(0);
  });

  it("shows a probe that answers with an error as a bad line and still sends it to probe_log", async () => {
    tauri.answers.holidays_year = () => {
      throw { code: "holidays.offline", message: "No network and no cached year" };
    };
    mount();
    await settle();
    const line = 'holidays {"error":"holidays.offline","message":"No network and no cached year"}';
    expect(screen.getByText(line)).toHaveProperty("className", "probe-bad");
    expect(logged()).toContain(line);
    expect(screen.getByText('paths {"appended":1,"docs":["probe"],"listed":true}')).toHaveProperty("className", "");
  });

  it("shows a probe whose line cannot be logged as one bad line and reports it to console.error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    tauri.answers.holidays_year = () => ({ days: [{ date: 1n }], fetchedAt: "x", fromCache: true, coverage: null });
    mount();
    await settle();
    const bad = screen.getAllByText('probe {"thrown":"Do not know how to serialize a BigInt"}');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toHaveProperty("className", "probe-bad");
    expect(consoleError).toHaveBeenCalledTimes(1);
    const reported: unknown = consoleError.mock.calls[0][0];
    expect(reported).toBeInstanceOf(TypeError);
    expect((reported as TypeError).message).toBe("Do not know how to serialize a BigInt");
    expect(logged().filter((l) => l.includes("thrown"))).toEqual([]);
  });

  it("logs a window source once it settles and only when its sizes change", async () => {
    vi.useFakeTimers();
    mount();
    await advance(0);
    Array.from({ length: 10 }).forEach(() => window.dispatchEvent(new Event("resize")));
    await advance(149);
    expect(resizeLines()).toEqual([]);
    await advance(1);
    expect(resizeLines()).toHaveLength(1);
    window.dispatchEvent(new Event("resize"));
    await advance(150);
    expect(resizeLines()).toHaveLength(1);
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width - 200 });
    try {
      window.dispatchEvent(new Event("resize"));
      await advance(150);
      expect(resizeLines()).toHaveLength(2);
      expect(resizeLines()[1]).toContain(`"inner":[${width - 200},`);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    }
  });

  it("logs a missing selection as null and a selection by its length", async () => {
    mount();
    await settle();
    vi.spyOn(document, "getSelection").mockReturnValueOnce(null);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    expect(logged()).toContain('touch {"on":"selectionchange","selected":null}');
    document.getSelection()?.selectAllChildren(screen.getByText("WebBoard probe"));
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    expect(logged()).toContain('touch {"on":"selectionchange","selected":14}');
  });

  it("prevents a touchmove after the hold on bar B and not on bar C", async () => {
    vi.useFakeTimers();
    mount();
    await advance(0);
    const b = screen.getByText("B · pan-x pan-y + hold");
    const c = screen.getByText("C · pan-x pan-y");
    touch(b, "touchstart", 1);
    touch(c, "touchstart", 1);
    expect(touch(b, "touchmove", 1).defaultPrevented).toBe(false);
    await advance(500);
    expect(logged()).toContain('touch {"bar":"B","on":"armed","afterMs":500}');
    expect(touch(b, "touchmove", 1).defaultPrevented).toBe(true);
    expect(touch(c, "touchmove", 1).defaultPrevented).toBe(false);
  });

  it("keeps bar B armed until the last finger lifts", async () => {
    vi.useFakeTimers();
    mount();
    await advance(0);
    const b = screen.getByText("B · pan-x pan-y + hold");
    touch(b, "touchstart", 2);
    await advance(500);
    touch(b, "touchend", 1);
    expect(touch(b, "touchmove", 1).defaultPrevented).toBe(true);
    touch(b, "touchend", 0);
    expect(touch(b, "touchmove", 1).defaultPrevented).toBe(false);
  });

  it("restores the original viewport content when cover is turned off", async () => {
    mount();
    await settle();
    const meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement;
    fireEvent.click(screen.getByText("Viewport cover on"));
    expect(meta.getAttribute("content")).toBe(`${ORIGINAL_VIEWPORT}, viewport-fit=cover`);
    fireEvent.click(screen.getByText("Viewport cover off"));
    expect(meta.getAttribute("content")).toBe(ORIGINAL_VIEWPORT);
  });
});
