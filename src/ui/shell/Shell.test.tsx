import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { RegionRef } from "../../domain/calendar";
import type { PlanId } from "../../domain/model";
import { sideText } from "../../plan/choices";
import { fixedClock } from "../../services/clock";
import { playHaptic } from "../../services/haptics";
import { messageOf } from "../common/errorText";
import { AppError } from "../../services/ipc";
import { decodeAction, encodeAction } from "../../store/doc";
import { importPlan, type Imported } from "../../store/file";
import { IndexDoc } from "../../store/index-doc";
import type { PersistedDoc } from "../../store/persist";
import { Registry } from "../../store/registry";
import { NEWER_PLAN, type PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { memoryStore } from "../../test/fixtures/store";
import { MESA_SEED, memoryDoc, testSession, type SeedItem, type TestSession } from "../../test/session";
import { seededStore as store, shellFor } from "../../test/shell";
import { hold, offeredSettings, resetTauri, tauri, type Call } from "../../test/tauriMock";
import { orderedSides } from "../choices/order";
import { CHOICE_TITLE } from "../choices/pick";
import { clearToasts } from "../common/Toast";
import { forgetLastPlan, NO_PLAN_KEY, PLACE_KEY, PLACE_UNREADABLE, pickPlan, useUi, type UiState } from "../state";
import { closeConverted, CONVERTED_TITLE, OPEN_PLAN, showConverted, shownConverted } from "./ConvertedReport";
import { exportFlow, importFlow } from "./fileFlows";
import { printNow } from "../print/print";
import { OpenChoice } from "../run";
import { PlanHead } from "./PlanHead";
import { Shell } from "./Shell";
import { connectedStubs, withSync } from "../../test/withSync";
import { paintNative } from "../../theme/apply";
import { PRESETS, tokensOf, type Theme } from "../../theme/presets";
import { setCoarsePointer } from "../../test/matchMedia";
import { IPAD, LINUX, setPlatform, stubVisualViewport } from "../../test/platform";
import { TAP_HINT } from "./Tray";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));
vi.mock("../../store/file", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../store/file")>();
  return { ...m, exportPlan: vi.fn(m.exportPlan), importPlan: vi.fn(m.importPlan) };
});
vi.mock("./fileFlows", async (importOriginal) => {
  const m = await importOriginal<typeof import("./fileFlows")>();
  return { ...m, exportFlow: vi.fn(m.exportFlow), importFlow: vi.fn(m.importFlow) };
});
vi.mock("../print/print", () => ({ printNow: vi.fn(async () => undefined) }));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const ZH: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const FILES_STAY = "The plan’s files stay on this device.";
const RELOAD = "Load again from the server";
const RELOAD_TEXT = "Changes this device had not sent to the server are not loaded again; the damaged files stay on this device.";
const INCOMPLETE = "This plan has not arrived yet; it opens once it syncs.";

const sessions: PlanSession[] = [];
const registries: Registry[] = [];

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
});

