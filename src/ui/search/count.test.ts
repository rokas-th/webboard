import { afterEach, describe, expect, it, vi } from "vitest";
import { projectBoard } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import type { NoteText } from "../list/columns";
import { DEFAULT_LIST_PREFS } from "../list/prefs";
import { searchCount } from "./count";
import { planMatcher } from "./match";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const SEED: readonly SeedItem[] = [
  { id: "g", name: "Dome works", kind: "group" },
  { id: "a", name: "Pour", parent: "g", start: "2026-11-10", dur: 2 },
  { id: "m", name: "Dome set", kind: "milestone", start: "2026-11-20" },
  { id: "b", name: "Bolts", start: "2026-11-12", dur: 1 },
  { id: "d", name: "Done dome", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  { id: "u", name: "Unscheduled dome", horizon: "next" },
];

const made = async (): Promise<{ t: TestSession; notes: NoteText }> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  return { t, notes: (id) => t.session.note(id).toString() };
};

describe("searchCount", () => {
  it("is null without a query", async () => {
    const { t, notes } = await made();
    const v = t.session.view();
    expect(searchCount(v, { view: "list", collapsed: new Set() }, DEFAULT_LIST_PREFS, notes, null, planMatcher(v, notes, " "))).toBeNull();
  });

  it("counts the List's shown rows of its scoped rows", async () => {
    const { t, notes } = await made();
    const v = t.session.view();
    expect(searchCount(v, { view: "list", collapsed: new Set() }, DEFAULT_LIST_PREFS, notes, null, planMatcher(v, notes, "dome"))).toEqual({ shown: 3, total: 4 });
  });

  it("counts the Timeline's task and milestone rows, without groups, unscheduled items or what a collapsed group hides", async () => {
    const { t, notes } = await made();
    const v = t.session.view();
    const match = planMatcher(v, notes, "dome");
    expect(searchCount(v, { view: "timeline", collapsed: new Set() }, DEFAULT_LIST_PREFS, notes, null, match)).toEqual({ shown: 3, total: 4 });
    expect(searchCount(v, { view: "timeline", collapsed: new Set(["g"]) }, DEFAULT_LIST_PREFS, notes, null, match)).toEqual({ shown: 2, total: 3 });
  });

  it("counts the Board's cards among its column keys", async () => {
    const { t, notes } = await made();
    const v = t.session.view();
    const keys = [...projectBoard(v.plan, v.derived).columnOf.keys()];
    const match = planMatcher(v, notes, "dome");
    if (match === null) throw new Error("no matcher");
    expect(searchCount(v, { view: "board", collapsed: new Set() }, DEFAULT_LIST_PREFS, notes, null, match)).toEqual({ shown: keys.filter(match).length, total: keys.length });
    expect(keys.filter(match).length).toBeGreaterThan(0);
  });
});
