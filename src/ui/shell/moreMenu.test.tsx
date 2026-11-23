import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { IPAD, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { shellFor } from "../../test/shell";
import { emitFromRust, resetTauri, tauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { PLACE_KEY } from "../state";
import { MEDIUM_MIN, ROOMY_MIN } from "./planListMode";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];
let unstub = (): void => undefined;
const ON_IPAD: Partial<Registry> = { device: { deviceId: "ipad", name: "iPad", platform: "ios" } };
const BOARD = "Board";

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
  setPlatform(IPAD);
  unstub = stubVisualViewport();
});

afterEach(async () => {
  unstub();
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

const at = async (width: number, o: { place?: object; over?: Partial<Registry> } = {}): Promise<TestSession> => {
  setScreen(width, 1194);
  const t = await testSession(MESA_SEED);
  sessions.push(t.session);
  window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: t.session.view().plan.id, view: "timeline", zoom: "W", ...o.place }));
  render(withSync(shellFor(t, o.over ?? ON_IPAD).ui));
  await settle();
  return t;
};

const bar = (): HTMLElement => {
  const el = document.querySelector("header.toolbar");
  if (!(el instanceof HTMLElement)) throw new Error("no toolbar");
  return el;
};

const inline = (): string[] =>
  Array.from(bar().querySelectorAll<HTMLElement>(".seg, button:not(.seg button)")).map((el) =>
    el.classList.contains("seg") ? `[${el.getAttribute("aria-label") ?? ""}]` : (el.getAttribute("aria-label") ?? el.textContent ?? ""),
  );

const more = (): HTMLElement => within(bar()).getByRole("button", { name: "More" });

interface Asked {
  token: string;
  sections: { title: string | null; rows: { id: string; title: string; checked: boolean }[] }[];
}

const lastAsk = (): Asked => {
  const all = tauri.calls.filter((c) => c.cmd === "menu_show").map((c) => (c.args as { menu: Asked }).menu);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error("More sent no menu_show");
  return last;
};

const opened = async (): Promise<Asked> => {
  fireEvent.click(more());
  await settle();
  expect(screen.queryByRole("menu")).toBeNull();
  return lastAsk();
};

const rows = (m: Asked): string[] => m.sections.flatMap((s) => [...(s.title === null ? [] : [`group ${s.title}`]), ...s.rows.map((r) => r.title)]);

const checks = (m: Asked): boolean[] => m.sections.filter((s) => s.title === "Zoom").flatMap((s) => s.rows.map((r) => r.checked));

const choose = (m: Asked, title: string): void => {
  const row = m.sections.flatMap((s) => s.rows).find((r) => r.title === title);
  if (row === undefined) throw new Error(`More has no row ${title}`);
  act(() => {
    emitFromRust("menu-ended", { token: m.token });
    emitFromRust("menu-chosen", { token: m.token, id: row.id });
  });
};

const gone = (): void => {
  expect(screen.queryByRole("menu")).toBeNull();
  expect(more().getAttribute("aria-expanded")).toBe("false");
};

const tab = (name: string): HTMLElement => within(bar()).getByRole("tab", { name });