afterEach(async () => {
  cleanup();
  clearToasts();
  if (shownConverted() !== null) closeConverted();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(useUi).mockClear();
  vi.mocked(importPlan).mockClear();
  vi.mocked(exportFlow).mockClear();
  vi.mocked(importFlow).mockClear();
  vi.mocked(printNow).mockReset();
  vi.mocked(printNow).mockResolvedValue(undefined);
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(registries.splice(0).map((r) => r.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const made = async (...a: Parameters<typeof testSession>): Promise<TestSession> => {
  const t = await testSession(...a);
  sessions.push(t.session);
  return t;
};

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const toastNodes = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast"));

const slot = (name: string): Element | null => document.querySelector(`[data-slot="${name}"]`);

const expectTimeline = (): void => {
  const at = slot("timeline");
  expect(at).not.toBeNull();
  expect(at?.querySelector(".tl-scroll")).not.toBeNull();
  expect(document.querySelectorAll(".tl-scroll")).toHaveLength(1);
};

const expectNoTimeline = (): void => {
  expect(slot("timeline")).toBeNull();
  expect(document.querySelector(".tl-scroll")).toBeNull();
};

const lastUi = () => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value[0];
};

const setUiNow = (patch: Partial<UiState>): void => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  act(() => r.value[1](patch));
};

const menuToggle = (): HTMLElement => screen.getByRole("button", { name: "Plan menu" });

const menuItems = (): HTMLElement[] => within(screen.getByRole("menu", { name: "Plan" })).getAllByRole("menuitem");

const entry = (name: string): HTMLElement => {
  const nav = screen.getByRole("navigation", { name: "Plans" });
  return within(nav).getByText(name).closest("li") ?? (() => { throw new Error("no entry " + name); })();
};

const currentName = (): string | null => {
  const nav = screen.getByRole("navigation", { name: "Plans" });
  return nav.querySelector('[aria-current="page"]')?.textContent ?? null;
};

const newPlanIn = (nav: HTMLElement): HTMLElement => {
  const box = nav.querySelector(".sidebar-new");
  if (!(box instanceof HTMLElement)) throw new Error("no sidebar New plan");
  return within(box).getByRole("button");
};

const trashSection = (): HTMLElement | null => screen.queryByRole("region", { name: "Trash" });

const xdoc = (c: Call): string | null => new Headers(c.options?.headers).get("x-doc");
const xseq = (c: Call): string | null => new Headers(c.options?.headers).get("x-seq");

async function opened(): Promise<Registry> {
  const r = await Registry.open({ clock: fixedClock("2026-11-09") });
  registries.push(r);
  return r;
}

const notifier = (r: Registry): (() => void) => {
  const subscribers = new Set<() => void>();
  const real = r.subscribe.bind(r);
  vi.spyOn(r, "subscribe").mockImplementation((cb) => {
    subscribers.add(cb);
    const off = real(cb);
    return () => {
      subscribers.delete(cb);
      off();
    };
  });
  return () => [...subscribers].forEach((cb) => cb());
};

const cyberdeck = (): Theme => {
  const t = PRESETS.find((p) => p.id === "cyberdeck");
  if (t === undefined) throw new Error("no cyberdeck preset");
  return t;
};

const shellOn = (r: Registry) => <Shell registry={r} clock={fixedClock("2026-11-09")} />;

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  const settlers: { resolve(v: T): void; reject(e: unknown): void }[] = [];
  const promise = new Promise<T>((resolve, reject) => {
    settlers.push({ resolve, reject });
  });
  const [s] = settlers;
  return { promise, resolve: s.resolve, reject: s.reject };
}

describe("Shell on testSession(MESA_SEED)", () => {
  it("full by default", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    expect(document.documentElement.dataset.form).toBe("full");
    expect(screen.getByRole("navigation", { name: "Plans" })).toBeTruthy();
    expect(slot("panel")).not.toBeNull();
  });

  it("renders the toolbar", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    const bar = document.querySelector("header.toolbar[data-tauri-drag-region]");
    if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
    expect(bar.querySelector(".wordmark")?.textContent).toBe("WebBoard");
    expect([within(bar).queryByText("Plan"), bar.querySelector(".toolbar-plan")]).toEqual([null, null]);
    const tabs = within(bar).getAllByRole("tab");
    expect(tabs.map((b) => [b.textContent, b.getAttribute("aria-selected")])).toEqual([
      ["Timeline", "true"],
      ["Board", "false"],
      ["List", "false"],
    ]);
    expect(["W", "M", "Q"].map((z) => within(bar).getByRole("button", { name: z }).getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(within(bar).getByRole("button", { name: "⌘K" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Local only" })).toBeTruthy();
    const undo = within(bar).getByRole("button", { name: "Undo" });
    const redo = within(bar).getByRole("button", { name: "Redo" });
    expect([undo.hasAttribute("disabled"), redo.hasAttribute("disabled")]).toEqual([true, true]);
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    expect([undo.hasAttribute("disabled"), redo.hasAttribute("disabled")]).toEqual([false, true]);
    fireEvent.click(undo);
    expect([undo.hasAttribute("disabled"), redo.hasAttribute("disabled")]).toEqual([true, false]);
    act(() => t.session.setReadOnly(true));
    expect([undo.hasAttribute("disabled"), redo.hasAttribute("disabled")]).toEqual([true, true]);
  });

  it("lists Export plan…, Import plan… and Print… under ⋯, all enabled while read-only, and runs each flow", async () => {
    const t = await made(MESA_SEED);
    t.session.setReadOnly(true);
    const { ui, registry } = shellFor(t);
    render(withSync(ui));
    await settle();
    const head = document.querySelector(".plan-head");
    if (!(head instanceof HTMLElement)) throw new Error("no plan head");
    const more = within(head).getByRole("button", { name: "Plan menu" });
    expect(more.textContent).toBe("⋯");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const items = within(screen.getByRole("menu", { name: "Plan" })).getAllByRole("menuitem");
    expect(items.map((b) => [b.textContent, b.hasAttribute("disabled")])).toEqual([
      ["Export plan…", false],
      ["Import plan…", false],
      ["Print…", false],
    ]);
    vi.mocked(exportFlow).mockResolvedValueOnce(undefined);
    fireEvent.click(items[0]);
    expect(vi.mocked(exportFlow).mock.calls).toEqual([[t.session]]);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(more);
    vi.mocked(importFlow).mockResolvedValueOnce(undefined);
    fireEvent.click(within(screen.getByRole("menu", { name: "Plan" })).getByRole("menuitem", { name: "Import plan…" }));
    expect(vi.mocked(importFlow).mock.calls.map((c) => c[0])).toEqual([registry]);
    expect(screen.queryByRole("menu")).toBeNull();
    await settle();
  });

  it("closes the ⋯ menu on Esc without touching the selection, and a second Esc on ⋯ deselects", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    setUiNow({ selected: "t3" });
    expect(lastUi().selected).toBe("t3");
    fireEvent.click(menuToggle());
    expect(document.activeElement).toBe(menuItems()[0]);
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(menuToggle());
    expect(lastUi().selected).toBe("t3");
    act(() => {
      fireEvent.keyDown(menuToggle(), { key: "Escape" });
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(lastUi().selected).toBeNull();
  });

  it("moves focus through the ⋯ menu with the arrow keys, Home and End, wrapping", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    setUiNow({ selected: "t3" });
    fireEvent.click(menuToggle());
    const [exportItem, importItem, printItem] = menuItems();
    expect(document.activeElement).toBe(exportItem);
    const press = (key: string): boolean => {
      let kept = true;
      act(() => {
        kept = fireEvent.keyDown(document.activeElement ?? document.body, { key });
      });
      return kept;
    };
    expect(press("ArrowDown")).toBe(false);
    expect(document.activeElement).toBe(importItem);
    expect(press("ArrowDown")).toBe(false);
    expect(document.activeElement).toBe(printItem);
    expect(press("ArrowDown")).toBe(false);
    expect(document.activeElement).toBe(exportItem);
    expect(press("ArrowUp")).toBe(false);
    expect(document.activeElement).toBe(printItem);
    expect(press("Home")).toBe(false);
    expect(document.activeElement).toBe(exportItem);
    expect(press("End")).toBe(false);
    expect(document.activeElement).toBe(printItem);
    expect(screen.getByRole("menu", { name: "Plan" })).toBeTruthy();
    expect(lastUi().selected).toBe("t3");
  });

  it.each([
    ["⋯", "Plan"],
    ["+ New", "New item"],
  ])("with the %s menu open, the shortcuts behind it do nothing", async (toggle, menuName) => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    setUiNow({ selected: "t3" });
    const before = t.session.view().plan.items.get("t3");
    const count = t.session.view().plan.items.size;
    const view = lastUi().view;
    fireEvent.click(toggle === "⋯" ? menuToggle() : screen.getByRole("button", { name: toggle }));
    const menu = screen.getByRole("menu", { name: menuName });
    expect(menu.contains(document.activeElement)).toBe(true);
    const keys = [{ key: "ArrowLeft" }, { key: "ArrowRight" }, { key: "ArrowLeft", shiftKey: true }, { key: "Backspace" }, { key: "Delete" }, { key: "2" }, { key: "n" }, { key: "m" }, { key: "t" }, { key: "d", metaKey: true }, { key: "d", ctrlKey: true }];
    keys.forEach((k) =>
      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, k);
      }),
    );
    await settle();
    expect(t.session.view().plan.items.get("t3")).toEqual(before);
    expect(t.session.view().plan.items.size).toBe(count);
    expect(lastUi().selected).toBe("t3");
    expect(lastUi().view).toBe(view);
    expect(screen.getByRole("menu", { name: menuName })).toBeTruthy();
  });

  it("moves focus through the + New menu with the arrow keys, Home and End, wrapping, and the selection stays", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    setUiNow({ selected: "t3" });
    fireEvent.click(screen.getByRole("button", { name: "+ New" }));
    const [task, milestone, group] = within(screen.getByRole("menu", { name: "New item" })).getAllByRole("menuitem");
    expect(document.activeElement).toBe(task);
    const press = (key: string): boolean => {
      let kept = true;
      act(() => {
        kept = fireEvent.keyDown(document.activeElement ?? document.body, { key });
      });
      return kept;
    };
    expect(press("ArrowDown")).toBe(false);
    expect(document.activeElement).toBe(milestone);
    expect(press("ArrowDown")).toBe(false);
    expect(document.activeElement).toBe(group);
    expect(press("ArrowDown")).toBe(false);
    expect(document.activeElement).toBe(task);
    expect(press("ArrowUp")).toBe(false);
    expect(document.activeElement).toBe(group);
    expect(press("Home")).toBe(false);
    expect(document.activeElement).toBe(task);
    expect(press("End")).toBe(false);
    expect(document.activeElement).toBe(group);
    expect(lastUi().selected).toBe("t3");
  });

  it("closes the ⋯ menu when focus leaves it, and keeps it while focus moves between its items", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    fireEvent.click(menuToggle());
    const [exportItem, importItem] = menuItems();
    act(() => {
      fireEvent.focusOut(exportItem, { relatedTarget: importItem });
    });
    expect(screen.getByRole("menu", { name: "Plan" })).toBeTruthy();
    act(() => {
      fireEvent.focusOut(importItem, { relatedTarget: menuToggle() });
    });
    expect(screen.getByRole("menu", { name: "Plan" })).toBeTruthy();
    expect(fireEvent.mouseDown(importItem)).toBe(false);
    expect(screen.getByRole("menu", { name: "Plan" })).toBeTruthy();
    act(() => {
      fireEvent.focusOut(importItem, { relatedTarget: screen.getByRole("button", { name: "⌘K" }) });
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuToggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("reads Ctrl K off macOS", async () => {
    setPlatform(LINUX);
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t, { device: { deviceId: "mac", name: "Linux", platform: "linux" } });
    render(withSync(ui));
    await settle();
    expect(screen.getByRole("button", { name: "Ctrl K" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "⌘K" })).toBeNull();
  });

  it("keeps the traffic-light inset to macOS", async () => {
    const t = await made(MESA_SEED);
    const linux = shellFor(t, { device: { deviceId: "mac", name: "Linux", platform: "linux" } });
    const first = render(withSync(linux.ui));
    await settle();
    expect(document.querySelector("header.toolbar")?.classList.contains("toolbar-mac")).toBe(false);
    first.unmount();
    const mac = shellFor(t, { device: { deviceId: "mac", name: "Mac", platform: "macos" } });
    render(withSync(mac.ui));
    await settle();
    expect(document.querySelector("header.toolbar")?.classList.contains("toolbar-mac")).toBe(true);
  });

  it("mounts the slots for the view", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    expectTimeline();
    expect(slot("panel")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    expect(slot("list")).not.toBeNull();
    expect(slot("list")?.querySelector(".list-wrap table.list")).not.toBeNull();
    expectNoTimeline();
    expect(screen.getByRole("tab", { name: "List" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(slot("board")).not.toBeNull();
    expect(slot("board")?.querySelectorAll(".nnl section.col[data-col]")).toHaveLength(3);
    expect(slot("board")?.querySelectorAll('.nnl [data-strip="done"]')).toHaveLength(1);
    expect(slot("list")).toBeNull();
    expect(document.querySelector(".list-wrap")).toBeNull();
  });

  it("lists cached names, Loading… for a missing one, and marks the selected plan", async () => {
    const t = await made(MESA_SEED);
    const id = t.session.view().plan.id;
    const { ui } = shellFor(t, {
      plans: () => [
        { id, name: "Plan", trashed: false, loaded: true, space: null, example: false },
        { id: "other000000", name: null, trashed: false, loaded: false, space: null, example: false },
      ],
    });
    render(withSync(ui));
    await settle();
    expect(within(screen.getByRole("navigation", { name: "Plans" })).getByText("Loading…")).toBeTruthy();
    expect(currentName()).toBe("Plan");
  });

  it("shows the tray count and legend", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    expect(screen.getByText("Unscheduled · 5")).toBeTruthy();
    expect(document.querySelector(".legend")?.textContent).toBe("taskmilestonelateconflictheld");
  });

  it("tells a mouse to drag an unscheduled item and a finger to tap it, which opens it with its start", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    const hint = (): string | null | undefined => document.querySelector(".tray-hint")?.textContent;
    expect(hint()).toBe("Drag one onto the timeline to give it dates.");
    act(() => setCoarsePointer(true));
    expect(hint()).toBe(TAP_HINT);
    act(() => setCoarsePointer(false));
    expect(hint()).toBe("Drag one onto the timeline to give it dates.");
    act(() => setCoarsePointer(true));
    expect(hint()).toBe(TAP_HINT);
    const chip = document.querySelector(".tray-chip");
    if (!(chip instanceof HTMLElement)) throw new Error("no tray chip");
    fireEvent.pointerDown(chip, { button: 0, pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(chip, { button: 0, pointerType: "touch", clientX: 5, clientY: 5 });
    await settle();
    const start = document.querySelector('.slot-panel input[aria-label="Start"], .slot-panel input[aria-label="Date"]');
    expect(start instanceof HTMLInputElement ? start.value : null).toBe("");
    const name = document.querySelector('.slot-panel input[aria-label="Name"]');
    expect(name instanceof HTMLInputElement ? name.value : null).toBe(chip.textContent);
  });

  it("toasts the session's repair notice once", async () => {
    const t = await made(MESA_SEED);
    const take = vi.spyOn(t.session, "takeRepairNotice").mockReturnValueOnce("The last change before WebBoard stopped was cut off while saving and was not kept.").mockReturnValue(null);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    expect(toastTexts().filter((x) => x === "The last change before WebBoard stopped was cut off while saving and was not kept.")).toHaveLength(1);
    expect(take.mock.calls.length).toBeGreaterThan(1);
  });

  it("puts a store error in one banner, and Try again retries it", async () => {
    const t = await made(MESA_SEED);
    const { ui, registry } = shellFor(t);
    render(withSync(ui));
    await settle();
    const real = tauri.answers.store_append;
    const fails: { code: string; message: string }[] = [{ code: "store.io", message: "Disk full." }];
    tauri.answers.store_append = (args, options) => {
      const e = fails.shift();
      if (e !== undefined) throw e;
      return real(args, options);
    };
    const from = tauri.calls.length;
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    await settle();
    expect(screen.getAllByText("Disk full.")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    const retryPlan = vi.spyOn(registry, "retryPlan");
    const retry = vi.spyOn(t.doc, "retry");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(retryPlan.mock.calls).toEqual([[t.session.view().plan.id]]);
    expect(retry).toHaveBeenCalledTimes(1);
    const appends = tauri.calls.slice(from).filter((c) => c.cmd === "store_append" && xdoc(c) === t.session.view().plan.id);
    expect(appends).toHaveLength(2);
    expect(xseq(appends[1])).toBe(xseq(appends[0]));
    expect(appends[1].args).toEqual(appends[0].args);
    expect(screen.queryByText("Disk full.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps the banner when the retry fails too", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    const real = tauri.answers.store_append;
    const fails: { code: string; message: string }[] = [{ code: "store.io", message: "Disk full." }];
    tauri.answers.store_append = (args, options) => {
      const e = fails.shift();
      if (e !== undefined) throw e;
      return real(args, options);
    };
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    await settle();
    fails.push({ code: "store.io", message: "Disk still full." });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.getAllByText("Disk still full.")).toHaveLength(1);
    expect(screen.queryByText("Disk full.")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("on iOS shows a haptic's own unhandled fault without asking for another haptic, and any other with the error haptic", async () => {
    Object.defineProperty(window, "__WEBBOARD_PLATFORM__", { configurable: true, writable: true, value: undefined });
    const fault = await playHaptic("error").catch((x: unknown) => x);
    setPlatform(IPAD);
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t, { device: { deviceId: "ipad", name: "iPad", platform: "ios" } }).ui));
    await settle();
    const from = tauri.calls.length;
    const haptics = (): unknown[] => tauri.calls.slice(from).filter((c) => c.cmd === "haptic").map((c) => c.args);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: fault }));
    });
    await settle();
    expect(toastTexts()).toEqual([messageOf(fault)]);
    expect(haptics()).toEqual([]);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: fault }));
    });
    await settle();
    expect(haptics()).toEqual([{ kind: "error" }]);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("elsewhere") }));
    });
    await settle();
    expect(haptics()).toEqual([{ kind: "error" }, { kind: "error" }]);
  });

  it("toasts a window error and an unhandled rejection until unmounted", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    const view = render(withSync(ui));
    await settle();
    act(() => {
      window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("Holiday warm for plan p failed: boom") }));
    });
    expect(toastNodes().map((n) => [n.textContent, n.className])).toEqual([["Holiday warm for plan p failed: boom", "toast bad"]]);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "plain reason" }));
    });
    expect(toastTexts()).toEqual(["Holiday warm for plan p failed: boom", "plain reason"]);
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("thrown in a handler"), message: "Uncaught Error: thrown in a handler" }));
    });
    expect(toastTexts()).toEqual(["Holiday warm for plan p failed: boom", "plain reason", "thrown in a handler"]);
    expect(screen.getAllByRole("button", { name: "Copy details" })).toHaveLength(3);
    view.unmount();
    clearToasts();
    const probe = render(<div />);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("after unmount") }));
    });
    expect(toastTexts()).toEqual([]);
    probe.unmount();
  });

  it.each([
    ["a WebKit stack of frames only", "render@http://localhost/src/ui/Shell.tsx:1:1\nfrom@http://localhost/src/main.tsx:2:2", "TypeError: boom here\nrender@http://localhost/src/ui/Shell.tsx:1:1\nfrom@http://localhost/src/main.tsx:2:2"],
    ["a V8 stack that already names the error", "TypeError: boom here\n    at render (Shell.tsx:1:1)", "TypeError: boom here\n    at render (Shell.tsx:1:1)"],
  ])("Copy details copies the error's name and message with %s", async (_, stack, copied) => {
    const writeText = vi.fn((_: string) => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    const error = new TypeError("boom here");
    error.stack = stack;
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { error, message: "Uncaught TypeError: boom here" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
      await Promise.resolve();
    });
    expect(writeText.mock.calls).toEqual([[copied]]);
  });

  it("toasts only error events that carry an error", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
      window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    });
    expect(toastTexts()).toEqual([]);
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("thrown in a handler"), message: "Uncaught Error: thrown in a handler" }));
    });
    expect(toastNodes().map((n) => [n.textContent, n.className])).toEqual([["thrown in a handler", "toast bad"]]);
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { error: "thrown string", message: "Uncaught thrown string" }));
    });
    expect(toastTexts()).toEqual(["thrown in a handler", "thrown string"]);
  });

  it("resets an unreadable webboard.place with one toast", async () => {
    window.localStorage.setItem(PLACE_KEY, "{");
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    expect(toastTexts().filter((x) => x === PLACE_UNREADABLE)).toHaveLength(1);
    expect(toastNodes().find((n) => n.textContent === PLACE_UNREADABLE)?.className).toBe("toast bad");
    expect(screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "W" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    const saved: unknown = JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null");
    expect(saved).toEqual({ plan: t.session.view().plan.id, view: "list", zoom: "W", collapsed: [], sidebarOpen: true, sidebarWidth: null });
  });

  it("reads and keeps a stored fit zoom", async () => {
    const t = await made(MESA_SEED);
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: t.session.view().plan.id, view: "timeline", zoom: "F", collapsed: [] }));
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    expect(toastTexts()).toEqual([]);
    const fit = screen.getByRole("button", { name: "F" });
    expect([fit.getAttribute("aria-pressed"), fit.title]).toEqual(["true", "Fit the whole plan"]);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    const saved: unknown = JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null");
    expect(saved).toEqual({ plan: t.session.view().plan.id, view: "list", zoom: "F", collapsed: [], sidebarOpen: true, sidebarWidth: null });
  });

  it("does not toast a missing webboard.place", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    expect(toastTexts()).toEqual([]);
  });
});

function Head(p: { session: PlanSession; onChoose(choice: string): void }) {
  return (
    <OpenChoice.Provider value={vi.fn()}>
      <PlanHead session={p.session} local="Mac" readOnly={false} naming={false} onNamed={vi.fn()} onChoose={p.onChoose} />
    </OpenChoice.Provider>
  );
}

