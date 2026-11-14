import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import type { PlanListing, Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { setReducedMotion } from "../../test/matchMedia";
import { IPAD, LINUX, setPlatform } from "../../test/platform";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { shellFor } from "../../test/shell";
import { resetTauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { PLACE_KEY } from "../state";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];
const OTHER: PlanId = "zz000000001";
const ON_IPAD: Partial<Registry> = { device: { deviceId: "ipad", name: "iPad", platform: "ios" } };

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
  setPlatform(IPAD);
  setScreen(834, 1194);
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
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

const twoPlans = (t: TestSession, over: Partial<Registry> = {}): Partial<Registry> => {
  const id = t.session.view().plan.id;
  const plans: PlanListing[] = [
    { id, name: "MESA", trashed: false, loaded: true, space: null, example: false },
    { id: OTHER, name: "Other", trashed: false, loaded: true, space: null, example: false },
  ];
  return { ...ON_IPAD, plans: () => plans, ...over };
};

const shown = async (t: TestSession, over: Partial<Registry> = ON_IPAD, place?: object): Promise<void> => {
  if (place !== undefined) window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: t.session.view().plan.id, ...place }));
  render(withSync(shellFor(t, over).ui));
  await settle();
};

const bar = (): HTMLElement => {
  const el = document.querySelector("header.toolbar");
  if (!(el instanceof HTMLElement)) throw new Error("no toolbar");
  return el;
};

const toggle = (): HTMLElement => within(bar()).getByRole("button", { name: "Plan list" });

const overlay = (): HTMLElement | null => screen.queryByRole("dialog", { name: "Plans" });

const opened = (): HTMLElement => {
  const d = overlay();
  if (d === null) throw new Error("the overlay is not open");
  return d;
};

const layer = (): Element | null => document.querySelector(".plan-overlay-layer");

const scrim = (): HTMLElement => {
  const el = document.querySelector(".plan-overlay-scrim");
  if (!(el instanceof HTMLElement)) throw new Error("no scrim");
  return el;
};

const main = (): HTMLElement => {
  const el = document.querySelector("main.main");
  if (!(el instanceof HTMLElement)) throw new Error("no main");
  return el;
};

const press = (target: Element, key: string, o: { meta?: boolean; shift?: boolean } = {}): void => {
  fireEvent.keyDown(target, { key, metaKey: o.meta ?? false, shiftKey: o.shift ?? false });
};

const ended = (panel: Element, propertyName: string): void => {
  const e = new Event("transitionend", { bubbles: true });
  Object.defineProperty(e, "propertyName", { value: propertyName });
  act(() => {
    panel.dispatchEvent(e);
  });
};

const finish = (): void => {
  const panel = document.querySelector(".plan-overlay");
  if (panel === null) throw new Error("no overlay panel to finish its transition");
  ended(panel, "transform");
};

const closed = (): void => {
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(main().hasAttribute("inert")).toBe(false);
  if (layer() !== null) {
    expect(layer()?.hasAttribute("data-shown")).toBe(false);
    finish();
  }
  expect(layer()).toBeNull();
};

