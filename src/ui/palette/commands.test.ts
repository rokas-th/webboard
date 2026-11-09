import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "../../actions/intents";
import type { PlanSession } from "../../store/session";
import { fs, MESA_SEED, testSession, type SeedItem, type TestSession } from "../../test/session";
import { testRegistry } from "../../test/shell";
import { clearToasts } from "../common/Toast";
import { runWith } from "../run";
import type { UiState } from "../state";
import { commands, type CommandCtx } from "./commands";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return t;
};

const UI: UiState = {
  plan: null,
  view: "timeline",
  zoom: "W",
  selected: null,
  collapsed: new Set(),
  baseline: null,
  dialog: null,
  reveal: null,
  naming: null,
};

const SMALL: readonly SeedItem[] = [
  { id: "g1", name: "Group", kind: "group" },
  { id: "a", name: "A", parent: "g1", start: "2026-11-10", dur: 3 },
  { id: "b", name: "B", parent: "g1", start: "2026-11-10", dur: 2, deps: [fs("a")] },
  { id: "one", name: "One day", start: "2026-11-16", dur: 1 },
  { id: "m", name: "Gate", kind: "milestone", start: "2026-11-20" },
  { id: "u", name: "Unscheduled" },
];

interface Harness {
  ctx: CommandCtx;
  setUi: ReturnType<typeof vi.fn<(p: Partial<UiState>) => void>>;
  newPlan: ReturnType<typeof vi.fn<() => void>>;
  reveal: ReturnType<typeof vi.fn<(target: string) => void>>;
  open: ReturnType<typeof vi.fn<(choice: string, side?: string) => void>>;
}

function harness(t: TestSession, ui: Partial<UiState> = {}, plans: readonly string[] = []): Harness {
  const setUi = vi.fn<(p: Partial<UiState>) => void>();
  const newPlan = vi.fn<() => void>();
  const reveal = vi.fn<(target: string) => void>();
  const open = vi.fn<(choice: string, side?: string) => void>();
  const id = t.session.view().plan.id;
  const registry = testRegistry(t, {
    plans: () => [
      { id, name: "Plan", trashed: false, loaded: true, space: null },
      ...plans.map((p) => ({ id: p, name: `Plan ${p}`, trashed: false, loaded: true, space: null })),
      { id: "gone", name: "Gone", trashed: true, loaded: true, space: null },
    ],
  });
  const r = runWith(t.session, open);
  const ctx: CommandCtx = {
    session: t.session,
    registry,
    ui: { ...UI, plan: id, ...ui },
    setUi,
    run: r.run,
    undo: r.undo,
    redo: r.redo,
    readOnly: t.session.readOnly,
    mac: true,
    clock: t.clock,
    newPlan,
    reveal,
  };
  return { ctx, setUi, newPlan, reveal, open };
}

const find = (ctx: CommandCtx, id: string) => {
  const c = commands(ctx).find((x) => x.id === id);
  if (c === undefined) throw new Error("no command " + id);
  return c;
};

const ids = (ctx: CommandCtx): string[] => commands(ctx).map((c) => c.id);

const created = (apply: { mock: { calls: Intent[][] } }): Intent[] => apply.mock.calls.map((c) => c[0]);

