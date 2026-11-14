import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import type { PlanListing, Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import type { UpdateState, Updates } from "../../store/updates";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { shellFor } from "../../test/shell";
import { resetTauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { PLACE_KEY } from "../state";
import { UpdatesContext } from "./UpdateLine";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
  document.documentElement.classList.remove("sidebar-dragging");
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const made = async (): Promise<TestSession> => {
  const t = await testSession(MESA_SEED);
  sessions.push(t.session);
  return t;
};

const updatesAt = (state: UpdateState): Updates => ({
  state: () => state,
  subscribe: () => () => undefined,
  start: () => undefined,
  stop: () => undefined,
  check: () => Promise.reject(new Error("planList stub: check not used")),
  install: () => Promise.reject(new Error("planList stub: install not used")),
});

const shown = async (t: TestSession, o: { over?: Partial<Registry>; updates?: Updates | null; place?: object } = {}): Promise<void> => {
  if (o.place !== undefined) window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: t.session.view().plan.id, ...o.place }));
  render(<UpdatesContext.Provider value={o.updates ?? null}>{withSync(shellFor(t, o.over).ui)}</UpdatesContext.Provider>);
  await settle();
};

const toggle = (): HTMLElement => within(document.querySelector("header.toolbar") ?? document.body).getByRole("button", { name: "Plan list" });

const list = (): HTMLElement | null => screen.queryByRole("navigation", { name: "Plans" });

const handle = (): HTMLElement => screen.getByRole("separator", { name: "Resize the plan list" });

const body = (): HTMLElement => {
  const el = document.querySelector(".app-body");
  if (!(el instanceof HTMLElement)) throw new Error("no .app-body");
  return el;
};

const inlineWidth = (): string => body().style.getPropertyValue("--sidebar-w");

const saved = (): unknown => JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null");

const savedField = (key: string): unknown => {
  const s = saved();
  if (typeof s !== "object" || s === null || !(key in s)) throw new Error(`no ${key} in the saved place`);
  return Object.entries(s).find(([k]) => k === key)?.[1];
};

const placeSaves = (spy: { mock: { calls: unknown[][] } }): number => spy.mock.calls.filter((c) => c[0] === PLACE_KEY).length;

const press = (target: Element, key: string, o: { meta?: boolean; ctrl?: boolean } = {}): void => {
  fireEvent.keyDown(target, { key, metaKey: o.meta ?? false, ctrlKey: o.ctrl ?? false });
};

const LINUX: Partial<Registry> = { device: { deviceId: "pc", name: "PC", platform: "linux" } };

describe("the plan list toggle (full form)", () => {
  it("is the first control in the toolbar, labelled, expanded and controlling the list", async () => {
    await shown(await made());
    const start = document.querySelector(".toolbar-start");
    expect(start?.firstElementChild).toBe(toggle());
    const b = toggle();
    const nav = list();
    expect(nav).not.toBeNull();
    expect([b.className, b.getAttribute("aria-expanded"), b.getAttribute("aria-controls"), b.title]).toEqual([
      "icon-button sidebar-toggle",
      "true",
      nav?.id,
      "Hide the plan list (⌘B)",
    ]);
    expect(b.hasAttribute("data-attention")).toBe(false);
    expect(b.querySelector("svg .sidebar-toggle-fill")).not.toBeNull();
  });

  it("hides and shows the list, keeps focus on itself and saves the choice", async () => {
    await shown(await made());
    const b = toggle();
    b.focus();
    fireEvent.click(b);
    expect(list()).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect([toggle().getAttribute("aria-expanded"), toggle().title]).toEqual(["false", "Show the plan list (⌘B)"]);
    expect(toggle().querySelector("svg .sidebar-toggle-fill")).toBeNull();
    expect(document.activeElement).toBe(toggle());
    expect(savedField("sidebarOpen")).toBe(false);
    fireEvent.click(toggle());
    expect(list()).not.toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(savedField("sidebarOpen")).toBe(true);
  });

  it("names Ctrl B off the Mac", async () => {
    const t = await made();
    await shown(t, { over: LINUX });
    expect(toggle().title).toBe("Hide the plan list (Ctrl B)");
    fireEvent.click(toggle());
    expect(toggle().title).toBe("Show the plan list (Ctrl B)");
  });

  it("starts hidden from a saved place", async () => {
    const t = await made();
    await shown(t, { place: { sidebarOpen: false } });
    expect(list()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("main.main")).not.toBeNull();
  });
});