describe("the plan list overlay on an iPad at 700-1179", () => {
  it("leads the toolbar with the Plan list button, closed, in place of the Plans button", async () => {
    await shown(await made());
    const start = document.querySelector(".toolbar-start");
    expect(start?.firstElementChild).toBe(toggle());
    const b = toggle();
    expect([b.className, b.getAttribute("aria-expanded"), b.getAttribute("aria-controls"), b.title]).toEqual(["icon-button sidebar-toggle", "false", "plan-list", "Show the plan list (⌘B)"]);
    expect(within(bar()).queryByRole("button", { name: "Plans" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Plans" })).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(layer()).toBeNull();
  });

  it("opens over the plan as a modal region holding the list, focused, with the plan area inert", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    const d = opened();
    expect([d.getAttribute("aria-modal"), d.tabIndex]).toEqual(["true", -1]);
    expect(within(d).getByRole("navigation", { name: "Plans" }).id).toBe("plan-list");
    expect([toggle().getAttribute("aria-expanded"), toggle().title]).toEqual(["true", "Hide the plan list (⌘B)"]);
    expect(toggle().querySelector("svg .sidebar-toggle-fill")).not.toBeNull();
    expect(document.activeElement).toBe(d);
    expect(main().hasAttribute("inert")).toBe(true);
    expect(layer()?.getAttribute("data-shown")).toBe("true");
    expect(document.querySelector(".app-body")?.contains(layer())).toBe(true);
  });

  it("closes from the toolbar button and gives the button focus", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(document.activeElement).toBe(toggle());
    closed();
  });

  it("closes on Escape and gives the button focus", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    press(opened(), "Escape");
    expect(document.activeElement).toBe(toggle());
    closed();
  });

  it("closes on Escape from the toolbar button too", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    toggle().focus();
    press(toggle(), "Escape");
    closed();
  });

  it("toggles on ⌘B, from the page and from inside the list", async () => {
    await shown(await made());
    press(document.body, "b", { meta: true });
    const d = opened();
    press(d, "b", { meta: true });
    expect(document.activeElement).toBe(toggle());
    closed();
  });

  it("closes on a scrim tap, and not on a press that ends elsewhere", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    const s = scrim();
    const away = vi.spyOn(document, "elementFromPoint").mockReturnValue(opened());
    fireEvent.pointerDown(s, { button: 0, pointerType: "touch", clientX: 600, clientY: 400 });
    fireEvent.pointerUp(s, { button: 0, pointerType: "touch", clientX: 600, clientY: 400 });
    fireEvent.click(s, { button: 0, clientX: 600, clientY: 400 });
    away.mockRestore();
    expect(overlay()).not.toBeNull();
    const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(s);
    fireEvent.pointerDown(s, { button: 0, pointerType: "touch", clientX: 600, clientY: 400 });
    fireEvent.pointerUp(s, { button: 0, pointerType: "touch", clientX: 600, clientY: 400 });
    fireEvent.click(s, { button: 0, clientX: 600, clientY: 400 });
    under.mockRestore();
    expect(document.activeElement).toBe(toggle());
    closed();
  });

  it("closes after choosing a plan, with the plan chosen", async () => {
    const t = await made();
    const seen: string[] = [];
    await shown(t, twoPlans(t, { session: (x: string) => {
      seen.push(`${x}:${overlay() === null ? "closed" : "open"}`);
      return new Promise<PlanSession>(() => undefined);
    } }));
    fireEvent.click(toggle());
    fireEvent.click(within(opened()).getByRole("button", { name: /^Other/ }));
    expect(seen.filter((x) => x.startsWith(OTHER))).toEqual([`${OTHER}:open`]);
    expect(within(bar()).queryByRole("button", { name: "Plan list" })?.getAttribute("aria-expanded")).toBe("false");
    closed();
  });

  it("closes on New plan once the new plan is made", async () => {
    const t = await made();
    let made_: (id: PlanId) => void = () => {
      throw new Error("createPlan was not called");
    };
    const createPlan = vi.fn(() => new Promise<PlanId>((r) => (made_ = r)));
    await shown(t, twoPlans(t, { createPlan, session: () => new Promise<PlanSession>(() => undefined) }));
    fireEvent.click(toggle());
    fireEvent.click(within(opened()).getByRole("button", { name: "New plan" }));
    expect(createPlan).toHaveBeenCalledTimes(1);
    await settle();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    made_(OTHER);
    await settle();
    closed();
  });

  it("stays open with a toast when New plan fails", async () => {
    const t = await made();
    const createPlan = vi.fn(() => Promise.reject(new AppError("store.io", "the disk is full")));
    await shown(t, twoPlans(t, { createPlan }));
    fireEvent.click(toggle());
    fireEvent.click(within(opened()).getByRole("button", { name: "New plan" }));
    await settle();
    expect(createPlan).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/the disk is full/)).toBeTruthy();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(main().hasAttribute("inert")).toBe(true);
  });

  it("keeps plan shortcuts away from the plan behind it, but lets ⌘B and ⌘K through", async () => {
    const t = await made();
    await shown(t);
    const items = t.session.view().plan.items.size;
    fireEvent.click(toggle());
    const d = opened();
    ["n", "m", "ArrowDown", "t", "2", "3"].forEach((k) => press(d, k));
    press(d, "z", { meta: true });
    expect(t.session.view().plan.items.size).toBe(items);
    expect(document.querySelector(".sheet")).toBeNull();
    expect(document.querySelector('.slot[data-slot="timeline"]')).not.toBeNull();
    expect(overlay()).not.toBeNull();
    press(d, "k", { meta: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    press(document.body, "Escape");
    press(opened(), "b", { meta: true });
    closed();
  });

  it("closes on Escape when focus has fallen to the page", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    act(() => opened().blur());
    expect(document.activeElement).toBe(document.body);
    press(document.body, "Escape");
    expect(document.activeElement).toBe(toggle());
    closed();
  });

  it("takes Tab back into the cycle when focus has fallen to the page", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    const d = opened();
    act(() => d.blur());
    press(document.body, "Tab");
    expect(document.activeElement).toBe(within(d).getByRole("button", { name: "New plan" }));
    act(() => within(d).getByRole("button", { name: "New plan" }).blur());
    press(document.body, "Tab", { shift: true });
    const stops = Array.from(d.querySelectorAll<HTMLElement>("button:not(:disabled)"));
    expect(document.activeElement).toBe(stops[stops.length - 1]);
  });

  it("keeps Tab inside from a panel element outside the cycle", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    const d = opened();
    const stray = document.createElement("span");
    stray.tabIndex = -1;
    within(d).getByRole("navigation", { name: "Plans" }).append(stray);
    act(() => stray.focus());
    press(stray, "Tab");
    expect(document.activeElement).toBe(within(d).getByRole("button", { name: "New plan" }));
    stray.remove();
  });

  it("gives the button focus when closed from the palette", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    const newPlan = within(opened()).getByRole("button", { name: "New plan" });
    act(() => newPlan.focus());
    press(newPlan, "k", { meta: true });
    const item = screen.getByText("Hide the plan list").closest('[role="option"]');
    if (item === null) throw new Error("no palette option");
    fireEvent.mouseDown(item);
    await settle();
    expect(document.activeElement).toBe(toggle());
    expect(layer()?.hasAttribute("inert")).toBe(true);
    closed();
    expect(document.activeElement).toBe(toggle());
  });

  it("stays open on Move to Trash", async () => {
    const t = await made();
    const trashPlan = vi.fn();
    await shown(t, twoPlans(t, { trashPlan }));
    fireEvent.click(toggle());
    const other = within(opened()).getByRole("button", { name: /^Other/ }).closest("li");
    if (other === null) throw new Error("no entry for Other");
    fireEvent.click(within(other).getByRole("button", { name: "Move to Trash" }));
    expect(trashPlan).toHaveBeenCalledWith(OTHER);
    expect(overlay()).not.toBeNull();
    expect(main().hasAttribute("inert")).toBe(true);
  });

  it("opens Delete forever's dialog above the overlay and stays open behind it", async () => {
    const t = await made();
    const id = t.session.view().plan.id;
    const plans: PlanListing[] = [
      { id, name: "MESA", trashed: false, loaded: true, space: null, example: false },
      { id: OTHER, name: "Other", trashed: true, loaded: true, space: null, example: false },
    ];
    await shown(t, { ...ON_IPAD, plans: () => plans, purgeRefusal: () => null });
    fireEvent.click(toggle());
    fireEvent.click(within(opened()).getByRole("button", { name: "Delete forever" }));
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs.length).toBe(2);
    expect(dialogs[0]).toBe(opened());
    press(dialogs[1], "Escape");
    expect(overlay()).not.toBeNull();
  });

  it("cycles Tab through the panel and the toolbar button", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    const d = opened();
    const newPlan = within(d).getByRole("button", { name: "New plan" });
    press(d, "Tab");
    expect(document.activeElement).toBe(newPlan);
    press(newPlan, "Tab", { shift: true });
    expect(document.activeElement).toBe(toggle());
    press(toggle(), "Tab", { shift: true });
    const stops = Array.from(d.querySelectorAll<HTMLElement>("button:not(:disabled)"));
    expect(document.activeElement).toBe(stops[stops.length - 1]);
    press(stops[stops.length - 1], "Tab");
    expect(document.activeElement).toBe(toggle());
    press(toggle(), "Tab");
    expect(document.activeElement).toBe(newPlan);
    press(d, "Tab", { shift: true });
    expect(document.activeElement).toBe(toggle());
  });

  it("lights the attention dot while closed, on the hidden column's condition", async () => {
    const t = await made();
    const id = t.session.view().plan.id;
    const plans: PlanListing[] = [
      { id, name: "MESA", trashed: false, loaded: true, space: null, example: false },
      { id: OTHER, name: "Other", trashed: false, loaded: false, space: null, example: false },
    ];
    await shown(t, { ...ON_IPAD, plans: () => plans, failures: () => new Map([[OTHER, new AppError("store.corrupt", "Other could not be read")]]) });
    expect([toggle().getAttribute("data-attention"), toggle().title]).toEqual(["true", "Show the plan list (⌘B) · needs attention"]);
    fireEvent.click(toggle());
    expect([toggle().hasAttribute("data-attention"), toggle().title]).toEqual([false, "Hide the plan list (⌘B)"]);
  });

  it("starts closed whatever the saved column state, and never saves its own", async () => {
    const t = await made();
    await shown(t, ON_IPAD, { sidebarOpen: true, sidebarWidth: 400 });
    expect(overlay()).toBeNull();
    const before = window.localStorage.getItem(PLACE_KEY);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.click(toggle());
    press(document.body, "b", { meta: true });
    press(document.body, "b", { meta: true });
    fireEvent.click(toggle());
    expect(writes.mock.calls.filter((c) => c[0] === PLACE_KEY)).toEqual([]);
    expect(window.localStorage.getItem(PLACE_KEY)).toBe(before);
  });

  it("offers Show and Hide the plan list in the palette", async () => {
    await shown(await made());
    press(document.body, "k", { meta: true });
    const item = screen.getByText("Show the plan list").closest('[role="option"]');
    if (item === null) throw new Error("no palette option");
    fireEvent.mouseDown(item);
    await settle();
    expect(overlay()).not.toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the column in its saved state and no leftover scrim on a rotation to the full form", async () => {
    const t = await made();
    await shown(t, ON_IPAD, { sidebarOpen: false });
    fireEvent.click(toggle());
    expect(document.activeElement).toBe(opened());
    act(() => setScreen(1194, 834));
    await settle();
    expect(document.activeElement).toBe(toggle());
    expect(layer()).toBeNull();
    expect(overlay()).toBeNull();
    expect(main().hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("navigation", { name: "Plans" })).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle());
    expect(screen.getByRole("navigation", { name: "Plans" }).closest('[role="dialog"]')).toBeNull();
    act(() => setScreen(834, 1194));
    await settle();
    expect(overlay()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the column open on a rotation when that is the saved state", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    act(() => setScreen(1194, 834));
    await settle();
    expect(layer()).toBeNull();
    expect(screen.getByRole("navigation", { name: "Plans" }).closest('[role="dialog"]')).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes into the Plans button below 700", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 699 });
      window.dispatchEvent(new Event("resize"));
    });
    await settle();
    expect(layer()).toBeNull();
    expect(main().hasAttribute("inert")).toBe(false);
    expect(within(bar()).queryByRole("button", { name: "Plan list" })).toBeNull();
    expect(document.activeElement).toBe(within(bar()).getByRole("button", { name: "Plans" }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Plans" }));
    expect(screen.getByRole("dialog", { name: "Plans" }).classList.contains("sheet")).toBe(true);
  });

  it("drops a Plans sheet left open below 700 when the window widens into the overlay", async () => {
    const wide = (w: number): void => {
      act(() => {
        Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
        window.dispatchEvent(new Event("resize"));
      });
    };
    await shown(await made());
    wide(690);
    await settle();
    fireEvent.click(within(bar()).getByRole("button", { name: "Plans" }));
    expect(screen.getByRole("dialog", { name: "Plans" }).classList.contains("sheet")).toBe(true);
    wide(760);
    await settle();
    expect(document.querySelector(".sheet")).toBeNull();
    expect(overlay()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the overlay's motion", () => {
  it("stays in the page until the slide out ends, then leaves", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(layer()).not.toBeNull();
    expect(layer()?.hasAttribute("data-shown")).toBe(false);
    expect(main().hasAttribute("inert")).toBe(false);
    const panel = document.querySelector(".plan-overlay");
    if (panel === null) throw new Error("no panel");
    ended(panel, "opacity");
    expect(layer()).not.toBeNull();
    finish();
    expect(layer()).toBeNull();
  });

  it("leaves the state the last toggle asked for when toggled mid-slide", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(layer()?.getAttribute("data-shown")).toBe("true");
    finish();
    expect(overlay()).not.toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle());
    finish();
    expect(layer()).toBeNull();
  });

  it("leaves when the slide out is cancelled with nothing left running, and not while a reversed slide runs", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    const panel = document.querySelector(".plan-overlay");
    if (!(panel instanceof HTMLElement)) throw new Error("no panel");
    const running: unknown[] = [{}];
    Object.defineProperty(panel, "getAnimations", { configurable: true, value: () => running });
    const cancelled = (): void => {
      const e = new Event("transitioncancel", { bubbles: true });
      Object.defineProperty(e, "propertyName", { value: "transform" });
      act(() => {
        panel.dispatchEvent(e);
      });
    };
    cancelled();
    expect(layer()).not.toBeNull();
    running.splice(0);
    cancelled();
    expect(layer()).toBeNull();
  });

  it("leaves at once when reduced motion turns on mid-slide", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(layer()).not.toBeNull();
    act(() => setReducedMotion(true));
    expect(layer()).toBeNull();
  });

  it("is inert while it slides out", async () => {
    await shown(await made());
    fireEvent.click(toggle());
    expect(layer()?.hasAttribute("inert")).toBe(false);
    fireEvent.click(toggle());
    expect(layer()?.hasAttribute("inert")).toBe(true);
  });

  it("removes the panel at once under reduced motion", async () => {
    setReducedMotion(true);
    await shown(await made());
    fireEvent.click(toggle());
    expect(overlay()).not.toBeNull();
    fireEvent.click(toggle());
    expect(layer()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });
});

