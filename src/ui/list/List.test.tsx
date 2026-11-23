import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { fs, TEST_PLAN, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { shellFor } from "../../test/shell";
import { clearToasts } from "../common/Toast";
import { useUi, type UiState } from "../state";
import { statusLabel } from "./groups";
import { listModel } from "./model";
import { DEFAULT_LIST_PREFS, listKey, type ListPrefs } from "./prefs";
import { withSync } from "../../test/withSync";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
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
