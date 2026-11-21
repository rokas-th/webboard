import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { seedPanesClosed } from "../../test/panes";
import { IPAD, LINUX, setPlatform } from "../../test/platform";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { shellFor } from "../../test/shell";
import { resetTauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { PLACE_KEY } from "../state";
import { PANES_KEY, parsePanes, type PaneKey, type PanesRecord } from "./panes";
import { NOT_A_PANE_OVERLAY } from "./PlanOverlay";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];
const ON_LINUX: Partial<Registry> = { device: { deviceId: "pc", name: "PC", platform: "linux" } };
const ON_IPAD: Partial<Registry> = { device: { deviceId: "ipad", name: "iPad", platform: "ios" } };
const PICKED = "Tracking: review results";

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
  document.documentElement.classList.remove("inspector-dragging");
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const shown = async (o: { over?: Partial<Registry>; place?: object; closed?: readonly PaneKey[] } = {}): Promise<TestSession> => {
  const t = await testSession(MESA_SEED);
  sessions.push(t.session);
  window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: t.session.view().plan.id, view: "timeline", zoom: "W", ...o.place }));
  seedPanesClosed(o.closed ?? ["outline"]);
  render(withSync(shellFor(t, o.over).ui));
  await settle();
  return t;
};

const bar = (): HTMLElement => {
  const el = document.querySelector("header.toolbar");
  if (!(el instanceof HTMLElement)) throw new Error("no toolbar");
  return el;
};

const toggle = (): HTMLElement => within(bar()).getByRole("button", { name: "Inspector" });

const slot = (): HTMLElement | null => document.querySelector<HTMLElement>(".slot-panel#inspector");

const handle = (): HTMLElement => screen.getByRole("separator", { name: "Resize the inspector" });

const drawer = (): HTMLElement | null => screen.queryByRole("dialog", { name: "Inspector" });

const stored = (): PanesRecord => {
  const raw = window.localStorage.getItem(PANES_KEY);
  if (raw === null) throw new Error("no saved panes");
  const record = parsePanes(raw);
  if (record === null) throw new Error("the saved panes do not parse");
  return record;
};

const press = (target: Element, key: string, o: { meta?: boolean; ctrl?: boolean; alt?: boolean; code?: string } = {}): void => {
  fireEvent.keyDown(target, { key, code: o.code ?? "", metaKey: o.meta ?? false, ctrlKey: o.ctrl ?? false, altKey: o.alt ?? false });
};

const panelWidth = (): string => {
  const body = document.querySelector(".app-body");
  if (!(body instanceof HTMLElement)) throw new Error("no .app-body");
  return body.style.getPropertyValue("--panel-w");
};

const option = (label: string): Element => {
  const item = screen.getByText(label).closest('[role="option"]');
  if (item === null) throw new Error(`no palette option ${label}`);
  return item;
};

