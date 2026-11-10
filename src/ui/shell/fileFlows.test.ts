import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import { encodeAction } from "../../store/doc";
import { exportPlan, importPlan } from "../../store/file";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { testRegistry } from "../../test/shell";
import { hold, tauri, type Call } from "../../test/tauriMock";
import { clearToasts, toast } from "../common/Toast";
import { closeConverted, shownConverted } from "./ConvertedReport";
import { exportFlow, importFlow } from "./fileFlows";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
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
  vi.mocked(save).mockReset();
  vi.mocked(openDialog).mockReset();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
};

const PATH = "/Users/x/Plans/MESA 1.0.webboard";

const toasts = (): unknown[][] => vi.mocked(toast).mock.calls;

const xpath = (c: Call): string | null => new Headers(c.options?.headers).get("x-path");

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
    vi.mocked(exportPlan).mockResolvedValueOnce({ path: PATH, unreadable: 0 });
    await exportFlow(t.session, "macos");
    expect(vi.mocked(exportPlan).mock.calls).toEqual([[t.session, "macos"]]);
    expect(toasts()).toEqual([["Exported to MESA 1.0.webboard"]]);
  });

  it("does nothing when the save dialog is cancelled", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    vi.mocked(exportPlan).mockResolvedValueOnce(null);
    await exportFlow(t.session, "macos");
    expect(toasts()).toEqual([]);
  });

  it("shows a failed write as one bad toast and touches nothing else", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    const apply = vi.spyOn(t.session, "apply");
    const message = "Could not write /Users/x/Plans/MESA 1.0.webboard: Permission denied.";
    vi.mocked(exportPlan).mockRejectedValueOnce(new AppError("file.io", message));
    const from = tauri.calls.length;
    await exportFlow(t.session, "macos");
    expect(toasts()).toEqual([[message, "bad"]]);
    expect(vi.mocked(exportPlan)).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(tauri.calls.slice(from)).toEqual([]);
  });

  it("lets an error that is not an AppError propagate, with no toast", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    const bug = new Error("exportPlan broke");
    vi.mocked(exportPlan).mockRejectedValueOnce(bug);
    await expect(exportFlow(t.session, "macos")).rejects.toBe(bug);
    expect(toasts()).toEqual([]);
  });

  it("writes a clean plan and toasts the plain success", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }], { answers: { file_write: () => null } });
    vi.mocked(save).mockResolvedValueOnce(PATH);
    const from = tauri.calls.length;
    await exportFlow(t.session, "macos");
    expect(tauri.calls.slice(from).filter((c) => c.cmd === "file_write").map(xpath)).toEqual([encodeURIComponent(PATH)]);
    expect(toasts()).toEqual([["Exported to MESA 1.0.webboard"]]);
  });

  it("on iOS stages the plan before the dialog, writes nothing after it, and toasts the destination's name", async () => {
    const dest = "/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/MESA 1.0.webboard";
    const t = await made([{ name: "A", start: "2026-11-10" }], {
      answers: { file_stage: () => "MESA 1.0.webboard", file_unstage: () => null, file_write: () => null },
    });
    vi.mocked(save).mockResolvedValueOnce(dest);
    const from = tauri.calls.length;
    await exportFlow(t.session, "ios");
    expect(vi.mocked(exportPlan).mock.calls).toEqual([[t.session, "ios"]]);
    expect(vi.mocked(save).mock.calls).toEqual([[{ defaultPath: "MESA 1.0.webboard", filters: [{ name: "WebBoard plan", extensions: ["webboard"] }] }]]);
    expect(tauri.calls.slice(from).flatMap((c) => (c.cmd.startsWith("file_") ? [c.cmd] : []))).toEqual(["file_stage", "file_unstage"]);
    expect(toasts()).toEqual([["Exported to MESA 1.0.webboard"]]);
  });

  it("still writes a plan holding an unreadable action, and says Import will refuse it", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }], { raw: { x1: RAW_X1 }, answers: { file_write: () => null } });
    expect([t.session.view().unreadable.length, t.session.view().pending]).toEqual([1, 0]);
    vi.mocked(save).mockResolvedValueOnce(PATH);
    const from = tauri.calls.length;
    await exportFlow(t.session, "macos");
    expect(tauri.calls.slice(from).filter((c) => c.cmd === "file_write").map(xpath)).toEqual([encodeURIComponent(PATH)]);
    expect(toasts()).toEqual([
      ["Exported. This file holds 1 action this app cannot read yet, so Import will refuse it until they are resolved."],
    ]);
  });

  it("counts the unreadable action and the one waiting on it", async () => {
    const t = await made([{ id: "A", name: "A", start: "2026-11-10" }], { raw: { x1: RAW_X1, x2: child("x2", "Renamed") }, answers: { file_write: () => null } });
    expect([t.session.view().unreadable.length, t.session.view().pending]).toEqual([1, 1]);
    vi.mocked(save).mockResolvedValueOnce(PATH);
    await exportFlow(t.session, "macos");
    expect(toasts()).toEqual([
      ["Exported. This file holds 2 actions this app cannot read yet, so Import will refuse it until they are resolved."],
    ]);
  });
  it("reports the unreadable count of the state it encoded, not of a view that changed during the write", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }], { answers: { file_write: () => null } });
    vi.mocked(save).mockResolvedValueOnce(PATH);
    const held = hold("file_write");
    const from = tauri.calls.length;
    const flow = exportFlow(t.session, "macos");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(tauri.calls.slice(from).filter((c) => c.cmd === "file_write")).toHaveLength(1);
    t.doc.ydoc.getMap("actions").set("x1", RAW_X1);
    expect(t.session.view().unreadable).toHaveLength(1);
    held.resolve(null);
    await flow;
    expect(toasts()).toEqual([["Exported to MESA 1.0.webboard"]]);
  });

  it("opens one save dialog for two exports of a session at once, and its own for another session", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    const u = await made([{ name: "B", start: "2026-11-10" }]);
    const picks = [deferred<string | null>(), deferred<string | null>()];
    vi.mocked(save).mockReturnValueOnce(picks[0].promise).mockReturnValueOnce(picks[1].promise);
    const first = exportFlow(t.session, "macos");
    const second = exportFlow(t.session, "macos");
    const other = exportFlow(u.session, "macos");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(second).toBe(first);
    expect(vi.mocked(save)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(exportPlan).mock.calls).toEqual([[t.session, "macos"], [u.session, "macos"]]);
    picks.forEach((p) => p.resolve(null));
    await Promise.all([first, second, other]);
    vi.mocked(save).mockResolvedValueOnce(null);
    await exportFlow(t.session, "macos");
    expect(vi.mocked(save)).toHaveBeenCalledTimes(3);
    expect(toasts()).toEqual([]);
  });
});

