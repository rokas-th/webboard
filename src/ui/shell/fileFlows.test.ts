import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import { encodeAction } from "../../store/doc";
import { fixedClock } from "../../services/clock";
import { exportBackup, exportIcs, exportListCsv, exportPlan, importPlan } from "../../store/file";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { testRegistry } from "../../test/shell";
import { hold, tauri } from "../../test/tauriMock";
import { clearToasts, toast } from "../common/Toast";
import { closeConverted, showConverted, shownConverted } from "./ConvertedReport";
import { listKey } from "../list/prefs";
import { backupFlow, exportFlow, exportIcsFlow, exportListCsvFlow, importFlow } from "./fileFlows";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../../store/file", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../store/file")>();
  return {
    ...m,
    exportPlan: vi.fn(m.exportPlan),
    exportListCsv: vi.fn(m.exportListCsv),
    exportIcs: vi.fn(m.exportIcs),
    exportBackup: vi.fn(m.exportBackup),
    importPlan: vi.fn(m.importPlan),
  };
});
vi.mock("../common/Toast", async (importOriginal) => {
  const m = await importOriginal<typeof import("../common/Toast")>();
  return { ...m, toast: vi.fn(m.toast) };
});

const sessions: PlanSession[] = [];

afterEach(async () => {
  clearToasts();
  vi.mocked(exportPlan).mockClear();
  vi.mocked(exportListCsv).mockClear();
  vi.mocked(exportIcs).mockClear();
  vi.mocked(exportBackup).mockClear();
  vi.mocked(importPlan).mockClear();
  window.localStorage.clear();
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

describe("exportListCsvFlow", () => {
  const OPEN_TWO: readonly SeedItem[] = [
    { id: "a", name: "Pour", start: "2026-11-10", dur: 2 },
    { id: "b", name: "Bolt", start: "2026-11-12", dur: 1 },
    { id: "c", name: "Survey", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  ];
  const EMPTY = "The List shows no items, so there is nothing to export.";

  it("writes the List's rows under the plan's name and toasts the count and the file", async () => {
    const t = await made(OPEN_TWO);
    vi.mocked(exportListCsv).mockResolvedValueOnce("Plan List.csv");
    await exportListCsvFlow(t.session, null);
    expect(vi.mocked(exportListCsv).mock.calls).toEqual([["Plan", "\uFEFFName,Step,Assignees,Start,End,Status\r\nPour,Now,,2026-11-10,2026-11-11,not started\r\nBolt,Now,,2026-11-12,2026-11-12,not started\r\n"]]);
    expect(toasts()).toEqual([["Exported 2 rows to Plan List.csv"]]);
  });

  it("reads the List settings this device keeps for the plan", async () => {
    const t = await made(OPEN_TWO);
    window.localStorage.setItem(listKey(t.session.view().plan.id), JSON.stringify({ v: 1, cols: [{ id: "name", w: 300 }], sort: [], scope: "done", chips: [], group: "outline" }));
    vi.mocked(exportListCsv).mockResolvedValueOnce("Plan List.csv");
    await exportListCsvFlow(t.session, null);
    expect(vi.mocked(exportListCsv).mock.calls).toEqual([["Plan", "\uFEFFName\r\nSurvey\r\n"]]);
    expect(toasts()).toEqual([["Exported 1 row to Plan List.csv"]]);
  });

  it("refuses with one error, writes no file and keeps the record when the saved List settings are unreadable", async () => {
    const t = await made(OPEN_TWO);
    const key = listKey(t.session.view().plan.id);
    window.localStorage.setItem(key, "{nope");
    const from = tauri.calls.length;
    await exportListCsvFlow(t.session, null);
    expect(vi.mocked(exportListCsv)).not.toHaveBeenCalled();
    expect(tauri.calls.slice(from)).toEqual([]);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].slice(0, 2)).toEqual(["Saved List settings for this plan could not be read, so nothing was exported. Open the List to reset them.", "bad"]);
    expect(String(toasts()[0][2])).toContain("The record was: {nope");
    expect(window.localStorage.getItem(key)).toBe("{nope");
  });

  it("gives the List's own Mine line, not the empty line, when Mine is stored without a live me", async () => {
    const t = await made(OPEN_TWO);
    window.localStorage.setItem(listKey(t.session.view().plan.id), JSON.stringify({ v: 1, cols: [{ id: "name", w: 300 }], sort: [], scope: "mine", chips: [], group: "outline" }));
    const from = tauri.calls.length;
    await exportListCsvFlow(t.session, null);
    await exportListCsvFlow(t.session, "nobody");
    expect(vi.mocked(exportListCsv)).not.toHaveBeenCalled();
    expect(tauri.calls.slice(from)).toEqual([]);
    expect(toasts()).toEqual([
      ["Mine needs “This is me”. Choose who you are in Settings › General."],
      ["The person chosen as you is not in this plan’s people. Mine shows nothing until you choose again."],
    ]);
  });

  it("opens no dialog and says so when the List shows no items", async () => {
    const t = await made([{ name: "Survey", start: "2026-11-02", dur: 1, status: "done", progress: 100 }]);
    const from = tauri.calls.length;
    await exportListCsvFlow(t.session, null);
    expect(vi.mocked(exportListCsv)).not.toHaveBeenCalled();
    expect(tauri.calls.slice(from)).toEqual([]);
    expect(toasts()).toEqual([[EMPTY]]);
  });

  it("does nothing when the save dialog is cancelled", async () => {
    const t = await made(OPEN_TWO);
    vi.mocked(exportListCsv).mockResolvedValueOnce(null);
    await exportListCsvFlow(t.session, null);
    expect(toasts()).toEqual([]);
  });

  it("shows a failed write as one bad toast", async () => {
    const t = await made(OPEN_TWO);
    const message = "Could not write /Users/x/Plan List.csv: Permission denied.";
    vi.mocked(exportListCsv).mockRejectedValueOnce(new AppError("file.io", message));
    await exportListCsvFlow(t.session, null);
    expect(toasts()).toEqual([[message, "bad"]]);
  });

  it("lets an error that is not an AppError propagate, with no toast", async () => {
    const t = await made(OPEN_TWO);
    const bug = new Error("exportListCsv broke");
    vi.mocked(exportListCsv).mockRejectedValueOnce(bug);
    await expect(exportListCsvFlow(t.session, null)).rejects.toBe(bug);
    expect(toasts()).toEqual([]);
  });

  it("writes through plan_export as csv", async () => {
    const t = await named(OPEN_TWO);
    tauri.answers.plan_export = () => "MESA 2027 List.csv";
    const from = tauri.calls.length;
    await exportListCsvFlow(t.session, null);
    const calls = tauri.calls.slice(from);
    expect(calls.map((c) => [c.cmd, new Headers(c.options?.headers).get("x-format"), new Headers(c.options?.headers).get("x-name")])).toEqual([["plan_export", "csv", encodeURIComponent("MESA 2027 List")]]);
    expect(toasts()).toEqual([["Exported 2 rows to MESA 2027 List.csv"]]);
  });

  it("calls plan_export once for two exports of a session at once, and again once it settles", async () => {
    const t = await made(OPEN_TWO);
    const pick = deferred<string | null>();
    const answers: Promise<string | null>[] = [pick.promise, Promise.resolve(null)];
    tauri.answers.plan_export = () => answers.shift();
    const exports = (): number => tauri.calls.filter((c) => c.cmd === "plan_export").length;
    const from = exports();
    const first = exportListCsvFlow(t.session, null);
    const second = exportListCsvFlow(t.session, null);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(second).toBe(first);
    expect(exports() - from).toBe(1);
    pick.resolve(null);
    await Promise.all([first, second]);
    await exportListCsvFlow(t.session, null);
    expect(exports() - from).toBe(2);
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
    const report = { fileName: "Fixture Plan 20260901.gantt", name: "MESA 2027", counts: { groups: 1, tasks: 2, milestones: 1, links: 2, notes: 1, people: 0, assignments: 0 }, dropped: ["TaskID on 4 items"] };
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

describe("exportIcsFlow", () => {
  const MILESTONES: readonly SeedItem[] = [
    { id: "a", name: "Pour", start: "2026-11-10", dur: 2 },
    { id: "m1", name: "Pier poured", kind: "milestone", start: "2026-11-12", dur: 0 },
    { id: "m2", name: "Dome set", kind: "milestone", start: "2026-11-20", dur: 0 },
    { id: "m3", name: "Optics ready", kind: "milestone", start: "2026-12-01", dur: 0 },
    { id: "m4", name: "Opening night", kind: "milestone", start: "2027-01-15", dur: 0 },
  ];
  const UNDATED: readonly SeedItem[] = [
    { id: "u1", name: "Some day", kind: "milestone" },
    { id: "u2", name: "Later", kind: "milestone" },
  ];
  const NOTHING = "This plan has no dated milestones, so there is nothing to export.";
  const ICS_CLOCK = fixedClock("2026-11-23", Date.UTC(2026, 10, 23, 14, 37, 58));

  it("stamps every event with the given clock's time, not the wall clock", async () => {
    const t = await made(MILESTONES);
    vi.mocked(exportIcs).mockResolvedValueOnce("Plan Milestones.ics");
    const wall = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2001, 0, 1));
    await exportIcsFlow(t.session, ICS_CLOCK);
    wall.mockRestore();
    const stamps = vi.mocked(exportIcs).mock.calls[0][1].split("\r\n").filter((l) => l.startsWith("DTSTAMP:"));
    expect(stamps).toEqual(Array.from({ length: 4 }, () => "DTSTAMP:20261123T143758Z"));
  });

  it("writes the dated milestones through plan_export as ics and toasts the count and the file", async () => {
    const t = await made(MILESTONES);
    t.session.apply({ t: "planName", name: "MESA 1.0" });
    tauri.answers.plan_export = () => "MESA 1.0 Milestones.ics";
    const from = tauri.calls.length;
    await exportIcsFlow(t.session, ICS_CLOCK);
    const calls = tauri.calls.slice(from);
    expect(calls.map((c) => [c.cmd, new Headers(c.options?.headers).get("x-format"), new Headers(c.options?.headers).get("x-name")])).toEqual([["plan_export", "ics", encodeURIComponent("MESA 1.0 Milestones")]]);
    expect(vi.mocked(exportIcs).mock.calls[0][0]).toBe("MESA 1.0");
    expect(vi.mocked(exportIcs).mock.calls[0][1].match(/BEGIN:VEVENT/g)).toHaveLength(4);
    expect(toasts()).toEqual([["Exported 4 milestones to MESA 1.0 Milestones.ics"]]);
  });

  it("says how many milestones without dates were left out", async () => {
    const t = await made([...MILESTONES, ...UNDATED]);
    vi.mocked(exportIcs).mockResolvedValueOnce("MESA 1.0 Milestones.ics");
    await exportIcsFlow(t.session, ICS_CLOCK);
    expect(toasts()).toEqual([["Exported 4 milestones to MESA 1.0 Milestones.ics 2 milestones without dates were left out."]]);
  });

  it("counts one in the singular", async () => {
    const t = await made([MILESTONES[1], UNDATED[0]]);
    vi.mocked(exportIcs).mockResolvedValueOnce("Plan Milestones.ics");
    await exportIcsFlow(t.session, ICS_CLOCK);
    expect(toasts()).toEqual([["Exported 1 milestone to Plan Milestones.ics 1 milestone without a date was left out."]]);
  });

  it("opens no dialog and says so when no milestone has a date", async () => {
    const t = await made([MILESTONES[0], ...UNDATED]);
    const from = tauri.calls.length;
    await exportIcsFlow(t.session, ICS_CLOCK);
    expect(vi.mocked(exportIcs)).not.toHaveBeenCalled();
    expect(tauri.calls.slice(from)).toEqual([]);
    expect(toasts()).toEqual([[NOTHING]]);
  });

  it("does nothing when the save dialog is cancelled", async () => {
    const t = await made(MILESTONES);
    vi.mocked(exportIcs).mockResolvedValueOnce(null);
    await exportIcsFlow(t.session, ICS_CLOCK);
    expect(toasts()).toEqual([]);
  });

  it("shows a failed write as one bad toast", async () => {
    const t = await made(MILESTONES);
    const message = "Could not write /Users/x/Plan Milestones.ics: Permission denied.";
    vi.mocked(exportIcs).mockRejectedValueOnce(new AppError("file.io", message));
    await exportIcsFlow(t.session, ICS_CLOCK);
    expect(toasts()).toEqual([[message, "bad"]]);
  });

  it("calls plan_export once for two exports of a session at once, and again once it settles", async () => {
    const t = await made(MILESTONES);
    const pick = deferred<string | null>();
    const answers: Promise<string | null>[] = [pick.promise, Promise.resolve(null)];
    tauri.answers.plan_export = () => answers.shift();
    const exports = (): number => tauri.calls.filter((c) => c.cmd === "plan_export").length;
    const from = exports();
    const first = exportIcsFlow(t.session, ICS_CLOCK);
    const second = exportIcsFlow(t.session, ICS_CLOCK);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(second).toBe(first);
    expect(exports() - from).toBe(1);
    pick.resolve(null);
    await Promise.all([first, second]);
    await exportIcsFlow(t.session, ICS_CLOCK);
    expect(exports() - from).toBe(2);
  });
});

describe("backupFlow", () => {
  interface Plans {
    registry: ReturnType<typeof testRegistry>;
    ids: PlanId[];
  }

  const plansOf = async (names: readonly string[], o: { trashed?: readonly string[]; failing?: Readonly<Record<string, Error>> } = {}): Promise<Plans> => {
    const all = await Promise.all(names.map(() => made([{ name: "A", start: "2026-11-10" }])));
    all.forEach((t, i) => t.session.apply({ t: "planName", name: names[i] }));
    const ids = all.map((_, i) => `P${i}`);
    const registry = testRegistry(all[0], {
      plans: () => all.map((_, i) => ({ id: ids[i], name: names[i], trashed: (o.trashed ?? []).includes(names[i]), loaded: true, space: null, example: false })),
      session: (id: string) => {
        const at = ids.indexOf(id);
        const failure = o.failing?.[names[at]];
        return failure === undefined ? Promise.resolve(all[at].session) : Promise.reject(failure);
      },
    });
    return { registry, ids };
  };

  const CLOCK = fixedClock("2026-11-23");

  it("writes every plan outside the Trash into one zip under today's date and toasts the count and the file", async () => {
    const p = await plansOf(["MESA 1.0", "Survey", "Old", "Optics"], { trashed: ["Old"] });
    tauri.answers.plan_export = () => "WebBoard backup 2026-11-23.zip";
    const from = tauri.calls.length;
    await backupFlow(p.registry, CLOCK);
    const calls = tauri.calls.slice(from);
    expect(calls.map((c) => [c.cmd, new Headers(c.options?.headers).get("x-format"), new Headers(c.options?.headers).get("x-name")])).toEqual([["plan_export", "zip", encodeURIComponent("WebBoard backup 2026-11-23")]]);
    expect(vi.mocked(exportBackup).mock.calls).toHaveLength(1);
    const [sessions, today, when] = vi.mocked(exportBackup).mock.calls[0];
    expect([sessions.map((s) => s.view().plan.name), today, when.getTime()]).toEqual([["MESA 1.0", "Survey", "Optics"], "2026-11-23", CLOCK.now()]);
    expect(toasts()).toEqual([["Backed up 3 plans to WebBoard backup 2026-11-23.zip"]]);
  });

  it("says when a plan holds changes this app cannot read yet", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }], { raw: { x1: RAW_X1 } });
    const two = await made([{ name: "B", start: "2026-11-10" }]);
    const ids = ["P0", "P1"];
    const registry = testRegistry(t, {
      plans: () => ids.map((id, i) => ({ id, name: `Plan ${i}`, trashed: false, loaded: true, space: null, example: false })),
      session: (id: string) => Promise.resolve(id === ids[0] ? t.session : two.session),
    });
    tauri.answers.plan_export = () => "WebBoard backup 2026-11-23.zip";
    await backupFlow(registry, CLOCK);
    expect(toasts()).toEqual([
      ["Backed up 2 plans to WebBoard backup 2026-11-23.zip 1 plan holds changes this app cannot read yet; Import will refuse it until they are resolved."],
    ]);
  });

  it("counts one plan in the singular", async () => {
    const p = await plansOf(["MESA 1.0"]);
    vi.mocked(exportBackup).mockResolvedValueOnce({ name: "WebBoard backup 2026-11-23.zip", plans: 1, unreadable: 0 });
    await backupFlow(p.registry, CLOCK);
    expect(toasts()).toEqual([["Backed up 1 plan to WebBoard backup 2026-11-23.zip"]]);
  });

  it("counts two plans with unreadable changes in the plural", async () => {
    const p = await plansOf(["MESA 1.0", "Survey"]);
    vi.mocked(exportBackup).mockResolvedValueOnce({ name: "WebBoard backup 2026-11-23.zip", plans: 2, unreadable: 2 });
    await backupFlow(p.registry, CLOCK);
    expect(toasts()).toEqual([
      ["Backed up 2 plans to WebBoard backup 2026-11-23.zip 2 plans hold changes this app cannot read yet; Import will refuse them until they are resolved."],
    ]);
  });

  it("opens no dialog and says so when every plan is in the Trash", async () => {
    const p = await plansOf(["Old"], { trashed: ["Old"] });
    const from = tauri.calls.length;
    await backupFlow(p.registry, CLOCK);
    expect(vi.mocked(exportBackup)).not.toHaveBeenCalled();
    expect(tauri.calls.slice(from)).toEqual([]);
    expect(toasts()).toEqual([["There are no plans to back up."]]);
  });

  it("writes nothing when one plan cannot be opened, and names it with its reason", async () => {
    const p = await plansOf(["MESA 1.0", "Survey", "Optics"], { failing: { Survey: new AppError("store.io", "Could not read the plan: disk error.") } });
    const from = tauri.calls.length;
    await backupFlow(p.registry, CLOCK);
    expect(vi.mocked(exportBackup)).not.toHaveBeenCalled();
    expect(tauri.calls.slice(from).filter((c) => c.cmd === "plan_export")).toEqual([]);
    expect(toasts()).toEqual([["“Survey” could not be opened, so nothing was backed up. Could not read the plan: disk error.", "bad"]]);
  });

  it("names every plan that could not be opened, each with its reason in the details", async () => {
    const p = await plansOf(["MESA 1.0", "Survey", "Optics", "Dome"], {
      failing: { Survey: new AppError("store.io", "Could not read the plan: disk error."), Optics: new AppError("store.io", "Second failure."), Dome: new AppError("plan.incomplete", "Third failure.") },
    });
    await backupFlow(p.registry, CLOCK);
    expect(vi.mocked(exportBackup)).not.toHaveBeenCalled();
    expect(toasts()).toEqual([
      [
        "“Survey”, “Optics” and “Dome” could not be opened, so nothing was backed up.",
        "bad",
        "“Survey”: Could not read the plan: disk error.\n“Optics”: Second failure.\n“Dome”: Third failure.",
      ],
    ]);
  });

  it("lets a bug in a later plan propagate even when an earlier plan failed with an AppError", async () => {
    const bug = new TypeError("projection broke");
    const p = await plansOf(["MESA 1.0", "Survey", "Optics"], { failing: { Survey: new AppError("store.io", "Could not read the plan: disk error."), Optics: bug } });
    await expect(backupFlow(p.registry, CLOCK)).rejects.toBe(bug);
    expect(vi.mocked(exportBackup)).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it("lets an open failure that is not an AppError propagate, with no toast", async () => {
    const bug = new Error("session broke");
    const p = await plansOf(["MESA 1.0", "Survey"], { failing: { Survey: bug } });
    await expect(backupFlow(p.registry, CLOCK)).rejects.toBe(bug);
    expect(vi.mocked(exportBackup)).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it("does nothing when the save dialog is cancelled", async () => {
    const p = await plansOf(["MESA 1.0"]);
    vi.mocked(exportBackup).mockResolvedValueOnce(null);
    await backupFlow(p.registry, CLOCK);
    expect(toasts()).toEqual([]);
  });

  it("shows a failed write as one bad toast", async () => {
    const p = await plansOf(["MESA 1.0"]);
    const message = "Could not write /Users/x/WebBoard backup 2026-11-23.zip: Permission denied.";
    vi.mocked(exportBackup).mockRejectedValueOnce(new AppError("file.io", message));
    await backupFlow(p.registry, CLOCK);
    expect(toasts()).toEqual([[message, "bad"]]);
  });

  it("runs once at a time, and again once it settles", async () => {
    const p = await plansOf(["MESA 1.0"]);
    const pick = deferred<string | null>();
    const answers: Promise<string | null>[] = [pick.promise, Promise.resolve(null)];
    tauri.answers.plan_export = () => answers.shift();
    const exports = (): number => tauri.calls.filter((c) => c.cmd === "plan_export").length;
    const from = exports();
    const first = backupFlow(p.registry, CLOCK);
    const second = backupFlow(p.registry, CLOCK);
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(second).toBe(first);
    expect(exports() - from).toBe(1);
    pick.resolve(null);
    await Promise.all([first, second]);
    await backupFlow(p.registry, CLOCK);
    expect(exports() - from).toBe(2);
  });
});
