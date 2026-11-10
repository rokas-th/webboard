import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { shellFor } from "../../test/shell";
import { clearToasts } from "../common/Toast";
import { useUi, type UiState } from "../state";
import { statusLabel } from "./groups";
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

const list = async (t: TestSession): Promise<void> => {
  render(withSync(shellFor(t).ui));
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: "List" }));
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

describe("List", () => {
  it("has the columns Item Start End Days Status Depends on, unsorted", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    const ths = all("thead th");
    expect(ths.map((e) => e.textContent)).toEqual(["Item", "Start", "End", "Days", "Status", "Depends on"]);
    ths.forEach((th) => expect(th.hasAttribute("aria-sort")).toBe(false));
    const before = one("tbody").innerHTML;
    ths.forEach((th) => fireEvent.click(th));
    expect(one("tbody").innerHTML).toBe(before);
    expect(uiNow().selected).toBeNull();
  });

  it("writes Start, End, Days, one status label per row and its dependencies", async () => {
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
    expect(all("tbody tr").map((r) => (r.classList.contains("grp") ? `# ${r.textContent}` : r.dataset.lrow))).toEqual(["# G", "b", "a", "# Not in a group", "c"]);
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

  it("selects nothing for a pointer that moved 4 px or more", async () => {
    const t = await made(STATUS_SEED);
    await list(t);
    pointer(row("P"), "down", 10, 10);
    pointer(row("P"), "up", 10, 14);
    expect(uiNow().selected).toBeNull();
  });

  it("shows the trashed item of a delete choice as a ghost row that opens", async () => {
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
    const t = await made(SPRINT);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["S"] });
    p.session.apply({ t: "rename", item: "r", name: "Review 2" });
    p.sync();
    await list(t);
    expect(all("tbody tr").map((r) => (r.classList.contains("grp") ? `# ${r.textContent}` : r.dataset.lrow))).toEqual(["# Sprint 4", "r", "# Not in a group", "x"]);
    expect(row("r").tagName).toBe("TR");
    expect(row("r").classList.contains("ghost-row")).toBe(true);
    expect(row("x").classList.contains("ghost-row")).toBe(false);
    expect(cells("r")).toEqual(["Review 2", "", "", "", "held", ""]);
    pointer(row("r"), "down", 10, 10);
    pointer(row("r"), "up", 12, 11);
    expect(uiNow().selected).toBe("r");
  });

  it("renders a ghost whose parent group was trashed apart under Not in a group", async () => {
    const t = await made(SPRINT);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["r"] });
    p.session.apply({ t: "rename", item: "r", name: "Review 2" });
    p.sync();
    t.session.apply({ t: "trash", items: ["S"] });
    await list(t);
    expect(all("tbody tr").map((r) => (r.classList.contains("grp") ? `# ${r.textContent}` : r.dataset.lrow))).toEqual(["# Not in a group", "r", "x"]);
    expect(row("r").classList.contains("ghost-row")).toBe(true);
    expect(cells("r")).toEqual(["Review 2", "", "", "", "held", ""]);
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