describe("the plan list shortcut and palette entry", () => {
  it("toggles on ⌘B on the Mac", async () => {
    await shown(await made());
    press(document.body, "b", { meta: true });
    expect(list()).toBeNull();
    press(document.body, "b", { meta: true });
    expect(list()).not.toBeNull();
  });

  it("toggles on Ctrl+B off the Mac and not on ⌘B there", async () => {
    const t = await made();
    await shown(t, { over: LINUX });
    press(document.body, "b", { meta: true });
    expect(list()).not.toBeNull();
    press(document.body, "b", { ctrl: true });
    expect(list()).toBeNull();
  });

  it("does nothing while typing", async () => {
    await shown(await made());
    const name = document.querySelector(".plan-head h1 input");
    if (!(name instanceof HTMLInputElement)) throw new Error("no plan name input");
    name.focus();
    press(name, "b", { meta: true });
    expect(list()).not.toBeNull();
  });

  it("does nothing while a dialog is open", async () => {
    await shown(await made());
    press(document.body, "k", { meta: true });
    const palette = screen.getByRole("dialog");
    press(palette, "b", { meta: true });
    expect(list()).not.toBeNull();
  });

  it("offers Hide the plan list in the palette, and runs it", async () => {
    await shown(await made());
    press(document.body, "k", { meta: true });
    const item = screen.getByText("Hide the plan list").closest('[role="option"]');
    if (item === null) throw new Error("no palette option");
    expect(item.getAttribute("data-command")).toBe("sidebar");
    fireEvent.mouseDown(item);
    expect(list()).toBeNull();
    press(document.body, "k", { meta: true });
    expect(screen.getByText("Show the plan list")).toBeTruthy();
  });

  it("moves focus from inside the list to the toggle when the list hides", async () => {
    await shown(await made());
    const nav = list();
    if (nav === null) throw new Error("no plan list");
    const inside = within(nav).getByRole("button", { name: "New plan" });
    inside.focus();
    expect(document.activeElement).toBe(inside);
    press(inside, "b", { meta: true });
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it("moves focus from inside the list to the toggle when the palette hides the list", async () => {
    await shown(await made());
    const nav = list();
    if (nav === null) throw new Error("no plan list");
    const inside = within(nav).getByRole("button", { name: "New plan" });
    inside.focus();
    press(inside, "k", { meta: true });
    const item = screen.getByText("Hide the plan list").closest('[role="option"]');
    if (item === null) throw new Error("no palette option");
    fireEvent.mouseDown(item);
    await settle();
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it("moves focus from inside the list to the Plans button when the window turns compact", async () => {
    await shown(await made());
    const nav = list();
    if (nav === null) throw new Error("no plan list");
    within(nav).getByRole("button", { name: "New plan" }).focus();
    act(() => setScreen(1100, 800));
    await settle();
    expect(list()).toBeNull();
    const bar = document.querySelector("header.toolbar");
    if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
    expect(document.activeElement).toBe(within(bar).getByRole("button", { name: "Plans" }));
  });

  it("leaves focus alone when focus fell from the list to the page before the list hides", async () => {
    await shown(await made());
    const nav = list();
    if (nav === null) throw new Error("no plan list");
    const inside = within(nav).getByRole("button", { name: "New plan" });
    inside.focus();
    act(() => inside.blur());
    await settle();
    expect(document.activeElement).toBe(document.body);
    press(document.body, "b", { meta: true });
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("still moves focus to the toggle when the list entry loses focus in the same task that hides the list", async () => {
    await shown(await made());
    const nav = list();
    if (nav === null) throw new Error("no plan list");
    const inside = within(nav).getByRole("button", { name: "New plan" });
    inside.focus();
    act(() => {
      inside.blur();
      press(document.body, "b", { meta: true });
    });
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it("moves focus to the toggle again once focus that fell to the page is back in the list", async () => {
    await shown(await made());
    const nav = list();
    if (nav === null) throw new Error("no plan list");
    const inside = within(nav).getByRole("button", { name: "New plan" });
    inside.focus();
    act(() => inside.blur());
    await settle();
    inside.focus();
    press(inside, "k", { meta: true });
    const item = screen.getByText("Hide the plan list").closest('[role="option"]');
    if (item === null) throw new Error("no palette option");
    fireEvent.mouseDown(item);
    await settle();
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it("leaves focus alone when the list hides with focus elsewhere", async () => {
    await shown(await made());
    const today = screen.getByRole("button", { name: "Today" });
    today.focus();
    press(today, "b", { meta: true });
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(today);
  });
});

describe("the attention dot", () => {
  const other: PlanId = "zz000000001";
  const failing = (t: TestSession): Partial<Registry> => {
    const id = t.session.view().plan.id;
    const plans: PlanListing[] = [
      { id, name: "MESA", trashed: false, loaded: true, space: null, example: false },
      { id: other, name: "Other", trashed: false, loaded: false, space: null, example: false },
    ];
    return { plans: () => plans, failures: () => new Map([[other, new AppError("store.corrupt", "Other could not be read")]]) };
  };

  it("lights on a hidden list holding a plan failure, and says so in the title", async () => {
    const t = await made();
    await shown(t, { over: failing(t) });
    expect(toggle().hasAttribute("data-attention")).toBe(false);
    fireEvent.click(toggle());
    expect(toggle().getAttribute("data-attention")).toBe("true");
    expect(toggle().title).toBe("Show the plan list (⌘B) · needs attention");
    fireEvent.click(toggle());
    expect(toggle().hasAttribute("data-attention")).toBe(false);
    expect(toggle().title).toBe("Hide the plan list (⌘B)");
  });

  it.each<[UpdateState, boolean]>([
    [{ k: "available", version: "9.9.9" }, true],
    [{ k: "installFailed", version: "9.9.9", message: "disk full" }, true],
    [{ k: "checkFailed", message: "offline" }, false],
    [{ k: "current", at: 0 }, false],
    [{ k: "downloading", version: "9.9.9", percent: 10 }, false],
  ])("for update state %o lights %s on a hidden list", async (state, lit) => {
    const t = await made();
    await shown(t, { updates: updatesAt(state), place: { sidebarOpen: false } });
    expect(toggle().getAttribute("data-attention")).toBe(lit ? "true" : null);
    expect(toggle().title).toBe(lit ? "Show the plan list (⌘B) · needs attention" : "Show the plan list (⌘B)");
  });

  it("stays off for a hidden list with nothing to act on", async () => {
    await shown(await made(), { place: { sidebarOpen: false } });
    expect(toggle().hasAttribute("data-attention")).toBe(false);
  });
});

describe("the resize handle", () => {
  it("describes itself as a vertical separator with the applied width and the window's limits", async () => {
    await shown(await made());
    const h = handle();
    const nav = list();
    expect([
      h.className,
      h.getAttribute("aria-orientation"),
      h.getAttribute("aria-controls"),
      h.getAttribute("aria-valuemin"),
      h.getAttribute("aria-valuemax"),
      h.getAttribute("aria-valuenow"),
      h.tabIndex,
    ]).toEqual(["sidebar-resizer", "vertical", nav?.id, "200", "480", "284", 0]);
    expect(inlineWidth()).toBe("");
    expect(nav?.nextElementSibling).toBe(h);
  });

  it("applies a stored width on .app-body, clamped to the window, and keeps the stored value", async () => {
    const t = await made();
    await shown(t, { place: { sidebarWidth: 470 } });
    expect([inlineWidth(), handle().getAttribute("aria-valuenow")]).toEqual(["470px", "470"]);
    act(() => setScreen(1180, 820));
    expect([inlineWidth(), handle().getAttribute("aria-valuenow"), handle().getAttribute("aria-valuemax")]).toEqual(["470px", "470", "472"]);
    act(() => setScreen(1200, 820));
    expect(handle().getAttribute("aria-valuemax")).toBe("480");
  });

  it("clamps a stored width above the window's max on screen only, and gives it back on a wider window", async () => {
    const t = await made();
    act(() => setScreen(1180, 820));
    await shown(t, { place: { sidebarWidth: 478 } });
    expect([inlineWidth(), handle().getAttribute("aria-valuenow")]).toEqual(["472px", "472"]);
    expect(savedField("sidebarWidth")).toBe(478);
    act(() => setScreen(1440, 900));
    expect([inlineWidth(), handle().getAttribute("aria-valuenow")]).toEqual(["478px", "478"]);
  });

  it("follows the pointer live and commits once on release", async () => {
    await shown(await made());
    const h = handle();
    const store = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 300 });
    expect(document.documentElement.classList.contains("sidebar-dragging")).toBe(true);
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 340 });
    expect([inlineWidth(), h.getAttribute("aria-valuenow")]).toEqual(["324px", "324"]);
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 360 });
    expect(inlineWidth()).toBe("344px");
    expect(placeSaves(store)).toBe(0);
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 360 });
    expect(document.documentElement.classList.contains("sidebar-dragging")).toBe(false);
    expect(placeSaves(store)).toBe(1);
    expect(savedField("sidebarWidth")).toBe(344);
    expect([inlineWidth(), handle().getAttribute("aria-valuenow")]).toEqual(["344px", "344"]);
  });

  it("clamps the drag to the limits", async () => {
    await shown(await made());
    const h = handle();
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 2000 });
    expect(inlineWidth()).toBe("480px");
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 0 });
    expect(inlineWidth()).toBe("200px");
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 0 });
    expect(savedField("sidebarWidth")).toBe(200);
  });

  it("commits nothing for a press that does not move", async () => {
    await shown(await made());
    const store = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 300 });
    expect(placeSaves(store)).toBe(0);
    expect(inlineWidth()).toBe("");
  });

  it.each([
    ["pointercancel", (h: HTMLElement) => fireEvent.pointerCancel(h, { pointerId: 1 })],
    ["a lost capture", (h: HTMLElement) => fireEvent.lostPointerCapture(h, { pointerId: 1 })],
    ["Escape", () => press(document.body, "Escape")],
  ])("restores the starting width and commits nothing on %s", async (_, end) => {
    const t = await made();
    await shown(t, { place: { sidebarWidth: 300 } });
    const store = vi.spyOn(Storage.prototype, "setItem");
    const h = handle();
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 380 });
    expect(inlineWidth()).toBe("380px");
    end(h);
    expect([inlineWidth(), h.getAttribute("aria-valuenow")]).toEqual(["300px", "300"]);
    expect(document.documentElement.classList.contains("sidebar-dragging")).toBe(false);
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 420 });
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 420 });
    expect(inlineWidth()).toBe("300px");
    expect(placeSaves(store)).toBe(0);
  });

  it("restores the stylesheet's width when a drag from the default is cancelled", async () => {
    await shown(await made());
    const h = handle();
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 380 });
    fireEvent.pointerCancel(h, { pointerId: 1 });
    expect([inlineWidth(), h.getAttribute("aria-valuenow")]).toEqual(["", "284"]);
  });

  it("keeps a selected item selected when Escape cancels a drag", async () => {
    await shown(await made());
    fireEvent.click(screen.getAllByText("Tracking: review results")[0]);
    const selected = document.querySelector(".slot-panel .panel .kind");
    expect(selected?.textContent).toBe("TASK");
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 340 });
    press(document.body, "Escape");
    expect(document.querySelector(".slot-panel .panel .kind")?.textContent).toBe("TASK");
  });

  it("ignores a press with a button other than the primary one", async () => {
    await shown(await made());
    const h = handle();
    fireEvent.pointerDown(h, { button: 2, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 380 });
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 380 });
    expect(inlineWidth()).toBe("");
    expect(document.documentElement.classList.contains("sidebar-dragging")).toBe(false);
    expect(savedField("sidebarWidth")).toBeNull();
  });

  it("drops the dragging class when it unmounts mid-drag", async () => {
    await shown(await made());
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 300 });
    expect(document.documentElement.classList.contains("sidebar-dragging")).toBe(true);
    press(toggle(), "b", { meta: true });
    expect(list()).toBeNull();
    expect(document.documentElement.classList.contains("sidebar-dragging")).toBe(false);
  });

  it("leaves no dragged width behind when a drag from the default goes away and back", async () => {
    await shown(await made());
    const h = handle();
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 340 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 300 });
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 300 });
    expect([inlineWidth(), h.getAttribute("aria-valuenow"), savedField("sidebarWidth")]).toEqual(["", "284", null]);
    press(h, "Enter");
    expect(inlineWidth()).toBe("");
  });

  it.each([
    ["the list hides", () => press(toggle(), "b", { meta: true }), () => press(toggle(), "b", { meta: true })],
    ["the window turns compact", () => setScreen(1100, 800), () => setScreen(1440, 900)],
  ])("leaves no dragged width behind when %s mid-drag from the default", async (_, away, back) => {
    await shown(await made());
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 380 });
    expect(inlineWidth()).toBe("364px");
    act(away);
    await settle();
    expect(inlineWidth()).toBe("");
    act(back);
    await settle();
    expect([inlineWidth(), handle().getAttribute("aria-valuenow"), savedField("sidebarWidth")]).toEqual(["", "284", null]);
    press(handle(), "Enter");
    expect(inlineWidth()).toBe("");
  });

  it("puts a stored width back when the list hides mid-drag", async () => {
    const t = await made();
    await shown(t, { place: { sidebarWidth: 300 } });
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 380 });
    act(() => press(toggle(), "b", { meta: true }));
    await settle();
    expect(inlineWidth()).toBe("");
    act(() => press(toggle(), "b", { meta: true }));
    await settle();
    expect([inlineWidth(), handle().getAttribute("aria-valuenow"), savedField("sidebarWidth")]).toEqual(["300px", "300", 300]);
  });

  it("steps 16 px with the arrows, goes to the limits on Home and End, and resets on Enter", async () => {
    await shown(await made());
    const h = handle();
    press(h, "ArrowRight");
    expect([savedField("sidebarWidth"), inlineWidth(), h.getAttribute("aria-valuenow")]).toEqual([300, "300px", "300"]);
    press(h, "ArrowLeft");
    press(h, "ArrowLeft");
    expect(savedField("sidebarWidth")).toBe(268);
    press(h, "Home");
    expect(savedField("sidebarWidth")).toBe(200);
    press(h, "ArrowLeft");
    expect(savedField("sidebarWidth")).toBe(200);
    press(h, "End");
    expect(savedField("sidebarWidth")).toBe(480);
    press(h, "ArrowRight");
    expect(savedField("sidebarWidth")).toBe(480);
    press(h, "Enter");
    expect([savedField("sidebarWidth"), inlineWidth(), h.getAttribute("aria-valuenow")]).toEqual([null, "", "284"]);
  });

  it("takes the arrows for itself, so a selected item does not move", async () => {
    await shown(await made());
    fireEvent.click(screen.getAllByText("Tracking: review results")[0]);
    const before = document.querySelector(".slot-panel .panel")?.textContent;
    press(handle(), "ArrowRight");
    expect(savedField("sidebarWidth")).toBe(300);
    expect(document.querySelector(".slot-panel .panel")?.textContent).toBe(before);
  });

  it("follows the stylesheet's width across 1240 px in both directions while no width is stored", async () => {
    await shown(await made());
    const cross = (w: number, token: string): void =>
      act(() => {
        document.documentElement.style.setProperty("--sidebar-w", token);
        setScreen(w, 820);
      });
    cross(1200, "236px");
    expect(handle().getAttribute("aria-valuenow")).toBe("236");
    press(handle(), "ArrowRight");
    expect([savedField("sidebarWidth"), handle().getAttribute("aria-valuenow")]).toEqual([252, "252"]);
    press(handle(), "Enter");
    expect([savedField("sidebarWidth"), handle().getAttribute("aria-valuenow")]).toEqual([null, "236"]);
    cross(1440, "284px");
    expect(handle().getAttribute("aria-valuenow")).toBe("284");
    press(handle(), "ArrowRight");
    expect([savedField("sidebarWidth"), handle().getAttribute("aria-valuenow")]).toEqual([300, "300"]);
  });

  it("resets to the stylesheet's width on a double-click", async () => {
    const t = await made();
    await shown(t, { place: { sidebarWidth: 400 } });
    fireEvent.doubleClick(handle());
    expect([savedField("sidebarWidth"), inlineWidth(), handle().getAttribute("aria-valuenow")]).toEqual([null, "", "284"]);
  });
});