describe("PlanHead", () => {
  const RAW_X1 = ["iphone", "s1", 0, [], "Bad", "not-writes"];
  const RAW_X3 = ["ipad7", "s2", 0, [], "Bad", "not-writes"];
  const child = (id: string, name: string) =>
    encodeAction({ id, dev: "iphone", ses: "s1", at: 0, par: ["x1"], lbl: "Rename", w: [{ u: "n:A", v: name, c: "own" }] });
  const thrown = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      if (e instanceof Error) return e.message;
    }
    throw new Error("expected a throw");
  };

  it("names unreadable changes and pending ones", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }], { raw: { x1: RAW_X1, x2: child("x2", "Renamed"), x3: RAW_X3 } });
    const m1 = thrown(() => decodeAction("x1", RAW_X1));
    const m3 = thrown(() => decodeAction("x3", RAW_X3));
    const messages = [
      "A change from iPhone could not be read: " + m1 + ". Update WebBoard on this device.",
      "A change from Device ipad could not be read: " + m3 + ". Update WebBoard on this device.",
    ];
    expect(t.session.view().unreadable).toEqual([
      { id: "x1", message: messages[0] },
      { id: "x3", message: messages[1] },
    ]);
    const view = render(<Head session={t.session} onChoose={vi.fn()} />);
    const bad = (): (string | null)[] => [...view.container.querySelectorAll(".bad")].map((e) => e.textContent);
    expect(bad()).toEqual(messages);
    const lines = (): (string | null)[] => [...view.container.querySelectorAll(".head-line")].map((e) => e.textContent);
    expect(lines()).toEqual([NEWER_PLAN, ...messages]);
    view.rerender(<Head session={t.session} onChoose={vi.fn()} />);
    expect(bad()).toEqual(messages);
    expect(lines()).toEqual([NEWER_PLAN, ...messages]);
    expect(screen.getByText("Receiving… · 1 change waiting")).toBeTruthy();
  });

  it("counts several pending changes", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }], {
      raw: { x1: RAW_X1, x2: child("x2", "One"), x4: child("x4", "Two"), x5: child("x5", "Three") },
    });
    render(<Head session={t.session} onChoose={vi.fn()} />);
    expect(screen.getByText("Receiving… · 3 changes waiting")).toBeTruthy();
  });

  const A = [{ name: "A", start: "2026-11-10", dur: 3 }];
  const NAME_CLASH = { unit: "n:A", mac: "North", iphone: "South" };
  const DAY_CLASH = { unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null };
  const chip = (): string | null => document.querySelector(".chip-amber")?.textContent ?? null;

  it("counts open choices", async () => {
    const one = await made(A, { clashes: [NAME_CLASH] });
    const first = render(<Head session={one.session} onChoose={vi.fn()} />);
    expect(chip()).toBe("1 open choice · Choose…");
    first.unmount();
    const none = await made(A);
    const empty = render(<Head session={none.session} onChoose={vi.fn()} />);
    expect(empty.container.textContent).not.toMatch(/open choice/);
    empty.unmount();
  });

  it("lists every choice, calendar ones included, and opens the picked one", async () => {
    const t = await made(A, { clashes: [NAME_CLASH, DAY_CLASH] });
    const onChoose = vi.fn();
    render(<Head session={t.session} onChoose={onChoose} />);
    expect(chip()).toBe("2 open choices · Choose…");
    const chips = document.querySelector(".chips");
    if (!(chips instanceof HTMLElement)) throw new Error("no chips");
    fireEvent.click(within(chips).getByRole("button", { name: "Choose…" }));
    const view = t.session.view();
    expect(view.choices.map((c) => c.kind).sort()).toEqual(["calendar", "items"]);
    const rows = within(screen.getByRole("list", { name: "Open choices" })).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(view.choices.map((c) => orderedSides(c, "Mac").map((s) => sideText(c, s.key, view.plan)).join(" or ")));
    fireEvent.click(rows[1]);
    expect(onChoose.mock.calls).toEqual([[view.choices[1].id]]);
    expect(screen.queryByRole("list", { name: "Open choices" })).toBeNull();
  });

  it("holds the list in a popover whose ✕, Escape and scrim close it, focus staying on Choose…", async () => {
    const t = await made(A, { clashes: [NAME_CLASH] });
    const onChoose = vi.fn();
    render(<Head session={t.session} onChoose={onChoose} />);
    const choose = screen.getByRole("button", { name: "Choose…" });
    const open = (): HTMLElement => {
      act(() => choose.focus());
      fireEvent.click(choose);
      expect(document.activeElement).toBe(choose);
      return screen.getByRole("dialog", { name: "Open choices" });
    };
    const box = open();
    expect([box.classList.contains("popover"), box.hasAttribute("aria-modal"), [...box.children].map((k) => k.className)]).toEqual([true, false, ["choice-list", "popover-close"]]);
    expect(within(box).getByRole("list", { name: "Open choices" })).toBeTruthy();
    fireEvent.click(within(box).getByRole("button", { name: "Close" }));
    expect([screen.queryByRole("dialog", { name: "Open choices" }), choose.getAttribute("aria-expanded")]).toEqual([null, "false"]);
    open();
    fireEvent.keyDown(choose, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Open choices" })).toBeNull();
    open();
    const scrim = document.querySelector(".popover-scrim");
    if (!(scrim instanceof HTMLElement)) throw new Error("no popover scrim");
    const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(scrim);
    fireEvent.pointerDown(scrim, { button: 0, pointerType: "mouse", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(scrim, { button: 0, pointerType: "mouse", clientX: 5, clientY: 5 });
    fireEvent.click(scrim, { button: 0, clientX: 5, clientY: 5 });
    under.mockRestore();
    expect(screen.queryByRole("dialog", { name: "Open choices" })).toBeNull();
    expect([document.activeElement, onChoose.mock.calls]).toEqual([choose, []]);
  });

  it("lists this device's side first even when the iPhone's replays first", async () => {
    const t = await made(A);
    const p = await t.peer("iphone");
    t.session.apply({ t: "rename", item: "A", name: "Draft" });
    t.session.apply({ t: "rename", item: "A", name: "Alpha" });
    p.session.apply({ t: "rename", item: "A", name: "Beta" });
    p.sync();
    expect(t.session.view().choices.map((c) => c.sides.map((s) => s.label))).toEqual([["iPhone", "Mac"]]);
    render(<Head session={t.session} onChoose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    const rows = within(screen.getByRole("list", { name: "Open choices" })).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(["Mac or iPhone"]);
    await p.session.close();
  });

  it("closes the list when the last choice is resolved", async () => {
    const t = await made(A, { clashes: [NAME_CLASH] });
    render(<Head session={t.session} onChoose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    expect(screen.queryByRole("list", { name: "Open choices" })).not.toBeNull();
    act(() => {
      const c = t.session.view().choices[0];
      t.session.resolve(c.id, { side: c.sides[0].key }, { pushFromPredecessors: false, returnPushed: false });
    });
    expect(chip()).toBeNull();
    const p = await t.peer("iphone");
    act(() => {
      t.session.apply({ t: "rename", item: "A", name: "East" });
      p.session.apply({ t: "rename", item: "A", name: "West" });
      p.sync();
    });
    expect(chip()).toBe("1 open choice · Choose…");
    expect(screen.queryByRole("list", { name: "Open choices" })).toBeNull();
    await p.session.close();
  });

  it("keeps one head popover open: ⋯ closes the choice list and Choose… closes the menu", async () => {
    const t = await made(A, { clashes: [NAME_CLASH] });
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    const choose = screen.getByRole("button", { name: "Choose…" });
    fireEvent.click(choose);
    expect(screen.queryByRole("list", { name: "Open choices" })).not.toBeNull();
    fireEvent.click(menuToggle());
    expect(screen.queryByRole("menu", { name: "Plan" })).not.toBeNull();
    expect(screen.queryByRole("list", { name: "Open choices" })).toBeNull();
    expect(choose.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(choose);
    expect(screen.queryByRole("list", { name: "Open choices" })).not.toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuToggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the choice holding the held items", async () => {
    const t = await made(A, { clashes: [{ unit: "s:A", mac: ["2026-11-16", 3, "todo", 0, "now"], iphone: ["2026-11-18", 3, "todo", 0, "now"] }] });
    const onChoose = vi.fn();
    const view = render(<Head session={t.session} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: "1 held" }));
    expect(onChoose.mock.calls).toEqual([[t.session.view().choices[0].id]]);
    view.unmount();
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "1 held" }));
    expect(lastUi().dialog).toEqual({ t: "choice", id: t.session.view().choices[0].id });
  });
});