describe("the inspector column", () => {
  it("is the last toolbar control, expanded and controlling the column, and hides and shows the column", async () => {
    await shown();
    const end = bar().querySelector(".toolbar-end");
    expect(end?.lastElementChild).toBe(toggle());
    expect([toggle().className, toggle().getAttribute("aria-expanded"), toggle().getAttribute("aria-controls"), toggle().title]).toEqual([
      "icon-button inspector-toggle",
      "true",
      "inspector",
      "Hide the inspector (⌥⌘I)",
    ]);
    expect(slot()?.querySelector(".panel h2")?.textContent).toBe("Plan");
    expect(handle().nextElementSibling).toBe(slot());
    fireEvent.click(toggle());
    expect(slot()).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize the inspector" })).toBeNull();
    expect([toggle().getAttribute("aria-expanded"), toggle().title]).toEqual(["false", "Show the inspector (⌥⌘I)"]);
    expect(stored().desk.inspector).toEqual({ open: false, w: null });
    fireEvent.click(toggle());
    expect(slot()).not.toBeNull();
    expect(stored().desk.inspector).toEqual({ open: true, w: null });
  });

  it("starts collapsed from the saved panes, with no slot and no divider", async () => {
    await shown({ closed: ["outline", "inspector"] });
    expect(slot()).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize the inspector" })).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles on ⌥⌘I on the Mac, by the physical key", async () => {
    await shown();
    press(document.body, "ˆ", { meta: true, alt: true, code: "KeyI" });
    expect(slot()).toBeNull();
    press(document.body, "ˆ", { meta: true, alt: true, code: "KeyI" });
    expect(slot()).not.toBeNull();
  });

  it("toggles on Ctrl Alt I off the Mac, and names it so", async () => {
    setPlatform(LINUX);
    await shown({ over: ON_LINUX });
    expect(toggle().title).toBe("Hide the inspector (Ctrl Alt I)");
    press(document.body, "i", { meta: true, alt: true, code: "KeyI" });
    expect(slot()).not.toBeNull();
    press(document.body, "i", { ctrl: true, alt: true, code: "KeyI" });
    expect(slot()).toBeNull();
  });

  it("offers Hide and Show the inspector in the palette, and runs it", async () => {
    await shown();
    press(document.body, "k", { meta: true });
    const hide = option("Hide the inspector");
    expect(hide.getAttribute("data-command")).toBe("inspector");
    fireEvent.mouseDown(hide);
    expect(slot()).toBeNull();
    press(document.body, "k", { meta: true });
    fireEvent.mouseDown(option("Show the inspector"));
    expect(slot()).not.toBeNull();
  });

  it("resizes from its leading divider, live, and commits once on release", async () => {
    await shown();
    const h = handle();
    expect([h.getAttribute("aria-valuemin"), h.getAttribute("aria-valuenow"), h.getAttribute("aria-controls")]).toEqual(["300", "360", "inspector"]);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 1000 });
    expect(document.documentElement.classList.contains("inspector-dragging")).toBe(true);
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 960 });
    expect([panelWidth(), h.getAttribute("aria-valuenow")]).toEqual(["400px", "400"]);
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 940 });
    expect(writes.mock.calls.filter((c) => c[0] === PANES_KEY)).toEqual([]);
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 940 });
    expect(document.documentElement.classList.contains("inspector-dragging")).toBe(false);
    expect(writes.mock.calls.filter((c) => c[0] === PANES_KEY)).toHaveLength(1);
    expect(stored().desk.inspector).toEqual({ open: true, w: 420 });
    expect([panelWidth(), handle().getAttribute("aria-valuenow")]).toEqual(["420px", "420"]);
    expect(JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null")).not.toHaveProperty("inspector");
  });

  it.each<readonly [string, (h: HTMLElement) => void]>([
    ["Esc", () => fireEvent.keyDown(window, { key: "Escape" })],
    ["pointercancel", (h) => fireEvent.pointerCancel(h, { pointerId: 1 })],
    ["a lost capture", (h) => fireEvent.lostPointerCapture(h, { pointerId: 1 })],
  ])("restores its width and commits nothing on %s mid-drag", async (_, end) => {
    await shown();
    const before = window.localStorage.getItem(PANES_KEY);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 1200 });
    expect(document.querySelector(".app-body")?.getAttribute("data-pane-snap")).toBe("inspector");
    end(handle());
    expect([panelWidth(), document.querySelector(".app-body")?.getAttribute("data-pane-snap"), handle().getAttribute("aria-valuenow"), document.documentElement.classList.contains("inspector-dragging")]).toEqual([
      "",
      null,
      "360",
      false,
    ]);
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 1200 });
    expect(window.localStorage.getItem(PANES_KEY)).toBe(before);
    expect(slot()).not.toBeNull();
  });

  it("snaps closed when dragged 48 px past its minimum, keeping the stored width", async () => {
    await shown();
    const h = handle();
    press(h, "ArrowLeft");
    expect(stored().desk.inspector).toEqual({ open: true, w: 376 });
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 1000 + 376 - 300 + 47 });
    expect(document.querySelector(".app-body")?.getAttribute("data-pane-snap")).toBeNull();
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 1000 + 376 - 300 + 49 });
    expect(document.querySelector(".app-body")?.getAttribute("data-pane-snap")).toBe("inspector");
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 1000 + 376 - 300 + 49 });
    expect(slot()).toBeNull();
    expect(document.querySelector(".app-body")?.getAttribute("data-pane-snap")).toBeNull();
    expect(stored().desk.inspector).toEqual({ open: false, w: 376 });
    fireEvent.click(toggle());
    expect(handle().getAttribute("aria-valuenow")).toBe("376");
  });

  it("steps with the arrows growing leftwards, goes to its limits on Home and End, and resets on Enter and a double click", async () => {
    await shown();
    press(handle(), "ArrowLeft");
    expect(stored().desk.inspector.w).toBe(376);
    press(handle(), "ArrowRight");
    press(handle(), "ArrowRight");
    expect(stored().desk.inspector.w).toBe(344);
    press(handle(), "Home");
    expect(stored().desk.inspector.w).toBe(300);
    press(handle(), "End");
    expect(stored().desk.inspector.w).toBe(Number(handle().getAttribute("aria-valuemax")));
    press(handle(), "Enter");
    expect([stored().desk.inspector, panelWidth()]).toEqual([{ open: true, w: null }, ""]);
    press(handle(), "Home");
    fireEvent.doubleClick(handle());
    expect(stored().desk.inspector).toEqual({ open: true, w: null });
  });

  it("holds the selected item, and Settings while it is open", async () => {
    await shown();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    expect(slot()?.querySelector(".panel .kind")?.textContent).toBe("TASK");
    fireEvent.click(within(bar()).getByRole("button", { name: "Settings" }));
    expect(slot()?.querySelector(".settings-head")).not.toBeNull();
  });

  it.each<readonly [string, () => void]>([
    ["the toolbar button", () => fireEvent.click(toggle())],
    ["⌥⌘I", () => press(document.body, "ˆ", { meta: true, alt: true, code: "KeyI" })],
    [
      "a snap-close drag",
      () => {
        fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 1000 });
        fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 1200 });
        fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 1200 });
      },
    ],
  ])("closes Settings, dropping its preview, when %s hides the inspector it lives in", async (_, hide) => {
    await shown();
    const settings = within(bar()).getByRole("button", { name: "Settings" });
    fireEvent.click(settings);
    expect(slot()?.querySelector(".settings-head")).not.toBeNull();
    hide();
    expect(slot()).toBeNull();
    expect(document.querySelector(".settings-head")).toBeNull();
    expect([settings.getAttribute("aria-pressed"), stored().desk.inspector.open]).toEqual(["false", false]);
    fireEvent.click(settings);
    expect(slot()?.querySelector(".settings-head")).not.toBeNull();
    expect(stored().desk.inspector.open).toBe(true);
  });

  it("reveals the column when Settings opens with the inspector collapsed", async () => {
    await shown({ closed: ["outline", "inspector"] });
    expect(slot()).toBeNull();
    fireEvent.click(within(bar()).getByRole("button", { name: "Settings" }));
    expect(slot()?.querySelector(".settings-head")).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(stored().desk.inspector.open).toBe(true);
  });
});