describe("the iPad toolbar tiers", () => {
  it("shows everything inline in the roomy tier, with no More button", async () => {
    await at(ROOMY_MIN);
    expect(inline()).toEqual(["Plan list", "Local only", "[Views]", "[Zoom]", "Today", "Undo", "Redo", "Search", "+ New", "Settings", "Inspector"]);
    expect(within(bar()).queryByRole("button", { name: "More" })).toBeNull();
    expect(tab(BOARD).textContent).toBe(BOARD);
    expect(bar().querySelector(".sync-chip-text")?.textContent).toBe("Local only");
  });

  it("moves Settings into More in the medium tier, with short view labels, the sync dot and the Inspector button last", async () => {
    await at(ROOMY_MIN - 1);
    expect(inline()).toEqual(["Plan list", "Local only", "[Views]", "[Zoom]", "Today", "Undo", "Redo", "+ New", "More", "Inspector"]);
    expect(bar().lastElementChild?.lastElementChild).toBe(within(bar()).getByRole("button", { name: "Inspector" }));
    expect(bar().lastElementChild?.lastElementChild?.previousElementSibling?.firstElementChild).toBe(more());
    expect(Array.from(bar().querySelectorAll(".seg-modes button")).map((b) => [b.textContent, b.getAttribute("aria-label"), b.getAttribute("title")])).toEqual([
      ["Timeline", "Timeline", "Timeline"],
      ["Board", BOARD, BOARD],
      ["List", "List", "List"],
    ]);
    expect(rows(await opened())).toEqual(["Search…", "Settings"]);
  });

  it("is the narrow tier at 834 and the medium tier at MEDIUM_MIN", async () => {
    await at(834);
    expect(inline()).toEqual(["Plan list", "Local only", "[Views]", "Undo", "Redo", "+ New", "More", "Inspector"]);
    cleanup();
    await at(MEDIUM_MIN);
    expect(inline()).toEqual(["Plan list", "Local only", "[Views]", "[Zoom]", "Today", "Undo", "Redo", "+ New", "More", "Inspector"]);
  });

  it("moves zoom and Today into More in the narrow tier", async () => {
    await at(MEDIUM_MIN - 1);
    expect(inline()).toEqual(["Plan list", "Local only", "[Views]", "Undo", "Redo", "+ New", "More", "Inspector"]);
    expect([tab(BOARD).textContent, tab(BOARD).title]).toEqual(["Board", BOARD]);
    const m = await opened();
    expect(rows(m)).toEqual(["Search…", "group Zoom", "Week", "Month", "Quarter", "Fit", "Go to today", "Settings"]);
    expect(checks(m)).toEqual([true, false, false, false]);
  });

  it("leads with Plans below 700 in the narrow tier", async () => {
    await at(600);
    expect(inline()).toEqual(["Plans", "Local only", "[Views]", "Undo", "Redo", "+ New", "More"]);
    expect(rows(await opened())).toEqual(["Search…", "group Zoom", "Week", "Month", "Quarter", "Fit", "Go to today", "Settings", "Plan"]);
  });

  it("leaves out the zoom rows off the timeline, as the toolbar leaves out the zoom", async () => {
    await at(760, { place: { view: "board" } });
    expect(rows(await opened())).toEqual(["Search…", "Go to today", "Settings"]);
  });

  it("leaves out the plan rows with no plan open", async () => {
    setScreen(760, 1194);
    const t = await testSession(MESA_SEED);
    sessions.push(t.session);
    render(withSync(shellFor(t, { ...ON_IPAD, plans: () => [] }).ui));
    await settle();
    expect(inline()).toEqual(["Plan list", "Local only", "More"]);
    expect(rows(await opened())).toEqual(["Settings"]);
  });

  it("keeps the toolbar untouched on macOS at the same widths", async () => {
    setPlatform(MAC);
    await at(MEDIUM_MIN - 1, { over: { device: { deviceId: "d", name: "D", platform: "macos" } } });
    expect(within(bar()).queryByRole("button", { name: "More" })).toBeNull();
    expect(tab(BOARD).textContent).toBe(BOARD);
    expect(tab(BOARD).hasAttribute("aria-label")).toBe(false);
    expect(bar().querySelector(".sync-chip-text")?.textContent).toBe("Local only");
    expect(within(bar()).getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(within(bar()).getByRole("button", { name: "Today" })).toBeTruthy();
  });

  it("keeps the full form untouched on an iPad", async () => {
    setScreen(1194, 834);
    const t = await testSession(MESA_SEED);
    sessions.push(t.session);
    render(withSync(shellFor(t, ON_IPAD).ui));
    await settle();
    expect(within(bar()).queryByRole("button", { name: "More" })).toBeNull();
    expect(tab(BOARD).textContent).toBe(BOARD);
  });
});

describe("the More menu", () => {
  it("is an ellipsis button that asks for a native menu and renders no HTML list", async () => {
    await at(834);
    const b = more();
    expect([b.textContent, b.getAttribute("aria-haspopup"), b.getAttribute("aria-expanded")]).toEqual(["⋯", "menu", "false"]);
    await opened();
    expect(more().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".plan-menu-list")).toBeNull();
  });

  it("goes back to closed when the menu ends without a choice", async () => {
    await at(834);
    const m = await opened();
    act(() => emitFromRust("menu-ended", { token: m.token }));
    gone();
    expect(screen.queryAllByRole("dialog")).toEqual([]);
  });

  it("sets the zoom from a Zoom row, and the check follows", async () => {
    await at(MEDIUM_MIN - 1);
    choose(await opened(), "Quarter");
    gone();
    const again = await opened();
    expect(again.sections.filter((x) => x.title === "Zoom").flatMap((x) => x.rows.map((r) => [r.title, r.checked]))).toEqual([
      ["Week", false],
      ["Month", false],
      ["Quarter", true],
      ["Fit", false],
    ]);
  });

  it("runs Go to today as the Today button does", async () => {
    await at(MEDIUM_MIN - 1, { place: { view: "board" } });
    expect(tab(BOARD).getAttribute("aria-selected")).toBe("true");
    choose(await opened(), "Go to today");
    gone();
    expect(tab("Timeline").getAttribute("aria-selected")).toBe("true");
  });

  it("opens Settings from its row once", async () => {
    await at(834);
    choose(await opened(), "Settings");
    gone();
    expect(screen.getAllByRole("dialog").map((d) => [d.getAttribute("aria-label"), d.hasAttribute("data-settings-modal")])).toEqual([["General", true]]);
  });

  it("puts Search… in More at the medium tier, opens the Search popover from it with the field focused, and gives focus back to More on close", async () => {
    await at(ROOMY_MIN - 1);
    expect(within(bar()).queryByRole("button", { name: "Search" })).toBeNull();
    expect(bar().querySelector(".search-field")).toBeNull();
    choose(await opened(), "Search…");
    gone();
    await settle();
    const pop = screen.getByRole("dialog", { name: "Search" });
    const field = within(pop).getByRole("searchbox", { name: "Search this plan" });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "dome" } });
    expect(within(pop).getByText(/^\d+ of \d+$/)).toBeTruthy();
    fireEvent.click(within(pop).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it("opens the Plan sheet from its row below 700", async () => {
    await at(600);
    choose(await opened(), "Plan");
    gone();
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Plan"]);
  });

  it("opens from the toolbar while the plan list is open, and its Settings row adds the Settings modal", async () => {
    await at(834);
    fireEvent.click(within(bar()).getByRole("button", { name: "Plan list" }));
    expect(screen.getByRole("dialog", { name: "Plans" })).toBeTruthy();
    choose(await opened(), "Settings");
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Plans", "General"]);
  });

  it("keeps the plan list open when a tap reaches its scrim while the native menu is up", async () => {
    await at(834);
    fireEvent.click(within(bar()).getByRole("button", { name: "Plan list" }));
    const m = await opened();
    const scrim = document.querySelector(".plan-overlay-scrim");
    if (!(scrim instanceof HTMLElement)) throw new Error("no scrim");
    const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(scrim);
    fireEvent.pointerDown(scrim, { button: 0, pointerType: "touch", clientX: 600, clientY: 400 });
    fireEvent.pointerUp(scrim, { button: 0, pointerType: "touch", clientX: 600, clientY: 400 });
    fireEvent.click(scrim, { button: 0, clientX: 600, clientY: 400 });
    under.mockRestore();
    expect(within(bar()).getByRole("button", { name: "Plan list" }).getAttribute("aria-expanded")).toBe("true");
    act(() => emitFromRust("menu-ended", { token: m.token }));
    gone();
  });

  it("dismisses its menu when a resize takes its zoom rows away, and drops a late choice", async () => {
    await at(800);
    const m = await opened();
    act(() => setScreen(900, 1194));
    await settle();
    expect(tauri.calls.filter((c) => c.cmd === "menu_dismiss").map((c) => c.args)).toEqual([{ token: m.token }]);
    choose(m, "Settings");
    gone();
    expect(screen.queryAllByRole("dialog")).toEqual([]);
  });

  it("hands focus to the Settings button when a resize takes the focused More button away, and dismisses its menu", async () => {
    await at(900);
    more().focus();
    const m = await opened();
    act(() => setScreen(ROOMY_MIN, 1194));
    await settle();
    expect(within(bar()).queryByRole("button", { name: "More" })).toBeNull();
    expect(document.activeElement).toBe(within(bar()).getByRole("button", { name: "Settings" }));
    expect(tauri.calls.filter((c) => c.cmd === "menu_dismiss").map((c) => c.args)).toEqual([{ token: m.token }]);
  });
});

