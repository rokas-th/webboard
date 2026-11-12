import { afterEach, describe, expect, it, vi } from "vitest";
import type { Built } from "../actions/intents";
import type { PlanSession } from "../store/session";
import { fs, testSession, type SeedItem } from "../test/session";
import { clearToasts } from "./common/Toast";
import { duplicatedItem, duplicateRow } from "./duplicate";
import { runWith } from "./run";
import type { UiState } from "./state";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  clearToasts();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const UI: UiState = {
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
  theme: false,
};

const SEED: readonly SeedItem[] = [
  { id: "g1", name: "Group", kind: "group" },
  { id: "a", name: "A", parent: "g1", start: "2026-11-10", dur: 3 },
  { id: "b", name: "B", parent: "g1", start: "2026-11-13", dur: 2, deps: [fs("a")] },
  { id: "u", name: "Unscheduled" },
];

const setup = async () => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  const r = runWith(t.session, vi.fn());
  const setUi = vi.fn<(p: Partial<UiState>) => void>();
  return { session: t.session, run: r.run, setUi };
};

const nameOf = (s: PlanSession, id: string): string => {
  const it = s.view().plan.items.get(id);
  if (it === undefined) throw new Error(`no item ${id}`);
  return it.name;
};

describe("duplicateRow (product-7)", () => {
  it("selects and follows the copy on the timeline, without naming it", async () => {
    const { session, run, setUi } = await setup();
    duplicateRow(run, () => session.view(), UI, setUi, "a");
    expect(setUi).toHaveBeenCalledTimes(1);
    const patch = setUi.mock.calls[0][0];
    expect(Object.keys(patch).sort()).toEqual(["follow", "selected"]);
    const copy = patch.selected;
    if (typeof copy !== "string") throw new Error("no copy selected");
    expect(patch.follow).toBe(copy);
    expect(nameOf(session, copy)).toBe("A copy");
  });

  it("only selects in the List and Board views", async () => {
    const { session, run, setUi } = await setup();
    duplicateRow(run, () => session.view(), { ...UI, view: "list" }, setUi, "a");
    duplicateRow(run, () => session.view(), { ...UI, view: "board" }, setUi, "b");
    expect(setUi.mock.calls.map((c) => Object.keys(c[0]))).toEqual([["selected"], ["selected"]]);
  });

  it("does not follow a copy the timeline has no row for: unscheduled, or under a collapsed group", async () => {
    const { session, run, setUi } = await setup();
    duplicateRow(run, () => session.view(), UI, setUi, "u");
    duplicateRow(run, () => session.view(), { ...UI, collapsed: new Set(["g1"]) }, setUi, "a");
    expect(setUi.mock.calls.map((c) => Object.keys(c[0]))).toEqual([["selected"], ["selected"]]);
  });

  it("sets nothing when the duplicate is refused", async () => {
    const { session, run, setUi } = await setup();
    run({ t: "trash", items: ["a"] });
    duplicateRow(run, () => session.view(), UI, setUi, "a");
    expect(setUi).not.toHaveBeenCalled();
  });

  it("takes the copy from the first new note and throws on a build without one", () => {
    const built = (newNotes: readonly string[]): Built => ({
      action: { id: "x", dev: "d", ses: "s", at: 0, par: [], lbl: "x", w: [] },
      newNotes,
      toast: "x.",
      preview: { itemsChanged: 0, endsChanged: 0, movedLater: 0, stopped: [], conflictsAfter: 0, kept: [] },
    });
    expect(duplicatedItem(built(["c1", "c2"]))).toBe("c1");
    expect(() => duplicatedItem(built([]))).toThrow("Duplicate: “x” made no copy");
  });
});
