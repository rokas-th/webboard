import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../test/platform";
import { emitFromRust, failNextListen, listenerCount, resetTauri, tauri } from "../test/tauriMock";
import { clearToasts } from "../ui/common/Toast";
import { AppError } from "./ipc";
import { anchorOf, dismissNativeMenu, resetNativeMenus, showNativeMenu, usesNativeMenu, type NativeMenuSection } from "./nativeMenu";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../test/tauriMock"));

const toasts = vi.hoisted(() => [] as { text: string; tone: string | undefined; details: string | undefined }[]);
vi.mock("../ui/common/Toast", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ui/common/Toast")>();
  return { ...real, toast: (text: string, tone?: string, details?: string) => toasts.push({ text, tone, details }) };
});

const SECTIONS: readonly NativeMenuSection[] = [{ title: null, rows: [{ id: "task", title: "New task", checked: false }] }];
const ANCHOR = { x: 10, y: 20, width: 44, height: 30 };

beforeEach(() => {
  resetTauri({});
  setPlatform(IPAD);
  toasts.length = 0;
});

afterEach(() => {
  clearToasts();
});

const watcher = (): { chosen: string[]; ended: number; log: string[]; on: { chosen(id: string): void; ended(): void } } => {
  const w = {
    chosen: [] as string[],
    ended: 0,
    log: [] as string[],
    on: {
      chosen: (id: string) => {
        w.chosen.push(id);
        w.log.push(`chosen ${id}`);
      },
      ended: () => {
        w.ended += 1;
        w.log.push("ended");
      },
    },
  };
  return w;
};

describe("anchorOf", () => {
  it("is the client box itself when the page is not zoomed", () => {
    expect(anchorOf({ left: 100, top: 8, width: 44, height: 36 }, { offsetLeft: 0, offsetTop: 0, scale: 1 })).toEqual({ x: 100, y: 8, width: 44, height: 36 });
  });

  it("maps through the visual viewport's offset and scale", () => {
    expect(anchorOf({ left: 100, top: 50, width: 40, height: 20 }, { offsetLeft: 20, offsetTop: 10, scale: 2 })).toEqual({ x: 160, y: 80, width: 80, height: 40 });
  });
});

describe("usesNativeMenu", () => {
  it("is true on iPhone and iPad and false on the desktops", () => {
    expect([IPAD, IPHONE, MAC, LINUX].map((p) => (setPlatform(p), usesNativeMenu()))).toEqual([true, true, false, false]);
  });
});