describe("compact and phone forms are unchanged", () => {
  it("shows no toggle and no handle in the compact form, ignores ⌘B there and still opens the Plans sheet", async () => {
    setScreen(820, 1180);
    await shown(await made());
    const bar = document.querySelector("header.toolbar");
    if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
    expect(within(bar).queryByRole("button", { name: "Plan list" })).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(list()).toBeNull();
    const before = window.localStorage.getItem(PLACE_KEY);
    press(document.body, "b", { meta: true });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.localStorage.getItem(PLACE_KEY)).toBe(before);
    fireEvent.click(within(bar).getByRole("button", { name: "Plans" }));
    expect(within(screen.getByRole("dialog", { name: "Plans" })).getByRole("navigation", { name: "Plans" })).toBeTruthy();
    expect(inlineWidth()).toBe("");
  });

  it("keeps a hidden list's saved choice out of the compact form", async () => {
    setScreen(820, 1180);
    const t = await made();
    await shown(t, { place: { sidebarOpen: false, sidebarWidth: 400 } });
    expect(inlineWidth()).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    expect(screen.getByRole("dialog", { name: "Plans" })).toBeTruthy();
  });

  it("shows no toggle on a phone", async () => {
    setScreen(390, 844);
    await shown(await made());
    expect(screen.queryByRole("button", { name: "Plan list" })).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