describe("Shell banners on a stub registry", () => {
  it("shows an index error with Try again, and drops it on notify", async () => {
    const t = await made(MESA_SEED);
    let error: AppError | null = new AppError("store.io", "Could not save the plan list: disk full.");
    const retryIndex = vi.fn(async () => undefined);
    const { ui, registry } = shellFor(t, { indexError: () => error, indexErrorDoc: () => (error === null ? null : "local"), retryIndex });
    render(withSync(ui));
    await settle();
    expect(screen.getByText("Could not save the plan list: disk full.").closest(".banner")?.classList.contains("bad")).toBe(true);
    expect(screen.queryByRole("button", { name: RELOAD })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retryIndex).toHaveBeenCalledTimes(1);
    error = null;
    act(() => registry.notify());
    expect(screen.queryByText("Could not save the plan list: disk full.")).toBeNull();
  });

  it("offers Load again from the server for a damaged space index", async () => {
    const t = await made(MESA_SEED);
    const reloadFromServer = vi.fn(async () => undefined);
    const { ui } = shellFor(t, {
      ...connectedStubs(t),
      indexError: () => new AppError("store.corrupt", "The space plan list is damaged at record 4."),
      indexErrorDoc: () => "ix-sp000000000",
      retryIndex: vi.fn(async () => undefined),
      reloadFromServer,
    });
    render(withSync(ui, { connected: true }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: RELOAD }));
    const dialog = screen.getByRole("dialog", { name: RELOAD });
    expect(within(dialog).getByText(RELOAD_TEXT)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reloadFromServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: RELOAD }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Load again" }));
    await settle();
    expect(reloadFromServer.mock.calls).toEqual([["ix-sp000000000"]]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts one reload per press until it settles", async () => {
    const t = await made(MESA_SEED);
    const held = deferred<void>();
    const reloadFromServer = vi.fn<(docId: string) => Promise<void>>().mockReturnValueOnce(held.promise).mockResolvedValue(undefined);
    const { ui } = shellFor(t, {
      ...connectedStubs(t),
      indexError: () => new AppError("store.corrupt", "The space plan list is damaged at record 4."),
      indexErrorDoc: () => "ix-sp000000000",
      retryIndex: vi.fn(async () => undefined),
      reloadFromServer,
    });
    render(withSync(ui, { connected: true }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: RELOAD }));
    const load = within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Load again" });
    fireEvent.click(load);
    fireEvent.click(load);
    expect(reloadFromServer).toHaveBeenCalledTimes(1);
    expect(load.hasAttribute("disabled")).toBe(true);
    await act(async () => held.reject(new AppError("store.io", "Could not set the plan aside: disk full.")));
    await settle();
    expect(toastTexts()).toEqual(["Could not set the plan aside: disk full."]);
    expect(load.hasAttribute("disabled")).toBe(false);
    fireEvent.click(load);
    await settle();
    expect(reloadFromServer).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the files of a damaged space index while read-only", async () => {
    const t = await made(MESA_SEED);
    const reloadFromServer = vi.fn(async () => undefined);
    const { ui } = shellFor(t, {
      indexError: () => new AppError("store.corrupt", "The space plan list is damaged at record 4."),
      indexErrorDoc: () => "ix-sp000000000",
      spaceReadOnly: () => true,
      reloadFromServer,
    });
    render(withSync(ui));
    await settle();
    expect(screen.getByText("The space plan list is damaged at record 4.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(FILES_STAY)).toBeTruthy();
    expect(screen.queryByRole("button", { name: RELOAD })).toBeNull();
    expect(reloadFromServer).not.toHaveBeenCalled();
  });

  it("shows each unreadable plan-list change as its own line", async () => {
    const t = await made(MESA_SEED);
    const line = "A change to the plan list from iPhone could not be read: Action x9 has a malformed w. Update WebBoard on this device.";
    let lines: string[] = [line];
    const { ui, registry } = shellFor(t, { indexUnreadable: () => lines });
    render(withSync(ui));
    await settle();
    const el = screen.getByText(line);
    expect(el.classList.contains("bad")).toBe(true);
    expect(el.textContent).toBe(line);
    expect(el.querySelector("button")).toBeNull();
    lines = [];
    act(() => registry.notify());
    expect(screen.queryByText(line)).toBeNull();
  });

  it("shows a settings error with its own Try again", async () => {
    const t = await made(MESA_SEED);
    let error: AppError | null = new AppError("settings.io", "Could not save settings: disk full.");
    const retrySettings = vi.fn(async () => undefined);
    const retryIndex = vi.fn(async () => undefined);
    const { ui, registry } = shellFor(t, { settingsError: () => error, retrySettings, retryIndex });
    render(withSync(ui));
    await settle();
    expect(screen.getByText("Could not save settings: disk full.").closest(".banner")?.classList.contains("bad")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retrySettings).toHaveBeenCalledTimes(1);
    expect(retryIndex).not.toHaveBeenCalled();
    error = null;
    act(() => registry.notify());
    expect(screen.queryByText("Could not save settings: disk full.")).toBeNull();
  });

  it("toasts the index repair notice once", async () => {
    const t = await made(MESA_SEED);
    const text = "The last change to the plan list before WebBoard closed was not saved.";
    const take = vi.fn<() => string | null>().mockReturnValueOnce(text).mockReturnValue(null);
    const { ui, registry } = shellFor(t, { takeIndexRepairNotice: take });
    const view = render(withSync(ui));
    await settle();
    expect(toastTexts().filter((x) => x === text)).toHaveLength(1);
    view.rerender(withSync(ui));
    act(() => registry.notify());
    expect(take).toHaveBeenCalledTimes(2);
    expect(toastTexts().filter((x) => x === text)).toHaveLength(1);
  });

  it("toasts a later index repair notice once", async () => {
    const t = await made(MESA_SEED);
    const text = "The last change to the plan list before WebBoard closed was not saved.";
    const take = vi.fn<() => string | null>().mockReturnValueOnce(null).mockReturnValueOnce(text).mockReturnValue(null);
    const { ui, registry } = shellFor(t, { takeIndexRepairNotice: take });
    render(withSync(ui));
    await settle();
    expect(toastTexts()).toEqual([]);
    act(() => registry.notify());
    act(() => registry.notify());
    expect(toastTexts().filter((x) => x === text)).toHaveLength(1);
    expect(take).toHaveBeenCalledTimes(3);
  });

  it("waits for a plan that has not arrived", async () => {
    const t = await made(MESA_SEED);
    const id = t.session.view().plan.id;
    const session = vi
      .fn<(x: string) => Promise<PlanSession>>()
      .mockRejectedValueOnce(new AppError("plan.incomplete", INCOMPLETE))
      .mockResolvedValue(t.session);
    const { ui, registry } = shellFor(t, {
      plans: () => [{ id, name: "Beta", trashed: false, loaded: false, space: null, example: false }],
      session,
    });
    render(withSync(ui));
    await settle();
    expect(currentName()).toBe("Beta");
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    expectNoTimeline();
    expect(document.querySelector(".plan-failed")).toBeNull();
    act(() => registry.notify());
    await settle();
    expect(session).toHaveBeenCalledTimes(2);
    expectTimeline();
    expect(screen.queryByText(INCOMPLETE)).toBeNull();
  });

  it("keeps the not-arrived message while its retry runs", async () => {
    const t = await made(MESA_SEED);
    const id = t.session.view().plan.id;
    const held = deferred<PlanSession>();
    const session = vi
      .fn<(x: string) => Promise<PlanSession>>()
      .mockRejectedValueOnce(new AppError("plan.incomplete", INCOMPLETE))
      .mockReturnValue(held.promise);
    const { ui, registry } = shellFor(t, {
      plans: () => [{ id, name: "Beta", trashed: false, loaded: false, space: null, example: false }],
      session,
    });
    render(withSync(ui));
    await settle();
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    act(() => registry.notify());
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    act(() => registry.notify());
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    await settle();
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    expect(session).toHaveBeenCalledTimes(3);
    await act(async () => held.resolve(t.session));
    await settle();
    expectTimeline();
    expect(screen.queryByText(INCOMPLETE)).toBeNull();
  });

  it("shows a failed session open with Try again, and still rethrows it", async () => {
    const t = await made(MESA_SEED);
    const boom = new Error("boom");
    const rethrown: Promise<unknown>[] = [];
    const failing = (): Promise<PlanSession> => {
      const p = Promise.reject(boom);
      const then = p.then.bind(p);
      vi.spyOn(p, "then").mockImplementation((ok, bad) => {
        const next = then(ok, bad);
        rethrown.push(next.then(() => null, (e: unknown) => e));
        return next;
      });
      return p;
    };
    const calls: string[] = [];
    const session = (x: string): Promise<PlanSession> => {
      calls.push(x);
      return calls.length === 1 ? failing() : Promise.resolve(t.session);
    };
    const { ui } = shellFor(t, { session });
    render(withSync(ui));
    await settle();
    expect(screen.getByText("boom").closest(".banner")?.classList.contains("bad")).toBe(true);
    expectNoTimeline();
    expect(await Promise.all(rethrown)).toEqual([boom]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(calls).toEqual([t.session.view().plan.id, t.session.view().plan.id]);
    expectTimeline();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("shows a recorded failure of a loaded plan that did not open", async () => {
    const t = await made(MESA_SEED);
    const id = t.session.view().plan.id;
    const failure = new AppError("store.io", "Could not read the plan: disk error.");
    const retryPlan = vi.fn(async () => undefined);
    const { ui } = shellFor(t, { failures: () => new Map([[id, failure]]), session: () => Promise.reject(failure), retryPlan });
    render(withSync(ui));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).getByText("Could not read the plan: disk error.")).toBeTruthy();
    expectNoTimeline();
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(retryPlan.mock.calls).toEqual([[id]]);
  });
});

describe("Shell on Registry.open", () => {
  it("renders a failed plan with Try again until it loads", async () => {
    const s = await store(["Alpha", "Beta"]);
    s.mem.fail("store_load", s.ids[1], { code: "store.io", message: "Could not read the plan: disk error." });
    const registry = await opened();
    await registry.warm();
    render(withSync(shellOn(registry)));
    await settle();
    const beta = entry("Beta");
    expect(within(beta).getByText("Could not read the plan: disk error.").className).toBe("entry-bad");
    expect(within(beta).queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(within(beta).getByRole("button", { name: "Beta" }));
    await settle();
    expectNoTimeline();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).getByText("Could not read the plan: disk error.").classList.contains("bad")).toBe(true);
    const retryPlan = vi.spyOn(registry, "retryPlan");
    s.mem.recover("store_load", s.ids[1]);
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await settle();
    expect(retryPlan.mock.calls).toEqual([[s.ids[1]]]);
    expectTimeline();
    expect(document.querySelector(".plan-failed")).toBeNull();
  });

  it.each([
    ["store.locked", "This plan is open in another WebBoard process; close it there first."],
    ["ipc.shape", "store_load: expected raw bytes."],
  ])("offers Try again for %s", async (code, message) => {
    const s = await store(["Alpha", "Beta"]);
    s.mem.fail("store_load", s.ids[1], { code, message });
    const registry = await opened();
    await registry.warm();
    render(withSync(shellOn(registry)));
    await settle();
    fireEvent.click(within(entry("Beta")).getByRole("button", { name: "Beta" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).getByText(message)).toBeTruthy();
    const retryPlan = vi.spyOn(registry, "retryPlan").mockResolvedValue(undefined);
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(retryPlan.mock.calls).toEqual([[s.ids[1]]]);
    expect(within(failed).queryByRole("button", { name: "Move to Trash" })).toBeNull();
    expect(within(failed).queryByRole("button", { name: RELOAD })).toBeNull();
  });

  it("offers Move to Trash for a damaged local plan", async () => {
    const s = await store(["Alpha", "Beta"]);
    s.mem.fail("store_load", s.ids[1], { code: "store.corrupt", message: "The plan file is damaged at record 12." });
    const registry = await opened();
    await registry.warm();
    render(withSync(shellOn(registry)));
    await settle();
    fireEvent.click(within(entry("Beta")).getByRole("button", { name: "Beta" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(failed).queryByRole("button", { name: RELOAD })).toBeNull();
    expect(within(failed).getByText(FILES_STAY)).toBeTruthy();
    const trashPlan = vi.spyOn(registry, "trashPlan");
    fireEvent.click(within(failed).getByRole("button", { name: "Move to Trash" }));
    expect(trashPlan.mock.calls).toEqual([[s.ids[1]]]);
    expect(toastTexts()).toEqual(["Moved “Beta” to the Trash. Restore it from the Trash."]);
  });

  it("offers Load again from the server for a damaged space plan", async () => {
    const s = await store(["Alpha", "Beta", "Gamma"]);
    const p3 = s.ids[2];
    s.mem.fail("store_load", p3, { code: "store.corrupt", message: "The plan file is damaged at record 12." });
    const registry = await opened();
    await registry.warm();
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().map((l) => (l.id === p3 ? { ...l, space: "sp000000000" } : l)));
    const reload = vi.spyOn(registry, "reloadFromServer").mockResolvedValue(undefined);
    const trashPlan = vi.spyOn(registry, "trashPlan");
    render(withSync(shellOn(registry), { connected: true }));
    await settle();
    fireEvent.click(within(entry("Gamma")).getByRole("button", { name: "Gamma" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).queryByRole("button", { name: "Move to Trash" })).toBeNull();
    fireEvent.click(within(failed).getByRole("button", { name: RELOAD }));
    const dialog = screen.getByRole("dialog", { name: RELOAD });
    expect(within(dialog).getByText(RELOAD_TEXT)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(within(failed).getByRole("button", { name: RELOAD }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Load again" }));
    await settle();
    expect(reload.mock.calls).toEqual([[p3]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trashPlan).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when Load again fails", async () => {
    const s = await store(["Alpha", "Gamma"]);
    const p3 = s.ids[1];
    s.mem.fail("store_load", p3, { code: "store.corrupt", message: "The plan file is damaged at record 12." });
    const registry = await opened();
    await registry.warm();
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().map((l) => (l.id === p3 ? { ...l, space: "sp000000000" } : l)));
    const reload = vi
      .spyOn(registry, "reloadFromServer")
      .mockRejectedValueOnce(new AppError("store.io", "Could not set the plan aside: disk full."))
      .mockResolvedValue(undefined);
    render(withSync(shellOn(registry), { connected: true }));
    await settle();
    fireEvent.click(within(entry("Gamma")).getByRole("button", { name: "Gamma" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    fireEvent.click(within(failed).getByRole("button", { name: RELOAD }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Load again" }));
    await settle();
    expect(toastNodes().map((n) => [n.textContent, n.className])).toEqual([["Could not set the plan aside: disk full.", "toast bad"]]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.querySelector(".plan-failed")).not.toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Load again" }));
    await settle();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a damaged space plan's files while read-only", async () => {
    const s = await store(["Alpha", "Gamma"]);
    const p3 = s.ids[1];
    s.mem.fail("store_load", p3, { code: "store.corrupt", message: "The plan file is damaged at record 12." });
    const registry = await opened();
    await registry.warm();
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().map((l) => (l.id === p3 ? { ...l, space: "sp000000000" } : l)));
    vi.spyOn(registry, "spaceReadOnly").mockReturnValue(true);
    const reload = vi.spyOn(registry, "reloadFromServer");
    const trashPlan = vi.spyOn(registry, "trashPlan");
    render(withSync(shellOn(registry)));
    await settle();
    fireEvent.click(within(entry("Gamma")).getByRole("button", { name: "Gamma" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).getByText("The plan file is damaged at record 12.")).toBeTruthy();
    expect(within(failed).getByText(FILES_STAY)).toBeTruthy();
    expect(within(failed).queryByRole("button")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(trashPlan).not.toHaveBeenCalled();
  });

  it("disables trash and restore of space plans while read-only", async () => {
    const s = await store(["Alpha", "Gamma", "Delta"], { trash: [2] });
    const [p1, p3, p4] = s.ids;
    const registry = await opened();
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().map((l) => (l.id === p3 || l.id === p4 ? { ...l, space: "sp000000000" } : l)));
    vi.spyOn(registry, "spaceReadOnly").mockReturnValue(true);
    const trashPlan = vi.spyOn(registry, "trashPlan");
    render(withSync(shellOn(registry)));
    await settle();
    const gamma = within(entry("Gamma")).getByRole("button", { name: "Move to Trash" });
    expect(gamma.hasAttribute("disabled")).toBe(true);
    fireEvent.click(gamma);
    expect(trashPlan).not.toHaveBeenCalled();
    expect(within(entry("Alpha")).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(false);
    const section = trashSection();
    if (section === null) throw new Error("no Trash section");
    expect(within(section).getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(true);
    expect(p1).not.toBe(p4);
  });

  it("puts a loaded plan's store error in the banner once it is selected", async () => {
    const s = await store(["Alpha", "Beta"]);
    const [p1, p2] = s.ids;
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: p2 }));
    const registry = await opened();
    await registry.session(p1);
    let failures: ReadonlyMap<PlanId, AppError> = new Map([[p1, new AppError("store.io", "Could not save the plan: disk full.")]]);
    vi.spyOn(registry, "failures").mockImplementation(() => failures);
    const retryPlan = vi.spyOn(registry, "retryPlan").mockResolvedValue(undefined);
    const notify = notifier(registry);
    render(withSync(shellOn(registry)));
    await settle();
    expect(currentName()).toBe("Beta");
    const alpha = entry("Alpha");
    expect(within(alpha).getByText("Could not save the plan: disk full.").className).toBe("entry-bad");
    fireEvent.click(within(alpha).getByRole("button", { name: "Try again" }));
    expect(retryPlan.mock.calls).toEqual([[p1]]);
    fireEvent.click(within(alpha).getByRole("button", { name: "Alpha" }));
    await settle();
    expectTimeline();
    expect(document.querySelector(".plan-failed")).toBeNull();
    expect(screen.getAllByText("Could not save the plan: disk full.")).toHaveLength(1);
    expect(screen.getByText("Could not save the plan: disk full.").closest(".banner")).not.toBeNull();
    failures = new Map();
    act(() => notify());
    expect(screen.queryByText("Could not save the plan: disk full.")).toBeNull();
  });

  it("starts empty with New plan, then creates and opens one", async () => {
    resetTauri({ ...memoryStore().answers, settings_read: offeredSettings, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: "macos" }) });
    const registry = await opened();
    const createPlan = vi.spyOn(registry, "createPlan");
    render(withSync(shellOn(registry)));
    await settle();
    expectNoTimeline();
    expect(screen.queryAllByRole("tab")).toEqual([]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    const bar = document.querySelector("header.toolbar");
    if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
    expect(within(bar).getByRole("button", { name: "⌘K" })).toBeTruthy();
    expect(within(bar).getByText("Local only")).toBeTruthy();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    fireEvent.click(within(main).getByRole("button", { name: "New plan" }));
    await settle();
    expect(createPlan.mock.calls).toEqual([["New plan"]]);
    expect(tauri.calls.filter((c) => c.cmd === "holidays_year")).toEqual([]);
    expect(currentName()).toBe("New plan");
    expectTimeline();
    expect(slot("timeline")?.textContent).toBe("No items yet. Add one with + New.");
    const panelSlot = slot("panel");
    if (!(panelSlot instanceof HTMLElement)) throw new Error("no panel");
    expect(within(panelSlot).queryByLabelText("Plan name")).toBeNull();
    const name = document.querySelector('.plan-head input[aria-label="Plan name"]');
    if (!(name instanceof HTMLInputElement)) throw new Error("no Plan name field in the heading");
    expect([document.activeElement === name, name.selectionStart, name.selectionEnd]).toEqual([true, 0, "New plan".length]);
    act(() => {
      fireEvent.change(name, { target: { value: "Launch" } });
    });
    act(() => {
      fireEvent.keyDown(name, { key: "Enter" });
    });
    await settle();
    expect([currentName(), document.activeElement === name]).toEqual(["Launch", false]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    await settle();
    expect([currentName(), name.value]).toEqual(["New plan", "New plan"]);
  });

  it("focuses nothing in the panel when an existing plan opens", async () => {
    await store(["Alpha"], { lastRegion: ZH });
    const registry = await opened();
    render(withSync(shellOn(registry)));
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  const runPalette = (query: string): void => {
    act(() => {
      fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    });
    const input = within(screen.getByRole("dialog", { name: "Command palette" })).getByRole("textbox", { name: "Command" });
    act(() => {
      fireEvent.change(input, { target: { value: query } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
  };

  it.each(["the empty state's button", "the palette"])("creates the example plan from %s and opens it", async (from) => {
    resetTauri({ ...memoryStore().answers, settings_read: offeredSettings, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: "macos" }) });
    const registry = await opened();
    const createExample = vi.spyOn(registry, "createExample");
    render(withSync(shellOn(registry)));
    await settle();
    expectNoTimeline();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    if (from === "the palette") runPalette("Create the example plan");
    else fireEvent.click(within(main).getByRole("button", { name: "Show an example plan" }));
    await settle();
    expect(createExample).toHaveBeenCalledTimes(1);
    expect(currentName()).toBe("Example: Website relaunch");
    expectTimeline();
    expect(registry.plans().map((l) => [l.name, l.trashed, l.space])).toEqual([["Example: Website relaunch", false, null]]);
    expect(within(main).queryByRole("button", { name: "Show an example plan" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the palette's Create the example plan opens a fresh example while a plan is open", async () => {
    resetTauri({ ...memoryStore().answers, settings_read: offeredSettings, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: "macos" }) });
    const registry = await opened();
    const first = await registry.createPlan("Alpha");
    render(withSync(shellOn(registry)));
    await settle();
    expect(currentName()).toBe("Alpha");
    runPalette("Create the example plan");
    await settle();
    expect(currentName()).toBe("Example: Website relaunch");
    const ids = registry.plans().map((l) => l.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(first);
    runPalette("Create the example plan");
    await settle();
    const after = registry.plans();
    expect(after.map((l) => l.name)).toEqual(["Alpha", "Example: Website relaunch", "Example: Website relaunch"]);
    const nav = screen.getByRole("navigation", { name: "Plans" });
    const current = nav.querySelector('[aria-current="page"]');
    expect(current?.textContent).toBe("Example: Website relaunch");
    expect(after.filter((l) => l.space !== null)).toEqual([]);
  });

  it.each(["the empty state's button", "the palette"])("imports a plan from %s and opens it", async (from) => {
    resetTauri({ ...memoryStore().answers, settings_read: offeredSettings, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: "macos" }) });
    const registry = await opened();
    vi.mocked(importPlan).mockImplementationOnce(async (r) => ({ planId: await r.createPlan("MESA 2027"), converted: null }));
    render(withSync(shellOn(registry)));
    await settle();
    expectNoTimeline();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getAllByRole("button").map((b) => b.textContent)).toEqual(["New plan", "Show an example plan", "Import plan…", "Join with a code", "Set up sync"]);
    if (from === "the palette") {
      act(() => {
        fireEvent.keyDown(document.body, { key: "k", metaKey: true });
      });
      const input = within(screen.getByRole("dialog", { name: "Command palette" })).getByRole("textbox", { name: "Command" });
      act(() => {
        fireEvent.change(input, { target: { value: "Import" } });
      });
      act(() => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
    } else {
      fireEvent.click(within(main).getByRole("button", { name: "Import plan…" }));
    }
    await settle();
    expect(importFlow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(importPlan).mock.calls).toEqual([[registry, showConverted]]);
    expect(currentName()).toBe("MESA 2027");
    expectTimeline();
    expect(toastTexts()).toEqual(["Imported “MESA 2027”"]);
    expect(within(main).queryByRole("button", { name: "New plan" })).toBeNull();
    expect(within(main).queryByRole("button", { name: "Import plan…" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the .gantt conversion report before it opens the imported plan", async () => {
    resetTauri({ ...memoryStore().answers, settings_read: offeredSettings, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: "macos" }) });
    const registry = await opened();
    const report = { fileName: "Fixture Plan 20260901.gantt", name: "MESA 2027", counts: { groups: 1, tasks: 2, milestones: 1, links: 2, notes: 1 }, dropped: ["TaskID on 4 items"] };
    vi.mocked(importPlan).mockImplementationOnce(async (r, review) => {
      await review(report);
      return { planId: await r.createPlan("MESA 2027"), converted: report };
    });
    render(withSync(shellOn(registry)));
    await settle();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    fireEvent.click(within(main).getByRole("button", { name: "Import plan…" }));
    await settle();
    const dialog = screen.getByRole("dialog", { name: CONVERTED_TITLE });
    expect(within(dialog).getByText("Plan “MESA 2027” from Fixture Plan 20260901.gantt")).toBeTruthy();
    expect(within(dialog).getByText("TaskID on 4 items")).toBeTruthy();
    expect(toastTexts()).toEqual([]);
    expectNoTimeline();
    expect(registry.plans().map((p) => p.name)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: OPEN_PLAN }));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(currentName()).toBe("MESA 2027");
    expectTimeline();
    expect(toastTexts()).toEqual(["Imported “MESA 2027”"]);
  });

  it.each(["cancel", "AppError"])("shows Importing… on the empty state's Import plan… until an import ending in %s settles", async (end) => {
    resetTauri({ ...memoryStore().answers, settings_read: offeredSettings, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: "macos" }) });
    const registry = await opened();
    const pending = deferred<Imported | null>();
    vi.mocked(importPlan).mockReturnValueOnce(pending.promise);
    render(withSync(shellOn(registry)));
    await settle();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    fireEvent.click(within(main).getByRole("button", { name: "Import plan…" }));
    await settle();
    const busy = within(main).getByRole("button", { name: "Importing…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(busy.querySelector(".dim")?.textContent).toBe("Importing…");
    fireEvent.click(busy);
    expect(importPlan).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (end === "cancel") pending.resolve(null);
      else pending.reject(new AppError("import.foreign", "This file is not a WebBoard plan."));
    });
    await settle();
    const idle = within(main).getByRole("button", { name: "Import plan…" });
    expect(idle.hasAttribute("disabled")).toBe(false);
    expect(within(main).queryByRole("button", { name: "Importing…" })).toBeNull();
    expect(toastTexts()).toEqual(end === "cancel" ? [] : ["This file is not a WebBoard plan."]);
  });

  it("opens the plan the ⋯ menu's import names through the rail's selection", async () => {
    const s = await store(["Alpha", "Beta"], { lastRegion: ZH });
    const registry = await opened();
    render(withSync(shellOn(registry)));
    await settle();
    expect(currentName()).toBe("Alpha");
    vi.mocked(importFlow).mockResolvedValueOnce(undefined);
    fireEvent.click(menuToggle());
    fireEvent.click(within(screen.getByRole("menu", { name: "Plan" })).getByRole("menuitem", { name: "Import plan…" }));
    const calls = vi.mocked(importFlow).mock.calls;
    expect(calls.map((c) => c[0])).toEqual([registry]);
    act(() => calls[0][1](s.ids[1]));
    await settle();
    expect(currentName()).toBe("Beta");
    expect(slot("timeline")).not.toBeNull();
  });

  it.each(["empty state", "sidebar"])("shows Creating… while a plan is created from the %s", async (from) => {
    await store(from === "sidebar" ? ["Alpha"] : [], { lastRegion: ZH });
    const registry = await opened();
    const createPlan = vi.spyOn(registry, "createPlan");
    render(withSync(shellOn(registry)));
    await settle();
    const held = hold("holidays_year");
    const nav = screen.getByRole("navigation", { name: "Plans" });
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    fireEvent.click(from === "sidebar" ? newPlanIn(nav) : within(main).getByRole("button", { name: "New plan" }));
    await settle();
    const creating = screen.getAllByRole("button", { name: "Creating…" });
    expect(creating).toHaveLength(from === "sidebar" ? 1 : 2);
    creating.forEach((b) => {
      expect(b.hasAttribute("disabled")).toBe(true);
      expect(b.querySelector(".dim")?.textContent).toBe("Creating…");
    });
    creating.forEach((b) => fireEvent.click(b));
    expect(createPlan).toHaveBeenCalledTimes(1);
    await act(async () => {
      held.resolve({ days: [], fetchedAt: "2026-11-09T08:00:00Z", fromCache: false, coverage: [2020, 2030] });
    });
    await settle();
    expect(screen.queryAllByRole("button", { name: "Creating…" })).toEqual([]);
    expect(currentName()).toBe("New plan");
  });

  it("creates, trashes and restores plans", async () => {
    const s = await store(["Alpha", "Beta"], { lastRegion: ZH });
    const registry = await opened();
    const from = tauri.calls.length;
    render(withSync(shellOn(registry)));
    await settle();
    expect(currentName()).toBe("Alpha");
    const nav = screen.getByRole("navigation", { name: "Plans" });
    fireEvent.click(newPlanIn(nav));
    await settle();
    await settle();
    const localAppends = tauri.calls.slice(from).filter((c) => c.cmd === "store_append" && xdoc(c) === "local");
    expect(localAppends).toHaveLength(1);
    expect(currentName()).toBe("New plan");
    const created = registry.plans().find((l) => !s.ids.includes(l.id));
    if (created === undefined) throw new Error("no new plan");
    const session = await registry.session(created.id);
    expect(session.view().plan.calendar.region).toEqual(ZH);

    fireEvent.click(within(entry("Alpha")).getByRole("button", { name: "Alpha" }));
    await settle();
    vi.spyOn(registry, "createPlan").mockRejectedValueOnce(new AppError("store.io", "Could not save the plan: disk full."));
    fireEvent.click(newPlanIn(nav));
    await settle();
    expect(toastNodes().filter((n) => n.textContent === "Could not save the plan: disk full.").map((n) => n.className)).toEqual(["toast bad"]);
    expect(registry.plans()).toHaveLength(3);
    expect(currentName()).toBe("Alpha");

    clearToasts();
    const trashPlan = vi.spyOn(registry, "trashPlan");
    const restorePlan = vi.spyOn(registry, "restorePlan");
    fireEvent.click(within(entry("Alpha")).getByRole("button", { name: "Move to Trash" }));
    expect(trashPlan.mock.calls).toEqual([[s.ids[0]]]);
    expect(toastTexts()).toEqual(["Moved “Alpha” to the Trash. Restore it from the Trash."]);
    const section = trashSection();
    if (section === null) throw new Error("no Trash section");
    expect(within(section).getByText("Alpha")).toBeTruthy();
    await settle();
    expect(currentName()).toBe("Beta");
    clearToasts();
    fireEvent.click(within(section).getByRole("button", { name: "Restore" }));
    expect(restorePlan.mock.calls).toEqual([[s.ids[0]]]);
    expect(toastTexts()).toEqual(["Restored “Alpha” from the Trash."]);
    expect(trashSection()).toBeNull();
    expect(within(nav).getByText("Alpha")).toBeTruthy();
  });

  it("moves the open plan to the Trash from Settings › Danger zone, closing Settings first", async () => {
    const s = await store(["Alpha", "Beta"]);
    const registry = await opened();
    render(withSync(shellOn(registry)));
    await settle();
    expect(currentName()).toBe("Alpha");
    const trashPlan = vi.spyOn(registry, "trashPlan");
    const bar = document.querySelector("header.toolbar");
    if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
    fireEvent.click(within(bar).getByRole("button", { name: "Settings" }));
    const modal = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-settings-modal]");
    const open = modal();
    if (open === null) throw new Error("no Settings modal");
    fireEvent.click(within(within(open).getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Danger zone" }));
    expect(within(open).getByText("Moves “Alpha” to the Trash. Restore it from the plan list's Trash.")).toBeTruthy();
    clearToasts();
    fireEvent.click(within(open).getByRole("button", { name: "Move to Trash" }));
    expect([modal(), lastUi().settings, trashPlan.mock.calls]).toEqual([null, null, [[s.ids[0]]]]);
    expect(toastTexts()).toEqual(["Moved “Alpha” to the Trash. Restore it from the Trash."]);
    await settle();
    expect([currentName(), modal()]).toEqual(["Beta", null]);
  });

  it("disables Settings' Move to Trash for a space plan while the space is read-only", async () => {
    const s = await store(["Alpha", "Beta"]);
    const registry = await opened();
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().map((l) => (l.id === s.ids[0] ? { ...l, space: "sp000000000" } : l)));
    vi.spyOn(registry, "spaceReadOnly").mockReturnValue(true);
    render(withSync(shellOn(registry)));
    await settle();
    expect(currentName()).toBe("Alpha");
    act(() => {
      fireEvent.keyDown(document.body, { key: ",", code: "Comma", metaKey: true });
    });
    const open = document.querySelector<HTMLElement>("[data-settings-modal]");
    if (open === null) throw new Error("no Settings modal");
    fireEvent.click(within(within(open).getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Danger zone" }));
    expect(within(open).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(true);
  });

  it("falls to the empty state when the last plan is trashed", async () => {
    await store(["Alpha"]);
    const registry = await opened();
    render(withSync(shellOn(registry)));
    await settle();
    fireEvent.click(within(entry("Alpha")).getByRole("button", { name: "Move to Trash" }));
    await settle();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getByRole("button", { name: "New plan" })).toBeTruthy();
    expect(screen.getByText("Local only")).toBeTruthy();
    expectNoTimeline();
    expect(slot("panel")).toBeNull();
  });

  async function remoteTrash(names: readonly string[]): Promise<{ registry: Registry; trashPlan: ReturnType<typeof vi.spyOn> }> {
    const s = await store(names);
    const registry = await opened();
    const trashPlan = vi.spyOn(registry, "trashPlan");
    render(withSync(shellOn(registry)));
    await settle();
    expect(currentName()).toBe("Alpha");
    const local = await registry.doc("local");
    const r = new Y.Doc();
    Y.applyUpdate(r, Y.encodeStateAsUpdate(local.ydoc));
    const persist = async (id: string): Promise<PersistedDoc> => memoryDoc(id, r);
    const ix = await IndexDoc.open("local", "iphone", persist);
    ix.trashPlan(s.ids[0]);
    act(() => {
      Y.applyUpdate(local.ydoc, Y.encodeStateAsUpdate(r, Y.encodeStateVector(local.ydoc)));
    });
    await settle();
    await ix.close();
    return { registry, trashPlan };
  }

  it("follows a trash from another device", async () => {
    const { trashPlan } = await remoteTrash(["Alpha", "Beta"]);
    expect(currentName()).toBe("Beta");
    const section = trashSection();
    if (section === null) throw new Error("no Trash section");
    expect(within(section).getByText("Alpha")).toBeTruthy();
    expect(toastTexts()).toEqual(["“Alpha” was moved to the Trash on another device. Restore it from the Trash."]);
    expect(trashPlan).not.toHaveBeenCalled();
  });

  it("falls to the empty state when another device trashes the only plan", async () => {
    await remoteTrash(["Alpha"]);
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getByRole("button", { name: "New plan" })).toBeTruthy();
    expect(screen.getByText("Local only")).toBeTruthy();
    expectNoTimeline();
  });

  it("toasts only its own message for a local trash", async () => {
    await store(["Alpha", "Beta"]);
    const registry = await opened();
    render(withSync(shellOn(registry)));
    await settle();
    fireEvent.click(within(entry("Alpha")).getByRole("button", { name: "Move to Trash" }));
    await settle();
    expect(toastTexts()).toEqual(["Moved “Alpha” to the Trash. Restore it from the Trash."]);
  });
});

describe("selection rule", () => {
  const listing = (id: string, trashed: boolean) => ({ id, name: id, trashed, loaded: false, space: null, example: false });

  it("picks a listed untrashed plan", () => {
    const plans = [listing("p1", true), listing("p2", false), listing("p3", false)];
    expect(pickPlan(plans, null)).toBe("p2");
    expect(pickPlan(plans, "zz000000000")).toBe("p2");
    expect(pickPlan(plans, "p1")).toBe("p2");
    expect(pickPlan(plans, "p3")).toBe("p3");
    expect(pickPlan([listing("p1", true), listing("p2", true), listing("p3", true)], "p2")).toBeNull();
  });

  it.each([{ view: "list" }, { view: "list", plan: "zz000000000" }, { view: "list", plan: "first" }])("opens Beta from %o", async (place) => {
    const s = await store(["Alpha", "Beta", "Gamma"], { trash: [0] });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place.plan === "first" ? { ...place, plan: s.ids[0] } : place));
    const registry = await opened();
    render(withSync(shellOn(registry)));
    await settle();
    expect(currentName()).toBe("Beta");
    expect(slot("list")).not.toBeNull();
  });

  it("opens nothing when every plan is trashed", async () => {
    const s = await store(["Alpha", "Beta", "Gamma"], { trash: [0, 1, 2] });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: s.ids[1] }));
    const registry = await opened();
    const session = vi.spyOn(registry, "session");
    render(withSync(shellOn(registry)));
    await settle();
    expect(session).not.toHaveBeenCalled();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getByRole("button", { name: "New plan" })).toBeTruthy();
  });

  it("opens nothing after Open without the last plan, even when that plan is the only one, until a plan is picked", async () => {
    const s = await store(["Alpha"]);
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: s.ids[0], view: "timeline", zoom: "W", collapsed: [] }));
    forgetLastPlan();
    const registry = await opened();
    const notify = notifier(registry);
    const session = vi.spyOn(registry, "session");
    render(withSync(shellOn(registry)));
    await settle();
    act(() => notify());
    await settle();
    expect(session).not.toHaveBeenCalled();
    expect(currentName()).toBeNull();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getByRole("button", { name: "New plan" })).toBeTruthy();
    const open = entry("Alpha").querySelector(".entry-open");
    if (!(open instanceof HTMLElement)) throw new Error("no entry-open");
    fireEvent.click(open);
    await settle();
    expect(currentName()).toBe("Alpha");
    expect(session).toHaveBeenCalledWith(s.ids[0]);
    expect(window.localStorage.getItem(NO_PLAN_KEY)).toBeNull();
  });

  it("moves on when the selected plan leaves the list", async () => {
    const s = await store(["Alpha", "Beta", "Gamma"], { trash: [0] });
    const registry = await opened();
    const notify = notifier(registry);
    render(withSync(shellOn(registry)));
    await settle();
    expect(currentName()).toBe("Beta");
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().filter((l) => l.id !== s.ids[1]));
    act(() => notify());
    await settle();
    expect(currentName()).toBe("Gamma");
  });

  it("keeps a plan that is still arriving", async () => {
    const s = await store(["Alpha", "Beta", "Gamma"], { trash: [0] });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: s.ids[1] }));
    const registry = await opened();
    vi.spyOn(registry, "session").mockRejectedValue(new AppError("plan.incomplete", INCOMPLETE));
    const notify = notifier(registry);
    render(withSync(shellOn(registry)));
    await settle();
    act(() => notify());
    await settle();
    act(() => notify());
    await settle();
    expect(currentName()).toBe("Beta");
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
  });
});

