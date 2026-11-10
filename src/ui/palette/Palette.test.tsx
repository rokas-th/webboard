import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import { toDay } from "../../domain/dates";
import type { PlanSession } from "../../store/session";
import { MESA_SEED, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { shellFor } from "../../test/shell";
import { clearToasts } from "../common/Toast";
import { READ_ONLY } from "../run";
import { useUi, type UiState } from "../state";
import { geometry, leadFor, ROW } from "../timeline/geometry";
import { timelineRows } from "../timeline/rows";
import type { Command } from "./commands";
import { shownCommands } from "./Palette";
import { withSync } from "../../test/withSync";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
};

const shown = async (t: TestSession, over?: Parameters<typeof shellFor>[1]) => {
  const s = shellFor(t, over);
  render(withSync(s.ui));
  await settle();
  return s;
};

const uiNow = (): [UiState, (patch: Partial<UiState>) => void] => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value;
};

const setUi = (patch: Partial<UiState>): void => act(() => uiNow()[1](patch));

const press = (key: string, o: Partial<KeyboardEventInit> = {}, target: Element = document.body): void => {
  act(() => {
    fireEvent.keyDown(target, { key, ...o });
  });
};

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const palette = (): HTMLElement => screen.getByRole("dialog", { name: "Command palette" });
const query = (): HTMLInputElement => {
  const el = within(palette()).getByRole("textbox", { name: "Command" });
  if (!(el instanceof HTMLInputElement)) throw new Error("no palette input");
  return el;
};
const rows = (): string[] => within(palette()).queryAllByRole("option").map((o) => o.textContent ?? "");
const highlighted = (): string | null => palette().querySelector('[role="option"][aria-selected="true"]')?.textContent ?? null;
const type = (text: string): void => {
  act(() => {
    fireEvent.change(query(), { target: { value: text } });
  });
};
const runFromPalette = (text: string): void => {
  press("k", { metaKey: true });
  type(text);
  press("Enter", {}, query());
};

const panel = (): HTMLElement => {
  const el = document.querySelector('[data-slot="panel"]');
  if (!(el instanceof HTMLElement)) throw new Error("no panel");
  return el;
};

const nameField = (): HTMLInputElement => {
  const el = within(panel()).getByLabelText("Name");
  if (!(el instanceof HTMLInputElement)) throw new Error("no name field");
  return el;
};

const expectNameFocused = (name: string): void => {
  const field = nameField();
  expect(field.value).toBe(name);
  expect(document.activeElement).toBe(field);
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, name.length]);
};

const bar = (): HTMLElement => {
  const el = document.querySelector("header.toolbar");
  if (!(el instanceof HTMLElement)) throw new Error("no toolbar");
  return el;
};

const pickNew = (name: string): void => {
  fireEvent.click(button(bar(), "+ New"));
  fireEvent.click(within(within(bar()).getByRole("menu")).getByRole("menuitem", { name }));
};

const button = (root: HTMLElement, name: string): HTMLButtonElement => {
  const el = within(root).getByRole("button", { name });
  if (!(el instanceof HTMLButtonElement)) throw new Error("no button " + name);
  return el;
};

