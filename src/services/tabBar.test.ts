import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../test/platform";
import { emitFromRust, failNextListen, hold, listenerCount, resetTauri, tauri } from "../test/tauriMock";
import { AppError } from "./ipc";
import {
  TAB_IMAGES,
  faultTabBar,
  installTabBar,
  listened,
  moveTabBar,
  parseGeometry,
  parseFault,
  parsePick,
  phoneTabs,
  sentTabBar,
  setTabBar,
  tabBarStatus,
  wantedTabBar,
  usesNativeTabBar,
  type TabBarState,
} from "./tabBar";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../test/tauriMock"));

const STATE: TabBarState = { selected: "board", hidden: false, tint: "#24E0FF" };

beforeEach(() => {
  resetTauri({});
  setPlatform(IPHONE);
});

afterEach(() => {
  setPlatform(MAC);
});

describe("phoneTabs", () => {
  it("is Timeline, Board, List with their system images", () => {
    expect(phoneTabs()).toEqual([
      { id: "timeline", title: "Timeline", image: "calendar.day.timeline.left" },
      { id: "board", title: "Board", image: "rectangle.split.3x1" },
      { id: "list", title: "List", image: "list.bullet" },
    ]);
    expect(TAB_IMAGES).toEqual({ timeline: "calendar.day.timeline.left", board: "rectangle.split.3x1", list: "list.bullet" });
  });
});

describe("usesNativeTabBar", () => {
  it("is true on the iPhone only", () => {
    expect([IPHONE, IPAD, MAC, LINUX].map((p) => (setPlatform(p), usesNativeTabBar()))).toEqual([true, false, false, false]);
  });
});

describe("parseGeometry", () => {
  it.each([83, 64, 49.5])("takes { height: %s }", (height) => {
    expect(parseGeometry({ height })).toBe(height);
  });

  it.each([
    [{ height: 0 }],
    [{ height: -1 }],
    [{ height: Number.NaN }],
    [{ height: Number.POSITIVE_INFINITY }],
    [{ height: "83" }],
    [{ height: 83, width: 390 }],
    [{}],
    [null],
    [83],
    [[83]],
  ])("refuses %o as ipc.shape", (x) => {
    expect(() => parseGeometry(x)).toThrow(AppError);
    expect(() => parseGeometry(x)).toThrow(expect.objectContaining({ code: "ipc.shape" }));
  });
});

describe("parsePick", () => {
  it.each([
    [{ id: "timeline", again: false }],
    [{ id: "board", again: true }],
    [{ id: "list", again: false }],
  ])("takes %o", (x) => {
    expect(parsePick(x)).toEqual(x);
  });

  it.each([
    [{ id: "plans", again: false }],
    [{ id: "board" }],
    [{ id: "board", again: "yes" }],
    [{ id: "board", again: false, extra: 1 }],
    [{ again: true }],
    [{ id: 0, again: false }],
    [null],
    ["board"],
  ])("refuses %o as ipc.shape", (x) => {
    expect(() => parsePick(x)).toThrow(expect.objectContaining({ code: "ipc.shape" }));
  });
});

describe("installTabBar", () => {
  it("sends the three tabs and the state, answers the height and stores installed", async () => {
    expect(tabBarStatus()).toEqual({ k: "off" });
    const asked = installTabBar(STATE);
    expect(tabBarStatus()).toEqual({ k: "installing" });
    await expect(asked).resolves.toBe(83);
    expect(tauri.calls).toEqual([{ cmd: "tabbar_install", args: { bar: { tabs: phoneTabs(), state: STATE } }, options: undefined }]);
    expect(tabBarStatus()).toEqual({ k: "installed", height: 83 });
  });

  it("stores failed with the reason when the command refuses, and rethrows", async () => {
    resetTauri({
      tabbar_install: () => {
        throw { code: "tabbar.no_image", message: "The system image calendar.day.timeline.left does not exist." };
      },
    });
    await expect(installTabBar(STATE)).rejects.toMatchObject({ code: "tabbar.no_image" });
    expect(tabBarStatus()).toEqual({ k: "failed", reason: "The system image calendar.day.timeline.left does not exist.", height: null });
  });

  it("refuses an answer that is not a geometry", async () => {
    resetTauri({ tabbar_install: () => ({ height: 0 }) });
    await expect(installTabBar(STATE)).rejects.toMatchObject({ code: "ipc.shape" });
    expect(tabBarStatus().k).toBe("failed");
  });

  it("never asks twice in one page load", async () => {
    await installTabBar(STATE);
    await expect(installTabBar(STATE)).rejects.toMatchObject({ code: "tabbar.twice" });
    expect(tauri.calls.map((c) => c.cmd)).toEqual(["tabbar_install"]);
    expect(tabBarStatus()).toEqual({ k: "installed", height: 83 });
  });

  it.each([MAC, LINUX, IPAD])("rejects tabbar.platform on $os $idiom without an invoke, and stays off", async (p) => {
    setPlatform(p);
    await expect(installTabBar(STATE)).rejects.toMatchObject({ code: "tabbar.platform" });
    await expect(setTabBar(STATE)).rejects.toMatchObject({ code: "tabbar.platform" });
    expect(tauri.calls).toEqual([]);
    expect(tabBarStatus()).toEqual({ k: "off" });
  });
});