describe("importFlow", () => {
  it("opens one open dialog for two imports at once, and a new one once it settles", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const registry = testRegistry(t);
    const pick = deferred<string | null>();
    vi.mocked(openDialog).mockReturnValueOnce(pick.promise);
    const open = vi.fn<(id: PlanId) => void>();
    const first = importFlow(registry, open);
    const second = importFlow(registry, open);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(second).toBe(first);
    expect(vi.mocked(openDialog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(importPlan)).toHaveBeenCalledTimes(1);
    pick.resolve(null);
    await Promise.all([first, second]);
    vi.mocked(openDialog).mockResolvedValueOnce(null);
    await importFlow(registry, open);
    expect(vi.mocked(openDialog)).toHaveBeenCalledTimes(2);
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
    expect(vi.mocked(importPlan).mock.calls).toEqual([[registry]]);
    expect(open.mock.calls).toEqual([[id]]);
    expect(toasts()).toEqual([["Imported “MESA 2027”"]]);
  });

  it("shows what a .gantt conversion made and dropped, and opens the plan only once that report is closed", async () => {
    const t = await named([{ name: "A", start: "2026-11-10" }]);
    const id = t.session.view().plan.id;
    const open = vi.fn<(id: PlanId) => void>();
    const report = { fileName: "Fixture Plan 20260901.gantt", name: "MESA 2027", counts: { groups: 1, tasks: 2, milestones: 1, links: 2, notes: 1 }, dropped: ["TaskID on 4 items"] };
    vi.mocked(importPlan).mockResolvedValueOnce({ planId: id, converted: report });
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
