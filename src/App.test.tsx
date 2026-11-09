import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { REBUILD_LIST_LINE, RESET_SETTINGS_LINE } from "./App";
import { AppError } from "./services/ipc";
import { Registry } from "./store/registry";
import { seededStore } from "./test/shell";
import { closeListenerCount, requestWindowClose, resetTauri, tauri, windowState } from "./test/tauriMock";
import { Dialog } from "./ui/common/Dialog";
import { clearToasts } from "./ui/common/Toast";
import { PLACE_KEY } from "./ui/state";

vi.mock("@tauri-apps/api/core", () => import("./test/tauriMock"));
vi.mock("@tauri-apps/api/window", () => import("./test/tauriMock"));

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
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

it("lists plans before loading them and warms after the first render", async () => {
  const s = await seededStore(["Alpha", "Beta"]);
  expect(s.state.settings).toEqual({ v: 1, lastRegion: null, names: { [s.ids[0]]: "Alpha", [s.ids[1]]: "Beta" } });
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
  it("closes the registry before the window goes", async () => {
    await seededStore(["Alpha"]);
    spyOpen();
    render(<App />);
    await settle();
    expect(closeListenerCount()).toBe(1);
    const close = vi.spyOn(Registry.prototype, "close");
    let result: { prevented: boolean } | null = null;
    await act(async () => {
      result = await requestWindowClose();
    });
    expect(result).toEqual({ prevented: false });
    expect(close).toHaveBeenCalledTimes(1);
    expect(windowState.destroyed).toBe(1);
  });

  it("keeps the window open and toasts the failure when the registry fails to close", async () => {
    await seededStore(["Alpha"]);
    const failure = new AppError("store.io", "Could not save “Alpha”: disk full.");
    const log = logged();
    spyOpen();
    render(<App />);
    await settle();
    vi.spyOn(Registry.prototype, "close").mockRejectedValueOnce(failure);
    let result: { prevented: boolean } | null = null;
    await act(async () => {
      result = await requestWindowClose();
    });
    expect(result).toEqual({ prevented: true });
    expect(windowState.destroyed).toBe(0);
    expect(screen.getAllByRole("status").map((e) => [e.textContent, e.className])).toEqual([["Could not save “Alpha”: disk full.", "toast bad"]]);
    expect(log.mock.calls).toEqual([[failure]]);
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
