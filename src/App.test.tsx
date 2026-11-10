import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { REBUILD_LIST_LINE, RESET_SETTINGS_LINE } from "./App";
import { AppError } from "./services/ipc";
import { check as checkUpdate, restart, type FoundUpdate } from "./services/updates";
import type { InstallProgress } from "./store/updates";
import { SyncManager } from "./sync/manager";
import { Registry } from "./store/registry";
import { seededStore } from "./test/shell";
import { closeListenerCount, requestWindowClose, resetTauri, tauri, windowState } from "./test/tauriMock";
import { Dialog } from "./ui/common/Dialog";
import { clearToasts, Toasts } from "./ui/common/Toast";
import { PLACE_KEY } from "./ui/state";

vi.mock("@tauri-apps/api/core", () => import("./test/tauriMock"));
vi.mock("@tauri-apps/api/window", () => import("./test/tauriMock"));
vi.mock("./services/updates", () => ({
  check: vi.fn(async () => null),
  restart: vi.fn(async () => undefined),
}));

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
  vi.mocked(checkUpdate).mockReset().mockResolvedValue(null);
  vi.mocked(restart).mockReset().mockResolvedValue(undefined);
});

const opened: Promise<Registry>[] = [];

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map(async (p) => (await p).close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

function spyOpen() {
  const real = Registry.open.bind(Registry);
  return vi.spyOn(Registry, "open").mockImplementation((o) => {
    const p = real(o);
    opened.push(p);
    return p;
  });
}

const toolbar = (): Element | null => document.querySelector("header.toolbar");

const logged = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

it("the toolbar is the window's drag region and carries the wordmark", async () => {
  await seededStore(["Alpha"]);
  spyOpen();
  render(<App />);
  await settle();
  expect(document.querySelector("header.toolbar[data-tauri-drag-region] .wordmark")?.textContent).toBe("WebBoard");
});

describe("start failure", () => {
  it("device.io offers Try again only", async () => {
    await seededStore(["Alpha"]);
    const failure = new AppError("device.io", "Could not read the device id: permission denied.");
    const log = logged();
    const open = spyOpen().mockRejectedValueOnce(failure);
    render(<App />);
    await settle();
    expect(log.mock.calls).toEqual([[failure]]);
    expect(screen.getByText("Could not read the device id: permission denied.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rebuild the plan list" })).toBeNull();
    expect(toolbar()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
    expect(toolbar()).not.toBeNull();
  });

  it("settings.corrupt offers Reset settings", async () => {
    await seededStore(["Alpha"]);
    const reset = vi.fn(() => null);
    tauri.answers.settings_reset = reset;
    const failure = new AppError("settings.corrupt", "settings.json is not valid JSON: line 1.");
    const log = logged();
    const open = spyOpen().mockRejectedValueOnce(failure);
    render(<App />);
    await settle();
    expect(log.mock.calls).toEqual([[failure]]);
    expect(screen.getByText("settings.json is not valid JSON: line 1.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(RESET_SETTINGS_LINE)).toBeTruthy();
    expect(RESET_SETTINGS_LINE).toBe("Plan names and the last region are rebuilt; the old file is kept.");
    expect(screen.queryByRole("button", { name: "Rebuild the plan list" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset settings" }));
    await settle();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
    expect(reset.mock.invocationCallOrder[0]).toBeGreaterThan(open.mock.invocationCallOrder[0]);
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[1]);
    expect(toolbar()).not.toBeNull();
  });

  it("shows a failed Reset settings in place of the old message", async () => {
    await seededStore(["Alpha"]);
    tauri.answers.settings_reset = () => {
      throw { code: "settings.io", message: "Could not rename settings.json: permission denied." };
    };
    const failure = new AppError("settings.corrupt", "settings.json is not valid JSON: line 1.");
    const log = logged();
    const open = spyOpen().mockRejectedValueOnce(failure);
    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Reset settings" }));
    await settle();
    expect(screen.getByText("Could not rename settings.json: permission denied.")).toBeTruthy();
    expect(screen.queryByText("settings.json is not valid JSON: line 1.")).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset settings" })).toBeTruthy();
    expect(log.mock.calls).toEqual([[failure]]);
  });

  it("store.corrupt offers Rebuild the plan list", async () => {
    await seededStore(["Alpha"]);
    const setAside = vi.fn(tauri.answers.store_set_aside);
    tauri.answers.store_set_aside = setAside;
    const failure = new AppError("store.corrupt", "The plan list is damaged at record 3.");
    const log = logged();
    const open = spyOpen().mockRejectedValueOnce(failure);
    render(<App />);
    await settle();
    expect(log.mock.calls).toEqual([[failure]]);
    expect(screen.getByText("The plan list is damaged at record 3.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(REBUILD_LIST_LINE)).toBeTruthy();
    expect(REBUILD_LIST_LINE).toBe("Plans on this device are listed again; trashed plans come back; the old list is kept.");
    expect(screen.queryByRole("button", { name: "Reset settings" })).toBeNull();
    const from = tauri.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Rebuild the plan list" }));
    await settle();
    expect(tauri.calls.slice(from).filter((c) => c.cmd === "store_set_aside").map((c) => c.args)).toEqual([{ doc: "local" }]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(setAside).toHaveBeenCalledTimes(1);
    expect(setAside.mock.invocationCallOrder[0]).toBeGreaterThan(open.mock.invocationCallOrder[0]);
    expect(setAside.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[1]);
    expect(toolbar()).not.toBeNull();
  });
});

describe("the example plan at the first start", () => {
  const current = (): string | null => screen.getByRole("navigation", { name: "Plans" }).querySelector('[aria-current="page"]')?.textContent ?? null;

  it("opens the example plan on a device with no plans and no flag", async () => {
    const s = await seededStore([]);
    s.state.settings = null;
    spyOpen();
    render(<App />);
    await settle();
    await settle();
    expect(current()).toBe("Example: Website relaunch");
    expect(document.querySelector(".tl-canvas")).not.toBeNull();
    expect(s.state.settings).toMatchObject({ exampleOffered: true });
  });

  it("shows a failed flag write as the start failure, and Try again opens the example made before it", async () => {
    const s = await seededStore([]);
    s.state.settings = null;
    const write = tauri.answers.settings_write;
    if (write === undefined) throw new Error("no settings_write answer");
    tauri.answers.settings_write = () => {
      throw { code: "settings.io", message: "Could not save settings.json: disk full" };
    };
    const log = logged();
    const real = Registry.open.bind(Registry);
    vi.spyOn(Registry, "open").mockImplementation(async (o) => {
      const r = await real(o);
      opened.push(Promise.resolve(r));
      return r;
    });
    render(<App />);
    await settle();
    expect(screen.getByText("Could not save settings.json: disk full").className).toBe("start-bad");
    expect(log).toHaveBeenCalledTimes(1);
    tauri.answers.settings_write = write;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    await settle();
    expect(current()).toBe("Example: Website relaunch");
    expect(within(screen.getByRole("navigation", { name: "Plans" })).getAllByText("Example: Website relaunch")).toHaveLength(1);
    expect(s.state.settings).not.toHaveProperty("exampleOffered");
  });
});

it("lists plans before loading them and warms after the first render", async () => {
  const s = await seededStore(["Alpha", "Beta"]);
  expect(s.state.settings).toEqual({ v: 1, lastRegion: null, names: { [s.ids[0]]: "Alpha", [s.ids[1]]: "Beta" }, exampleOffered: true });
  const seen: { sidebar: boolean }[] = [];
  const session = vi.spyOn(Registry.prototype, "session");
  const warm = vi.spyOn(Registry.prototype, "warm").mockImplementation(async () => {
    seen.push({ sidebar: document.querySelector(".sidebar") !== null });
  });
  spyOpen();
  render(<App />);
  await settle();
  const nav = screen.getByRole("navigation", { name: "Plans" });
  expect(within(nav).getByText("Alpha")).toBeTruthy();
  expect(within(nav).getByText("Beta")).toBeTruthy();
  expect(session.mock.calls).toEqual([[s.ids[0]]]);
  expect(warm).toHaveBeenCalledTimes(1);
  expect(seen).toEqual([{ sidebar: true }]);
});

it("toasts a warm rejection", async () => {
  await seededStore(["Alpha"]);
  const failure = new Error("warm broke");
  const log = logged();
  vi.spyOn(Registry.prototype, "warm").mockRejectedValue(failure);
  spyOpen();
  render(<App />);
  await settle();
  expect(screen.getAllByRole("status").map((e) => [e.textContent, e.className])).toEqual([["warm broke", "toast bad"]]);
  expect(log.mock.calls).toEqual([[failure]]);
});

describe("closing the window", () => {
  const closeFailed = (message: string): string => `WebBoard could not save everything before closing: ${message} Close the window again to quit.`;

  const requestClose = async (): Promise<void> => {
    await act(async () => {
      await requestWindowClose();
    });
  };

  it("closes the registry, then destroys the window", async () => {
    await seededStore(["Alpha"]);
    spyOpen();
    render(<App />);
    await settle();
    expect(closeListenerCount()).toBe(1);
    const order: string[] = [];
    const real = Registry.prototype.close;
    const close = vi.spyOn(Registry.prototype, "close").mockImplementation(async function (this: Registry) {
      await real.call(this);
      order.push(`closed with ${windowState.destroyed} destroyed`);
    });
    await requestClose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["closed with 0 destroyed"]);
    expect(windowState.destroyed).toBe(1);
  });

  it("shows the failure screen when the registry fails to close, and lets the next close through", async () => {
    await seededStore(["Alpha"]);
    const failure = new AppError("store.io", "Could not save “Alpha”: disk full.");
    const log = logged();
    spyOpen();
    render(
      <>
        <App />
        <Toasts />
      </>,
    );
    await settle();
    const close = vi.spyOn(Registry.prototype, "close").mockRejectedValueOnce(failure);
    await requestClose();
    expect(windowState.destroyed).toBe(0);
    expect(screen.getByText(closeFailed("Could not save “Alpha”: disk full.")).className).toBe("start-bad");
    expect(toolbar()).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rebuild the plan list" })).toBeNull();
    expect(screen.getAllByRole("status").map((e) => [e.textContent, e.className])).toEqual([["Could not save “Alpha”: disk full.", "toast bad"]]);
    expect(log.mock.calls).toEqual([[failure]]);
    await requestClose();
    expect(windowState.destroyed).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("shows the failure screen when the window cannot be destroyed, and lets the next close through", async () => {
    await seededStore(["Alpha"]);
    const failure = new Error("window not found");
    const log = logged();
    spyOpen();
    render(<App />);
    await settle();
    windowState.destroyFailure = failure;
    await requestClose();
    expect(screen.getByText(closeFailed("window not found")).className).toBe("start-bad");
    expect(toolbar()).toBeNull();
    expect(log.mock.calls).toEqual([[failure]]);
    windowState.destroyFailure = null;
    await requestClose();
    expect(windowState.destroyed).toBe(1);
  });

  it("guards the registry Try again opens after a failed close", async () => {
    await seededStore(["Alpha"]);
    logged();
    const open = spyOpen();
    render(<App />);
    await settle();
    const close = vi.spyOn(Registry.prototype, "close").mockRejectedValueOnce(new Error("disk full"));
    await requestClose();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
    expect(toolbar()).not.toBeNull();
    await requestClose();
    expect(close).toHaveBeenCalledTimes(2);
    expect(windowState.destroyed).toBe(1);
  });

  it("stops listening when the app unmounts", async () => {
    await seededStore(["Alpha"]);
    spyOpen();
    const { unmount } = render(<App />);
    await settle();
    expect(closeListenerCount()).toBe(1);
    unmount();
    expect(closeListenerCount()).toBe(0);
  });
});

it("restores the view from webboard.place after a remount", async () => {
  await seededStore(["Alpha"]);
  spyOpen();
  const first = render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: "List" }));
  expect(JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null")).toMatchObject({ view: "list" });
  first.unmount();
  const [p] = opened.splice(0);
  await (await p).close();
  render(<App />);
  await settle();
  expect(screen.getByRole("tab", { name: "List" }).getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector('[data-slot="list"]')).not.toBeNull();
});

describe("updates", () => {
  const requestClose = async (): Promise<void> => {
    await act(async () => {
      await requestWindowClose();
    });
  };

  const offer = (order: string[], install?: (onProgress: (p: InstallProgress) => void) => Promise<void>): FoundUpdate => ({
    version: "0.2.0",
    install:
      install ??
      (async (onProgress) => {
        order.push("install");
        onProgress({ t: "downloading", downloaded: 0, total: 10 });
        onProgress({ t: "installing" });
      }),
  });

  it("checks once when the shell opens on the desktop and shows the line at the bottom of the sidebar", async () => {
    await seededStore(["Alpha"]);
    spyOpen();
    render(<App />);
    await settle();
    expect(checkUpdate).toHaveBeenCalledTimes(1);
    const line = document.querySelector("nav.sidebar")?.lastElementChild;
    expect(line?.className).toBe("update-line");
    expect(line?.querySelector(".update-status")?.textContent).toMatch(/^Up to date · checked \d\d:\d\d$/);
    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    await settle();
    expect(document.querySelector(".palette")?.textContent).toContain("Check for updates");
  });

  it("neither checks nor shows the line or the commands on a phone or iPad", async () => {
    const seeded = await seededStore(["Alpha"]);
    resetTauri({ ...seeded.answers, device_info: () => ({ deviceId: "mac", platform: "ios" }) });
    spyOpen();
    render(<App />);
    await settle();
    expect(toolbar()).not.toBeNull();
    expect(checkUpdate).not.toHaveBeenCalled();
    expect(document.querySelector(".update-line")).toBeNull();
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    await settle();
    const palette = document.querySelector(".palette");
    expect(palette).not.toBeNull();
    expect(palette?.textContent).toContain("About WebBoard");
    expect(palette?.textContent).not.toContain("Check for updates");
  });

  it("Install and restart installs, then stops sync and closes the registry, then restarts", async () => {
    await seededStore(["Alpha"]);
    const order: string[] = [];
    vi.mocked(checkUpdate).mockResolvedValueOnce(offer(order));
    vi.mocked(restart).mockImplementationOnce(async () => {
      order.push("restart");
    });
    vi.spyOn(SyncManager.prototype, "stop").mockImplementation(() => {
      order.push("stopSync");
    });
    const real = Registry.prototype.close;
    vi.spyOn(Registry.prototype, "close").mockImplementation(async function (this: Registry) {
      order.push("registry.close");
      await real.call(this);
    });
    spyOpen();
    render(<App />);
    await settle();
    expect(screen.getByText("WebBoard 0.2.0 is available")).toBeTruthy();
    order.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    await settle();
    expect(order).toEqual(["install", "stopSync", "registry.close", "restart"]);
  });

  it("a failed install closes nothing and shows the failure on the line", async () => {
    await seededStore(["Alpha"]);
    vi.mocked(checkUpdate).mockResolvedValueOnce(offer([], async () => Promise.reject("signature verification failed")));
    const log = logged();
    const close = vi.spyOn(Registry.prototype, "close");
    spyOpen();
    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    await settle();
    expect(screen.getByText("Could not install 0.2.0: signature verification failed")).toBeTruthy();
    expect(log.mock.calls).toEqual([["signature verification failed"]]);
    expect(close).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(toolbar()).not.toBeNull();
  });

  it("a failed close after the install shows the installed-but-not-saved screen, never restarts, and lets the next close through", async () => {
    await seededStore(["Alpha"]);
    vi.mocked(checkUpdate).mockResolvedValueOnce(offer([]));
    const failure = new AppError("store.io", "Could not save “Alpha”: disk full.");
    const log = logged();
    spyOpen();
    render(<App />);
    await settle();
    const close = vi.spyOn(Registry.prototype, "close").mockRejectedValueOnce(failure);
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    await settle();
    const line = "WebBoard 0.2.0 is installed, but WebBoard could not save everything before restarting: Could not save “Alpha”: disk full. Close the window again to quit, then start WebBoard.";
    expect(screen.getByText(line).className).toBe("start-bad");
    expect(toolbar()).toBeNull();
    expect(restart).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([[failure]]);
    expect(log.mock.calls[0]?.[0]).toBe(failure);
    await requestClose();
    expect(windowState.destroyed).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a failed restart after the install and the close shows the restart failure screen, and the next close quits", async () => {
    await seededStore(["Alpha"]);
    const failure = new Error("could not relaunch");
    const log = logged();
    vi.mocked(checkUpdate).mockResolvedValueOnce(offer([]));
    vi.mocked(restart).mockRejectedValueOnce(failure);
    const close = vi.spyOn(Registry.prototype, "close");
    spyOpen();
    render(
      <>
        <App />
        <Toasts />
      </>,
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    await settle();
    const line = "WebBoard 0.2.0 is installed and everything is saved, but WebBoard could not restart: could not relaunch Quit WebBoard and start it again.";
    expect(screen.getByText(line).className).toBe("start-bad");
    expect(toolbar()).toBeNull();
    expect(screen.queryAllByRole("status")).toEqual([]);
    expect(log.mock.calls).toEqual([[failure]]);
    expect(log.mock.calls[0]?.[0]).toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
    await requestClose();
    expect(windowState.destroyed).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a failed check logs the original error", async () => {
    await seededStore(["Alpha"]);
    const failure = new Error("error sending request");
    const log = logged();
    vi.mocked(checkUpdate).mockRejectedValueOnce(failure);
    spyOpen();
    render(<App />);
    await settle();
    expect(screen.getByText("Could not check for updates: error sending request")).toBeTruthy();
    expect(log.mock.calls).toEqual([[failure]]);
    expect(log.mock.calls[0]?.[0]).toBe(failure);
  });
});

describe("Dialog", () => {
  function Host(p: { onClose(): void }) {
    const [n, setN] = useState(0);
    return (
      <Dialog label="Test dialog" onClose={p.onClose}>
        <button type="button" onClick={() => setN(n + 1)}>
          First
        </button>
        <button type="button">Last</button>
      </Dialog>
    );
  }

  it("traps Tab and closes on Escape", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Test dialog" });
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(document.activeElement).toBe(first);
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