describe("the panel slot", () => {
  const shown = async (t: TestSession): Promise<void> => {
    render(withSync(shellFor(t).ui));
    await settle();
  };
  const uiNow = (): [UiState, (patch: Partial<UiState>) => void] => {
    const results = vi.mocked(useUi).mock.results;
    const r = results[results.length - 1];
    if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
    return r.value;
  };
  const select = (id: string | null): void => act(() => uiNow()[1]({ selected: id }));
  const panel = (): HTMLElement => {
    const el = slot("panel");
    if (!(el instanceof HTMLElement)) throw new Error("no panel slot");
    return el;
  };
  const inPanel = () => within(panel());
  const input = (label: string): HTMLInputElement => {
    const el = inPanel().getByLabelText(label);
    if (!(el instanceof HTMLInputElement)) throw new Error(label + " is not an input");
    return el;
  };
  const planShown = (): void => {
    expect(document.querySelector(".slot-panel .panel h2")?.textContent).toBe("Plan");
  };
  const button = (name: string): HTMLElement => inPanel().getByRole("button", { name });
  const click = (el: Element): void => {
    act(() => {
      fireEvent.click(el);
    });
  };

  it("a newer plan closes every editing path", async () => {
    const t = await made(MESA_SEED, { raw: { x1: ["iphone", "s1", 0, [], 42, []] } });
    expect(t.session.readOnlyReason).toBe(NEWER_PLAN);
    await shown(t);
    const count = t.session.view().plan.items.size;
    expect(document.querySelector(".plan-head .forward-lock")?.textContent).toBe(NEWER_PLAN);
    const bar = document.querySelector(".toolbar");
    if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
    expect(["+ New", "Undo", "Redo"].map((name) => within(bar).getByRole("button", { name }).hasAttribute("disabled"))).toEqual([true, true, true]);
    expect(screen.queryByRole("textbox", { name: "Plan name" })).toBeNull();
    expect(screen.getByLabelText("Plan name").tagName).toBe("SPAN");
    act(() => {
      fireEvent.keyDown(document.body, { key: "n" });
    });
    expect(toastTexts()).toEqual([NEWER_PLAN]);
    expect(t.session.view().plan.items.size).toBe(count);
    select("t3");
    expect(panel().querySelectorAll("input, select")).toHaveLength(0);
    expect(inPanel().queryByRole("button", { name: "Delete" })).toBeNull();
    expect(inPanel().queryByRole("button", { name: "Move to Trash" })).toBeNull();
    act(() => {
      fireEvent.keyDown(document.body, { key: "Delete" });
    });
    expect(toastTexts()).toEqual([NEWER_PLAN, NEWER_PLAN]);
    expect(t.session.view().plan.items.get("t3")?.trashed).toBe(false);
    expect(document.querySelectorAll(".nub")).toHaveLength(0);
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    const cards = [...document.querySelectorAll<HTMLElement>("[data-card]")];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((c) => c.draggable)).toEqual([]);
  });

  it("drops nubs, handles and panel fields when the session turns read-only, and brings the nubs back", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    select("t3");
    expect(document.querySelectorAll(".nub").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".h").length).toBeGreaterThan(0);
    expect(panel().querySelectorAll("input, select").length).toBeGreaterThan(0);
    act(() => t.session.setReadOnly(true));
    expect(document.querySelectorAll(".nub")).toHaveLength(0);
    expect(document.querySelectorAll(".h")).toHaveLength(0);
    expect(panel().querySelectorAll("input, select")).toHaveLength(0);
    act(() => t.session.setReadOnly(false));
    expect(document.querySelectorAll(".nub").length).toBeGreaterThan(0);
  });

  describe("stale selection", () => {
    const SEED: SeedItem[] = [{ name: "A", start: "2026-11-10", dur: 3 }];

    it("lets go of a selected item the open plan no longer holds, and shows the plan", async () => {
      const t = await made(SEED);
      await shown(t);
      act(() => {
        t.session.apply({ t: "create", kind: "task", name: "New", parent: null, after: "A", start: "2026-11-12", dur: 1 });
      });
      const created = [...t.session.view().plan.items.keys()].find((id) => id !== "A");
      if (created === undefined) throw new Error("create added no item");
      select(created);
      expect(input("Name").value).toBe("New");
      clearToasts();
      act(() => {
        t.session.undo();
      });
      expect(t.session.view().plan.items.has(created)).toBe(false);
      expect(uiNow()[0].selected).toBeNull();
      planShown();
      expect(toastTexts().filter((x) => x !== null && /Trash/.test(x))).toEqual([]);
    });

    it("lets go of a selection that names no item of the open plan, without a toast", async () => {
      const t = await made(SEED);
      await shown(t);
      select("A");
      select("gone");
      expect(uiNow()[0].selected).toBeNull();
      planShown();
      expect(toastTexts()).toEqual([]);
    });

    it("keeps the selection when the open plan is picked again and drops it on a switch to another plan", async () => {
      const t = await made(SEED);
      const id = t.session.view().plan.id;
      const plans = () => [
        { id, name: "Plan", trashed: false, loaded: true, space: null, example: false },
        { id: "other", name: "Other", trashed: false, loaded: true, space: null, example: false },
      ];
      const session = (x: string): Promise<PlanSession> => (x === id ? Promise.resolve(t.session) : new Promise<PlanSession>(() => undefined));
      render(withSync(shellFor(t, { plans, session }).ui));
      await settle();
      expect(uiNow()[0].plan).toBe(id);
      select("A");
      click(within(entry("Plan")).getByRole("button", { name: "Plan" }));
      await settle();
      expect(uiNow()[0].plan).toBe(id);
      expect(uiNow()[0].selected).toBe("A");
      expect(input("Name").value).toBe("A");
      click(within(entry("Other")).getByRole("button", { name: "Other" }));
      expect(uiNow()[0].plan).toBe("other");
      expect(uiNow()[0].selected).toBeNull();
    });
  });

  describe("trashed selection (refinement 41)", () => {
    const SEED: SeedItem[] = [
      { name: "A", start: "2026-11-10", dur: 3 },
      { name: "B", start: "2026-11-16", dur: 2 },
    ];
    const remote = /was moved to the Trash on/;

    it("lets go of an item this device trashed, with only the trash's toast", async () => {
      const t = await made(SEED);
      await shown(t);
      select("A");
      const apply = vi.spyOn(t.session, "apply");
      click(button("Delete"));
      expect(t.session.authorOf("e:A")).toEqual({ dev: "mac", device: "Mac" });
      expect(uiNow()[0].selected).toBeNull();
      planShown();
      const done = apply.mock.results[0];
      if (done === undefined || done.type !== "return") throw new Error("Delete did not apply");
      expect(toastTexts()).toEqual([done.value.toast]);
      expect(toastTexts().filter((x) => x !== null && remote.test(x))).toEqual([]);
    });

    it("lets go of an item another device trashed, and says so", async () => {
      const t = await made(SEED);
      await shown(t);
      select("A");
      const p = await t.peer("iphone");
      sessions.push(p.session);
      act(() => {
        p.session.apply({ t: "trash", items: ["A"] });
        p.sync();
      });
      expect(t.session.authorOf("e:A")).toEqual({ dev: "iphone", device: "iPhone" });
      expect(uiNow()[0].selected).toBeNull();
      expect(toastTexts()).toEqual(["“A” was moved to the Trash on iPhone. Restore it from the Trash."]);
    });

    const NEW_X = { t: "create", kind: "task", name: "W", parent: null, after: "A", start: "2026-11-12", dur: 1 } as const;
    const createdX = (t: TestSession): string => {
      const x = [...t.session.view().plan.items.values()].find((it) => it.name === "W");
      if (x === undefined) throw new Error("no item W");
      return x.id;
    };

    it("lets go of an item another device's undo moved to the Trash, and names that device", async () => {
      const t = await made(SEED);
      await shown(t);
      const p = await t.peer("iphone");
      sessions.push(p.session);
      act(() => {
        p.session.apply(NEW_X);
        p.sync();
      });
      const x = createdX(t);
      select(x);
      act(() => {
        t.session.apply({ t: "rename", item: x, name: "X" });
        p.sync();
      });
      clearToasts();
      act(() => {
        p.session.undo();
        p.sync();
      });
      expect(t.session.view().plan.items.get(x)?.trashed).toBe(true);
      expect(t.session.authorOf("e:" + x)).toBeNull();
      expect(t.session.trashAuthorOf(x)).toEqual({ dev: "iphone", device: "iPhone" });
      expect(uiNow()[0].selected).toBeNull();
      expect(toastTexts()).toEqual(["“X” was moved to the Trash on iPhone. Restore it from the Trash."]);
    });

    it("lets go of an item its own undo moved to the Trash, with only the undo's toast", async () => {
      const t = await made(SEED);
      await shown(t);
      act(() => {
        t.session.apply(NEW_X);
      });
      const x = createdX(t);
      const p = await t.peer("iphone");
      sessions.push(p.session);
      select(x);
      act(() => {
        p.session.apply({ t: "rename", item: x, name: "X" });
        p.sync();
      });
      clearToasts();
      const undo = vi.spyOn(t.session, "undo");
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      const done = undo.mock.results[0];
      if (done === undefined || done.type !== "return" || done.value === null) throw new Error("Undo did not apply");
      expect(t.session.view().plan.items.get(x)?.trashed).toBe(true);
      expect(t.session.trashAuthorOf(x)).toEqual({ dev: "mac", device: "Mac" });
      expect(uiNow()[0].selected).toBeNull();
      expect(done.value.toast).toContain("“X” was changed since on the iPhone — moved to the Trash.");
      expect(toastTexts()).toEqual([done.value.toast]);
    });

    it("names the group another device trashed when a selected item inside it goes", async () => {
      const t = await made([
        { name: "G", kind: "group" },
        { name: "A", parent: "G", start: "2026-11-10", dur: 3 },
      ]);
      await shown(t);
      select("A");
      const p = await t.peer("iphone");
      sessions.push(p.session);
      act(() => {
        p.session.apply({ t: "trash", items: ["G"] });
        p.sync();
      });
      expect(uiNow()[0].selected).toBeNull();
      expect(toastTexts()).toEqual(["“G” was moved to the Trash on iPhone. Restore it from the Trash."]);
    });

    it("keeping a ghost in the Trash from its own panel toasts only the resolve", async () => {
      const t = await made(SEED);
      const p = await t.peer("iphone");
      sessions.push(p.session);
      await shown(t);
      select("A");
      act(() => {
        p.session.apply({ t: "trash", items: ["A"] });
      });
      act(() => {
        t.session.apply({ t: "rename", item: "A", name: "A2" });
      });
      act(() => p.sync());
      await settle();
      expect(t.session.view().choices.filter((x) => x.kind === "delete")).toHaveLength(1);
      expect(uiNow()[0].selected).toBe("A");
      expect(toastTexts()).toEqual([]);
      click(button("Choose"));
      const dialog = screen.getByRole("dialog", { name: CHOICE_TITLE });
      const resolve = vi.spyOn(t.session, "resolve");
      click(within(dialog).getByRole("button", { name: "Keep iPhone" }));
      await settle();
      const done = resolve.mock.results[0];
      if (done === undefined || done.type !== "return") throw new Error("resolve did not return");
      expect(t.session.view().plan.items.get("A")?.trashed).toBe(true);
      expect(t.session.trashAuthorOf("A").dev).toBe("mac");
      expect(uiNow()[0].selected).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(toastTexts()).toEqual([done.value.toast]);
    });

    it("keeps the ghost row of an open delete choice selected", async () => {
      const { t, p } = await deleteClash();
      sessions.push(t.session, p.session);
      await shown(t);
      click(screen.getByRole("tab", { name: "List" }));
      const row = document.querySelector('[data-lrow="A"]');
      if (row === null) throw new Error("no ghost row for A");
      expect(row.classList.contains("ghost-row")).toBe(true);
      const at = { clientX: 10, clientY: 10, button: 0, pointerId: 1, pointerType: "mouse" };
      act(() => {
        fireEvent.pointerDown(row, at);
      });
      act(() => {
        fireEvent.pointerUp(row, { ...at, clientX: 11 });
      });
      expect(uiNow()[0].selected).toBe("A");
      expect(inPanel().getByLabelText("Name").textContent).toBe("Renamed");
      act(() => {
        p.session.apply({ t: "rename", item: "B", name: "Other" });
        p.sync();
      });
      expect(uiNow()[0].selected).toBe("A");
      expect(toastTexts().filter((x) => x !== null && remote.test(x))).toEqual([]);
    });
  });
});

