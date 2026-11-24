import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phoneTabs, type TabBarState, type TabBarStatus, type TabPick } from "../../services/tabBar";
import { IPAD, IPHONE, MAC, setPlatform } from "../../test/platform";
import { DEFAULT_ANSWERS, emitFromRust, failNextListen, hold, listenerCount, pickTab, resetTauri, tauri } from "../../test/tauriMock";
import { clearToasts, COPY_DETAILS, Toasts } from "../common/Toast";
import { INSTALL_FAILED, SET_FAILED, tabBarMark, useNativeTabBar } from "./nativeTabBar";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));

const STATE: TabBarState = { selected: "board", hidden: false, tint: "#24E0FF" };

const seen: TabBarStatus[] = [];

function Bar(p: { state?: TabBarState; open?: boolean; onPick?: (pick: TabPick) => void }) {
  seen.push(useNativeTabBar(p.state ?? STATE, p.onPick ?? (() => undefined), p.open ?? true));
  return null;
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const status = (): TabBarStatus | undefined => seen[seen.length - 1];
const barCalls = (): [string, unknown][] => tauri.calls.filter((c) => c.cmd.startsWith("tabbar_")).map((c) => [c.cmd, c.args]);
const badToasts = (): (string | null)[] => Array.from(document.querySelectorAll(".toasts .toast.bad")).map((e) => e.textContent);
const html = (): [string | undefined, string] => [document.documentElement.dataset.tabbar, document.documentElement.style.getPropertyValue("--tabbar-h")];
const EVENTS = ["tabbar-picked", "tabbar-geometry", "tabbar-fault"];
const listening = (): number[] => EVENTS.map(listenerCount);

const copiedDetails = (): string[] => {
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast-bad")).forEach((t) => fireEvent.click(within(t).getByRole("button", { name: COPY_DETAILS })));
  return writeText.mock.calls.map(([text]) => text);
};

beforeEach(() => {
  setPlatform(IPHONE);
  resetTauri({});
  clearToasts();
  seen.length = 0;
  render(<Toasts />);
});

afterEach(() => {
  cleanup();
  clearToasts();
  setPlatform(MAC);
});

describe("the copy", () => {
  it("names the reason and says where the views stay", () => {
    expect(INSTALL_FAILED("The system image x does not exist.")).toBe("The tab bar could not be installed: The system image x does not exist. The views stay at the bottom of the screen.");
    expect(SET_FAILED("The tab bar cannot be set: it is not installed yet.")).toBe("The tab bar stopped following the app: The tab bar cannot be set: it is not installed yet. The views stay at the bottom of the screen.");
  });
});

describe("tabBarMark", () => {
  it("marks an installed bar only with a plan open, covered while hidden", () => {
    expect(tabBarMark({ k: "installed", height: 83 }, true, false)).toEqual({ height: 83, mark: "bar" });
    expect(tabBarMark({ k: "installed", height: 83 }, true, true)).toEqual({ height: 83, mark: "covered" });
    expect(tabBarMark({ k: "installed", height: 83 }, false, true)).toBeNull();
  });

  it("marks a failed bar that is still on screen as shown, whatever the page asks, and nothing for one that is gone", () => {
    expect(tabBarMark({ k: "failed", reason: "r", height: 64 }, false, true)).toEqual({ height: 64, mark: "bar" });
    expect(tabBarMark({ k: "failed", reason: "r", height: null }, true, false)).toBeNull();
    expect(tabBarMark({ k: "installing" }, true, false)).toBeNull();
    expect(tabBarMark({ k: "off" }, true, false)).toBeNull();
  });
});

describe("useNativeTabBar on the iPhone", () => {
  it("subscribes to both events, then installs the three tabs with the state, once across remounts", async () => {
    const first = render(<Bar />);
    expect(status()).toEqual({ k: "installing" });
    await flush();
    expect(status()).toEqual({ k: "installed", height: 83 });
    first.unmount();
    render(<Bar />);
    await flush();
    expect(barCalls()).toEqual([["tabbar_install", { bar: { tabs: phoneTabs(), state: STATE } }]]);
    expect(listening()).toEqual([1, 1, 1]);
    expect(status()).toEqual({ k: "installed", height: 83 });
  });

  it("installs with the state of the moment it asks, and sends a later change once installed", async () => {
    let answer = (): void => undefined;
    tauri.answers.tabbar_install = (args) => {
      const checked = DEFAULT_ANSWERS.tabbar_install(args);
      return new Promise((resolve) => {
        answer = () => resolve(checked);
      });
    };
    const view = render(<Bar />);
    await flush();
    view.rerender(<Bar state={{ ...STATE, selected: "list" }} />);
    await flush();
    expect(barCalls()).toEqual([["tabbar_install", { bar: { tabs: phoneTabs(), state: STATE } }]]);
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await flush();
    expect(barCalls()).toEqual([
      ["tabbar_install", { bar: { tabs: phoneTabs(), state: STATE } }],
      ["tabbar_set", { state: { ...STATE, selected: "list" } }],
    ]);
  });

  it("sends each change of the state and nothing for a render that changes nothing", async () => {
    const view = render(<Bar />);
    await flush();
    view.rerender(<Bar state={{ ...STATE }} />);
    view.rerender(<Bar state={{ ...STATE, hidden: true }} />);
    await flush();
    view.rerender(<Bar state={{ ...STATE, hidden: true, tint: "#FF00AA" }} />);
    await flush();
    expect(barCalls().slice(1)).toEqual([
      ["tabbar_set", { state: { ...STATE, hidden: true } }],
      ["tabbar_set", { state: { ...STATE, hidden: true, tint: "#FF00AA" } }],
    ]);
  });

  it("shows a failed install as one bad toast and never asks again", async () => {
    const message = "The system image calendar.day.timeline.left does not exist.";
    resetTauri({
      tabbar_install: () => {
        throw { code: "tabbar.no_image", message };
      },
    });
    const view = render(<Bar />);
    await flush();
    view.unmount();
    render(<Bar state={{ ...STATE, selected: "list" }} />);
    await flush();
    expect(barCalls().map(([cmd]) => cmd)).toEqual(["tabbar_install"]);
    expect(badToasts()).toEqual([INSTALL_FAILED(message)]);
    expect(status()).toEqual({ k: "failed", reason: message, height: null });
    expect(html()).toEqual([undefined, ""]);
    expect(copiedDetails()).toEqual([expect.stringMatching(/^tabbar\.no_image\n/)]);
  });

  it("fails the install when an event cannot be listened to, without asking for it, and drops the listeners it did get", async () => {
    failNextListen("tabbar-geometry", new Error("the event plugin is gone"));
    render(<Bar />);
    await flush();
    expect(barCalls()).toEqual([]);
    expect(badToasts()).toEqual([INSTALL_FAILED("listen tabbar-geometry: the event plugin is gone.")]);
    expect(status()).toEqual({ k: "failed", reason: "listen tabbar-geometry: the event plugin is gone.", height: null });
    expect(listening()).toEqual([0, 0, 0]);
  });

  it("shows a refused set as one bad toast, sends nothing after it and keeps the page above the bar that stays on screen", async () => {
    const message = "The tab bar cannot be set: the main thread's tab bar store is gone.";
    const view = render(<Bar />);
    await flush();
    tauri.answers.tabbar_set = () => {
      throw { code: "tabbar.stopped", message };
    };
    view.rerender(<Bar state={{ ...STATE, hidden: true }} />);
    await flush();
    view.rerender(<Bar state={{ ...STATE, selected: "list" }} />);
    await flush();
    expect(barCalls().map(([cmd]) => cmd)).toEqual(["tabbar_install", "tabbar_set"]);
    expect(badToasts()).toEqual([SET_FAILED(message)]);
    expect(status()).toEqual({ k: "failed", reason: message, height: 83 });
    expect(html()).toEqual(["bar", "83px"]);
    view.rerender(<Bar state={{ ...STATE, hidden: true }} open={false} />);
    expect(html()).toEqual(["bar", "83px"]);
    act(() => emitFromRust("tabbar-geometry", { height: 64 }));
    expect(html()).toEqual(["bar", "64px"]);
  });

  it("toasts a refused set once when two sets fail together", async () => {
    const view = render(<Bar />);
    await flush();
    const one = hold("tabbar_set");
    view.rerender(<Bar state={{ ...STATE, hidden: true }} />);
    await flush();
    tauri.answers.tabbar_set = () => {
      throw { code: "tabbar.stopped", message: "Gone." };
    };
    view.rerender(<Bar state={{ ...STATE, selected: "list" }} />);
    await flush();
    await act(async () => {
      one.reject({ code: "tabbar.stopped", message: "Gone." });
      await Promise.resolve();
    });
    await flush();
    expect(barCalls().map(([cmd]) => cmd)).toEqual(["tabbar_install", "tabbar_set", "tabbar_set"]);
    expect(badToasts()).toEqual([SET_FAILED("Gone.")]);
  });

  it("marks the page while installed: bar when shown, covered when hidden by a sheet, nothing with no plan open", async () => {
    const view = render(<Bar />);
    expect(html()).toEqual([undefined, ""]);
    await flush();
    expect(html()).toEqual(["bar", "83px"]);
    view.rerender(<Bar state={{ ...STATE, hidden: true }} />);
    expect(html()).toEqual(["covered", "83px"]);
    view.rerender(<Bar state={{ ...STATE, hidden: true }} open={false} />);
    expect(html()).toEqual([undefined, ""]);
    view.rerender(<Bar />);
    expect(html()).toEqual(["bar", "83px"]);
    view.unmount();
    expect(html()).toEqual([undefined, ""]);
  });

  it("marks nothing while installing", async () => {
    hold("tabbar_install");
    render(<Bar />);
    await flush();
    expect(status()).toEqual({ k: "installing" });
    expect(html()).toEqual([undefined, ""]);
  });

  it("follows the bar's geometry into --tabbar-h", async () => {
    render(<Bar />);
    await flush();
    act(() => emitFromRust("tabbar-geometry", { height: 64 }));
    expect(status()).toEqual({ k: "installed", height: 64 });
    expect(html()).toEqual(["bar", "64px"]);
  });

  it("hands a pick to the latest onPick", async () => {
    const before = vi.fn();
    const after = vi.fn();
    const view = render(<Bar onPick={before} />);
    await flush();
    view.rerender(<Bar onPick={after} />);
    act(() => pickTab("list"));
    act(() => pickTab("board", true));
    expect(before).not.toHaveBeenCalled();
    expect(after.mock.calls).toEqual([[{ id: "list", again: false }], [{ id: "board", again: true }]]);
  });

  it.each([
    ["tabbar-picked", { id: "plans", again: false }],
    ["tabbar-picked", { id: "list" }],
    ["tabbar-geometry", { height: 0 }],
    ["tabbar-geometry", { height: 64, width: 390 }],
    ["tabbar-fault", { code: "tabbar.order" }],
  ])("shows a bad %s payload %o as one ipc.shape bad toast and acts on nothing", async (name, payload) => {
    const onPick = vi.fn();
    render(<Bar onPick={onPick} />);
    await flush();
    act(() => emitFromRust(name, payload));
    await flush();
    expect(onPick).not.toHaveBeenCalled();
    expect(status()).toEqual({ k: "installed", height: 83 });
    expect(badToasts()).toHaveLength(1);
    expect(document.querySelector(".toasts .toast.bad")?.textContent).toContain(JSON.stringify(payload));
    expect(copiedDetails()).toEqual([expect.stringMatching(/^ipc\.shape\n/)]);
  });

  it("turns a fault from the native side into one bad toast and keeps the page above the bar", async () => {
    const message = "The tab bar cannot be laid out: the web view or the tab bar is not inside the tab bar controller's view.";
    const view = render(<Bar />);
    await flush();
    act(() => emitFromRust("tabbar-fault", { code: "tabbar.order", message }));
    act(() => emitFromRust("tabbar-fault", { code: "tabbar.order", message }));
    view.rerender(<Bar state={{ ...STATE, selected: "list" }} />);
    await flush();
    expect(status()).toEqual({ k: "failed", reason: message, height: 83 });
    expect(badToasts()).toEqual([SET_FAILED(message)]);
    expect(copiedDetails()).toEqual([expect.stringMatching(/^tabbar\.order\n/)]);
    expect(barCalls().map(([cmd]) => cmd)).toEqual(["tabbar_install"]);
    expect(html()).toEqual(["bar", "83px"]);
  });

  it("insets the page for a bar that a timed-out install put on screen late", async () => {
    const message = "The tab bar cannot be installed: the main thread did not run it within 5000 ms.";
    resetTauri({
      tabbar_install: () => {
        throw { code: "tabbar.stopped", message };
      },
    });
    render(<Bar />);
    await flush();
    expect(html()).toEqual([undefined, ""]);
    act(() => emitFromRust("tabbar-geometry", { height: 83 }));
    expect(status()).toEqual({ k: "failed", reason: message, height: 83 });
    expect(html()).toEqual(["bar", "83px"]);
    expect(badToasts()).toEqual([INSTALL_FAILED(message)]);
  });

  it("insets by a height that arrived while the install was answering", async () => {
    const held = hold("tabbar_install");
    render(<Bar />);
    await flush();
    act(() => emitFromRust("tabbar-geometry", { height: 64 }));
    await act(async () => {
      held.resolve({ height: 83 });
      await Promise.resolve();
    });
    await flush();
    expect(status()).toEqual({ k: "installed", height: 64 });
    expect(html()).toEqual(["bar", "64px"]);
  });

  it("sends a state that returns to the last confirmed one while a set is still on its way", async () => {
    const view = render(<Bar />);
    await flush();
    const held = hold("tabbar_set");
    view.rerender(<Bar state={{ ...STATE, hidden: true }} />);
    await flush();
    view.rerender(<Bar state={STATE} />);
    await flush();
    await act(async () => {
      held.resolve(null);
      await Promise.resolve();
    });
    await flush();
    expect(barCalls().slice(1)).toEqual([
      ["tabbar_set", { state: { ...STATE, hidden: true } }],
      ["tabbar_set", { state: STATE }],
    ]);
  });

  it("throws when asked to show the bar with no plan open", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Bar open={false} />)).toThrow("The tab bar was asked to show with no plan open.");
    logged.mockRestore();
  });
});

describe.each([IPAD, MAC])("useNativeTabBar on $os $idiom", (p) => {
  it("asks nothing, stays off and marks nothing", async () => {
    setPlatform(p);
    const view = render(<Bar />);
    await flush();
    view.rerender(<Bar state={{ ...STATE, hidden: true }} />);
    await flush();
    expect(barCalls()).toEqual([]);
    expect(listening()).toEqual([0, 0, 0]);
    expect(status()).toEqual({ k: "off" });
    expect(html()).toEqual([undefined, ""]);
  });
});
