import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { IPAD, LINUX, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { fs, TEST_PLAN, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { shellFor } from "../../test/shell";
import { emitFromRust, resetTauri, tauri } from "../../test/tauriMock";
import { clearToasts } from "../common/Toast";
import { useUi, type UiState } from "../state";
import { LONG_PRESS_MS } from "../timeline/touch";
import { statusLabel } from "./groups";
import { listModel } from "./model";
import { DEFAULT_LIST_PREFS, listKey, type ListPrefs } from "./prefs";
import { withSync } from "../../test/withSync";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));
vi.mock("./model", async (importOriginal) => {
  const m = await importOriginal<typeof import("./model")>();
  return { ...m, listModel: vi.fn(m.listModel) };
});
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

const list = async (t: TestSession): Promise<void> => {
  render(withSync(shellFor(t).ui));
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: "List" }));
};

const setUiNow = (patch: Partial<UiState>): void => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  act(() => r.value[1](patch));
};

const uiNow = (): UiState => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value[0];
};

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const all = (sel: string, root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

const row = (id: string): HTMLElement => one(`[data-lrow="${id}"]`);
const cells = (id: string): (string | null)[] => all("td", row(id)).map((c) => c.textContent);

const pointer = (el: Element, kind: "down" | "up", x: number, y: number): void => {
  const init = { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" };
  act(() => {
    if (kind === "down") fireEvent.pointerDown(el, init);
    else fireEvent.pointerUp(el, init);
  });
};

const STATUS_SEED: SeedItem[] = [
  { name: "L", start: "2026-11-02", dur: 2 },
  { name: "P", start: "2026-11-10", dur: 3, status: "doing" },
  { name: "C", start: "2026-11-11", dur: 1, deps: [fs("P")] },
  { name: "D", start: "2026-11-03", status: "done", progress: 100 },
  { name: "U" },
];

const SPRINT: SeedItem[] = [
  { id: "S", name: "Sprint 4", kind: "group" },
  { id: "r", name: "Review", parent: "S", start: "2026-11-10", dur: 3, status: "doing" },
  { id: "x", name: "Other", start: "2026-11-16", dur: 2 },
];

const OLD_COLUMNS: ListPrefs = {
  ...DEFAULT_LIST_PREFS,
  cols: [
    { id: "name", w: 300 },
    { id: "start", w: 88 },
    { id: "end", w: 88 },
    { id: "days", w: 64 },
    { id: "status", w: 110 },
    { id: "deps", w: 180 },
  ],
  scope: "all",
};

const seedPrefs = (prefs: ListPrefs): void => {
  window.localStorage.setItem(listKey(TEST_PLAN), JSON.stringify(prefs));
};

const rowIds = (): (string | undefined)[] => all("tbody tr[data-lrow]").map((r) => r.dataset.lrow);

const sections = (): (string | undefined)[] => all("tbody tr:not(.list-pad)").map((r) => (r.classList.contains("grp") ? `# ${one(".grp-name", r).textContent}` : r.dataset.lrow));

const head = (col: string): HTMLElement => one(`thead th[data-col="${col}"]`);

const sortBy = (col: string, shift = false): void => {
  act(() => {
    fireEvent.click(one(".th-sort", head(col)), { shiftKey: shift });
  });
};

const sorted = (): [string | undefined, string | null][] =>
  all("thead th")
    .filter((th) => th.hasAttribute("aria-sort"))
    .map((th) => [th.dataset.col, th.getAttribute("aria-sort")]);

const chevrons = (): [string | undefined, string | null][] => all("thead th .sort-chev").map((c) => [c.closest("th")?.dataset.col, c.textContent]);

const stubHeight = (px: number): (() => void) => {
  if (Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") !== undefined) throw new Error("clientHeight is already stubbed");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains("list-wrap") ? px : 0;
    },
  });
  return () => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  };
};

const SPRINT_MORE: SeedItem[] = [...SPRINT.slice(0, 2), { id: "m", name: "Ship", kind: "milestone", parent: "S", start: "2026-11-20" }, SPRINT[2]];

const scopes = (): (string | null | undefined)[][] =>
  all(".scope-bar [role='radio']").map((r) => [r.dataset.scope, one(".scope-label", r).textContent, one(".scope-n", r).textContent, r.getAttribute("aria-checked"), r.getAttribute("title")]);

const focusedScope = (): string | undefined => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.scope : undefined);

const checkedScope = (): string | undefined => one(".scope-bar [aria-checked='true']").dataset.scope;

const chips = (): (string | null | undefined)[][] => all(".chip-row .filter-chip").map((c) => [c.dataset.chip, one(".chip-text", c).textContent, one(".chip-x", c).getAttribute("aria-label")]);

const THOUSAND: SeedItem[] = Array.from({ length: 1000 }, (_, i) => ({ id: `i${i}`, name: `Task ${i}` }));