describe("the sync chip's place", () => {
  const placeOf = (): [boolean, boolean] => {
    const chip = bar().querySelector(".sync-chip");
    if (chip === null) throw new Error("no sync chip in the toolbar");
    return [chip.closest(".toolbar-start") !== null, chip.closest(".toolbar-end") !== null];
  };

  it("sits in the leading group on the desk, not the trailing one", async () => {
    setPlatform(MAC);
    await at(1440, { over: { device: { deviceId: "d", name: "D", platform: "macos" } } });
    expect([placeOf(), bar().querySelector(".toolbar-start .sync-chip-text")?.textContent]).toEqual([[true, false], "Local only"]);
  });

  it.each([
    ["roomy", ROOMY_MIN, false],
    ["medium", ROOMY_MIN - 1, true],
    ["medium at its minimum", MEDIUM_MIN, true],
    ["narrow", MEDIUM_MIN - 1, true],
    ["narrow below 700", 600, true],
  ])("sits in the leading group in the iPad %s tier, compact only when folded", async (_tier, width, compact) => {
    await at(width);
    expect([placeOf(), bar().querySelector(".toolbar-start .sync-chip")?.classList.contains("chip-compact")]).toEqual([[true, false], compact]);
  });
});

describe("the sync dot", () => {
  it("carries the chip's text as its label and opens sync", async () => {
    await at(834);
    const dot = within(bar()).getByRole("button", { name: "Local only" });
    expect([dot.classList.contains("chip-compact"), dot.querySelector(".sync-chip-text")]).toEqual([true, null]);
    fireEvent.click(dot);
    expect(screen.getByRole("dialog", { name: "Sync" })).toBeTruthy();
  });
});