describe("setTabBar", () => {
  it("sends the state once installed", async () => {
    await installTabBar(STATE);
    await setTabBar({ ...STATE, hidden: true });
    expect(tauri.calls.map((c) => [c.cmd, c.args])).toEqual([
      ["tabbar_install", { bar: { tabs: phoneTabs(), state: STATE } }],
      ["tabbar_set", { state: { ...STATE, hidden: true } }],
    ]);
    expect(tabBarStatus()).toEqual({ k: "installed", height: 83 });
  });

  it("refuses before the bar is installed, without an invoke", async () => {
    await expect(setTabBar(STATE)).rejects.toMatchObject({ code: "tabbar.not_installed" });
    expect(tauri.calls).toEqual([]);
  });

  it("stores failed when the command refuses, and rethrows", async () => {
    await installTabBar(STATE);
    tauri.answers.tabbar_set = () => {
      throw { code: "tabbar.stopped", message: "The tab bar cannot be set: the main thread's tab bar store is gone." };
    };
    await expect(setTabBar(STATE)).rejects.toMatchObject({ code: "tabbar.stopped" });
    expect(tabBarStatus()).toEqual({ k: "failed", reason: "The tab bar cannot be set: the main thread's tab bar store is gone.", height: 83 });
  });
});

describe("parseFault", () => {
  it("takes exactly { code, message } as the AppError it names", () => {
    const fault = parseFault({ code: "tabbar.order", message: "The tab bar cannot be laid out: gone." });
    expect(fault).toBeInstanceOf(AppError);
    expect([fault.code, fault.message]).toEqual(["tabbar.order", "The tab bar cannot be laid out: gone."]);
  });

  it.each([[{ code: "tabbar.order" }], [{ code: "", message: "m" }], [{ code: "c", message: " " }], [{ code: "c", message: "m", extra: 1 }], [null], ["tabbar.order"]])(
    "refuses %o as ipc.shape",
    (x) => {
      expect(() => parseFault(x)).toThrow(expect.objectContaining({ code: "ipc.shape" }));
    },
  );
});

describe("listened", () => {
  it("hands each payload to the handler and answers the unlisten", async () => {
    const seen: unknown[] = [];
    const unlisten = await listened("tabbar-geometry", (p) => seen.push(p));
    emitFromRust("tabbar-geometry", { height: 64 });
    unlisten();
    emitFromRust("tabbar-geometry", { height: 83 });
    expect(seen).toEqual([{ height: 64 }]);
    expect(listenerCount("tabbar-geometry")).toBe(0);
  });

  it("turns a failed listen into ipc.failed naming the event", async () => {
    failNextListen("tabbar-fault", new Error("the event plugin is gone"));
    await expect(listened("tabbar-fault", () => undefined)).rejects.toMatchObject({ code: "ipc.failed", message: "listen tabbar-fault: the event plugin is gone." });
  });
});