describe("List", () => {
  it("has the columns Name Step Assignees Start End Status, sorted by Plan order", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    const ths = all("thead th");
    expect(ths.map((e) => e.textContent)).toEqual(["Name", "Step", "Assignees", "Start", "End", "Status"]);
    expect(ths.map((e) => e.dataset.col)).toEqual(["name", "step", "assignees", "start", "end", "status"]);
    expect(all("thead th .th-sort").map((b) => b.getAttribute("title"))).toEqual(Array.from({ length: 6 }, () => "Click to sort · Shift-click adds a key"));
    expect(sorted()).toEqual([]);
    expect(rowIds()).toEqual(["L", "P", "C", "U"]);
    expect(one("table.list").style.width).toBe("896px");
    expect(all("colgroup col").map((c) => c.style.width)).toEqual(["300px", "140px", "170px", "88px", "88px", "110px"]);
    expect(uiNow().selected).toBeNull();
  });

  it("sorts by a clicked header, reverses on a second click and returns to Plan order on a third, with aria-sort on that header only", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    sortBy("start");
    expect([rowIds(), sorted(), chevrons()]).toEqual([["L", "P", "C", "U"], [["start", "ascending"]], [["start", "▲"]]]);
    expect(JSON.parse(window.localStorage.getItem(listKey(TEST_PLAN)) ?? "null").sort).toEqual([{ id: "start", dir: "asc" }]);
    sortBy("start");
    expect([rowIds(), sorted(), chevrons()]).toEqual([["C", "P", "L", "U"], [["start", "descending"]], [["start", "▼"]]]);
    sortBy("start");
    expect([rowIds(), sorted(), chevrons()]).toEqual([["L", "P", "C", "U"], [], []]);
    sortBy("name");
    sortBy("name");
    expect([rowIds(), sorted()]).toEqual([["U", "P", "L", "C"], [["name", "descending"]]]);
    expect(uiNow().selected).toBeNull();
  });

  it("adds a key on Shift-click and ranks the chevrons, aria-sort staying on the primary key", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    sortBy("status");
    sortBy("name", true);
    expect([sorted(), chevrons()]).toEqual([
      [["status", "ascending"]],
      [
        ["name", "▲2"],
        ["status", "▲1"],
      ],
    ]);
    expect(rowIds()).toEqual(["C", "L", "P", "U"]);
    sortBy("name", true);
    expect(chevrons()).toEqual([
      ["name", "▼2"],
      ["status", "▲1"],
    ]);
    sortBy("name", true);
    expect(chevrons()).toEqual([["status", "▲"]]);
  });

  it("refuses a fourth sort key with a toast", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    sortBy("name");
    sortBy("start", true);
    sortBy("end", true);
    sortBy("status", true);
    expect(chevrons().map((c) => c[0])).toEqual(["name", "start", "end"]);
    expect(all(".toasts .toast").map((e) => e.textContent)).toEqual(["The List sorts by at most 3 columns. Shift-click a sorted column to drop it."]);
  });

  it("resets unreadable saved settings with a toast and shows the defaults", async () => {
    window.localStorage.setItem(listKey(TEST_PLAN), JSON.stringify({ ...DEFAULT_LIST_PREFS, cols: [{ id: "name", w: 300 }, { id: "owner", w: 100 }] }));
    const t = await made(STATUS_SEED);
    await list(t);
    expect(window.localStorage.getItem(listKey(TEST_PLAN))).toBeNull();
    expect(all(".toasts .toast").map((e) => e.textContent)).toEqual(["Saved List settings for this plan could not be read; they were reset."]);
    expect(all("thead th").map((e) => e.dataset.col)).toEqual(["name", "step", "assignees", "start", "end", "status"]);
  });

  it("mounts at most 60 of 1,000 rows between spacers, and the rows further down after a scroll", async () => {
    const restore = stubHeight(680);
    try {
      const t = await made(THOUSAND);
      await list(t);
      expect(all("tbody tr[data-lrow]").length).toBeLessThanOrEqual(60);
      expect(rowIds()[0]).toBe("i0");
      expect(all("tbody tr.list-pad").map((r) => r.style.height)).toEqual([`${(1001 - 30) * 34}px`]);
      const wrap = one(".list-wrap");
      act(() => {
        wrap.scrollTop = 500 * 34;
        fireEvent.scroll(wrap);
      });
      const ids = rowIds();
      expect(ids.length).toBeLessThanOrEqual(60);
      expect(ids).toContain("i500");
      expect(ids).not.toContain("i0");
      expect(all("tbody tr.list-pad")).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it("builds the List model once per change, not once per scroll", async () => {
    const restore = stubHeight(680);
    try {
      const t = await made(THOUSAND);
      await list(t);
      const built = vi.mocked(listModel).mock.calls.length;
      const wrap = one(".list-wrap");
      [100, 200, 300].forEach((n) => {
        act(() => {
          wrap.scrollTop = n * 34;
          fireEvent.scroll(wrap);
        });
      });
      expect(rowIds()).toContain("i300");
      expect(vi.mocked(listModel).mock.calls.length).toBe(built);
      sortBy("name");
      expect(vi.mocked(listModel).mock.calls.length).toBeGreaterThan(built);
    } finally {
      restore();
    }
  });

  it("scrolls a selection outside the window into view", async () => {
    const restore = stubHeight(680);
    try {
      const t = await made(THOUSAND);
      await list(t);
      const results = vi.mocked(useUi).mock.results;
      const last = results[results.length - 1];
      if (last === undefined || last.type !== "return") throw new Error("useUi has not returned");
      const setUi = last.value[1];
      act(() => setUi({ selected: "i700" }));
      expect(one(".list-wrap").scrollTop).toBe(702 * 34 - 680);
      expect(row("i700").classList.contains("selected")).toBe(true);
      act(() => setUi({ selected: "i3" }));
      expect(one(".list-wrap").scrollTop).toBe(4 * 34);
      expect(row("i3").classList.contains("selected")).toBe(true);
    } finally {
      restore();
    }
  });

  it("writes Start, End, Days, one status label per row and its dependencies", async () => {
    seedPrefs(OLD_COLUMNS);
    const t = await made([...STATUS_SEED, { name: "Q", start: "2026-11-30", dur: 2, deps: [fs("L", 2), { from: "C", type: "SS", lag: -1 }] }]);
    await list(t);
    expect(cells("L")).toEqual(["L", "2 Nov", "3 Nov", "2", "late", ""]);
    expect(cells("P")).toEqual(["P", "10 Nov", "12 Nov", "3", "in progress", ""]);
    expect(cells("C")).toEqual(["C", "11 Nov", "11 Nov", "1", "conflict", "P FS"]);
    expect(cells("D")).toEqual(["D", "3 Nov", "5 Nov", "3", "done", ""]);
    expect(cells("U")).toEqual(["U", "", "", "3", "not started", ""]);
    expect(cells("Q")[5]).toBe("C SS-1d, L FS+2d");
    const view = t.session.view();
    ["L", "P", "C", "D", "U", "Q"].forEach((id) => expect([id, one(".st", row(id)).textContent]).toEqual([id, statusLabel(view, id)]));
    expect(one(".st", row("C")).className).toBe("st conflict");
    expect(one(".st", row("L")).className).toBe("st late");
    expect(one(".st", row("P")).className).toBe("st doing");
    expect(one(".st", row("D")).className).toBe("st done");
    expect(one(".st", row("U")).className).toBe("st todo");
  });

  it("labels a held row and leaves milestones without End and Days", async () => {
    seedPrefs(OLD_COLUMNS);
    const t = await made(
      [
        { name: "X", start: "2026-11-20", dur: 2 },
        { name: "M", kind: "milestone", start: "2026-11-24" },
      ],
      { clashes: [{ unit: "s:X", mac: ["2026-11-20", 2, "todo", 0, "now"], iphone: ["2026-11-23", 2, "todo", 0, "now"] }] },
    );
    await list(t);
    expect(one(".st", row("X")).textContent).toBe("held");
    expect(one(".st", row("X")).className).toBe("st held");
    expect(cells("M")).toEqual(["◆ M", "24 Nov", "", "", "not started", ""]);
  });

  it("lists groups in plan order, then Not in a group", async () => {
    const t = await made([
      { name: "c", start: "2026-11-09" },
      { name: "G", kind: "group" },
      { name: "b", parent: "G", start: "2026-12-01" },
      { name: "a", parent: "G", start: "2026-11-10" },
    ]);
    await list(t);
    expect(sections()).toEqual(["# G", "b", "a", "# Not in a group", "c"]);
  });

  it.each([false, true])("opens a clicked row (read-only %s)", async (readOnly) => {
    const t = await made(STATUS_SEED);
    act(() => t.session.setReadOnly(readOnly));
    await list(t);
    const apply = vi.spyOn(t.session, "apply");
    pointer(row("P"), "down", 10, 10);
    pointer(row("P"), "up", 12, 11);
    expect(uiNow().selected).toBe("P");
    expect(row("P").classList.contains("selected")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("selects a row and renames it on Enter, and opens it as the item modal on Space", async () => {
    const t = await made([
      { id: "a", name: "A", start: "2026-11-20", dur: 2 },
      { id: "b", name: "B", start: "2026-11-23", dur: 1 },
    ]);
    await list(t);
    act(() => {
      row("a").focus();
      fireEvent.keyDown(row("a"), { key: "Enter" });
    });
    const name = document.querySelector('#inspector [data-detail-field="name"]');
    expect([uiNow().selected, uiNow().dialog, document.activeElement === name && name !== null]).toEqual(["a", null, true]);
    act(() => {
      row("b").focus();
      fireEvent.keyDown(row("b"), { key: " " });
    });
    expect([uiNow().selected, uiNow().dialog, document.querySelector("[data-item-modal] [data-detail]")?.getAttribute("data-detail-item")]).toEqual(["b", { t: "item" }, "b"]);
  });

  it("selects nothing for a pointer that moved 4 px or more", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    pointer(row("P"), "down", 10, 10);
    pointer(row("P"), "up", 10, 14);
    expect(uiNow().selected).toBeNull();
  });

  it("shows the trashed item of a delete choice as a ghost row that opens", async () => {
    seedPrefs(OLD_COLUMNS);
    const { t, p } = await deleteClash();
    sessions.push(t.session, p.session);
    await list(t);
    expect(row("A").classList.contains("ghost-row")).toBe(true);
    expect(row("B").classList.contains("ghost-row")).toBe(false);
    expect(cells("A")).toEqual(["Renamed", "", "", "", "held", ""]);
    expect(one(".st", row("A")).className).toBe("st held");
    pointer(row("A"), "down", 10, 10);
    pointer(row("A"), "up", 12, 11);
    expect(uiNow().selected).toBe("A");
  });

  it("renders a ghost child of a trashed group as a name-only held row that opens (CR07, CR14)", async () => {
    seedPrefs(OLD_COLUMNS);
    const t = await made(SPRINT);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["S"] });
    p.session.apply({ t: "rename", item: "r", name: "Review 2" });
    p.sync();
    await list(t);
    expect(sections()).toEqual(["# Sprint 4", "r", "# Not in a group", "x"]);
    expect(row("r").tagName).toBe("TR");
    expect(row("r").classList.contains("ghost-row")).toBe(true);
    expect(row("x").classList.contains("ghost-row")).toBe(false);
    expect(cells("r")).toEqual(["Review 2", "", "", "", "held", ""]);
    pointer(row("r"), "down", 10, 10);
    pointer(row("r"), "up", 12, 11);
    expect(uiNow().selected).toBe("r");
  });

  it("renders a ghost whose parent group was trashed apart under Not in a group", async () => {
    seedPrefs(OLD_COLUMNS);
    const t = await made(SPRINT);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["r"] });
    p.session.apply({ t: "rename", item: "r", name: "Review 2" });
    p.sync();
    t.session.apply({ t: "trash", items: ["S"] });
    await list(t);
    expect(sections()).toEqual(["# Not in a group", "r", "x"]);
    expect(row("r").classList.contains("ghost-row")).toBe(true);
    expect(cells("r")).toEqual(["Review 2", "", "", "", "held", ""]);
  });

  it("shows the nine scopes with counts in one radiogroup, Open chosen, and filters by a clicked scope", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    const bar = one('.scope-bar[role="radiogroup"][aria-label="Scope"]');
    expect(scopes()).toEqual([
      ["open", "Open", "4", "true", "Not done"],
      ["soon", "Due soon", "2", "false", "Ends within 7 working days"],
      ["late", "Late", "1", "false", "Past its end and not done"],
      ["blocked", "Blocked", "1", "false", "Waits on an unfinished predecessor"],
      ["unscheduled", "Unscheduled", "1", "false", "No start date"],
      ["unassigned", "Unassigned", "5", "false", "Nobody assigned"],
      ["milestones", "Milestones", "0", "false", null],
      ["done", "Done", "1", "false", null],
      ["all", "All", "5", "false", "Everything in this plan"],
    ]);
    expect(all('[role="radio"]', bar).map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1, -1]);
    expect([rowIds(), one(".list-count").textContent]).toEqual([["L", "P", "C", "U"], "4 items"]);
    act(() => {
      fireEvent.click(one('[data-scope="done"]'));
    });
    expect([rowIds(), one(".list-count").textContent, one('[data-scope="done"]').getAttribute("aria-checked")]).toEqual([["D"], "1 item", "true"]);
    expect(JSON.parse(window.localStorage.getItem(listKey(TEST_PLAN)) ?? "null").scope).toBe("done");
    expect(
      all('[role="radio"]', bar)
        .filter((r) => r.tabIndex === 0)
        .map((r) => r.dataset.scope),
    ).toEqual(["done"]);
  });

  it("moves the scope with Left and Right from its one tab stop", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    act(() => {
      one('[data-scope="open"]').focus();
      fireEvent.keyDown(one('[data-scope="open"]'), { key: "ArrowRight" });
    });
    expect([checkedScope(), focusedScope()]).toEqual(["soon", "soon"]);
    act(() => {
      fireEvent.keyDown(one('[data-scope="soon"]'), { key: "ArrowLeft" });
      fireEvent.keyDown(one('[data-scope="open"]'), { key: "ArrowLeft" });
    });
    expect([checkedScope(), focusedScope()]).toEqual(["all", "all"]);
    expect(rowIds()).toEqual(["L", "P", "C", "D", "U"]);
  });

  it("adds a chip through Filter, lists every field's values, and removes the chip by its X", async () => {
    const t = await made(SPRINT_MORE);
    await list(t);
    act(() => {
      fireEvent.click(one('button.tool-btn[data-list="filter"]'));
    });
    const menu = screen.getByRole("menu", { name: "Filter" });
    expect(all('[role="group"]', menu).map((g) => [g.getAttribute("aria-label"), all('[role="menuitemcheckbox"]', g).map((r) => r.textContent)])).toEqual([
      ["Step", ["Now", "Next", "Later", "Done", "No step"]],
      ["Assignee", ["Unassigned"]],
      ["Kind", ["Task", "Milestone"]],
      ["Group", ["Sprint 4", "Not in a group"]],
    ]);
    act(() => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Milestone" }));
    });
    expect(chips()).toEqual([["kind:milestone", "Kind is Milestone", "Remove filter Kind is Milestone"]]);
    expect([rowIds(), one('[data-list="filter"]').textContent, all(".chip-row .link-button")]).toEqual([["m"], "Filter1", []]);
    expect(JSON.parse(window.localStorage.getItem(listKey(TEST_PLAN)) ?? "null").chips).toEqual([{ f: "kind", v: "milestone" }]);
    act(() => {
      fireEvent.click(one(".chip-x"));
    });
    expect([chips(), rowIds(), one('[data-list="filter"]').textContent]).toEqual([[], ["r", "m", "x"], "Filter"]);
  });

  it("ORs two chips of a field, offers Clear all, and words dead values", async () => {
    seedPrefs({
      ...DEFAULT_LIST_PREFS,
      chips: [
        { f: "group", v: "S" },
        { f: "group", v: null },
        { f: "step", v: "gone" },
        { f: "group", v: "nowhere" },
        { f: "assignee", v: "nobody" },
        { f: "assignee", v: null },
      ],
    });
    const t = await made(SPRINT_MORE);
    await list(t);
    expect(chips().map((c) => c[1])).toEqual([
      "Group is Sprint 4",
      "Group is Not in a group",
      "Step is a removed step",
      "Group is a removed group",
      "Assignee is Former person",
      "Assignee is Unassigned",
    ]);
    expect(rowIds()).toEqual([]);
    expect(all(".list-wrap .note").map((e) => e.textContent)).toEqual(["Nothing in Open with these filters."]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    });
    expect([chips(), rowIds()]).toEqual([[], ["r", "m", "x"]]);
    expect(all(".list-wrap .note")).toEqual([]);
  });

  it("groups by a value chosen from Group by", async () => {
    const t = await made(SPRINT_MORE);
    await list(t);
    expect(one('button.tool-btn[data-list="group"]').textContent).toBe("Group: Plan outline ▾");
    act(() => {
      fireEvent.click(one('[data-list="group"]'));
    });
    const menu = screen.getByRole("menu", { name: "Group by" });
    expect(all('[role="group"]', menu).map((g) => g.getAttribute("aria-label"))).toEqual(["Group by"]);
    expect(all('[role="menuitemcheckbox"]', menu).map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["Plan outline", "true"],
      ["Step", "false"],
      ["Assignee", "false"],
      ["None", "false"],
    ]);
    act(() => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Assignee" }));
    });
    expect([sections(), one('[data-list="group"]').textContent]).toEqual([["# Unassigned", "r", "m", "x"], "Group: Assignee ▾"]);
    expect(all(".grp-count").map((e) => e.textContent)).toEqual(["3"]);
    act(() => {
      fireEvent.click(one('[data-list="group"]'));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "None" }));
    });
    expect(sections()).toEqual(["r", "m", "x"]);
  });

  it("highlights the match in Name and counts 3 of 12 while searching", async () => {
    const t = await made([
      ...Array.from({ length: 9 }, (_, i): SeedItem => ({ id: `p${i}`, name: `Pier ${i}` })),
      { id: "d1", name: "Dome shell" },
      { id: "d2", name: "Upper dome" },
      { id: "d3", name: "DOME bolts" },
    ]);
    await list(t);
    expect(one(".list-count").textContent).toBe("12 items");
    setUiNow({ query: "dome" });
    expect(rowIds()).toEqual(["d1", "d2", "d3"]);
    expect(all("table.list .list-name mark").map((m) => m.textContent)).toEqual(["Dome", "dome", "DOME"]);
    expect(one(".list-count").textContent).toBe("3 of 12");
  });

  it("steps J and K through the rows in the order the List shows them, sorted and grouped", async () => {
    seedPrefs({ ...DEFAULT_LIST_PREFS, sort: [{ id: "name", dir: "desc" }], group: "step" });
    const t = await made([
      { id: "a", name: "Alpha", start: "2026-11-20", dur: 2 },
      { id: "b", name: "Bravo", horizon: "next" },
      { id: "c", name: "Charlie", start: "2026-11-23", dur: 1 },
      { id: "d", name: "Delta", horizon: "next" },
    ]);
    await list(t);
    expect(sections()).toEqual(["# Now", "c", "a", "# Next", "d", "b"]);
    const seen = ["j", "j", "j", "j", "k"].map((key) => {
      act(() => {
        fireEvent.keyDown(document.body, { key });
      });
      return uiNow().selected;
    });
    expect(seen).toEqual(["c", "a", "d", "b", "d"]);
  });

  it("names the scopes, the Filter button and the sort keys for assistive tech", async () => {
    seedPrefs({ ...DEFAULT_LIST_PREFS, sort: [{ id: "status", dir: "asc" }, { id: "name", dir: "desc" }], chips: [{ f: "kind", v: "task" }] });
    const t = await made(STATUS_SEED);
    await list(t);
    expect(screen.getByRole("radio", { name: "Open, 4 items" }).dataset.scope).toBe("open");
    expect(screen.getByRole("radio", { name: "Done, 1 item" }).dataset.scope).toBe("done");
    expect(one('[data-list="filter"]').getAttribute("aria-label")).toBe("Filter, 1 active");
    expect(all("thead .sort-chev").map((c) => c.getAttribute("aria-hidden"))).toEqual(["true", "true"]);
    const described = (col: string): string => {
      const id = one(".th-sort", head(col)).getAttribute("aria-describedby");
      if (id === null) throw new Error(`${col} names no description`);
      const el = document.getElementById(id);
      if (el === null) throw new Error(`no element ${id}`);
      return el.textContent ?? "";
    };
    expect([described("status"), described("name")]).toEqual(["ascending, sort key 1 of 2", "descending, sort key 2 of 2"]);
    expect(one(".th-sort", head("start")).hasAttribute("aria-describedby")).toBe(false);
    sortBy("name", true);
    sortBy("status");
    expect(described("status")).toBe("descending");
  });

  it("states the sort and returns to Plan order from its link", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    expect([one(".sort-summary").textContent, all(".list-status .link-button")]).toEqual(["Plan order", []]);
    sortBy("start");
    sortBy("name", true);
    sortBy("name", true);
    expect(one(".sort-summary").textContent).toBe("Sorted by Start ↑, then Name ↓Plan order");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Plan order" }));
    });
    expect([one(".sort-summary").textContent, sorted(), JSON.parse(window.localStorage.getItem(listKey(TEST_PLAN)) ?? "null").sort]).toEqual(["Plan order", [], []]);
  });

  it("says when a scope holds nothing", async () => {
    const t = await made([{ name: "a", start: "2026-11-20" }]);
    await list(t);
    act(() => {
      fireEvent.click(one('[data-scope="done"]'));
    });
    expect([all(".list-wrap .note").map((e) => e.textContent), rowIds()]).toEqual([["Nothing in Done."], []]);
  });

  it("says so for an empty plan", async () => {
    const t = await made([]);
    await list(t);
    expect(all(".list-wrap .note").map((e) => e.textContent)).toEqual(["No items yet. Add one with + New."]);
    expect(all("tbody tr")).toHaveLength(0);
  });

  it("drops the empty line once there is an item", async () => {
    const t = await made([{ name: "a", start: "2026-11-20" }]);
    await list(t);
    expect(screen.queryByText(/No items yet/)).toBeNull();
    expect(all("tbody tr[data-lrow]")).toHaveLength(1);
  });
});