describe("working time in Settings from the shell", () => {
  const workingTime = (): HTMLElement[] => screen.queryAllByRole("dialog", { name: "Working time" });
  const openFromRow = async (): Promise<void> => {
    const panel = slot("panel");
    if (!(panel instanceof HTMLElement)) throw new Error("no panel");
    const row = panel.querySelector('button.summary-row[data-summary-row="working-time"]');
    if (!(row instanceof HTMLElement)) throw new Error("no Working time row");
    fireEvent.click(row);
    await settle();
  };

  it("opens from PlanPanel's Working time row and closes with Esc", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    await openFromRow();
    expect([lastUi().settings, lastUi().dialog]).toEqual(["working-time", null]);
    expect(workingTime()).toHaveLength(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(workingTime()[0].querySelector('section.settings-section[data-section="working-time"]:not([hidden]) .cal-body')).not.toBeNull();
    fireEvent.keyDown(workingTime()[0], { key: "Escape" });
    await settle();
    expect(lastUi().settings).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape outside Settings goes through the calendar guard", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    await openFromRow();
    const before = t.session.view().plan.calendar;
    fireEvent.click(within(within(workingTime()[0]).getByRole("group", { name: "Working days" })).getByRole("button", { name: "Sat" }));
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    await settle();
    const ask = screen.getByRole("alertdialog", { name: "Discard calendar changes?" });
    expect([lastUi().settings, workingTime().length, document.activeElement]).toEqual(["working-time", 1, within(ask).getByRole("button", { name: "Keep editing" })]);
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    await settle();
    expect([screen.queryByRole("alertdialog"), workingTime().length, lastUi().settings]).toEqual([null, 1, "working-time"]);
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    await settle();
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Discard calendar changes?" })).getByRole("button", { name: "Discard" }));
    await settle();
    expect([screen.queryByRole("dialog"), screen.queryByRole("alertdialog"), lastUi().settings]).toEqual([null, null, null]);
    expect(t.session.view().plan.calendar).toBe(before);
  });

  it("opens Working time from Choose region on a plan with no region", async () => {
    const t = await made(MESA_SEED);
    expect(t.session.view().plan.calendar.region).toBeNull();
    render(withSync(shellFor(t).ui));
    await settle();
    const head = document.querySelector(".plan-head");
    if (!(head instanceof HTMLElement)) throw new Error("no plan head");
    fireEvent.click(within(head).getByRole("button", { name: "Choose region" }));
    await settle();
    expect([lastUi().settings, lastUi().dialog]).toEqual(["working-time", null]);
    expect(workingTime()).toHaveLength(1);
  });

  it("the gear keeps a calendar draft behind its ask", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    await openFromRow();
    fireEvent.click(within(within(workingTime()[0]).getByRole("group", { name: "Working days" })).getByRole("button", { name: "Sat" }));
    const gear = document.querySelector('.toolbar button[aria-label="Settings"]');
    if (!(gear instanceof HTMLElement)) throw new Error("no gear");
    fireEvent.click(gear);
    await settle();
    expect([screen.queryByRole("alertdialog", { name: "Discard calendar changes?" }) !== null, lastUi().settings]).toEqual([true, "working-time"]);
  });
});