describe("the state the bar holds", () => {
  it("records a set as sent only once the command succeeds, and as wanted from the moment it is asked", async () => {
    await installTabBar(STATE);
    expect([sentTabBar(), wantedTabBar()]).toEqual([STATE, STATE]);
    const held = hold("tabbar_set");
    const next = { ...STATE, hidden: true };
    const asked = setTabBar(next);
    expect([sentTabBar(), wantedTabBar()]).toEqual([STATE, next]);
    held.reject({ code: "tabbar.stopped", message: "The tab bar cannot be set: the main thread did not run it within 5000 ms." });
    await expect(asked).rejects.toMatchObject({ code: "tabbar.stopped" });
    expect([sentTabBar(), wantedTabBar()]).toEqual([STATE, next]);
  });

  it("records nothing as sent when the install fails", async () => {
    resetTauri({
      tabbar_install: () => {
        throw { code: "tabbar.no_image", message: "The system image list.bullet does not exist." };
      },
    });
    await expect(installTabBar(STATE)).rejects.toMatchObject({ code: "tabbar.no_image" });
    expect(sentTabBar()).toBeNull();
  });
});

describe("moveTabBar", () => {
  it("updates the height while installed", async () => {
    await installTabBar(STATE);
    moveTabBar(64);
    expect(tabBarStatus()).toEqual({ k: "installed", height: 64 });
  });

  it("refuses a height before the bar was asked to install", () => {
    expect(() => moveTabBar(64)).toThrow(expect.objectContaining({ code: "tabbar.unasked" }));
    expect(tabBarStatus()).toEqual({ k: "off" });
  });

  it("keeps a height that arrives while installing and installs with it, not the older answer", async () => {
    const held = hold("tabbar_install");
    const asked = installTabBar(STATE);
    moveTabBar(64);
    expect(tabBarStatus()).toEqual({ k: "installing" });
    held.resolve({ height: 83 });
    await expect(asked).resolves.toBe(64);
    expect(tabBarStatus()).toEqual({ k: "installed", height: 64 });
  });

  it("keeps the height of a bar that is still on screen when the install fails after it sent one", async () => {
    const held = hold("tabbar_install");
    const asked = installTabBar(STATE);
    moveTabBar(83);
    held.reject({ code: "tabbar.stopped", message: "The tab bar cannot be installed: the main thread did not run it within 5000 ms." });
    await expect(asked).rejects.toMatchObject({ code: "tabbar.stopped" });
    expect(tabBarStatus()).toEqual({ k: "failed", reason: "The tab bar cannot be installed: the main thread did not run it within 5000 ms.", height: 83 });
  });

  it("marks a failed bar as on screen when a late install reports its height", async () => {
    resetTauri({
      tabbar_install: () => {
        throw { code: "tabbar.stopped", message: "The tab bar cannot be installed: the main thread did not run it within 5000 ms." };
      },
    });
    await expect(installTabBar(STATE)).rejects.toMatchObject({ code: "tabbar.stopped" });
    expect(tabBarStatus()).toEqual({ k: "failed", reason: "The tab bar cannot be installed: the main thread did not run it within 5000 ms.", height: null });
    moveTabBar(83);
    expect(tabBarStatus()).toEqual({ k: "failed", reason: "The tab bar cannot be installed: the main thread did not run it within 5000 ms.", height: 83 });
  });
});

describe("faultTabBar", () => {
  const FAULT = new AppError("tabbar.order", "The tab bar cannot be laid out: the web view or the tab bar is not inside the tab bar controller's view.");

  it("fails an installed bar, keeps its height and asks for a toast", async () => {
    await installTabBar(STATE);
    expect(faultTabBar(FAULT)).toBe(true);
    expect(tabBarStatus()).toEqual({ k: "failed", reason: FAULT.message, height: 83 });
  });

  it("holds a fault that arrives while installing and fails the install with it", async () => {
    const held = hold("tabbar_install");
    const asked = installTabBar(STATE);
    expect(faultTabBar(FAULT)).toBe(false);
    held.resolve({ height: 83 });
    await expect(asked).rejects.toBe(FAULT);
    expect(tabBarStatus()).toEqual({ k: "failed", reason: FAULT.message, height: 83 });
    expect(sentTabBar()).toBeNull();
  });

  it("refuses a fault before the bar was asked to install", () => {
    expect(() => faultTabBar(FAULT)).toThrow(expect.objectContaining({ code: "tabbar.unasked" }));
  });
});