describe("the iPad toolbar below 1180", () => {
  it("drops the ⌘K button and turns Undo and Redo into glyphs", async () => {
    await shown(await made());
    expect(within(bar()).queryByRole("button", { name: "⌘K" })).toBeNull();
    const undo = within(bar()).getByRole("button", { name: "Undo" });
    const redo = within(bar()).getByRole("button", { name: "Redo" });
    expect([undo.textContent, undo.title, redo.textContent, redo.title]).toEqual(["↶", "Undo", "↷", "Redo"]);
    expect([undo.hasAttribute("disabled"), redo.hasAttribute("disabled")]).toEqual([true, true]);
    press(document.body, "k", { meta: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps ⌘K and the worded Undo and Redo at 1180 and up", async () => {
    setScreen(1194, 834);
    await shown(await made());
    expect(within(bar()).getByRole("button", { name: "⌘K" })).toBeTruthy();
    expect(within(bar()).getByRole("button", { name: "Undo" }).textContent).toBe("Undo");
  });
});

describe("other platforms at the same width", () => {
  it("keep the Plans button and the sheet on macOS and Linux at 834", async () => {
    for (const [platform, device] of [
      [{ os: "macos", idiom: null }, "macos"],
      [LINUX, "linux"],
    ] as const) {
      setPlatform(platform);
      const t = await made();
      await shown(t, { device: { deviceId: "d", name: "D", platform: device } });
      expect(within(bar()).queryByRole("button", { name: "Plan list" })).toBeNull();
      expect(within(bar()).getByRole("button", { name: platform.os === "linux" ? "Ctrl K" : "⌘K" })).toBeTruthy();
      expect(within(bar()).getByRole("button", { name: "Undo" }).textContent).toBe("Undo");
      fireEvent.click(within(bar()).getByRole("button", { name: "Plans" }));
      expect(screen.getByRole("dialog", { name: "Plans" }).classList.contains("sheet")).toBe(true);
      cleanup();
    }
  });
});