describe("showNativeMenu", () => {
  it("sends the menu with a page-made token and resolves to it once shown", async () => {
    const token = await showNativeMenu(SECTIONS, ANCHOR, watcher().on);
    expect(tauri.calls.filter((c) => c.cmd === "menu_show").map((c) => c.args)).toEqual([{ menu: { token, anchor: ANCHOR, sections: SECTIONS } }]);
    expect(token).not.toBe("");
    const next = await showNativeMenu(SECTIONS, ANCHOR, watcher().on);
    expect(next).not.toBe(token);
  });

  it("subscribes to the two events once for every menu", async () => {
    await showNativeMenu(SECTIONS, ANCHOR, watcher().on);
    await showNativeMenu(SECTIONS, ANCHOR, watcher().on);
    expect([listenerCount("menu-chosen"), listenerCount("menu-ended")]).toEqual([1, 1]);
  });

  it("routes each event to the menu its token names", async () => {
    const a = watcher();
    const b = watcher();
    const ta = await showNativeMenu(SECTIONS, ANCHOR, a.on);
    const tb = await showNativeMenu(SECTIONS, ANCHOR, b.on);
    emitFromRust("menu-ended", { token: ta });
    emitFromRust("menu-chosen", { token: tb, id: "task" });
    emitFromRust("menu-ended", { token: tb });
    expect([a.log, b.log]).toEqual([["ended"], ["chosen task", "ended"]]);
  });

  it("runs chosen once when it arrives after ended", async () => {
    const w = watcher();
    const token = await showNativeMenu(SECTIONS, ANCHOR, w.on);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitFromRust("menu-ended", { token });
    emitFromRust("menu-chosen", { token, id: "task" });
    emitFromRust("menu-chosen", { token, id: "task" });
    expect(w.log).toEqual(["ended", "chosen task"]);
    expect(toasts.map((t) => t.text)).toEqual([`menu-chosen named the menu "${token}", which this page did not show`]);
    errors.mockRestore();
  });

  it("runs chosen once when it arrives before ended", async () => {
    const w = watcher();
    const token = await showNativeMenu(SECTIONS, ANCHOR, w.on);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitFromRust("menu-chosen", { token, id: "task" });
    emitFromRust("menu-chosen", { token, id: "task" });
    emitFromRust("menu-ended", { token });
    emitFromRust("menu-ended", { token });
    expect(w.log).toEqual(["chosen task", "ended"]);
    expect(toasts.map((t) => t.text)).toEqual([`menu-ended named the menu "${token}", which this page did not show`]);
    errors.mockRestore();
  });

  it("refuses off iOS without asking Rust", async () => {
    setPlatform(MAC);
    await expect(showNativeMenu(SECTIONS, ANCHOR, watcher().on)).rejects.toMatchObject({ code: "menu.platform" });
    await expect(dismissNativeMenu("m1")).rejects.toMatchObject({ code: "menu.platform" });
    expect(tauri.calls.map((c) => c.cmd)).toEqual([]);
  });

  it("rejects with Rust's error and drops the events of the menu that failed", async () => {
    tauri.answers.menu_show = () => {
      throw { code: "menu.not_shown", message: "The menu cannot be shown: UIKit did not display it within 5000 ms." };
    };
    const w = watcher();
    const failed = await showNativeMenu(SECTIONS, ANCHOR, w.on).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(AppError);
    expect(failed).toMatchObject({ code: "menu.not_shown" });
    const sent = tauri.calls.find((c) => c.cmd === "menu_show");
    const token = (sent?.args as { menu: { token: string } } | undefined)?.menu.token;
    emitFromRust("menu-ended", { token });
    expect(w.log).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("names a payload that is not the documented shape as a bad toast", async () => {
    const w = watcher();
    const token = await showNativeMenu(SECTIONS, ANCHOR, w.on);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitFromRust("menu-chosen", { token, id: 7 });
    emitFromRust("menu-ended", { token, extra: true });
    emitFromRust("menu-ended", "m1");
    expect(w.log).toEqual([]);
    expect(toasts.map((t) => [t.tone, t.details?.split("\n")[0]])).toEqual([
      ["bad", "ipc.shape"],
      ["bad", "ipc.shape"],
      ["bad", "ipc.shape"],
    ]);
    expect(toasts[0].text).toBe(`menu-chosen carried {"token":"${token}","id":7} instead of { token: string, id: string }`);
    vi.restoreAllMocks();
  });

  it("names a choice in a menu whose show failed as a bad toast, since that choice is never run", async () => {
    tauri.answers.menu_show = () => {
      throw { code: "menu.stopped", message: "menu_show stopped: the main thread did not answer within 5000 ms" };
    };
    const w = watcher();
    await showNativeMenu(SECTIONS, ANCHOR, w.on).catch(() => undefined);
    const sent = tauri.calls.find((c) => c.cmd === "menu_show");
    const token = (sent?.args as { menu: { token: string } } | undefined)?.menu.token;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitFromRust("menu-ended", { token });
    emitFromRust("menu-chosen", { token, id: "task" });
    expect(w.log).toEqual([]);
    expect(toasts.map((t) => [t.tone, t.details?.split("\n")[0], t.text])).toEqual([
      ["bad", "menu.dropped", `The row "task" was chosen in the menu "${token}", which failed to show, so it was not run`],
    ]);
    vi.restoreAllMocks();
  });

  it("shows a handler's throw as a bad toast instead of letting it escape into Tauri's event script", async () => {
    const token = await showNativeMenu(SECTIONS, ANCHOR, {
      chosen: (id) => {
        throw new Error(`no row ${id}`);
      },
      ended: () => {
        throw new AppError("menu.host", "the host broke");
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => emitFromRust("menu-chosen", { token, id: "epic" })).not.toThrow();
    expect(() => emitFromRust("menu-ended", { token })).not.toThrow();
    expect(toasts.map((t) => [t.tone, t.details?.split("\n")[0], t.text])).toEqual([
      ["bad", "menu.chosen", "no row epic"],
      ["bad", "menu.host", "the host broke"],
    ]);
    expect(errors).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("makes tokens that differ from one page load to the next", async () => {
    const first = await showNativeMenu(SECTIONS, ANCHOR, watcher().on);
    resetNativeMenus();
    resetTauri({});
    const again = await showNativeMenu(SECTIONS, ANCHOR, watcher().on);
    expect(first.split("-").pop()).toBe("1");
    expect(again.split("-").pop()).toBe("1");
    expect(again).not.toBe(first);
  });

  it("subscribes again only to the event whose subscription failed", async () => {
    failNextListen("menu-ended", new Error("the event bridge is not ready"));
    await expect(showNativeMenu(SECTIONS, ANCHOR, watcher().on)).rejects.toMatchObject({ code: "ipc.failed" });
    expect([listenerCount("menu-chosen"), listenerCount("menu-ended")]).toEqual([1, 0]);
    const w = watcher();
    const token = await showNativeMenu(SECTIONS, ANCHOR, w.on);
    expect([listenerCount("menu-chosen"), listenerCount("menu-ended")]).toEqual([1, 1]);
    emitFromRust("menu-chosen", { token, id: "task" });
    emitFromRust("menu-ended", { token });
    expect(w.log).toEqual(["chosen task", "ended"]);
    expect(toasts).toEqual([]);
  });

  it("names an event for a menu this page never showed as a bad toast", async () => {
    await showNativeMenu(SECTIONS, ANCHOR, watcher().on);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitFromRust("menu-ended", { token: "nobody" });
    expect(toasts.map((t) => [t.tone, t.details?.split("\n")[0], t.text])).toEqual([["bad", "ipc.shape", 'menu-ended named the menu "nobody", which this page did not show']]);
    vi.restoreAllMocks();
  });
});

describe("dismissNativeMenu", () => {
  it("sends the token", async () => {
    await dismissNativeMenu("m9");
    expect(tauri.calls.map((c) => [c.cmd, c.args])).toEqual([["menu_dismiss", { token: "m9" }]]);
  });
});
