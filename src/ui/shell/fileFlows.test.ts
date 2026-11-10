import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import { encodeAction } from "../../store/doc";
import { exportPlan, importPlan } from "../../store/file";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { testRegistry } from "../../test/shell";
import { hold, tauri } from "../../test/tauriMock";
import { clearToasts, toast } from "../common/Toast";
import { closeConverted, showConverted, shownConverted } from "./ConvertedReport";
import { exportFlow, importFlow } from "./fileFlows";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../../store/file", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../store/file")>();
  return { ...m, exportPlan: vi.fn(m.exportPlan), importPlan: vi.fn(m.importPlan) };
});
vi.mock("../common/Toast", async (importOriginal) => {
  const m = await importOriginal<typeof import("../common/Toast")>();
  return { ...m, toast: vi.fn(m.toast) };
});

const sessions: PlanSession[] = [];

afterEach(async () => {
  clearToasts();
  vi.mocked(exportPlan).mockClear();
  vi.mocked(importPlan).mockClear();
  vi.mocked(toast).mockClear();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
};

const NAME = "MESA 1.0.webboard";

const toasts = (): unknown[][] => vi.mocked(toast).mock.calls;

const RAW_X1 = ["iphone", "s1", 0, [], "Bad", "not-writes"];
const child = (id: string, name: string): unknown[] =>
  encodeAction({ id, dev: "iphone", ses: "s1", at: 0, par: ["x1"], lbl: "Rename", w: [{ u: "n:A", v: name, c: "own" }] });

const CLASH: readonly SeedItem[] = [
  { id: "a", name: "A", start: "2026-11-10", dur: 3 },
  { id: "b", name: "B", start: "2026-11-10", dur: 2, deps: [fs("a")] },
  { id: "c", name: "C", start: "2026-11-10", dur: 2, deps: [fs("a")] },
];

const named = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await made(seed);
  t.session.apply({ t: "planName", name: "MESA 2027" });
  return t;
};

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  const settlers: ((v: T) => void)[] = [];
  const promise = new Promise<T>((resolve) => settlers.push(resolve));
  return { promise, resolve: (v) => settlers[0](v) };
}

describe("exportFlow", () => {
  it("toasts the file name once the plan is written", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    vi.mocked(exportPlan).mockResolvedValueOnce({ name: NAME, unreadable: 0 });
    await exportFlow(t.session);
    expect(vi.mocked(exportPlan).mock.calls).toEqual([[t.session]]);
    expect(toasts()).toEqual([["Exported to MESA 1.0.webboard"]]);
  });

  it("does nothing when the save dialog is cancelled", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    vi.mocked(exportPlan).mockResolvedValueOnce(null);
    await exportFlow(t.session);
    expect(toasts()).toEqual([]);
  });

  it("shows a failed write as one bad toast and touches nothing else", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    const apply = vi.spyOn(t.session, "apply");
    const message = "Could not write /Users/x/Plans/MESA 1.0.webboard: Permission denied.";
    vi.mocked(exportPlan).mockRejectedValueOnce(new AppError("file.io", message));
    const from = tauri.calls.length;
    await exportFlow(t.session);
    expect(toasts()).toEqual([[message, "bad"]]);
    expect(vi.mocked(exportPlan)).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(tauri.calls.slice(from)).toEqual([]);
  });

  it("lets an error that is not an AppError propagate, with no toast", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    const bug = new Error("exportPlan broke");
    vi.mocked(exportPlan).mockRejectedValueOnce(bug);
    await expect(exportFlow(t.session)).rejects.toBe(bug);
    expect(toasts()).toEqual([]);
  });

  it("writes a clean plan through plan_export and toasts the plain success", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    tauri.answers.plan_export = () => NAME;
    const from = tauri.calls.length;
    await exportFlow(t.session);
    expect(tauri.calls.slice(from).map((c) => c.cmd)).toEqual(["plan_export"]);
    expect(toasts()).toEqual([["Exported to MESA 1.0.webboard"]]);
  });

  it("still writes a plan holding an unreadable action, and says Import will refuse it", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }], { raw: { x1: RAW_X1 }, answers: { plan_export: () => NAME } });
    expect([t.session.view().unreadable.length, t.session.view().pending]).toEqual([1, 0]);
    const from = tauri.calls.length;
    await exportFlow(t.session);
    expect(tauri.calls.slice(from).map((c) => c.cmd)).toEqual(["plan_export"]);
    expect(toasts()).toEqual([
      ["Exported. This file holds 1 action this app cannot read yet, so Import will refuse it until they are resolved."],
    ]);
  });

  it("counts the unreadable action and the one waiting on it", async () => {
    const t = await made([{ id: "A", name: "A", start: "2026-11-10" }], { raw: { x1: RAW_X1, x2: child("x2", "Renamed") }, answers: { plan_export: () => NAME } });
    expect([t.session.view().unreadable.length, t.session.view().pending]).toEqual([1, 1]);
    await exportFlow(t.session);
    expect(toasts()).toEqual([
      ["Exported. This file holds 2 actions this app cannot read yet, so Import will refuse it until they are resolved."],
    ]);
  });
  it("reports the unreadable count of the state it encoded, not of a view that changed during the write", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    const held = hold("plan_export");
    const from = tauri.calls.length;
    const flow = exportFlow(t.session);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(tauri.calls.slice(from).filter((c) => c.cmd === "plan_export")).toHaveLength(1);
    t.doc.ydoc.getMap("actions").set("x1", RAW_X1);
    expect(t.session.view().unreadable).toHaveLength(1);
    held.resolve(NAME);
    await flow;
    expect(toasts()).toEqual([["Exported to MESA 1.0.webboard"]]);
  });

  it("calls plan_export once for two exports of a session at once, and once for another session", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    const u = await made([{ name: "B", start: "2026-11-10" }]);
    const picks = [deferred<string | null>(), deferred<string | null>()];
    const answers: Promise<string | null>[] = [picks[0].promise, picks[1].promise, Promise.resolve(null)];
    tauri.answers.plan_export = () => answers.shift();
    const exports = (): number => tauri.calls.filter((c) => c.cmd === "plan_export").length;
    const from = exports();
    const first = exportFlow(t.session);
    const second = exportFlow(t.session);
    const other = exportFlow(u.session);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(second).toBe(first);
    expect(exports() - from).toBe(2);
    expect(vi.mocked(exportPlan).mock.calls).toEqual([[t.session], [u.session]]);
    picks.forEach((p) => p.resolve(null));
    await Promise.all([first, second, other]);
    await exportFlow(t.session);
    expect(exports() - from).toBe(3);
    expect(toasts()).toEqual([]);
  });
});