describe("the shell's guards", () => {
  it("throws, naming the list pane, when the stylesheet's --sidebar-w is not in px", async () => {
    document.documentElement.style.setProperty("--sidebar-w", "20rem");
    const t = await testSession(MESA_SEED);
    sessions.push(t.session);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(withSync(shellFor(t).ui))).toThrow(`list pane: the stylesheet's --sidebar-w is "20rem", not a px length`);
  });

  it("does not count an open pane drawer as a dialog, and counts any other modal", () => {
    const host = document.createElement("div");
    host.innerHTML = '<div class="plan-overlay" aria-modal="true"></div><div class="inspector-overlay" aria-modal="true"></div>';
    document.body.append(host);
    expect(document.querySelectorAll(`[aria-modal="true"]${NOT_A_PANE_OVERLAY}`)).toHaveLength(0);
    host.insertAdjacentHTML("beforeend", '<div class="modal" aria-modal="true"></div>');
    expect(Array.from(document.querySelectorAll(`[aria-modal="true"]${NOT_A_PANE_OVERLAY}`), (el) => el.className)).toEqual(["modal"]);
    host.remove();
  });
});

describe("the pane budget in the shell", () => {
  it("yields the list to a drawer at 1180 on the Timeline with the outline open, and gives the column back on the Board", async () => {
    setScreen(1180, 820);
    await shown({ closed: [] });
    expect(screen.queryByRole("navigation", { name: "Plans" })).toBeNull();
    expect(slot()).not.toBeNull();
    const list = within(bar()).getByRole("button", { name: "Plan list" });
    expect(list.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(list);
    const plans = screen.getByRole("dialog", { name: "Plans" });
    expect(plans.classList.contains("plan-overlay")).toBe(true);
    expect(document.querySelector("main.main")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(within(plans).getByRole("button", { name: "Close" }));
    fireEvent.click(within(bar()).getByRole("tab", { name: "Now · Next · Later" }));
    expect(screen.getByRole("navigation", { name: "Plans" }).closest('[role="dialog"]')).toBeNull();
    expect(stored().desk.list).toEqual({ open: true, w: null });
  });

  it("mirrors the desk list into the saved place on every commit", async () => {
    await shown();
    fireEvent.click(within(bar()).getByRole("button", { name: "Plan list" }));
    const place = (): unknown => JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null");
    expect(place()).toMatchObject({ sidebarOpen: false, sidebarWidth: null });
    expect(stored().desk.list).toEqual({ open: false, w: null });
  });

  it("toggles the outline from the palette on the Timeline, which the budget then counts", async () => {
    setScreen(1180, 820);
    await shown();
    expect(screen.getByRole("navigation", { name: "Plans" })).toBeTruthy();
    press(document.body, "k", { meta: true });
    fireEvent.mouseDown(option("Show the outline"));
    expect(stored().desk.outline.open).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Plans" })).toBeNull();
    press(document.body, "¬", { meta: true, alt: true, code: "KeyL" });
    expect(stored().desk.outline.open).toBe(false);
    expect(screen.getByRole("navigation", { name: "Plans" })).toBeTruthy();
  });
});

describe("the inspector drawer on an iPad at 834", () => {
  beforeEach(() => {
    setPlatform(IPAD);
    setScreen(834, 1194);
  });

  it("opens from the toolbar as a trailing modal drawer with a ✕, holding the plan, and closes into the button", async () => {
    await shown({ over: ON_IPAD });
    expect(slot()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle());
    const d = drawer();
    if (d === null) throw new Error("the inspector drawer did not open");
    expect([d.className, d.getAttribute("aria-modal"), toggle().getAttribute("aria-expanded")]).toEqual(["inspector-overlay", "true", "true"]);
    expect(d.firstElementChild?.className).toBe("drawer-head");
    expect(d.querySelector(".panel h2")?.textContent).toBe("Plan");
    expect(document.querySelector("main.main")?.hasAttribute("inert")).toBe(true);
    const close = within(d).getByRole("button", { name: "Close" });
    act(() => close.focus());
    fireEvent.click(close);
    expect(document.activeElement).toBe(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("main.main")?.hasAttribute("inert")).toBe(false);
  });

  it("opens on a new selection in place of the item sheet", async () => {
    await shown({ over: ON_IPAD });
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    const d = drawer();
    if (d === null) throw new Error("the selection did not open the inspector drawer");
    expect(d.querySelector(".panel .kind")?.textContent).toBe("TASK");
    expect(document.querySelector(".sheet")).toBeNull();
    press(d, "Escape");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it.each<readonly [string, (d: HTMLElement) => void]>([
    ["its ✕", (d) => fireEvent.click(within(d).getByRole("button", { name: "Close" }))],
    ["Esc", (d) => press(d, "Escape")],
    ["the toolbar button", () => fireEvent.click(toggle())],
  ])("lets go of the item when closed by %s, so a tap on the same item opens the drawer again", async (_, close) => {
    await shown({ over: ON_IPAD });
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    const d = drawer();
    if (d === null) throw new Error("the selection did not open the inspector drawer");
    close(d);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('.tl-row[aria-selected="true"]')).toBeNull();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    expect(drawer()?.querySelector(".panel .kind")?.textContent).toBe("TASK");
  });

  it("hands focus to the plan list button when the window narrows into the sheet form under an open drawer", async () => {
    await shown({ over: ON_IPAD });
    fireEvent.click(toggle());
    const d = drawer();
    if (d === null) throw new Error("the inspector drawer did not open");
    const close = within(d).getByRole("button", { name: "Close" });
    act(() => close.focus());
    act(() => setScreen(699, 1000));
    expect(drawer()).toBeNull();
    expect(within(bar()).queryByRole("button", { name: "Inspector" })).toBeNull();
    expect(document.activeElement).toBe(within(bar()).getByRole("button", { name: "Plans" }));
  });

  it("never stores a drawer", async () => {
    await shown({ over: ON_IPAD });
    const before = window.localStorage.getItem(PANES_KEY);
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(window.localStorage.getItem(PANES_KEY)).toBe(before);
  });
});
