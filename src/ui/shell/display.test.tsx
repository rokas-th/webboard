import { act, cleanup, renderHook } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { boardKey } from "../board/prefs";
import type { PickSection } from "../common/ContextMenu";
import { clearToasts } from "../common/Toast";
import { DEFAULT_LIST_PREFS, listKey, type ListPrefs } from "../list/prefs";
import { UiContext, type UiState, type ViewKind } from "../state";
import { useDisplayMenu, type DisplayMenu } from "./display";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  clearToasts();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
});

const made = async (): Promise<TestSession> => {
  const t = await testSession(MESA_SEED);
  sessions.push(t.session);
  return t;
};

const BASE: UiState = {
  plan: null,
  view: "timeline",
  zoom: "W",
  selected: null,
  collapsed: new Set(),
  baseline: null,
  dialog: null,
  reveal: null,
  follow: null,
  naming: null,
  settings: null,
  settingsRow: null,
  syncPane: null,
  sidebarOpen: true,
  sidebarWidth: null,
  query: "",
  searchAsk: 0,
  columnsAsk: 0,
};

const seen: { ui: UiState } = { ui: BASE };

function Ui(p: { children: ReactNode }) {
  const [ui, setState] = useState<UiState>(BASE);
  seen.ui = ui;
  return <UiContext.Provider value={{ ui, setUi: (patch) => setState((prev) => ({ ...prev, ...patch })) }}>{p.children}</UiContext.Provider>;
}

const hook = (session: PlanSession | null, view: ViewKind) => renderHook(() => useDisplayMenu(session, view), { wrapper: Ui });

const present = (m: DisplayMenu | null): DisplayMenu => {
  if (m === null) throw new Error("no Display menu");
  return m;
};

const rows = (sections: readonly PickSection[]): string[] =>
  sections.flatMap((s) => [...(s.title === null ? [] : [`group ${s.title}`]), ...s.rows.map((r) => `${r.id} ${r.title}${r.checkable ? (r.checked ? " [x]" : " [ ]") : ""}`)]);

const storedList = (plan: string): ListPrefs => {
  const raw = window.localStorage.getItem(listKey(plan));
  if (raw === null) throw new Error("no List record");
  return JSON.parse(raw);
};

describe("useDisplayMenu", () => {
  it("is null on the Timeline and without a session", async () => {
    const t = await made();
    expect(hook(t.session, "timeline").result.current).toBeNull();
    expect(hook(null, "list").result.current).toBeNull();
    expect(hook(null, "board").result.current).toBeNull();
  });

  it("offers Group by and the column rows on the List", async () => {
    const t = await made();
    const m = present(hook(t.session, "list").result.current);
    expect(rows(m.sections)).toEqual([
      "group Group by",
      "group:outline Plan outline [x]",
      "group:step Step [ ]",
      "group:assignee Assignee [ ]",
      "group:none None [ ]",
      "columns Columns…",
      "reset-columns Reset columns",
    ]);
    expect(m.sections.map((s) => s.title)).toEqual(["Group by", null]);
  });

  it("groups the List from its rows and the check follows", async () => {
    const t = await made();
    const plan = t.session.view().plan.id;
    const h = hook(t.session, "list");
    act(() => present(h.result.current).run("group:step"));
    expect(storedList(plan).group).toBe("step");
    expect(rows(present(h.result.current).sections).slice(1, 3)).toEqual(["group:outline Plan outline [ ]", "group:step Step [x]"]);
  });

  it("asks for the Columns popover through columnsAsk", async () => {
    const t = await made();
    const h = hook(t.session, "list");
    const before = seen.ui.columnsAsk;
    act(() => present(h.result.current).run("columns"));
    expect(seen.ui.columnsAsk).toBe(before + 1);
  });

  it("resets the columns and keeps the sort keys still shown", async () => {
    const t = await made();
    const plan = t.session.view().plan.id;
    const wide: ListPrefs = {
      ...DEFAULT_LIST_PREFS,
      cols: [...DEFAULT_LIST_PREFS.cols.map((c) => (c.id === "step" ? { id: c.id, w: 200 } : c)), { id: "days", w: 64 }],
      sort: [
        { id: "days", dir: "asc" },
        { id: "start", dir: "desc" },
      ],
      group: "step",
    };
    window.localStorage.setItem(listKey(plan), JSON.stringify(wide));
    const h = hook(t.session, "list");
    act(() => present(h.result.current).run("reset-columns"));
    expect(storedList(plan)).toEqual({ ...DEFAULT_LIST_PREFS, sort: [{ id: "start", dir: "desc" }], group: "step" });
  });

  it("offers the Done column and one row per live step on the Board", async () => {
    const t = await made();
    const plan = t.session.view().plan.id;
    window.localStorage.setItem(boardKey(plan), JSON.stringify({ v: 1, hidden: ["later"], doneOpen: true }));
    const m = present(hook(t.session, "board").result.current);
    expect(rows(m.sections)).toEqual(["done-open Expand the Done column [x]", "group Steps", "step:now Now [x]", "step:next Next [x]", "step:later Later [ ]", "step:done Done [x]"]);
  });

  it("toggles a step and the Done column through the Board record", async () => {
    const t = await made();
    const plan = t.session.view().plan.id;
    const h = hook(t.session, "board");
    act(() => present(h.result.current).run("step:next"));
    expect(JSON.parse(window.localStorage.getItem(boardKey(plan)) ?? "null")).toEqual({ v: 1, hidden: ["next"], doneOpen: false });
    act(() => present(h.result.current).run("done-open"));
    act(() => present(h.result.current).run("step:next"));
    expect(JSON.parse(window.localStorage.getItem(boardKey(plan)) ?? "null")).toEqual({ v: 1, hidden: [], doneOpen: true });
  });

  it("leaves out the Done column row when no step completes", async () => {
    const t = await made();
    const h = hook(t.session, "board");
    act(() => {
      t.session.apply({ t: "step", op: "noneCompletes" });
    });
    expect(rows(present(h.result.current).sections)).toEqual(["group Steps", "step:now Now [x]", "step:next Next [x]", "step:later Later [x]", "step:done Done [x]"]);
    expect(() => present(h.result.current).run("done-open")).toThrow('Display: no row "done-open" on the Board');
  });

  it("follows a step added on another device", async () => {
    const t = await made();
    const h = hook(t.session, "board");
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "Review", colour: "amber", after: "next" });
    });
    expect(rows(present(h.result.current).sections).filter((r) => r.startsWith("step:")).map((r) => r.replace(/^step:\S+ /, ""))).toEqual(["Now [x]", "Next [x]", "Review [x]", "Later [x]", "Done [x]"]);
  });

  it("throws on a row it does not have", async () => {
    const t = await made();
    expect(() => present(hook(t.session, "list").result.current).run("step:now")).toThrow('Display: no row "step:now" on the List');
    expect(() => present(hook(t.session, "board").result.current).run("step:gone")).toThrow('Display: no row "step:gone" on the Board');
    expect(() => present(hook(t.session, "board").result.current).run("columns")).toThrow('Display: no row "columns" on the Board');
  });
});
