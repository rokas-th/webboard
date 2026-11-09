import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { fs, testSession, type TestSession } from "../../test/session";
import { listGroups, statusLabel } from "./groups";

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

describe("listGroups", () => {
  it("keeps plan order inside each group, whatever the start dates", async () => {
    const t = await made([
      { name: "G", kind: "group" },
      { name: "b", parent: "G", start: "2026-12-01", dur: 2 },
      { name: "a", parent: "G", start: "2026-11-10", dur: 2 },
      { name: "c", start: "2026-11-09", dur: 1 },
    ]);
    expect(listGroups(t.session.view())).toEqual([
      { group: "G", name: "G", items: ["b", "a"] },
      { group: null, name: "Not in a group", items: ["c"] },
    ]);
  });

  it("gives nested groups their own section, named by path", async () => {
    const t = await made([
      { name: "G", kind: "group" },
      { name: "H", kind: "group", parent: "G" },
      { name: "x", parent: "H", start: "2026-11-10" },
      { name: "y", parent: "G", start: "2026-11-10" },
    ]);
    expect(listGroups(t.session.view())).toEqual([
      { group: "G", name: "G", items: ["y"] },
      { group: "H", name: "G › H", items: ["x"] },
    ]);
  });

  it("lists sections in tree pre-order, empty groups included, and Not in a group last", async () => {
    const t = await made([
      { id: "S", name: "Sprint 4", kind: "group" },
      { id: "Q", name: "QA", kind: "group", parent: "S" },
      { name: "t", parent: "Q", start: "2026-11-10" },
      { name: "r", parent: "S", start: "2026-11-10" },
      { name: "n", start: "2026-11-10" },
      { name: "E", kind: "group" },
    ]);
    expect(listGroups(t.session.view())).toEqual([
      { group: "S", name: "Sprint 4", items: ["r"] },
      { group: "Q", name: "Sprint 4 › QA", items: ["t"] },
      { group: "E", name: "E", items: [] },
      { group: null, name: "Not in a group", items: ["n"] },
    ]);
  });

  it("leaves out trashed items and the whole subtree of a trashed group", async () => {
    const t = await made([
      { name: "G", kind: "group" },
      { name: "a", parent: "G", start: "2026-11-10" },
      { name: "H", kind: "group" },
      { name: "h", parent: "H", start: "2026-11-10" },
      { name: "c", start: "2026-11-10" },
      { name: "d", start: "2026-11-10" },
    ]);
    t.session.apply({ t: "trash", items: ["a"] });
    t.session.apply({ t: "trash", items: ["H"] });
    t.session.apply({ t: "trash", items: ["d"] });
    expect(listGroups(t.session.view())).toEqual([
      { group: "G", name: "G", items: [] },
      { group: null, name: "Not in a group", items: ["c"] },
    ]);
  });

  it("keeps the trashed item of an open delete choice as a ghost", async () => {
    const { t, p } = await deleteClash();
    sessions.push(t.session, p.session);
    expect(listGroups(t.session.view())).toEqual([{ group: null, name: "Not in a group", items: ["A", "B"] }]);
  });

  it("is empty for an empty plan", async () => {
    const t = await made([]);
    expect(listGroups(t.session.view())).toEqual([]);
  });
});

describe("statusLabel", () => {
  it("takes the first match: conflict, held, late, in progress, done, not started", async () => {
    const t = await made(
      [
        { name: "L", start: "2026-11-02", dur: 2 },
        { name: "P", start: "2026-11-10", dur: 3, status: "doing" },
        { name: "C", start: "2026-11-11", dur: 1, deps: [fs("P")] },
        { name: "D", start: "2026-11-03", status: "done", progress: 100 },
        { name: "U" },
        { name: "X", start: "2026-11-20", dur: 2 },
        { name: "LD", start: "2026-11-02", dur: 1, status: "doing" },
        { name: "HL", start: "2026-11-02", dur: 1 },
        { name: "HC", start: "2026-11-11", dur: 1, deps: [fs("P")] },
      ],
      {
        clashes: [
          { unit: "s:X", mac: ["2026-11-20", 2, "todo", 0, "now"], iphone: ["2026-11-23", 2, "todo", 0, "now"] },
          { unit: "s:HL", mac: ["2026-11-02", 1, "todo", 0, "now"], iphone: ["2026-11-03", 1, "todo", 0, "now"] },
          { unit: "s:HC", mac: ["2026-11-11", 1, "todo", 0, "now"], iphone: ["2026-11-10", 1, "todo", 0, "now"] },
        ],
      },
    );
    const view = t.session.view();
    expect(["HL", "HC"].map((id) => [view.held.has(id), view.derived.late.has(id)])).toEqual([
      [true, true],
      [true, false],
    ]);
    expect(["L", "P", "C", "D", "U", "X", "LD", "HL", "HC"].map((id) => statusLabel(view, id))).toEqual([
      "late",
      "in progress",
      "conflict",
      "done",
      "not started",
      "held",
      "late",
      "held",
      "conflict",
    ]);
  });

  it("marks the successor of a loop link as a conflict", async () => {
    const t = await made([
      { name: "A", start: "2026-11-10", dur: 1, deps: [fs("B")] },
      { name: "B", start: "2026-11-12", dur: 1, deps: [fs("A")] },
      { name: "Z", start: "2026-11-12", dur: 1 },
    ]);
    const view = t.session.view();
    expect(view.derived.conflicts.filter((c) => c.kind === "loop")).toHaveLength(2);
    expect(["A", "B", "Z"].map((id) => statusLabel(view, id))).toEqual(["conflict", "conflict", "not started"]);
  });
});