describe("commands()", () => {
  it("holds every command a key returns but close-dialog and deselect, plus the palette-only ones", async () => {
    const t = await made(SMALL);
    t.session.apply({ t: "baseline", op: "save", name: "B1" });
    const baseline = [...t.session.view().plan.baselines.keys()][0];
    const h = harness(t, { selected: "a" }, ["p2"]);
    const all = ids(h.ctx);
    const keyed = ["palette", "undo", "redo", "new-task", "view-timeline", "view-board", "view-list", "nudge+1", "nudge-1", "nudge+5", "nudge-5", "resize+1", "resize-1", "resize+5", "resize-5", "trash"];
    const more = ["new-milestone", "new-group", "zoom-W", "zoom-M", "zoom-Q", "today", `baseline-show:${baseline}`, "open-plan:p2", "new-plan", "calendar", "save-baseline", "go-first-conflict", "about"];
    const goTo = ["g1", "a", "b", "one", "m", "u"].map((x) => `goto:${x}`);
    expect([...keyed, ...more, ...goTo].filter((x) => !all.includes(x))).toEqual([]);
    expect(all.filter((x) => x === "close-dialog" || x === "deselect")).toEqual([]);
    expect(all.filter((x) => x.startsWith("open-plan:"))).toEqual(["open-plan:p2"]);
    expect(new Set(all).size).toBe(all.length);
    const byId = new Map(commands(h.ctx).map((c) => [c.id, c]));
    expect([byId.get("new-group")?.label, byId.get("new-group")?.group]).toEqual(["New group", "Create"]);
    expect(commands(h.ctx).filter((c) => c.group === "Go to").map((c) => c.label)).toEqual(["Group", "A", "B", "One day", "Gate", "Unscheduled"]);
    expect(new Set(commands(h.ctx).map((c) => c.group))).toEqual(new Set(["Create", "View", "Zoom", "Plan", "Edit", "Go to", "File", "Help"]));
  });

  it("drops edit commands without a selection and go-first-conflict without a conflict", async () => {
    const t = await made([{ name: "A", start: "2026-11-10" }]);
    const all = ids(harness(t).ctx);
    expect(all.filter((x) => x.startsWith("nudge") || x.startsWith("resize") || x === "trash" || x === "go-first-conflict")).toEqual([]);
  });

  it("holds exactly new-plan, open-plan, palette and about with no session", async () => {
    const t = await made(SMALL);
    const h = harness(t, { plan: null }, ["p2"]);
    const ctx: CommandCtx = { ...h.ctx, session: null, run: null, undo: null, redo: null };
    expect(ids(ctx)).toEqual(["new-plan", `open-plan:${t.session.view().plan.id}`, "open-plan:p2", "palette", "about"]);
  });

  it("runs new-plan through the shell's one path, once", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    find(h.ctx, "new-plan").run();
    expect(h.newPlan).toHaveBeenCalledTimes(1);
  });

  it("opens the palette, the about box and the calendar through UI state", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    ["palette", "about", "calendar"].forEach((id) => find(h.ctx, id).run());
    expect(h.setUi.mock.calls).toEqual([[{ dialog: { t: "palette" } }], [{ dialog: { t: "about" } }], [{ dialog: { t: "calendar" } }]]);
  });

  it("switches views and zooms, and jumps to today", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    ["view-board", "view-list", "view-timeline", "zoom-Q"].forEach((id) => find(h.ctx, id).run());
    find(h.ctx, "today").run();
    expect(h.setUi.mock.calls).toEqual([[{ view: "board" }], [{ view: "list" }], [{ view: "timeline" }], [{ view: "timeline", zoom: "Q" }]]);
    expect(h.reveal.mock.calls).toEqual([["today"]]);
  });

  it("selects and reveals on Go to and go-first-conflict", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    find(h.ctx, "goto:one").run();
    find(h.ctx, "go-first-conflict").run();
    expect(h.setUi.mock.calls).toEqual([[{ selected: "one" }], [{ selected: "b" }]]);
    expect(h.reveal.mock.calls).toEqual([["one"], ["b"]]);
  });

  it("shows and hides a baseline", async () => {
    const t = await made(SMALL);
    t.session.apply({ t: "baseline", op: "save", name: "B1" });
    const id = [...t.session.view().plan.baselines.keys()][0];
    const shown = harness(t);
    expect(find(shown.ctx, `baseline-show:${id}`).label).toBe("Compare with B1");
    find(shown.ctx, `baseline-show:${id}`).run();
    const hidden = harness(t, { baseline: id });
    expect(find(hidden.ctx, `baseline-show:${id}`).label).toBe("Hide B1");
    find(hidden.ctx, `baseline-show:${id}`).run();
    expect([shown.setUi.mock.calls, hidden.setUi.mock.calls]).toEqual([[[{ view: "timeline", baseline: id }]], [[{ baseline: null }]]]);
  });

  it("opens another plan", async () => {
    const t = await made(SMALL);
    const h = harness(t, {}, ["p2"]);
    expect(find(h.ctx, "open-plan:p2").label).toBe("Open Plan p2");
    find(h.ctx, "open-plan:p2").run();
    expect(h.setUi.mock.calls).toEqual([[{ plan: "p2", selected: null, dialog: null }]]);
  });

  it("saves a baseline named for the shell clock's today", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    const apply = vi.spyOn(t.session, "apply");
    find(h.ctx, "save-baseline").run();
    expect(created(apply)).toEqual([{ t: "baseline", op: "save", name: "Baseline 9 Nov 2026" }]);
  });
});

