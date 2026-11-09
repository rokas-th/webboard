import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutcomeRow, ResolvePreview } from "../../actions/resolve";
import type { Preview } from "../../actions/intents";
import { toDay } from "../../domain/dates";
import type { PlanSession } from "../../store/session";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { groupRows, outcomeLine, sideSummary } from "./outcome";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return t;
};

const span = (start: string, end: string): { start: number; end: number } => ({ start: toDay(start), end: toDay(end) });

const row = (item: string, before: { start: number; end: number } | null, after: { start: number; end: number } | null, shift = 0, group: string | null = null): OutcomeRow => ({
  item,
  group,
  before,
  after,
  shift,
});

const preview = (over: Partial<Preview>): Preview => ({ itemsChanged: 0, endsChanged: 0, movedLater: 0, stopped: [], conflictsAfter: 0, kept: [], ...over });

const r1 = row("r1", span("2026-11-16", "2026-11-18"), span("2026-11-19", "2026-11-23"), 3);
const r2 = row("r2", span("2026-11-16", "2026-11-17"), span("2026-11-16", "2026-11-17"));
const r3 = row("r3", null, span("2026-11-16", "2026-11-16"));
const r4 = row("r4", null, null);

describe("sideSummary", () => {
  it("counts the rows whose dates change, never movedLater or itemsChanged", () => {
    const rp = (rows: readonly OutcomeRow[], conflictsAfter: number): ResolvePreview => ({ rows, preview: preview({ movedLater: 5, itemsChanged: 7, conflictsAfter }) });
    expect(sideSummary(rp([r1, r2, r3, r4], 1))).toBe("moves 2 · 1 conflict");
    expect(sideSummary(rp([r1, r2, r3, r4], 2))).toBe("moves 2 · 2 conflicts");
    expect(sideSummary(rp([r2], 0))).toBe("moves 0");
  });
});

describe("outcomeLine", () => {
  it("reads before → after and the shift in working days", async () => {
    const plan = (await made([{ id: "a", name: "Review", start: "2026-11-19", dur: 2 }])).session.view().plan;
    const before = span("2026-11-19", "2026-11-20");
    const after = span("2026-11-16", "2026-11-17");
    expect(outcomeLine(row("a", before, after, -3), plan)).toBe("Review  Thu 19 Nov → Mon 16 Nov · −3 working days");
    expect(outcomeLine(row("a", after, before, 3), plan)).toBe("Review  Mon 16 Nov → Thu 19 Nov · +3 working days");
    expect(outcomeLine(row("a", before, before, 1), plan)).toBe("Review  Thu 19 Nov → Thu 19 Nov · +1 working day");
    expect(outcomeLine(row("a", before, before, 0), plan)).toBe("Review  Thu 19 Nov → Thu 19 Nov · unchanged");
    expect(outcomeLine(row("a", null, after), plan)).toBe("Review  unscheduled → Mon 16 Nov");
    expect(outcomeLine(row("a", before, null), plan)).toBe("Review  Thu 19 Nov → unscheduled");
    expect(() => outcomeLine(row("zz", before, after), plan)).toThrow(new Error("No item zz"));
  });
});

describe("groupRows", () => {
  it("makes one section per group in tree order, titled by its path, the top level last", async () => {
    const plan = (
      await made([
        { id: "z", name: "Top", start: "2026-11-10", dur: 1 },
        { id: "S", name: "Sprint 4", kind: "group" },
        { id: "y2", name: "Second", parent: "S", start: "2026-11-10", dur: 1 },
        { id: "Q", name: "QA", kind: "group", parent: "S" },
        { id: "x", name: "Check", parent: "Q", start: "2026-11-10", dur: 1 },
        { id: "y1", name: "First", parent: "S", start: "2026-11-10", dur: 1 },
      ])
    ).session.view().plan;
    const rows = [row("z", null, null), row("x", null, null, 0, "Q"), row("y1", null, null, 0, "S"), row("y2", null, null, 0, "S")];
    const sections = groupRows(rows, plan);
    expect(sections.map((s) => s.title)).toEqual(["Sprint 4", "Sprint 4 › QA", "Not in a group"]);
    expect(sections.map((s) => s.group)).toEqual(["S", "Q", null]);
    expect(sections.map((s) => s.rows.map((r) => r.item))).toEqual([["y2", "y1"], ["x"], ["z"]]);
    expect(groupRows([], plan)).toEqual([]);
    expect(() => groupRows([row("x", null, null, 0, "gone")], plan)).toThrow(new Error("No item gone"));
    expect(() => groupRows([row("lost", null, null, 0, "Q")], plan)).toThrow(new Error("No item lost"));
    expect(() => groupRows([row("lost", null, null)], plan)).toThrow(new Error("No item lost"));
  });
});