describe("importFlow", () => {
  it("calls plan_import once for two imports at once, and again once it settles", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const registry = testRegistry(t);
    const pick = deferred<ArrayBuffer>();
    const answers: Promise<ArrayBuffer>[] = [pick.promise, Promise.resolve(new ArrayBuffer(0))];
    tauri.answers.plan_import = () => answers.shift();
    const imports = (): number => tauri.calls.filter((c) => c.cmd === "plan_import").length;
    const from = imports();
    const open = vi.fn<(id: PlanId) => void>();
    const first = importFlow(registry, open);
    const second = importFlow(registry, open);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(second).toBe(first);
    expect(imports() - from).toBe(1);
    expect(vi.mocked(importPlan)).toHaveBeenCalledTimes(1);
    pick.resolve(new ArrayBuffer(0));
    await Promise.all([first, second]);
    await importFlow(registry, open);
    expect(imports() - from).toBe(2);
    expect(open).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it("opens the imported plan and names it", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const id = t.session.view().plan.id;
    const registry = testRegistry(t);
    const open = vi.fn<(id: PlanId) => void>();
    vi.mocked(importPlan).mockResolvedValueOnce({ planId: id, converted: null });
    await importFlow(registry, open);
    expect(vi.mocked(importPlan).mock.calls).toEqual([[registry, showConverted]]);
    expect(open.mock.calls).toEqual([[id]]);
    expect(toasts()).toEqual([["Imported “MESA 2027”"]]);
  });

  it("shows what a .gantt conversion made and dropped, and opens the plan only once that report is closed", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const id = t.session.view().plan.id;
    const open = vi.fn<(id: PlanId) => void>();
    const report = { fileName: "Fixture Plan 20260901.gantt", name: "MESA 2027", counts: { groups: 1, tasks: 2, milestones: 1, links: 2, notes: 1 }, dropped: ["TaskID on 4 items"] };
    vi.mocked(importPlan).mockImplementationOnce(async (_r, review) => {
      await review(report);
      return { planId: id, converted: report };
    });
    const flow = importFlow(testRegistry(t), open);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(shownConverted()).toEqual(report);
    expect(open).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
    closeConverted();
    await flow;
    expect(shownConverted()).toBeNull();
    expect(open.mock.calls).toEqual([[id]]);
    expect(toasts()).toEqual([["Imported “MESA 2027”"]]);
  });

  it("counts the conflicts to fix", async () => {
    const t = await named(CLASH);
    const id = t.session.view().plan.id;
    expect(t.session.view().derived.conflicts.filter((c) => c.kind === "early" || c.kind === "loop")).toHaveLength(2);
    const open = vi.fn<(id: PlanId) => void>();
    vi.mocked(importPlan).mockResolvedValueOnce({ planId: id, converted: null });
    await importFlow(testRegistry(t), open);
    expect(open.mock.calls).toEqual([[id]]);
    expect(toasts()).toEqual([["Imported “MESA 2027” — 2 conflicts to fix"]]);
  });

  it("counts one conflict in the singular", async () => {
    const t = await named(CLASH.slice(0, 2));
    vi.mocked(importPlan).mockResolvedValueOnce({ planId: t.session.view().plan.id, converted: null });
    await importFlow(testRegistry(t), vi.fn<(id: PlanId) => void>());
    expect(toasts()).toEqual([["Imported “MESA 2027” — 1 conflict to fix"]]);
  });

  it("opens the plan before its session arrives", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const id = t.session.view().plan.id;
    const later = deferred<PlanSession>();
    const open = vi.fn<(id: PlanId) => void>();
    vi.mocked(importPlan).mockResolvedValueOnce({ planId: id, converted: null });
    const flow = importFlow(testRegistry(t, { session: () => later.promise }), open);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(open.mock.calls).toEqual([[id]]);
    expect(toasts()).toEqual([]);
    later.resolve(t.session);
    await flow;
    expect(toasts()).toEqual([["Imported “MESA 2027”"]]);
  });

  it("does nothing when the open dialog is cancelled", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const open = vi.fn<(id: PlanId) => void>();
    vi.mocked(importPlan).mockResolvedValueOnce(null);
    await importFlow(testRegistry(t), open);
    expect(open).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it.each([
    ["import.foreign", "This file is not a WebBoard plan."],
    ["import.truncated", "This file is incomplete (20 of 64 bytes); export it again."],
    ["import.newer", "This file comes from a newer WebBoard (format 2); update WebBoard to open it."],
    ["import.corrupt", "This file is damaged: 1 actions refer to missing parents"],
    ["import.unknown_units", "This plan uses data this WebBoard does not know (zz:1); update WebBoard to open it."],
    ["file.io", "Could not read /Users/x/Plans/MESA 1.0.webboard: No such file or directory."],
  ])("shows %s as one bad toast of its message and opens nothing", async (code, message) => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const open = vi.fn<(id: PlanId) => void>();
    vi.mocked(importPlan).mockRejectedValueOnce(new AppError(code, message));
    await importFlow(testRegistry(t), open);
    expect(toasts()).toEqual([[message, "bad"]]);
    expect(open).not.toHaveBeenCalled();
  });

  it("shows a multi-line .gantt refusal whole and offers it to copy", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const open = vi.fn<(id: PlanId) => void>();
    const message = "WebBoard would show different dates than the .gantt file:\n- Task 2 Survey: source 2026-09-07 → 2026-09-10, WebBoard 2026-09-07 → 2026-09-11\n- Task 3 Build: source 2026-09-14 → 2026-09-17, WebBoard 2026-09-14 → 2026-09-18";
    vi.mocked(importPlan).mockRejectedValueOnce(new AppError("import.gantt", message));
    await importFlow(testRegistry(t), open);
    expect(toasts()).toEqual([[message, "bad", message]]);
    expect(open).not.toHaveBeenCalled();
  });

  it("shows a session that will not open as one bad toast, after opening the plan", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const id = t.session.view().plan.id;
    const open = vi.fn<(id: PlanId) => void>();
    vi.mocked(importPlan).mockResolvedValueOnce({ planId: id, converted: null });
    const registry = testRegistry(t, { session: () => Promise.reject(new AppError("store.io", "Could not read the plan: disk error.")) });
    await importFlow(registry, open);
    expect(open.mock.calls).toEqual([[id]]);
    expect(toasts()).toEqual([["Could not read the plan: disk error.", "bad"]]);
  });

  it("lets an error that is not an AppError propagate, with no toast", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const bug = new Error("importPlan broke");
    const open = vi.fn<(id: PlanId) => void>();
    vi.mocked(importPlan).mockRejectedValueOnce(bug);
    await expect(importFlow(testRegistry(t), open)).rejects.toBe(bug);
    expect(open).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });
});