const COL_PX = 100;

const headIds = (): (string | undefined)[] => all("thead th").map((th) => th.dataset.col);

const stored = (): ListPrefs | null => JSON.parse(window.localStorage.getItem(listKey(TEST_PLAN)) ?? "null");

const stubHeads = (): void => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches("thead th[data-col]") && this.parentElement !== null) {
      const at = [...this.parentElement.children].indexOf(this);
      return new DOMRect(at * COL_PX, 0, COL_PX, 34);
    }
    return new DOMRect(0, 0, 0, 0);
  });
};

const headPointer = (el: Element, kind: "down" | "move" | "up" | "cancel", x: number, mods: { ctrlKey?: boolean } = {}): void => {
  const init = { clientX: x, clientY: 10, button: 0, pointerId: 1, pointerType: "mouse", ...mods };
  act(() => {
    if (kind === "down") fireEvent.pointerDown(el, init);
    else if (kind === "move") fireEvent.pointerMove(el, init);
    else if (kind === "up") fireEvent.pointerUp(el, init);
    else fireEvent.pointerCancel(el, init);
  });
};

const edge = (col: string): HTMLElement => one(`.th-edge[data-col="${col}"]`);

const colWidths = (): string[] => all("colgroup col").map((c) => c.style.width);

const escape = (): void => {
  act(() => {
    fireEvent.keyDown(window, { key: "Escape" });
  });
};

