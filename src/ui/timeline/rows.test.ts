import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { testSession, type TestSession } from "../../test/session";
import { timelineRows, visibleRange } from "./rows";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (...a: Parameters<typeof testSession>): Promise<TestSession> => {
  const t = await testSession(...a);
  sessions.push(t.session);
  return t;
};

const SEED = [
  { id: "g1", name: "G1", kind: "group" as const },
  { id: "a", name: "A", parent: "g1", start: "2026-11-10", dur: 2 },
  { id: "g2", name: "G2", kind: "group" as const, parent: "g1" },
  { id: "m", name: "M", kind: "milestone" as const, parent: "g2", start: "2026-11-12" },
  { id: "u", name: "U", parent: "g1" },
  { id: "b", name: "B", start: "2026-11-11", dur: 1 },
  { id: "x", name: "X", start: "2026-11-12", dur: 1 },
];

describe("timelineRows", () => {
  it("lists groups and scheduled items in tree order, with depth", async () => {
    const t = await made(SEED);
    expect(timelineRows(t.session.view(), new Set())).toEqual([
      { id: "g1", depth: 0, kind: "group" },
      { id: "a", depth: 1, kind: "task" },
      { id: "g2", depth: 1, kind: "group" },
      { id: "m", depth: 2, kind: "milestone" },
      { id: "b", depth: 0, kind: "task" },
      { id: "x", depth: 0, kind: "task" },
    ]);
  });

  it("hides a collapsed group's children", async () => {
    const t = await made(SEED);
    expect(timelineRows(t.session.view(), new Set(["g2"])).map((r) => r.id)).toEqual(["g1", "a", "g2", "b", "x"]);
    expect(timelineRows(t.session.view(), new Set(["g1"])).map((r) => r.id)).toEqual(["g1", "b", "x"]);
  });

  it("leaves trashed items out and shows a delete choice's trashed item as a ghost", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "trash", items: ["b"] });
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["x"] });
    p.session.apply({ t: "rename", item: "x", name: "X2" });
    p.sync();
    const view = t.session.view();
    expect(view.choices.map((c) => c.kind)).toEqual(["delete"]);
    expect(timelineRows(view, new Set()).map((r) => [r.id, r.kind])).toEqual([
      ["g1", "group"],
      ["a", "task"],
      ["g2", "group"],
      ["m", "milestone"],
      ["x", "ghost"],
    ]);
  });
});

describe("timelineRows and gone items", () => {
  it("hides a trashed group's whole subtree", async () => {
    const t = await made(SEED);
    const v = t.session.view();
    const items = new Map([...v.plan.items].map(([id, i]) => [id, id === "g1" ? { ...i, trashed: true } : i]));
    expect(timelineRows({ ...v, plan: { ...v.plan, items } }, new Set()).map((r) => r.id)).toEqual(["b", "x"]);
    t.session.apply({ t: "trash", items: ["g1"] });
    expect(timelineRows(t.session.view(), new Set()).map((r) => r.id)).toEqual(["b", "x"]);
    t.session.apply({ t: "restore", items: ["g1"] });
    expect(timelineRows(t.session.view(), new Set()).map((r) => r.id)).toEqual(["g1", "a", "g2", "m", "b", "x"]);
  });
});

describe("visibleRange", () => {
  it("mounts the rows in view plus the overscan", () => {
    expect(visibleRange(17000, 700, 1000)).toEqual([492, 529]);
    expect(visibleRange(0, 700, 10)).toEqual([0, 10]);
    expect(visibleRange(0, 700, 1000)).toEqual([0, 29]);
    expect(visibleRange(0, 700, 1000, 0)).toEqual([0, 21]);
    expect(visibleRange(34000, 700, 1000)).toEqual([992, 1000]);
    expect(visibleRange(0, 0, 0)).toEqual([0, 0]);
  });
});