describe("Shell: print (product-8)", () => {
  const printSheet = (): Element | null => document.body.querySelector(":scope > .print-sheet");
  const pressPrint = (): void => {
    act(() => {
      fireEvent.keyDown(document.body, { key: "p", metaKey: true });
    });
  };

  it("mounts the sheet before printNow runs, keeps it while printing, and unmounts it on afterprint", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    expect(printSheet()).toBeNull();
    const mountedAtCall: boolean[] = [];
    vi.mocked(printNow).mockImplementation(async () => {
      mountedAtCall.push(printSheet() !== null);
    });
    pressPrint();
    await settle();
    expect(vi.mocked(printNow).mock.calls).toEqual([["macos"]]);
    expect(mountedAtCall).toEqual([true]);
    expect(printSheet()?.querySelector("h1")?.textContent).toBe(t.session.view().plan.name);
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(printSheet()).toBeNull();
  });

  it("prints again on a second Print when afterprint never came", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    pressPrint();
    await settle();
    pressPrint();
    await settle();
    expect(vi.mocked(printNow)).toHaveBeenCalledTimes(2);
    expect(document.body.querySelectorAll(":scope > .print-sheet")).toHaveLength(1);
  });

  it("toasts a refused print and unmounts the sheet", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    vi.mocked(printNow).mockRejectedValueOnce(new AppError("print.failed", "Could not open the print dialog: the window did not answer."));
    pressPrint();
    await settle();
    expect(printSheet()).toBeNull();
    expect(toastTexts()).toContain("Could not open the print dialog: the window did not answer.");
  });

  it("prints from the ⋯ menu", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t, { device: { deviceId: "pc", name: "pop-os", platform: "linux" } });
    render(withSync(ui));
    await settle();
    fireEvent.click(menuToggle());
    fireEvent.click(within(screen.getByRole("menu", { name: "Plan" })).getByRole("menuitem", { name: "Print…" }));
    await settle();
    expect(vi.mocked(printNow).mock.calls).toEqual([["linux"]]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers no Print… on iOS, in the menu or on ⌘P", async () => {
    setPlatform(IPAD);
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t, { device: { deviceId: "ipad", name: "iPad", platform: "ios" } });
    const unstub = stubVisualViewport();
    try {
      render(withSync(ui));
      await settle();
      fireEvent.click(menuToggle());
      await settle();
      expect(screen.queryByRole("menu", { name: "Plan" })).toBeNull();
      const asked = tauri.calls.filter((c) => c.cmd === "menu_show").map((c) => (c.args as { menu: { sections: { rows: { title: string }[] }[] } }).menu.sections.flatMap((s) => s.rows.map((r) => r.title)));
      expect(asked).toEqual([["Export plan…", "Import plan…"]]);
    } finally {
      unstub();
    }
    pressPrint();
    await settle();
    expect(printNow).not.toHaveBeenCalled();
    expect(printSheet()).toBeNull();
  });
});