const press = (el: Element, key: string, mods: { altKey?: boolean; shiftKey?: boolean } = {}): void => {
  act(() => {
    fireEvent.keyDown(el, { key, ...mods });
  });
};

const menuRows = (): (string | null)[] => all('.context-menu[aria-label="Column"] [role^="menuitem"]').map((r) => r.textContent);

const openHeadMenu = (col: string): void => {
  act(() => {
    fireEvent.contextMenu(head(col), { clientX: 320, clientY: 20 });
  });
};

const chooseRow = (title: string): void => {
  const rowEl = all('.context-menu [role^="menuitem"]').find((r) => r.textContent === title);
  if (rowEl === undefined) throw new Error(`no menu row ${title}`);
  act(() => {
    fireEvent.click(rowEl);
  });
};

const defineOwn = (el: HTMLElement, key: "scrollWidth" | "clientWidth" | "scrollLeft", value: number): void => {
  Object.defineProperty(el, key, { configurable: true, writable: true, value });
};

const fades = (): (string | null)[] => {
  const bar = one(".scope-bar");
  return [bar.getAttribute("data-fade-start"), bar.getAttribute("data-fade-end")];
};

describe("List columns with a mouse", () => {
  it("sorts on a pointer click on a header, and not again on the click that follows", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    headPointer(head("start"), "down", 310);
    headPointer(head("start"), "up", 311);
    act(() => {
      fireEvent.click(one(".th-sort", head("start")), { detail: 1 });
    });
    expect([sorted(), stored()?.sort]).toEqual([[["start", "ascending"]], [{ id: "start", dir: "asc" }]]);
  });

  it("treats a Control-click on a Mac header as the right-click it is: the Column menu opens, nothing sorts, moves or resizes", async () => {
    setPlatform(MAC);
    const t = await made(STATUS_SEED);
    await list(t);
    stubHeads();
    headPointer(head("start"), "down", 310, { ctrlKey: true });
    act(() => {
      fireEvent.contextMenu(head("start"), { clientX: 310, clientY: 10, ctrlKey: true });
    });
    headPointer(head("start"), "up", 310, { ctrlKey: true });
    act(() => {
      fireEvent.click(one(".th-sort", head("start")), { detail: 1, ctrlKey: true });
    });
    expect([menuRows(), sorted(), stored()]).toEqual([["Sort ascending", "Sort descending", "Hide column", "Size to fit", "Columns…", "Reset columns"], [], null]);
    escape();
    act(() => {
      fireEvent.keyDown(one('.context-menu[aria-label="Column"]'), { key: "Escape" });
    });
    headPointer(head("start"), "down", 310, { ctrlKey: true });
    headPointer(head("start"), "move", 140, { ctrlKey: true });
    expect([all("th.dragging"), all(".th-drop")]).toEqual([[], []]);
    headPointer(head("start"), "up", 140, { ctrlKey: true });
    headPointer(edge("start"), "down", 400, { ctrlKey: true });
    headPointer(edge("start"), "move", 450, { ctrlKey: true });
    expect([colWidths()[3], document.documentElement.classList.contains("col-resizing")]).toEqual(["88px", false]);
    headPointer(edge("start"), "up", 450, { ctrlKey: true });
    expect([headIds(), sorted(), stored()]).toEqual([["name", "step", "assignees", "start", "end", "status"], [], null]);
  });

  it("starts a header drag whose first move past the slop lands on the next header, and drops it where it is released", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    stubHeads();
    headPointer(head("start"), "down", 397);
    headPointer(head("end"), "move", 404);
    expect([head("start").classList.contains("dragging"), all(".th-drop")]).toEqual([true, [one(".th-drop")]]);
    headPointer(head("end"), "move", 560);
    headPointer(head("end"), "up", 560);
    expect([headIds(), sorted(), all("th.dragging")]).toEqual([["name", "step", "assignees", "end", "status", "start"], [], []]);
  });

  it("reorders on a 6 px header drag, marks the drop edge, and never sorts", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    stubHeads();
    headPointer(head("start"), "down", 310);
    headPointer(head("start"), "move", 316);
    expect([head("start").classList.contains("dragging"), one(".list-wrap > .th-drop").style.left]).toEqual([true, "299px"]);
    headPointer(head("start"), "move", 140);
    expect(one(".list-wrap > .th-drop").style.left).toBe("99px");
    headPointer(head("start"), "up", 140);
    expect(headIds()).toEqual(["name", "start", "step", "assignees", "end", "status"]);
    expect([sorted(), stored()?.sort, all(".th-drop"), all("th.dragging")]).toEqual([[], [], [], []]);
    expect(all("thead th").map((e) => e.textContent)).toEqual(["Name", "Start", "Step", "Assignees", "End", "Status"]);
    expect(cells("L")[1]).toBe("2 Nov");
  });

  it("drops a header dragged past the last column at the end", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    stubHeads();
    headPointer(head("step"), "down", 150);
    headPointer(head("step"), "move", 900);
    expect(one(".th-drop").style.left).toBe("599px");
    headPointer(head("step"), "up", 900);
    expect(headIds()).toEqual(["name", "assignees", "start", "end", "status", "step"]);
  });

  it("keeps Name first: a Name drag neither moves nor sorts", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    stubHeads();
    headPointer(head("name"), "down", 50);
    headPointer(head("name"), "move", 450);
    expect([all("th.dragging"), all(".th-drop")]).toEqual([[], []]);
    headPointer(head("name"), "up", 450);
    expect([headIds(), sorted(), stored()]).toEqual([["name", "step", "assignees", "start", "end", "status"], [], null]);
  });

  it("cancels a header drag on Escape and on pointercancel", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    stubHeads();
    headPointer(head("start"), "down", 310);
    headPointer(head("start"), "move", 140);
    escape();
    expect([all(".th-drop"), all("th.dragging")]).toEqual([[], []]);
    headPointer(head("start"), "move", 120);
    headPointer(head("start"), "up", 120);
    headPointer(head("end"), "down", 410);
    headPointer(head("end"), "move", 140);
    headPointer(head("end"), "cancel", 140);
    expect(all(".th-drop")).toEqual([]);
    headPointer(head("end"), "up", 140);
    expect([headIds(), sorted(), stored()]).toEqual([["name", "step", "assignees", "start", "end", "status"], [], null]);
  });

  it("moves a column one place with Alt+Left and Alt+Right, keeping focus, and Name refuses", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    const button = one(".th-sort", head("start"));
    button.focus();
    press(button, "ArrowLeft", { altKey: true });
    expect(headIds()).toEqual(["name", "step", "start", "assignees", "end", "status"]);
    expect(document.activeElement).toBe(one(".th-sort", head("start")));
    press(one(".th-sort", head("start")), "ArrowRight", { altKey: true });
    press(one(".th-sort", head("start")), "ArrowRight", { altKey: true });
    expect(headIds()).toEqual(["name", "step", "assignees", "end", "start", "status"]);
    const before = window.localStorage.getItem(listKey(TEST_PLAN));
    press(one(".th-sort", head("name")), "ArrowRight", { altKey: true });
    press(one(".th-sort", head("step")), "ArrowLeft", { altKey: true });
    press(one(".th-sort", head("status")), "ArrowRight", { altKey: true });
    expect([headIds(), window.localStorage.getItem(listKey(TEST_PLAN)), sorted()]).toEqual([["name", "step", "assignees", "end", "start", "status"], before, []]);
  });

  it("labels each header edge as a vertical separator with its width", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    expect(all("thead .th-edge").map((e) => e.dataset.col)).toEqual(["name", "step", "assignees", "start", "end", "status"]);
    const e = edge("start");
    expect([e.getAttribute("role"), e.getAttribute("aria-orientation"), e.getAttribute("aria-label"), e.getAttribute("aria-valuenow"), e.getAttribute("aria-valuemin"), e.getAttribute("aria-valuemax"), e.tabIndex]).toEqual([
      "separator",
      "vertical",
      "Resize Start",
      "88",
      "72",
      "640",
      0,
    ]);
    expect(edge("name").getAttribute("aria-label")).toBe("Resize Name");
  });

  it("resizes from a header edge: live while dragging, written on release, restored by Escape", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    headPointer(edge("start"), "down", 400);
    headPointer(edge("start"), "move", 450);
    expect([colWidths()[3], one("table.list").style.width, edge("start").getAttribute("aria-valuenow"), stored(), document.documentElement.classList.contains("col-resizing")]).toEqual(["138px", "946px", "138", null, true]);
    headPointer(edge("start"), "up", 450);
    expect([stored()?.cols[3], colWidths()[3], sorted(), document.documentElement.classList.contains("col-resizing")]).toEqual([{ id: "start", w: 138 }, "138px", [], false]);
    headPointer(edge("start"), "down", 400);
    headPointer(edge("start"), "move", 200);
    expect(colWidths()[3]).toBe("72px");
    escape();
    expect([colWidths()[3], document.documentElement.classList.contains("col-resizing")]).toEqual(["138px", false]);
    headPointer(edge("start"), "up", 200);
    expect([stored()?.cols[3], colWidths()[3]]).toEqual([{ id: "start", w: 138 }, "138px"]);
  });

  it("writes nothing for an edge press that drifts less than the click slop", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    headPointer(edge("start"), "down", 400);
    headPointer(edge("start"), "move", 401);
    expect([colWidths()[3], edge("start").getAttribute("aria-valuenow")]).toEqual(["88px", "88"]);
    headPointer(edge("start"), "up", 401);
    expect([stored(), colWidths()[3], document.documentElement.classList.contains("col-resizing")]).toEqual([null, "88px", false]);
    headPointer(edge("start"), "down", 400);
    headPointer(edge("start"), "move", 404);
    headPointer(edge("start"), "up", 404);
    expect(stored()?.cols[3]).toEqual({ id: "start", w: 92 });
  });

  it("restores the width when the pointer is cancelled mid-resize", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    headPointer(edge("end"), "down", 400);
    headPointer(edge("end"), "move", 700);
    expect(colWidths()[4]).toBe("388px");
    headPointer(edge("end"), "cancel", 700);
    headPointer(edge("end"), "up", 700);
    expect([colWidths()[4], stored()]).toEqual(["88px", null]);
  });

  it("resizes from the keyboard: Left and Right by 8, with Shift by 32", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    press(edge("start"), "ArrowRight");
    expect(stored()?.cols[3]).toEqual({ id: "start", w: 96 });
    press(edge("start"), "ArrowRight", { shiftKey: true });
    press(edge("start"), "ArrowLeft");
    expect([stored()?.cols[3], edge("start").getAttribute("aria-valuenow")]).toEqual([{ id: "start", w: 120 }, "120"]);
    press(edge("start"), "ArrowLeft", { shiftKey: true });
    press(edge("start"), "ArrowLeft", { shiftKey: true });
    expect(stored()?.cols[3]).toEqual({ id: "start", w: 72 });
  });

  it("fits a column to its widest mounted cell and its title on a double click and on Return", async () => {
    const t = await made([{ id: "a", name: "Survey the north ridge before the dome goes up", start: "2026-11-10", dur: 2 }, { id: "b", name: "Pier", start: "2026-11-12" }]);
    await list(t);
    const css = document.createElement("style");
    css.textContent = "table.list th, table.list td { padding-left: 10px; padding-right: 10px; }";
    document.head.append(css);
    const had = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range): DOMRect {
        const text = this.toString();
        return new DOMRect(0, 0, text.length * 7, text === "" ? 0 : 14);
      },
    });
    try {
      act(() => {
        fireEvent.doubleClick(edge("name"));
      });
      expect([stored()?.cols[0], sorted()]).toEqual([{ id: "name", w: 342 }, []]);
      press(edge("start"), "Enter");
      expect(stored()?.cols[3]).toEqual({ id: "start", w: 72 });
      sortBy("assignees");
      press(edge("assignees"), "Enter");
      expect(stored()?.cols[2]).toEqual({ id: "assignees", w: 110 });
    } finally {
      css.remove();
      if (had === undefined) Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      else Object.defineProperty(Range.prototype, "getBoundingClientRect", had);
    }
  });

  it("opens the header menu on a right-click and runs its rows", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    openHeadMenu("start");
    expect(menuRows()).toEqual(["Sort ascending", "Sort descending", "Hide column", "Size to fit", "Columns…", "Reset columns"]);
    chooseRow("Sort descending");
    expect([sorted(), all(".context-menu")]).toEqual([[["start", "descending"]], []]);
    openHeadMenu("end");
    expect(menuRows()).toContain("Add as second sort key");
    chooseRow("Add as second sort key");
    expect(stored()?.sort).toEqual([
      { id: "start", dir: "desc" },
      { id: "end", dir: "asc" },
    ]);
    openHeadMenu("end");
    chooseRow("Hide column");
    expect([headIds(), stored()?.sort]).toEqual([["name", "step", "assignees", "start", "status"], [{ id: "start", dir: "desc" }]]);
    openHeadMenu("name");
    expect(menuRows()).toEqual(["Sort ascending", "Sort descending", "Add as second sort key", "Size to fit", "Columns…", "Reset columns"]);
    chooseRow("Columns…");
    expect(uiNow().columnsAsk).toBe(1);
    openHeadMenu("start");
    chooseRow("Reset columns");
    expect([headIds(), stored()?.sort]).toEqual([["name", "step", "assignees", "start", "end", "status"], [{ id: "start", dir: "desc" }]]);
  });

  it("opens the header menu from the ContextMenu key and Shift+F10 on a header", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    press(one(".th-sort", head("status")), "ContextMenu");
    expect(menuRows()).toEqual(["Sort ascending", "Sort descending", "Hide column", "Size to fit", "Columns…", "Reset columns"]);
    escape();
    act(() => {
      fireEvent.keyDown(one('.context-menu[aria-label="Column"]'), { key: "Escape" });
    });
    expect(all(".context-menu")).toEqual([]);
    press(one(".th-sort", head("step")), "F10", { shiftKey: true });
    expect(menuRows()).toHaveLength(6);
  });

  it("fades the clipped ends of the scope bar on scroll and after revealing the chosen scope", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    expect(fades()).toEqual(["false", "false"]);
    const bar = one(".scope-bar");
    defineOwn(bar, "scrollWidth", 600);
    defineOwn(bar, "clientWidth", 400);
    defineOwn(bar, "scrollLeft", 0);
    act(() => {
      fireEvent.scroll(bar);
    });
    expect(fades()).toEqual(["false", "true"]);
    defineOwn(bar, "scrollLeft", 100);
    act(() => {
      fireEvent.scroll(bar);
    });
    expect(fades()).toEqual(["true", "true"]);
    defineOwn(bar, "scrollLeft", 199.5);
    act(() => {
      fireEvent.scroll(bar);
    });
    expect(fades()).toEqual(["true", "false"]);
    defineOwn(bar, "scrollLeft", 0.5);
    act(() => {
      fireEvent.scroll(bar);
    });
    expect(fades()).toEqual(["false", "true"]);
    const allScope = one('[data-scope="all"]');
    Object.defineProperty(allScope, "offsetLeft", { configurable: true, value: 520 });
    Object.defineProperty(allScope, "offsetWidth", { configurable: true, value: 60 });
    act(() => {
      fireEvent.click(allScope);
    });
    expect([bar.scrollLeft, fades()]).toEqual([188, ["true", "true"]]);
  });

  it("fades the scope bar again when a ResizeObserver reports it resized", async () => {
    const seen: ResizeObserverCallback[] = [];
    class Watching {
      constructor(cb: ResizeObserverCallback) {
        seen.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", Watching);
    try {
      const t = await made(STATUS_SEED);
      await list(t);
      const bar = one(".scope-bar");
      const resized = (): void => {
        act(() => {
          seen.forEach((cb) => cb([], new ResizeObserver(() => undefined)));
        });
      };
      expect(fades()).toEqual(["false", "false"]);
      defineOwn(bar, "scrollWidth", 600);
      defineOwn(bar, "clientWidth", 400);
      defineOwn(bar, "scrollLeft", 0);
      resized();
      expect(fades()).toEqual(["false", "true"]);
      defineOwn(bar, "clientWidth", 600);
      resized();
      expect(fades()).toEqual(["false", "false"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("List columns on iPad", () => {
  interface Sent {
    token: string;
    sections: { title: string | null; rows: { id: string; title: string; checked: boolean }[] }[];
  }
  const asks = (): Sent[] => tauri.calls.filter((c) => c.cmd === "menu_show").map((c) => (c.args as { menu: Sent }).menu);
  const lastAsk = (): Sent => {
    const sent = asks()[asks().length - 1];
    if (sent === undefined) throw new Error("no menu_show was sent");
    return sent;
  };
  const chooseNative = (id: string): void => {
    const { token } = lastAsk();
    act(() => {
      emitFromRust("menu-ended", { token });
      emitFromRust("menu-chosen", { token, id });
    });
  };
  const haptics = (): unknown[] => tauri.calls.filter((c) => c.cmd === "haptic").map((c) => c.args);
  const touch = (type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", el: HTMLElement, x: number): void => {
    act(() => {
      fireEvent[type](el, { pointerType: "touch", pointerId: 7, clientX: x, clientY: 20 });
    });
  };
  const holdFor = (): void => {
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
  };
  const scrollBlocked = (): boolean => {
    const e = new Event("touchmove", { cancelable: true });
    document.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const ipadList = async (): Promise<() => void> => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    const t = await made(STATUS_SEED);
    render(withSync(shellFor(t, { device: { deviceId: "ipad", name: "iPad", platform: "ios" } }).ui));
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    return unstub;
  };

  it("sorts on a tap, reorders on a hold-drag with one haptic, and opens the native header menu on a still hold", async () => {
    const unstub = await ipadList();
    try {
      stubHeads();
      vi.useFakeTimers();
      touch("pointerDown", head("start"), 310);
      touch("pointerUp", head("start"), 311);
      act(() => {
        fireEvent.click(one(".th-sort", head("start")), { detail: 1 });
      });
      expect([sorted(), haptics(), asks()]).toEqual([[["start", "ascending"]], [], []]);
      touch("pointerDown", head("end"), 410);
      expect([haptics(), all("th.lifted"), scrollBlocked()]).toEqual([[], [], false]);
      holdFor();
      expect([haptics(), head("end").classList.contains("lifted"), scrollBlocked()]).toEqual([[{ kind: "medium" }], true, true]);
      touch("pointerMove", head("end"), 140);
      expect(one(".list-wrap > .th-drop").style.left).toBe("99px");
      touch("pointerUp", head("end"), 140);
      expect(headIds()).toEqual(["name", "end", "step", "assignees", "start", "status"]);
      expect([sorted(), all("th.lifted"), all(".th-drop"), scrollBlocked(), asks()]).toEqual([[["start", "ascending"]], [], [], false, []]);
      touch("pointerDown", head("status"), 510);
      holdFor();
      touch("pointerUp", head("status"), 512);
      vi.useRealTimers();
      await settle();
      expect(document.querySelector(".context-menu")).toBeNull();
      expect(lastAsk().sections.map((s) => s.rows.map((r) => r.title))).toEqual([
        ["Sort ascending", "Sort descending", "Add as second sort key"],
        ["Hide column", "Size to fit"],
        ["Columns…", "Reset columns"],
      ]);
      chooseNative("desc");
      expect([sorted(), haptics(), all("th.lifted")]).toEqual([[["status", "descending"]], [{ kind: "medium" }, { kind: "medium" }], []]);
    } finally {
      vi.useRealTimers();
      unstub();
    }
  });

  it("draws every header at least 96 pt wide, so a 44 pt title fits between the two 44 pt edges, and resizes no narrower", async () => {
    const unstub = await ipadList();
    try {
      expect([colWidths(), edge("start").getAttribute("aria-valuemin"), edge("name").getAttribute("aria-valuemin")]).toEqual([["300px", "140px", "170px", "96px", "96px", "110px"], "96", "180"]);
      expect(one("table.list").style.width).toBe("912px");
      press(edge("start"), "ArrowRight");
      expect([stored()?.cols[3], colWidths()[3]]).toEqual([{ id: "start", w: 104 }, "104px"]);
      press(edge("start"), "ArrowLeft", { shiftKey: true });
      expect([stored()?.cols[3], colWidths()[3]]).toEqual([{ id: "start", w: 96 }, "96px"]);
      headPointer(edge("end"), "down", 400);
      headPointer(edge("end"), "move", 300);
      expect(colWidths()[4]).toBe("96px");
      headPointer(edge("end"), "up", 300);
      expect(stored()?.cols[4]).toEqual({ id: "end", w: 96 });
    } finally {
      unstub();
    }
  });

  it("keeps Name first on a hold-drag, drops a lift on pointercancel, and lets a mouse on iPad drag as on the Mac", async () => {
    const unstub = await ipadList();
    try {
      stubHeads();
      vi.useFakeTimers();
      touch("pointerDown", head("name"), 50);
      holdFor();
      touch("pointerMove", head("name"), 450);
      expect([head("name").classList.contains("lifted"), all(".th-drop")]).toEqual([true, []]);
      touch("pointerUp", head("name"), 450);
      expect([headIds(), sorted(), stored(), all("th.lifted")]).toEqual([["name", "step", "assignees", "start", "end", "status"], [], null, []]);
      touch("pointerDown", head("step"), 150);
      holdFor();
      touch("pointerMove", head("step"), 450);
      expect(all(".th-drop")).toHaveLength(1);
      touch("pointerCancel", head("step"), 450);
      expect([all(".th-drop"), all("th.lifted"), scrollBlocked(), headIds()]).toEqual([[], [], false, ["name", "step", "assignees", "start", "end", "status"]]);
      vi.useRealTimers();
      headPointer(head("start"), "down", 310);
      headPointer(head("start"), "move", 140);
      headPointer(head("start"), "up", 140);
      expect([headIds(), haptics(), asks()]).toEqual([["name", "start", "step", "assignees", "end", "status"], [{ kind: "medium" }, { kind: "medium" }], []]);
    } finally {
      vi.useRealTimers();
      unstub();
    }
  });
});

const colsBtn = (): HTMLElement => one(".list-body > .cols-gutter > .cols-head > button.icon-button.cols-btn");

const colsPop = (): HTMLElement | null => document.querySelector('.popover.cols-pop[role="dialog"][aria-label="Columns"]');

const checkOf = (li: HTMLElement): HTMLInputElement => {
  const box = li.querySelector('label.cols-check input[type="checkbox"]');
  if (!(box instanceof HTMLInputElement)) throw new Error(`no checkbox in the ${li.dataset.col} row`);
  return box;
};

const colsRow = (col: string): HTMLElement => one(`.cols-list > li.cols-row[data-col="${col}"]`);

const colsRows = (): [string | undefined, string | null, boolean, boolean][] =>
  all(".cols-list > li.cols-row").map((li) => [li.dataset.col, one("label.cols-check", li).textContent, checkOf(li).checked, checkOf(li).disabled]);

const handleOf = (col: string): HTMLButtonElement => {
  const b = colsRow(col).querySelector("button.cols-handle");
  if (!(b instanceof HTMLButtonElement)) throw new Error(`no handle on the ${col} row`);
  return b;
};

const toggleCol = (col: string): void => {
  const box = checkOf(colsRow(col));
  box.focus();
  act(() => {
    fireEvent.click(box);
  });
};

const openCols = (): void => {
  act(() => {
    fireEvent.click(colsBtn());
  });
};

const ROW_H = 30;

const stubColsRows = (): void => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches(".cols-list > li.cols-row") && this.parentElement !== null) {
      const at = [...this.parentElement.children].indexOf(this);
      return new DOMRect(0, at * ROW_H, 240, ROW_H);
    }
    return new DOMRect(0, 0, 0, 0);
  });
};

const handlePointer = (el: Element, kind: "down" | "move" | "up" | "cancel", y: number, pointerType: "mouse" | "touch"): void => {
  const init = { clientX: 10, clientY: y, button: 0, pointerId: 3, pointerType };
  act(() => {
    if (kind === "down") fireEvent.pointerDown(el, init);
    else if (kind === "move") fireEvent.pointerMove(el, init);
    else if (kind === "up") fireEvent.pointerUp(el, init);
    else fireEvent.pointerCancel(el, init);
  });
};

const HIDDEN_ROWS: [string, string, boolean, boolean][] = [
  ["days", "Days", false, false],
  ["progress", "Progress", false, false],
  ["late", "Late by", false, false],
  ["deps", "Depends on", false, false],
  ["blocks", "Blocks", false, false],
  ["group", "Group", false, false],
  ["kind", "Kind", false, false],
  ["note", "Note", false, false],
];

describe("the Columns popover", () => {
  it("ends the header row with a Columns button that toggles the popover: shown columns in order, then hidden ones in registry order", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    const b = colsBtn();
    expect([b.getAttribute("aria-label"), b.getAttribute("title"), b.getAttribute("aria-haspopup"), b.getAttribute("aria-expanded"), colsPop()]).toEqual(["Columns", "Columns", "dialog", "false", null]);
    openCols();
    expect(colsBtn().getAttribute("aria-expanded")).toBe("true");
    expect(colsRows()).toEqual([
      ["name", "Name", true, true],
      ["step", "Step", true, false],
      ["assignees", "Assignees", true, false],
      ["start", "Start", true, false],
      ["end", "End", true, false],
      ["status", "Status", true, false],
      ...HIDDEN_ROWS,
    ]);
    expect(colsRow("name").querySelector(".cols-handle")).toBeNull();
    expect([handleOf("start").getAttribute("aria-label"), handleOf("start").getAttribute("title"), handleOf("start").disabled, handleOf("days").disabled, handleOf("days").getAttribute("aria-label")]).toEqual([
      "Move Start",
      "Drag to reorder · ⌥↑ ⌥↓",
      false,
      true,
      "Move Days",
    ]);
    expect([all(".cols-pop .popover-close").length, one(".cols-pop .cols-reset").textContent, one(".cols-pop .cols-reset").classList.contains("link-button")]).toEqual([1, "Reset columns", true]);
    expect([one(".pin-tag", colsRow("name")).textContent, all(".pin-tag").length]).toEqual(["pinned", 1]);
    const scrim = one(".popover-scrim");
    const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(scrim);
    act(() => {
      fireEvent.pointerDown(scrim, { button: 0, pointerType: "mouse", clientX: 5, clientY: 5 });
      fireEvent.pointerUp(scrim, { button: 0, pointerType: "mouse", clientX: 5, clientY: 5 });
      fireEvent.click(scrim, { button: 0, clientX: 5, clientY: 5 });
    });
    under.mockRestore();
    expect([colsPop(), colsBtn().getAttribute("aria-expanded"), document.activeElement, uiNow().columnsAsk]).toEqual([null, "false", colsBtn(), 0]);
    openCols();
    expect(colsPop()).not.toBeNull();
    openCols();
    expect([colsPop(), colsBtn().getAttribute("aria-expanded")]).toEqual([null, "false"]);
  });

  it("titles the handles with the Option glyphs on a Mac and with Alt on Linux", async () => {
    setPlatform(LINUX);
    const t = await made(STATUS_SEED);
    await list(t);
    openCols();
    expect(handleOf("start").getAttribute("title")).toBe("Drag to reorder · Alt ↑ Alt ↓");
  });

  it("shows and hides columns from the checklist, drops a hidden column's sort key, and Reset columns restores the defaults", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    sortBy("start");
    openCols();
    toggleCol("step");
    expect(document.activeElement).toBe(checkOf(colsRow("step")));
    expect(headIds()).toEqual(["name", "assignees", "start", "end", "status"]);
    expect(colsRows().map(([id, , on]) => [id, on])).toEqual([
      ["name", true],
      ["assignees", true],
      ["start", true],
      ["end", true],
      ["status", true],
      ["step", false],
      ...HIDDEN_ROWS.map(([id]) => [id, false]),
    ]);
    toggleCol("days");
    expect(document.activeElement).toBe(checkOf(colsRow("days")));
    expect([headIds(), stored()?.cols[5]]).toEqual([["name", "assignees", "start", "end", "status", "days"], { id: "days", w: 64 }]);
    toggleCol("start");
    expect([headIds(), sorted(), stored()?.sort]).toEqual([["name", "assignees", "end", "status", "days"], [], []]);
    expect([checkOf(colsRow("name")).checked, checkOf(colsRow("name")).disabled]).toEqual([true, true]);
    act(() => {
      fireEvent.click(one(".cols-pop .cols-reset"));
    });
    expect([headIds(), stored()?.cols]).toEqual([["name", "step", "assignees", "start", "end", "status"], DEFAULT_LIST_PREFS.cols]);
    expect(colsPop()).not.toBeNull();
  });

  it("reorders with a handle drag by mouse and by finger, cancels a drag on Escape without closing, and moves one place on ⌥↓ and ⌥↑", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    openCols();
    stubColsRows();
    handlePointer(handleOf("end"), "down", 135, "mouse");
    handlePointer(handleOf("end"), "move", 40, "mouse");
    expect([colsRow("end").classList.contains("dragging"), all(".cols-row.drop-above").map((li) => li.dataset.col), all(".cols-row.drop-below")]).toEqual([true, ["step"], []]);
    handlePointer(handleOf("end"), "up", 40, "mouse");
    expect([headIds(), all(".cols-row.dragging, .cols-row.drop-above, .cols-row.drop-below")]).toEqual([["name", "end", "step", "assignees", "start", "status"], []]);
    handlePointer(handleOf("step"), "down", 75, "touch");
    handlePointer(handleOf("step"), "move", 400, "touch");
    expect(all(".cols-row.drop-below").map((li) => li.dataset.col)).toEqual(["status"]);
    handlePointer(handleOf("step"), "up", 400, "touch");
    expect(headIds()).toEqual(["name", "end", "assignees", "start", "status", "step"]);
    handlePointer(handleOf("start"), "down", 105, "mouse");
    handlePointer(handleOf("start"), "move", 20, "mouse");
    press(handleOf("start"), "Escape");
    expect([colsPop() !== null, all(".cols-row.dragging, .cols-row.drop-above")]).toEqual([true, []]);
    handlePointer(handleOf("start"), "up", 20, "mouse");
    handlePointer(handleOf("status"), "down", 135, "touch");
    handlePointer(handleOf("status"), "move", 20, "touch");
    handlePointer(handleOf("status"), "cancel", 20, "touch");
    handlePointer(handleOf("status"), "up", 20, "touch");
    expect([headIds(), all(".cols-row.dragging, .cols-row.drop-above")]).toEqual([["name", "end", "assignees", "start", "status", "step"], []]);
    handleOf("assignees").focus();
    press(handleOf("assignees"), "ArrowDown", { altKey: true });
    expect([headIds(), document.activeElement]).toEqual([["name", "end", "start", "assignees", "status", "step"], handleOf("assignees")]);
    press(handleOf("assignees"), "ArrowUp", { altKey: true });
    press(handleOf("assignees"), "ArrowUp", { altKey: true });
    expect([headIds(), document.activeElement]).toEqual([["name", "assignees", "end", "start", "status", "step"], handleOf("assignees")]);
    const before = window.localStorage.getItem(listKey(TEST_PLAN));
    press(handleOf("assignees"), "ArrowUp", { altKey: true });
    press(handleOf("step"), "ArrowDown", { altKey: true });
    press(handleOf("start"), "ArrowDown");
    expect([window.localStorage.getItem(listKey(TEST_PLAN)), colsPop() !== null]).toEqual([before, true]);
  });

  it("closes on its X with focus back on the Columns button, and opens whenever columnsAsk moves on", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    openHeadMenu("start");
    chooseRow("Columns…");
    expect([uiNow().columnsAsk, colsPop() !== null, colsBtn().getAttribute("aria-expanded")]).toEqual([1, true, "true"]);
    const x = one(".cols-pop .popover-close");
    expect(x.getAttribute("aria-label")).toBe("Close");
    x.focus();
    act(() => {
      fireEvent.click(x);
    });
    expect([colsPop(), document.activeElement]).toEqual([null, colsBtn()]);
    setUiNow({ columnsAsk: uiNow().columnsAsk + 1 });
    expect(colsPop()).not.toBeNull();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(colsPop()).toBeNull();
  });
});