describe("nudge and resize", () => {
  it("moves the selection by working days", async () => {
    const t = await made(SMALL);
    const h = harness(t, { selected: "one" });
    const apply = vi.spyOn(t.session, "apply");
    ["nudge+5", "nudge-1"].forEach((id) => find(h.ctx, id).run());
    expect(created(apply)).toEqual([
      { t: "move", items: ["one"], days: 5 },
      { t: "move", items: ["one"], days: -1 },
    ]);
  });

  it("resizes by max(1, dur ± n) and floors at 1 with no intent and no toast", async () => {
    const t = await made(SMALL);
    const apply = vi.spyOn(t.session, "apply");
    find(harness(t, { selected: "one" }).ctx, "resize-1").run();
    find(harness(t, { selected: "one" }).ctx, "resize-5").run();
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
    find(harness(t, { selected: "a" }).ctx, "resize-5").run();
    find(harness(t, { selected: "a" }).ctx, "resize+5").run();
    expect(created(apply)).toEqual([
      { t: "resize", item: "a", dur: 1 },
      { t: "resize", item: "a", dur: 6 },
    ]);
  });

  it("issues nothing for a milestone or a group", async () => {
    const t = await made(SMALL);
    const apply = vi.spyOn(t.session, "apply");
    ["m", "g1"].forEach((sel) => ["resize+1", "resize-1", "resize+5"].forEach((id) => find(harness(t, { selected: sel }).ctx, id).run()));
    expect(apply).not.toHaveBeenCalled();
  });

  it("trashes the selection", async () => {
    const t = await made(SMALL);
    const apply = vi.spyOn(t.session, "apply");
    find(harness(t, { selected: "u" }).ctx, "trash").run();
    expect(created(apply)).toEqual([{ t: "trash", items: ["u"] }]);
  });
});

describe("new items", () => {
  const cases: [string, string | null, { parent: string | null; after: string | null }][] = [
    ["nothing", null, { parent: null, after: null }],
    ["a group", "g1", { parent: "g1", after: null }],
    ["an item in a group", "a", { parent: "g1", after: "a" }],
    ["a top-level item", "one", { parent: null, after: "one" }],
  ];

  it.each(cases)("places a new task with %s selected", async (_what, selected, place) => {
    const t = await made(SMALL);
    const h = harness(t, { selected });
    const apply = vi.spyOn(t.session, "apply");
    find(h.ctx, "new-task").run();
    expect(created(apply)).toEqual([{ t: "create", kind: "task", name: "New task", ...place, start: "2026-11-10", dur: 3 }]);
    expect(t.session.history()[0].label).toBe("Added task “New task”");
    const id = h.setUi.mock.calls[0][0].selected;
    expect(typeof id).toBe("string");
    expect(h.setUi.mock.calls).toEqual([[{ selected: id, naming: id }]]);
    expect(t.session.view().plan.items.get(id ?? "")?.name).toBe("New task");
  });

  it.each(cases)("places a new milestone with %s selected", async (_what, selected, place) => {
    const t = await made(SMALL);
    const h = harness(t, { selected });
    const apply = vi.spyOn(t.session, "apply");
    find(h.ctx, "new-milestone").run();
    expect(created(apply)).toEqual([{ t: "create", kind: "milestone", name: "New milestone", ...place, start: "2026-11-10" }]);
    expect(t.session.history()[0].label).toBe("Added milestone “New milestone”");
  });

  it.each(cases)("places a new group with %s selected", async (_what, selected, place) => {
    const t = await made(SMALL);
    const h = harness(t, { selected });
    const apply = vi.spyOn(t.session, "apply");
    find(h.ctx, "new-group").run();
    expect(created(apply)).toEqual([{ t: "create", kind: "group", name: "New group", ...place, start: null }]);
    expect(t.session.history()[0].label).toBe("Added group “New group”");
    const id = h.setUi.mock.calls[0][0].selected;
    expect(h.setUi.mock.calls).toEqual([[{ selected: id, naming: id }]]);
  });

  it("starts on the next working day after the clock's today", async () => {
    const t = await made(MESA_SEED);
    t.clock.set("2026-11-13");
    const apply = vi.spyOn(t.session, "apply");
    find(harness(t).ctx, "new-task").run();
    expect(created(apply).map((i) => (i.t === "create" ? i.start : null))).toEqual(["2026-11-16"]);
  });

  it("selects nothing when the create is refused", async () => {
    const t = await made(SMALL);
    t.session.setReadOnly(true);
    const h = harness(t);
    const apply = vi.spyOn(t.session, "apply");
    ["new-task", "new-milestone", "new-group"].forEach((id) => find(h.ctx, id).run());
    expect(apply).not.toHaveBeenCalled();
    expect(h.setUi).not.toHaveBeenCalled();
  });
});