describe("the Settings modal in the wide shell", () => {
  const settingsModal = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-settings-modal]");
  const openModal = (): HTMLElement => {
    const m = settingsModal();
    if (m === null) throw new Error("no Settings modal");
    return m;
  };
  const gear = (): HTMLElement => {
    const bar = document.querySelector("header.toolbar");
    if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
    return within(bar).getByRole("button", { name: "Settings" });
  };
  const openSettings = (): void => {
    fireEvent.click(gear());
  };
  const commaKey = (target: Element = document.body): void => {
    act(() => {
      fireEvent.keyDown(target, { key: ",", code: "Comma", metaKey: true });
    });
  };
  const toSection = (name: string): void => {
    fireEvent.click(within(within(openModal()).getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name }));
  };
  const editAccent = (): void => {
    toSection("Theme");
    const field = within(openModal()).getByRole("textbox", { name: "Accent hex" });
    fireEvent.change(field, { target: { value: "#335577" } });
    fireEvent.blur(field);
  };
  const drafted = (): string => document.documentElement.style.getPropertyValue("--cyan");

  it("opens as a modal at General from the gear, leaving the plan panel in the inspector, and the gear closes it", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    expect(gear().getAttribute("aria-pressed")).toBe("false");
    openSettings();
    expect(lastUi().settings).toBe("general");
    expect([openModal().getAttribute("aria-label"), openModal().getAttribute("aria-modal"), gear().getAttribute("aria-pressed")]).toEqual(["General", "true", "true"]);
    expect(slot("panel")?.querySelector(".panel h2")?.textContent).toBe("Plan");
    expect(slot("panel")?.querySelector(".settings-section")).toBeNull();
    openSettings();
    expect([lastUi().settings, settingsModal(), gear().getAttribute("aria-pressed")]).toEqual([null, null, "false"]);
    expect(toastTexts()).not.toContain("Unsaved colours discarded.");
  });

  it("opens with no plan open, with no inspector column", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t, { plans: () => [] }).ui));
    await settle();
    expect(document.querySelector(".empty-state")).not.toBeNull();
    openSettings();
    expect([openModal().getAttribute("aria-label"), slot("panel")]).toEqual(["General", null]);
    fireEvent.click(within(openModal()).getByRole("button", { name: "Close" }));
    expect([lastUi().settings, settingsModal()]).toEqual([null, null]);
  });

  it("reopens on the last section", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    openSettings();
    toSection("Sync");
    expect([lastUi().settings, openModal().getAttribute("aria-label")]).toEqual(["sync", "Sync"]);
    openSettings();
    expect(settingsModal()).toBeNull();
    openSettings();
    expect([lastUi().settings, openModal().getAttribute("aria-label")]).toEqual(["sync", "Sync"]);
  });

  it.each<[string, () => void]>([
    ["the ✕", () => fireEvent.click(within(openModal()).getByRole("button", { name: "Close" }))],
    ["Escape", () => fireEvent.keyDown(openModal(), { key: "Escape" })],
    [
      "a scrim press",
      () => {
        const scrim = openModal().parentElement;
        if (scrim === null) throw new Error("no scrim");
        const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(scrim);
        fireEvent.pointerDown(scrim, { button: 0, pointerType: "mouse", clientX: 5, clientY: 5 });
        fireEvent.pointerUp(scrim, { button: 0, pointerType: "mouse", clientX: 5, clientY: 5 });
        fireEvent.click(scrim, { button: 0, clientX: 5, clientY: 5 });
        under.mockRestore();
      },
    ],
    ["the gear", () => fireEvent.click(gear())],
    ["⌘,", () => commaKey(openModal())],
  ])("discards a theme draft with the toast when closed by %s, and leaves the selection", async (_how, close) => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    setUiNow({ selected: "t3" });
    openSettings();
    editAccent();
    expect(drafted()).toBe("#335577");
    act(close);
    expect([lastUi().settings, settingsModal(), lastUi().selected]).toEqual([null, null, "t3"]);
    expect(toastTexts()).toContain("Unsaved colours discarded.");
    expect(drafted()).toBe(tokensOf(cyberdeck()).cyan);
  });

  it("opens and closes on ⌘, even from a field, and Ctrl , on Linux", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    commaKey();
    expect([lastUi().settings, openModal().getAttribute("aria-label")]).toEqual(["general", "General"]);
    commaKey(within(openModal()).getByRole("searchbox", { name: "Search settings" }));
    expect([lastUi().settings, settingsModal()]).toEqual([null, null]);
    act(() => {
      fireEvent.keyDown(document.body, { key: ",", code: "Comma", ctrlKey: true });
    });
    expect(lastUi().settings).toBeNull();
  });

  it("opens on Ctrl , on Linux", async () => {
    setPlatform(LINUX);
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t, { device: { deviceId: "linux", name: "Linux box", platform: "linux" } }).ui));
    await settle();
    act(() => {
      fireEvent.keyDown(document.body, { key: ",", code: "Comma", ctrlKey: true });
    });
    expect([lastUi().settings, openModal().getAttribute("aria-label")]).toEqual(["general", "General"]);
  });

  it("leaves ⌘, alone under another dialog", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    setUiNow({ dialog: { t: "palette" } });
    commaKey();
    expect([lastUi().settings, lastUi().dialog, settingsModal()]).toEqual([null, { t: "palette" }, null]);
  });

  it("switches sync panes inside the Sync section, keeping Settings and its draft", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    openSettings();
    editAccent();
    toSection("Sync");
    const modal = openModal();
    const tab = within(modal).getByRole("tab", { name: "Add a device" });
    act(() => {
      fireEvent.click(tab);
    });
    expect([lastUi().settings, lastUi().syncPane, lastUi().dialog, settingsModal()]).toEqual(["sync", "pair", null, modal]);
    expect(toastTexts()).not.toContain("Unsaved colours discarded.");
    expect(drafted()).not.toBe(tokensOf(cyberdeck()).cyan);
    expect(within(modal).getByRole("tab", { name: "Add a device" }).getAttribute("aria-selected")).toBe("true");
    expect(within(modal).getByRole("tabpanel", { name: "Add a device" }).closest('section.settings-section[data-section="sync"]')).not.toBeNull();
    expect(screen.getAllByRole("dialog")).toEqual([modal]);
    expect(gear().getAttribute("aria-pressed")).toBe("true");
  });

  it("one modal at a time: the item modal closes Settings, discarding its draft, and Settings closes the item modal", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    setUiNow({ selected: "t3" });
    openSettings();
    editAccent();
    const column = document.querySelector<HTMLElement>('#inspector [data-detail="column"]');
    if (column === null) throw new Error("no column detail");
    fireEvent.click(within(column).getByRole("button", { name: "Open as modal" }));
    await settle();
    expect([settingsModal(), document.querySelectorAll("[data-item-modal]").length, document.querySelectorAll('[aria-modal="true"]').length, lastUi().dialog]).toEqual([
      null,
      1,
      1,
      { t: "item" },
    ]);
    expect(toastTexts()).toContain("Unsaved colours discarded.");
    commaKey();
    await settle();
    expect([document.querySelectorAll("[data-item-modal]").length, settingsModal() !== null, document.querySelectorAll('[aria-modal="true"]').length, lastUi().dialog]).toEqual([0, true, 1, null]);
  });

  it("the inspector follows a selection made while Settings is open", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    openSettings();
    setUiNow({ selected: "t3" });
    expect(settingsModal()).not.toBeNull();
    expect(within(slot("panel") as HTMLElement).getByLabelText("Name")).toHaveProperty("value", "Tracking: review results");
  });

  it("does not paint a native background on iOS", async () => {
    vi.mocked(paintNative).mockClear();
    setPlatform(IPAD);
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t, { device: { deviceId: "ipad", name: "iPad", platform: "ios" } }).ui));
    await settle();
    expect(paintNative).not.toHaveBeenCalled();
  });

  it("shows a bad toast when the native window background cannot be set", async () => {
    vi.mocked(paintNative).mockClear();
    const failure = new Error("no window");
    vi.mocked(paintNative).mockRejectedValueOnce(failure);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    expect(logged).toHaveBeenCalledWith(failure);
    logged.mockRestore();
    expect(vi.mocked(paintNative).mock.calls).toHaveLength(1);
    expect(Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((n) => [n.textContent, n.className])).toEqual([["Window colour could not be set: no window", "toast bad"]]);
  });

  it("paints the native window background with the shown ground on macOS", async () => {
    vi.mocked(paintNative).mockClear();
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    expect(vi.mocked(paintNative).mock.calls).toEqual([[tokensOf(cyberdeck()).void]]);
  });
});

describe("Shell: ⌥⌘1-9 moves the selection to a step", () => {
  const press = (n: number): void => {
    act(() => {
      fireEvent.keyDown(document.body, { key: "x", code: `Digit${n}`, metaKey: true, altKey: true });
    });
  };

  it("moves the selected task to step 2 from the Timeline, in one toStep", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    setUiNow({ selected: "t3" });
    const apply = vi.spyOn(t.session, "apply");
    press(2);
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["t3"], step: "next" }]]);
    expect(t.session.view().plan.workflow.items.get("t3")).toBe("next");
    expect(lastUi().selected).toBe("t3");
  });

  it("toasts for a group and for a step the plan does not have, writing nothing", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    const apply = vi.spyOn(t.session, "apply");
    setUiNow({ selected: "g2" });
    press(1);
    setUiNow({ selected: "t3" });
    press(9);
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual(["Groups have no step. Select a task or milestone.", "This plan has no step 9."]);
  });

  it("says why while read-only, writing nothing", async () => {
    const t = await made(MESA_SEED);
    t.session.setReadOnly(true);
    render(withSync(shellFor(t).ui));
    await settle();
    setUiNow({ selected: "t3" });
    const apply = vi.spyOn(t.session, "apply");
    press(2);
    expect(apply).not.toHaveBeenCalled();
    const reason = t.session.readOnlyReason;
    expect(reason).not.toBeNull();
    expect(toastTexts()).toEqual([reason]);
  });

  it("says the selection is gone when the selected item leaves the plan before the shell has caught up", async () => {
    const t = await made(MESA_SEED);
    render(withSync(shellFor(t).ui));
    await settle();
    act(() => {
      t.session.apply({ t: "create", kind: "task", name: "Fresh", parent: null, after: null, start: null });
    });
    const fresh = [...t.session.view().plan.items.values()].find((i) => i.name === "Fresh");
    if (fresh === undefined) throw new Error("no new task");
    setUiNow({ selected: fresh.id });
    clearToasts();
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      t.session.undo();
      fireEvent.keyDown(document.body, { key: "x", code: "Digit2", metaKey: true, altKey: true });
    });
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual(["The selected item is no longer in this plan."]);
  });
});