describe("opening the palette", () => {
  it("opens one palette with its input focused on ⌘K, on the toolbar's ⌘K, and closes on Esc", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    press("k", { metaKey: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(query());
    press("Escape", {}, query());
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button(bar(), "⌘K"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(query());
  });

  it("opens on Ctrl K off macOS, and ⌘K does nothing there", async () => {
    const t = await made(MESA_SEED);
    await shown(t, { device: { deviceId: "mac", name: "Linux", platform: "linux" } });
    press("k", { metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    press("k", { ctrlKey: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("takes the modifier from the device's platform, not from a web view that names itself MacIntel", async () => {
    const t = await made(MESA_SEED);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await shown(t, { device: { deviceId: "mac", name: "Linux", platform: "linux" } });
    press("k", { metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    press("k", { ctrlKey: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("uses ⌘ on macOS whatever the web view names itself", async () => {
    const t = await made(MESA_SEED);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await shown(t);
    press("k", { ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    press("k", { metaKey: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("opens in the empty state from the key and from the toolbar", async () => {
    const t = await made(MESA_SEED);
    await shown(t, { plans: () => [] });
    expect(document.querySelector(".empty-state")).not.toBeNull();
    press("k", { metaKey: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(query());
    expect(rows().map((r) => r.replace(/⌘K$/, ""))).toEqual(["FileNew plan", "FileCreate the example plan", "FileImport plan…", "FileSet up sync", "FileJoin with a code", "FileSync devices", "HelpCommand palette", "HelpAbout WebBoard"]);
    press("Escape", {}, query());
    fireEvent.click(button(bar(), "⌘K"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(query());
  });

  it("returns focus, when a dialog a palette command opened closes, to what had focus before the palette", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    const opener = button(panel(), "Change calendar…");
    opener.focus();
    press("k", { metaKey: true }, opener);
    expect(document.activeElement).toBe(query());
    type("About WebBoard");
    press("Enter", {}, query());
    const about = screen.getByRole("dialog", { name: "About WebBoard" });
    expect(about.contains(document.activeElement)).toBe(true);
    press("Escape", {}, about);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("does nothing on ⌘K while another dialog is open, and the dialog keeps its draft", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    fireEvent.click(button(panel(), "Change calendar…"));
    await settle();
    const calendar = screen.getByRole("dialog", { name: "Calendar · Plan" });
    const days = within(calendar).getByRole("group", { name: "Working days" });
    const dayOff = within(days).getAllByRole("button").find((b) => b.getAttribute("aria-pressed") === "false");
    if (dayOff === undefined) throw new Error("no day off to switch on");
    fireEvent.click(dayOff);
    expect(dayOff.getAttribute("aria-pressed")).toBe("true");
    press("k", { metaKey: true }, dayOff);
    press("k", { metaKey: true });
    expect(uiNow()[0].dialog).toEqual({ t: "calendar" });
    expect(screen.getAllByRole("dialog")).toEqual([calendar]);
    expect(dayOff.isConnected).toBe(true);
    expect(dayOff.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("does nothing on Ctrl K off macOS while another dialog is open", async () => {
    const t = await made(MESA_SEED);
    await shown(t, { device: { deviceId: "mac", name: "Linux", platform: "linux" } });
    setUi({ dialog: { t: "about" } });
    const about = screen.getByRole("dialog");
    press("k", { ctrlKey: true }, about);
    expect(uiNow()[0].dialog).toEqual({ t: "about" });
    expect(screen.getAllByRole("dialog")).toEqual([about]);
  });

  it("does nothing for a key whose command is absent in the empty state", async () => {
    const t = await made(MESA_SEED);
    await shown(t, { plans: () => [] });
    const before = uiNow()[0];
    ["n", "1", "2", "z"].forEach((k) => press(k, k === "z" ? { metaKey: true } : {}));
    expect(uiNow()[0]).toEqual(before);
    expect(toastTexts()).toEqual([]);
  });
});

describe("the palette list", () => {
  it("shows Go to only for a query", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    press("k", { metaKey: true });
    expect(rows().filter((r) => r.startsWith("Go to"))).toEqual([]);
    type("review results");
    expect(rows()).toEqual(["Go toTracking: review results"]);
    type("zzzz");
    expect(rows()).toEqual([]);
    expect(within(palette()).getByText("No command or item matches.")).toBeTruthy();
  });

  it("moves with ↑ and ↓ and runs the highlighted command on Enter", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    press("k", { metaKey: true });
    type("view");
    expect(rows()).toEqual(["ViewTimeline1", "ViewNow · Next · Later2", "ViewList3", "ViewJump to todayT", "ViewCollapse all groups", "ViewExpand all groups", "Go toTracking: review results"]);
    expect(highlighted()).toBe("ViewTimeline1");
    press("ArrowUp", {}, query());
    expect(highlighted()).toBe("ViewTimeline1");
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    [1, 2, 3, 4, 5, 6, 7].forEach(() => press("ArrowDown", {}, query()));
    expect(highlighted()).toBe("Go toTracking: review results");
    const lastScrolled = (): string | null => {
      const el: unknown = scrolled.mock.contexts[scrolled.mock.contexts.length - 1];
      if (!(el instanceof Element)) throw new Error("scrollIntoView was not called on an element");
      expect(el.classList.contains("on")).toBe(true);
      return el.textContent;
    };
    expect([scrolled.mock.calls.length, lastScrolled()]).toEqual([6, "Go toTracking: review results"]);
    expect(scrolled.mock.calls).toEqual([1, 2, 3, 4, 5, 6].map(() => [{ block: "nearest" }]));
    [1, 2, 3, 4, 5].forEach(() => press("ArrowUp", {}, query()));
    expect(highlighted()).toBe("ViewNow · Next · Later2");
    expect([scrolled.mock.calls.length, lastScrolled()]).toEqual([11, "ViewNow · Next · Later2"]);
    press("Enter", {}, query());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uiNow()[0].view).toBe("board");
  });

  it("caps the list at 40", () => {
    const many: Command[] = Array.from({ length: 50 }, (_, i) => ({ id: `goto:${i}`, group: "Go to", label: `Item ${i}`, run: () => undefined }));
    expect(shownCommands(many, "item")).toHaveLength(40);
    expect(shownCommands(many, "")).toEqual([]);
  });

  it("selects and reveals an item from Go to, expanding its group", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    setUi({ view: "board", collapsed: new Set(["g2"]) });
    runFromPalette("First light: dry");
    expect(uiNow()[0].selected).toBe("t7");
    expect(uiNow()[0].view).toBe("timeline");
    expect([...uiNow()[0].collapsed]).toEqual([]);
    expect(uiNow()[0].reveal).toBeNull();
    expect(nameField().value).toBe("First light: dry runs");
  });

  it("selects a group from Go to and scrolls the timeline to its row", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    setUi({ view: "board", collapsed: new Set(["g2"]) });
    runFromPalette("Visitor services");
    const scroll = document.querySelector(".tl-scroll");
    if (!(scroll instanceof HTMLElement)) throw new Error("no timeline");
    const index = timelineRows(t.session.view(), new Set(["g2"])).findIndex((r) => r.id === "g3");
    expect(index).toBe(6);
    expect([uiNow()[0].selected, uiNow()[0].view, [...uiNow()[0].collapsed], uiNow()[0].reveal]).toEqual(["g3", "timeline", ["g2"], null]);
    expect(scroll.scrollTop).toBe(index * ROW);
  });

  it("jumps to today from another view, scrolling the timeline to today's column", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    const scroll = document.querySelector(".tl-scroll");
    if (!(scroll instanceof HTMLElement)) throw new Error("no timeline");
    const view = t.session.view();
    const todayAt = Math.max(0, geometry(view, "W").x(toDay(view.today)) - leadFor(0));
    expect(todayAt).toBeGreaterThan(0);
    setUi({ view: "list" });
    runFromPalette("Jump to today");
    const again = document.querySelector(".tl-scroll");
    if (!(again instanceof HTMLElement)) throw new Error("no timeline after the jump");
    expect(again.scrollLeft).toBe(todayAt);
    act(() => {
      again.scrollLeft = 0;
    });
    runFromPalette("Jump to today");
    expect([uiNow()[0].view, uiNow()[0].reveal, again.scrollLeft]).toEqual(["timeline", null, todayAt]);
  });

  it("creates a plan once from New plan", async () => {
    const t = await made(MESA_SEED);
    const createPlan = vi.fn(() => new Promise<string>(() => undefined));
    await shown(t, { createPlan });
    runFromPalette("New plan");
    runFromPalette("New plan");
    expect(createPlan.mock.calls).toEqual([["New plan"]]);
  });

  it("opens the calendar dialog", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    runFromPalette("Change calendar");
    expect(uiNow()[0].dialog).toEqual({ t: "calendar" });
  });

  it("goes to the first conflict the way the head's button does", async () => {
    const t = await made([
      { id: "a", name: "A", start: "2026-11-10", dur: 3 },
      { id: "b", name: "B", start: "2026-11-10", dur: 2, deps: [{ from: "a", type: "FS", lag: 0 }] },
    ]);
    await shown(t);
    setUi({ view: "list" });
    runFromPalette("first conflict");
    expect([uiNow()[0].view, uiNow()[0].selected, uiNow()[0].reveal]).toEqual(["timeline", "b", null]);
  });
});

describe("About", () => {
  it("names the version and the holiday data", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    runFromPalette("About");
    const box = screen.getByRole("dialog", { name: "About WebBoard" });
    expect(within(box).getByText(`WebBoard ${version}`)).toBeTruthy();
    expect(within(box).getByText("Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.").textContent).toBe("Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.");
    fireEvent.click(button(box, "Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("new items from keys, toolbar and palette", () => {
  it("adds a task on N after the selection, focused and selected for renaming", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    setUi({ selected: "t3" });
    const apply = vi.spyOn(t.session, "apply");
    press("n");
    expect(apply.mock.calls).toEqual([[{ t: "create", kind: "task", name: "New task", parent: "g2", after: "t3", start: "2026-11-10", dur: 3 }]]);
    expectNameFocused("New task");
    expect(uiNow()[0].naming).toBeNull();
  });

  it.each(["toolbar", "palette"])("adds a group from the %s", async (from) => {
    const t = await made(MESA_SEED);
    await shown(t);
    const apply = vi.spyOn(t.session, "apply");
    if (from === "toolbar") pickNew("New group");
    else runFromPalette("New group");
    expect(apply.mock.calls).toEqual([[{ t: "create", kind: "group", name: "New group", parent: null, after: null, start: null }]]);
    expect(t.session.history()[0].label).toBe("Added group “New group”");
    expectNameFocused("New group");
  });

  it("offers task, milestone and group from the toolbar's one + New menu", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    expect(within(bar()).queryByRole("button", { name: "+ Task" })).toBeNull();
    expect(within(bar()).queryByRole("button", { name: "+ Group" })).toBeNull();
    const add = button(bar(), "+ New");
    expect([add.getAttribute("aria-haspopup"), add.getAttribute("aria-expanded")]).toEqual(["menu", "false"]);
    fireEvent.click(add);
    const menu = within(bar()).getByRole("menu", { name: "New item" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["New task", "New milestone", "New group"]);
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "New task" }));
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New task" }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(within(bar()).queryByRole("menu")).toBeNull();
    expectNameFocused("New task");
  });

  it("adds a milestone after the selection from the + New menu and on M", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    setUi({ selected: "t3" });
    const apply = vi.spyOn(t.session, "apply");
    pickNew("New milestone");
    expect(apply.mock.calls).toEqual([[{ t: "create", kind: "milestone", name: "New milestone", parent: "g2", after: "t3", start: "2026-11-10" }]]);
    expectNameFocused("New milestone");
    act(() => {
      nameField().blur();
    });
    press("m");
    expect(apply.mock.calls.map((c) => c[0].t)).toEqual(["create", "create"]);
    expectNameFocused("New milestone");
    press("m", {}, nameField());
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("enters items from the keyboard alone: N, type, Enter, N again", async () => {
    const t = await made([{ id: "a", name: "Alpha", start: "2026-11-10", dur: 2 }]);
    await shown(t);
    press("n");
    act(() => {
      fireEvent.change(nameField(), { target: { value: "First" } });
    });
    act(() => {
      fireEvent.keyDown(nameField(), { key: "Enter" });
    });
    expect(document.activeElement).toBe(document.body);
    press("n");
    expectNameFocused("New task");
    const names = [...t.session.view().plan.items.values()].map((i) => i.name).sort();
    expect(names).toEqual(["Alpha", "First", "New task"]);
  });

  it("adds a milestone from the palette", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    setUi({ selected: "g3" });
    const apply = vi.spyOn(t.session, "apply");
    runFromPalette("New milestone");
    expect(apply.mock.calls).toEqual([[{ t: "create", kind: "milestone", name: "New milestone", parent: "g3", after: null, start: "2026-11-10" }]]);
    expect(t.session.history()[0].label).toBe("Added milestone “New milestone”");
    expectNameFocused("New milestone");
  });
});

describe("undo through the keys", () => {
  it("offers Keep the other version on ⌘Z for an open choice, without undoing or resolving", async () => {
    const t = await made([
      { name: "A", start: "2026-11-10", dur: 3 },
      { name: "B", start: "2026-11-16", dur: 2 },
    ]);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "move", items: ["A"], days: 1 });
    p.session.apply({ t: "move", items: ["A"], days: 2 });
    p.sync();
    const offer = t.session.undoOffer();
    if (offer === null) throw new Error("fixture: no undo offer");
    await shown(t);
    const undo = vi.spyOn(t.session, "undo");
    const resolve = vi.spyOn(t.session, "resolve");
    press("z", { metaKey: true });
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: offer.choice, side: offer.side });
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep the other version" })).toBeTruthy();
    expect([undo.mock.calls.length, resolve.mock.calls.length]).toEqual([0, 0]);
  });

  it("undoes and redoes on ⌘Z and ⇧⌘Z, and leaves a text field's own undo alone", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    const undo = vi.spyOn(t.session, "undo");
    const redo = vi.spyOn(t.session, "redo");
    setUi({ selected: "t3" });
    press("z", { metaKey: true }, nameField());
    expect([undo.mock.calls.length, redo.mock.calls.length]).toEqual([0, 0]);
    press("z", { metaKey: true });
    press("z", { metaKey: true, shiftKey: true });
    expect([undo.mock.calls.length, redo.mock.calls.length]).toEqual([1, 1]);
  });

  it("redoes on Ctrl+Y off macOS", async () => {
    const t = await made(MESA_SEED);
    await shown(t, { device: { deviceId: "mac", name: "Linux", platform: "linux" } });
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    const redo = vi.spyOn(t.session, "redo");
    press("z", { ctrlKey: true });
    press("y", { ctrlKey: true });
    expect(redo).toHaveBeenCalledTimes(1);
  });
});

describe("keys on the selection", () => {
  it("nudges, resizes, trashes and lets go", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    setUi({ selected: "t5" });
    const apply = vi.spyOn(t.session, "apply");
    press("ArrowRight", { altKey: true });
    press("ArrowLeft", { shiftKey: true });
    press("Delete");
    expect(apply.mock.calls.map((c) => c[0])).toEqual([
      { t: "move", items: ["t5"], days: 5 },
      { t: "resize", item: "t5", dur: 4 },
      { t: "trash", items: ["t5"] },
    ]);
    setUi({ selected: "t3" });
    press("Escape");
    expect(uiNow()[0].selected).toBeNull();
  });

  it("switches views on 1 2 3, not while typing", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    press("2");
    expect(uiNow()[0].view).toBe("board");
    press("3");
    expect(uiNow()[0].view).toBe("list");
    setUi({ selected: "t3" });
    press("1", {}, nameField());
    expect(uiNow()[0].view).toBe("list");
    press("1");
    expect(uiNow()[0].view).toBe("timeline");
  });

  it("treats editable content as typing and a checkbox as not typing", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "");
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.append(editable, box);
    try {
      press("2", {}, editable);
      expect(uiNow()[0].view).toBe("timeline");
      press("2", {}, box);
      expect(uiNow()[0].view).toBe("board");
    } finally {
      editable.remove();
      box.remove();
    }
  });
});

describe("read-only", () => {
  it("disables + New, and refuses every new item with the read-only toast", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    act(() => t.session.setReadOnly(true));
    const add = button(bar(), "+ New");
    expect(add.disabled).toBe(true);
    const apply = vi.spyOn(t.session, "apply");
    runFromPalette("New task");
    runFromPalette("New milestone");
    runFromPalette("New group");
    press("n");
    press("m");
    expect(apply).toHaveBeenCalledTimes(0);
    expect(toastTexts()).toEqual([READ_ONLY, READ_ONLY, READ_ONLY, READ_ONLY, READ_ONLY]);
    act(() => t.session.setReadOnly(false));
    expect(add.disabled).toBe(false);
  });

  it("answers writing keys with the read-only message and leaves no enabled writing control", async () => {
    const t = await made(MESA_SEED, { clashes: [{ unit: "n:t3", mac: "North", iphone: "South" }] });
    await shown(t);
    setUi({ selected: "t3" });
    const spies = (["apply", "undo", "redo", "resolve", "revert"] as const).map((m) => vi.spyOn(t.session, m));
    const rejected = vi.fn();
    window.addEventListener("unhandledrejection", rejected);
    try {
      act(() => t.session.setReadOnly(true));
      press("z", { metaKey: true });
      press("ArrowRight");
      press("Delete");
      expect(toastTexts()).toEqual([READ_ONLY, READ_ONLY, READ_ONLY]);
      press("Escape");
      expect(document.querySelector('[data-slot="panel"] .panel')).not.toBeNull();
      expect(within(panel()).queryByLabelText("Name")).toBeNull();
      const enabled = (root: ParentNode): string[] =>
        [...root.querySelectorAll("button, input, select, textarea")]
          .filter((e) => !(e instanceof HTMLButtonElement || e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) || !e.disabled)
          .filter((e) => !((e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) && e.readOnly))
          .map((e) => e.closest("label")?.textContent ?? e.textContent ?? "");
      expect(enabled(panel())).toEqual([]);
      fireEvent.click(within(bar()).getByRole("tab", { name: "Now · Next · Later" }));
      const board = document.querySelector('[data-slot="board"]');
      if (!(board instanceof HTMLElement)) throw new Error("no board");
      expect(board.querySelectorAll(".card").length).toBeGreaterThan(0);
      expect(enabled(board)).toEqual([]);
      const head = document.querySelector(".plan-head");
      if (!(head instanceof HTMLElement)) throw new Error("no head");
      fireEvent.click(within(head).getByRole("button", { name: /Choose…/ }));
      const row = document.querySelector(".choice-row");
      if (!(row instanceof HTMLElement)) throw new Error("no choice row");
      fireEvent.click(row);
      const choice = screen.getByRole("dialog");
      expect(within(choice).getAllByRole("button", { name: /^Keep / }).map((b) => b.hasAttribute("disabled"))).toEqual([true, true]);
      expect(enabled(choice)).toEqual(["Push from predecessors", "Return the items the other side's push moved", "Pick per item"]);
      spies.forEach((s) => expect(s).not.toHaveBeenCalled());
      await settle();
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", rejected);
    }
  });
});
