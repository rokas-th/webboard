import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTauri, tauri } from "../test/tauriMock";
import ProbeApp from "./ProbeApp";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

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
