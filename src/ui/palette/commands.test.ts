import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "../../actions/intents";
import { childrenOf } from "../../plan/project";
import { AppError } from "../../services/ipc";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { fs, MESA_SEED, testSession, type SeedItem, type TestSession } from "../../test/session";
import { testRegistry } from "../../test/shell";
import { clearToasts } from "../common/Toast";
import { runWith } from "../run";
import { exportFlow, importFlow } from "../shell/fileFlows";
import type { UiState } from "../state";
import type { UpdateState, Updates } from "../../store/updates";
import { commands, createdItem, type CommandCtx } from "./commands";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../shell/fileFlows", () => ({ exportFlow: vi.fn(async () => undefined), importFlow: vi.fn(async () => undefined) }));

const sessions: PlanSession[] = [];

afterEach(async () => {
  clearToasts();
  vi.mocked(exportFlow).mockClear();
  vi.mocked(importFlow).mockClear();
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
  follow: null,
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
  select: ReturnType<typeof vi.fn<(id: string) => void>>;
  newPlan: ReturnType<typeof vi.fn<() => void>>;
  newExample: ReturnType<typeof vi.fn<() => void>>;
  reveal: ReturnType<typeof vi.fn<(target: string) => void>>;
  print: ReturnType<typeof vi.fn<() => void>>;
  open: ReturnType<typeof vi.fn<(choice: string, side?: string) => void>>;
}

function harness(t: TestSession, ui: Partial<UiState> = {}, plans: readonly string[] = [], more: Partial<Registry> = {}): Harness {
  const setUi = vi.fn<(p: Partial<UiState>) => void>();
  const select = vi.fn<(id: string) => void>();
  const newPlan = vi.fn<() => void>();
  const newExample = vi.fn<() => void>();
  const reveal = vi.fn<(target: string) => void>();
  const print = vi.fn<() => void>();
  const open = vi.fn<(choice: string, side?: string) => void>();
  const id = t.session.view().plan.id;
  const registry = testRegistry(t, {
    plans: () => [
      { id, name: "Plan", trashed: false, loaded: true, space: null, example: false },
      ...plans.map((p) => ({ id: p, name: `Plan ${p}`, trashed: false, loaded: true, space: null, example: false })),
      { id: "gone", name: "Gone", trashed: true, loaded: true, space: null, example: false },
    ],
    ...more,
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
    select,
    newPlan,
    newExample,
    reveal,
    print,
    updates: null,
  };
  return { ctx, setUi, select, newPlan, newExample, reveal, print, open };
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
    const keyed = ["palette", "undo", "redo", "new-task", "view-timeline", "view-board", "view-list", "nudge+1", "nudge-1", "nudge+5", "nudge-5", "resize+1", "resize-1", "resize+5", "resize-5", "trash", "today", "select-next", "select-prev", "duplicate", "print"];
    const more = ["new-milestone", "new-group", "zoom-W", "zoom-M", "zoom-Q", "zoom-F", `baseline-show:${baseline}`, "open-plan:p2", "new-plan", "calendar", "save-baseline", "go-first-conflict", "about"];
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

  it("holds exactly new-plan, example-plan, import, the sync commands, open-plan, palette and about with no session", async () => {
    const t = await made(SMALL);
    const h = harness(t, { plan: null }, ["p2"]);
    const ctx: CommandCtx = { ...h.ctx, session: null, run: null, undo: null, redo: null };
    expect(ids(ctx)).toEqual(["new-plan", "example-plan", "import", "sync-setup", "sync-join", "sync-devices", `open-plan:${t.session.view().plan.id}`, "open-plan:p2", "palette", "about"]);
  });

  it("holds export and import in the File group with an open plan", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    expect([find(h.ctx, "export"), find(h.ctx, "import")].map((c) => [c.label, c.group])).toEqual([
      ["Export plan…", "File"],
      ["Import plan…", "File"],
    ]);
  });

  it("lists the File commands together: New plan, Create the example plan, Export plan…, Import plan…, Print…, then sync", async () => {
    const t = await made(SMALL);
    const h = harness(t, { selected: "a" }, ["p2"]);
    const all = commands(h.ctx);
    const at = all.findIndex((c) => c.group === "File");
    expect(all.slice(at, at + 8).map((c) => [c.id, c.group])).toEqual([
      ["new-plan", "File"],
      ["example-plan", "File"],
      ["export", "File"],
      ["import", "File"],
      ["print", "File"],
      ["sync-setup", "File"],
      ["sync-join", "File"],
      ["sync-devices", "File"],
    ]);
    expect(all.filter((c) => c.group === "File")).toHaveLength(8);
    const none: CommandCtx = { ...h.ctx, session: null, run: null, undo: null, redo: null };
    expect(commands(none).filter((c) => c.group === "File").map((c) => c.id)).toEqual(["new-plan", "example-plan", "import", "sync-setup", "sync-join", "sync-devices"]);
  });

  it.each([
    ["with", "sync-setup", "setup", "Set up sync"],
    ["with", "sync-join", "join", "Join with a code"],
    ["with", "sync-devices", "devices", "Sync devices"],
    ["without", "sync-setup", "setup", "Set up sync"],
    ["without", "sync-join", "join", "Join with a code"],
    ["without", "sync-devices", "devices", "Sync devices"],
  ])("a plan open %s: %s opens the %s pane", async (mode, id, pane, label) => {
    const t = await made(SMALL);
    const h = harness(t);
    const ctx: CommandCtx = mode === "with" ? h.ctx : { ...h.ctx, session: null, run: null, undo: null, redo: null };
    const cmd = find(ctx, id);
    expect([cmd.label, cmd.group]).toEqual([label, "File"]);
    cmd.run();
    expect(h.setUi.mock.calls).toEqual([[{ dialog: { t: "sync", pane } }]]);
  });

  it("runs export through exportFlow once, on the open session", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    find(h.ctx, "export").run();
    expect(vi.mocked(exportFlow).mock.calls).toEqual([[t.session, "macos"]]);
    expect(importFlow).not.toHaveBeenCalled();
  });

  it.each(["with", "without"])("runs import through importFlow once %s a session, opening the plan through select", async (mode) => {
    const t = await made(SMALL);
    const h = harness(t, mode === "with" ? {} : { plan: null });
    const ctx: CommandCtx = mode === "with" ? h.ctx : { ...h.ctx, session: null, run: null, undo: null, redo: null };
    find(ctx, "import").run();
    const calls = vi.mocked(importFlow).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(h.ctx.registry);
    calls[0][1]("p9");
    expect(h.select.mock.calls).toEqual([["p9"]]);
    expect(exportFlow).not.toHaveBeenCalled();
  });

  it.each(["with", "without"])("runs Create the example plan through the shell's one path, once, %s a session", async (mode) => {
    const t = await made(SMALL);
    const h = harness(t, mode === "with" ? {} : { plan: null });
    const ctx: CommandCtx = mode === "with" ? h.ctx : { ...h.ctx, session: null, run: null, undo: null, redo: null };
    const cmd = find(ctx, "example-plan");
    expect([cmd.label, cmd.group]).toEqual(["Create the example plan", "File"]);
    cmd.run();
    expect(h.newExample).toHaveBeenCalledTimes(1);
    expect(h.newPlan).not.toHaveBeenCalled();
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

  it("gives Jump to today the key T", async () => {
    const t = await made(SMALL);
    expect(find(harness(t).ctx, "today").keys).toBe("T");
  });

  it("steps the selection through the timeline's visible rows and reveals it", async () => {
    const t = await made(SMALL);
    const step = (ui: Partial<UiState>, id: string): unknown[] => {
      const h = harness(t, ui);
      find(h.ctx, id).run();
      return h.setUi.mock.calls;
    };
    expect([
      step({}, "select-next"),
      step({}, "select-prev"),
      step({ selected: "g1" }, "select-next"),
      step({ selected: "b" }, "select-next"),
      step({ selected: "one" }, "select-prev"),
      step({ selected: "g1" }, "select-prev"),
      step({ selected: "m" }, "select-next"),
      step({ selected: "g1", collapsed: new Set(["g1"]) }, "select-next"),
      step({ selected: "u" }, "select-next"),
    ]).toEqual([
      [[{ selected: "g1", follow: "g1" }]],
      [[{ selected: "m", follow: "m" }]],
      [[{ selected: "a", follow: "a" }]],
      [[{ selected: "one", follow: "one" }]],
      [[{ selected: "b", follow: "b" }]],
      [[{ selected: "g1", follow: "g1" }]],
      [[{ selected: "m", follow: "m" }]],
      [[{ selected: "one", follow: "one" }]],
      [[{ selected: "g1", follow: "g1" }]],
    ]);
    expect([find(harness(t).ctx, "select-next").keys, find(harness(t).ctx, "select-prev").keys]).toEqual(["↓", "↑"]);
  });

  it("offers the row steps only on the timeline", async () => {
    const t = await made(SMALL);
    const steps = (view: UiState["view"]): string[] => ids(harness(t, { view }).ctx).filter((x) => x.startsWith("select-"));
    expect([steps("board"), steps("list"), steps("timeline")]).toEqual([[], [], ["select-next", "select-prev"]]);
  });

  it("selects and reveals on Go to, for an item and for a group", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    find(h.ctx, "goto:one").run();
    find(h.ctx, "goto:g1").run();
    expect(h.setUi.mock.calls).toEqual([[{ selected: "one" }], [{ selected: "g1" }]]);
    expect(h.reveal.mock.calls).toEqual([["one"], ["g1"]]);
  });

  it("goes to the first conflict's task successor in one patch, opening its group", async () => {
    const t = await made(SMALL);
    const open = harness(t);
    find(open.ctx, "go-first-conflict").run();
    const shut = harness(t, { collapsed: new Set(["g1"]) });
    find(shut.ctx, "go-first-conflict").run();
    expect([open.setUi.mock.calls, shut.setUi.mock.calls]).toEqual([
      [[{ selected: "b", view: "timeline", collapsed: new Set(), reveal: "b" }]],
      [[{ selected: "b", view: "timeline", collapsed: new Set(), reveal: "b" }]],
    ]);
    expect([open.reveal, shut.reveal].map((r) => r.mock.calls.length)).toEqual([0, 0]);
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
    expect(h.select.mock.calls).toEqual([["p2"]]);
    expect(h.setUi).not.toHaveBeenCalled();
  });

  it("leaves failed plans out and labels a loading plan Loading…", async () => {
    const t = await made(SMALL);
    const id = t.session.view().plan.id;
    const h = harness(t, {}, [], {
      plans: () => [
        { id, name: "Plan", trashed: false, loaded: true, space: null, example: false },
        { id: "bad", name: null, trashed: false, loaded: false, space: null, example: false },
        { id: "slow", name: null, trashed: false, loaded: false, space: null, example: false },
      ],
      failures: () => new Map([["bad", new AppError("store.corrupt", "The plan file is damaged.")]]),
    });
    expect(commands(h.ctx).filter((c) => c.id.startsWith("open-plan:")).map((c) => [c.id, c.label])).toEqual([["open-plan:slow", "Open Loading…"]]);
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

  it("issues nothing when resizing a milestone", async () => {
    const t = await made(SMALL);
    const apply = vi.spyOn(t.session, "apply");
    ["resize+1", "resize-1", "resize+5"].forEach((id) => find(harness(t, { selected: "m" }).ctx, id).run());
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("lists nudge and resize only for a selection with a dated schedule", async () => {
    const t = await made(SMALL);
    const edits = (sel: string): string[] => ids(harness(t, { selected: sel }).ctx).filter((x) => x.startsWith("nudge") || x.startsWith("resize") || x === "trash");
    const dated = ["nudge+1", "nudge-1", "nudge+5", "nudge-5", "resize+1", "resize-1", "resize+5", "resize-5", "trash"];
    const group = ["nudge+1", "nudge-1", "nudge+5", "nudge-5", "trash"];
    expect([edits("a"), edits("m"), edits("u"), edits("g1")]).toEqual([dated, dated, ["trash"], group]);
  });

  it("nudges a selected group by moving its dated items", async () => {
    const t = await made(SMALL);
    const apply = vi.spyOn(t.session, "apply");
    find(harness(t, { selected: "g1" }).ctx, "nudge+1").run();
    expect(apply.mock.calls).toEqual([[{ t: "move", items: ["g1"], days: 1 }]]);
  });

  it("throws by name when the task lost its start between listing and running", async () => {
    const t = await made(SMALL);
    const resize = find(harness(t, { selected: "a" }).ctx, "resize+1");
    t.session.apply({ t: "schedule", item: "a", set: { start: null } });
    expect(t.session.view().plan.items.get("a")?.schedule?.start).toBeNull();
    const apply = vi.spyOn(t.session, "apply");
    expect(() => resize.run()).toThrow("Command: cannot resize task a, which has no dated schedule");
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

  it("takes the new item from the build's one new id, and throws unless there is exactly one", async () => {
    const t = await made(SMALL);
    const built = t.session.apply({ t: "create", kind: "task", name: "X", parent: null, after: null, start: null });
    const [id] = built.newNotes;
    expect(createdItem(built)).toBe(id);
    expect(() => createdItem({ ...built, newNotes: [] })).toThrow("Command: the create “Added task “X”” made 0 items, not one");
    expect(() => createdItem({ ...built, newNotes: [id, "other"] })).toThrow("Command: the create “Added task “X”” made 2 items, not one");
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

  it("puts M on New milestone", async () => {
    const t = await made(SMALL);
    expect(find(harness(t).ctx, "new-milestone").keys).toBe("M");
  });
});

describe("order and groups", () => {
  it("moves the selected item one place up or down among its siblings with the place intent", async () => {
    const t = await made(SMALL);
    const apply = vi.spyOn(t.session, "apply");
    const up = find(harness(t, { selected: "b" }).ctx, "move-up");
    expect([up.label, up.keys, up.group]).toEqual(["Move up", "⌥↑", "Edit"]);
    up.run();
    expect(created(apply)).toEqual([{ t: "place", item: "b", parent: "g1", after: null }]);
    expect(childrenOf(t.session.view().plan, "g1").map((i) => i.id)).toEqual(["b", "a"]);
    find(harness(t, { selected: "b" }).ctx, "move-down").run();
    expect(created(apply)[1]).toEqual({ t: "place", item: "b", parent: "g1", after: "a" });
    find(harness(t, { selected: "one" }).ctx, "move-down").run();
    expect(created(apply)[2]).toEqual({ t: "place", item: "one", parent: null, after: "m" });
    find(harness(t, { selected: "one" }).ctx, "move-up").run();
    expect(created(apply)[3]).toEqual({ t: "place", item: "one", parent: null, after: "g1" });
    expect(childrenOf(t.session.view().plan, null).map((i) => i.id)).toEqual(["g1", "one", "m", "u"]);
  });

  it("offers Move up only below the first sibling and Move down only above the last, with Alt keys off macOS", async () => {
    const t = await made(SMALL);
    const first = ids(harness(t, { selected: "a" }).ctx);
    const last = ids(harness(t, { selected: "b" }).ctx);
    expect([first.includes("move-up"), first.includes("move-down"), last.includes("move-up"), last.includes("move-down")]).toEqual([false, true, true, false]);
    expect(ids(harness(t).ctx).filter((x) => x.startsWith("move-"))).toEqual([]);
    const pc = harness(t, { selected: "b" });
    expect(find({ ...pc.ctx, mac: false }, "move-up").keys).toBe("Alt ↑");
    expect(find({ ...pc.ctx, mac: false, ui: { ...pc.ctx.ui, selected: "a" } }, "move-down").keys).toBe("Alt ↓");
  });

  it("collapses every group and expands them all again", async () => {
    const t = await made([...SMALL, { id: "g2", name: "Inner", kind: "group", parent: "g1" }, { id: "g3", name: "Gone", kind: "group" }]);
    t.session.apply({ t: "trash", items: ["g3"] });
    const h = harness(t);
    const collapse = find(h.ctx, "collapse-all");
    const expand = find(h.ctx, "expand-all");
    expect([collapse.label, collapse.group, expand.label, expand.group]).toEqual(["Collapse all groups", "View", "Expand all groups", "View"]);
    collapse.run();
    expand.run();
    expect(h.setUi.mock.calls).toEqual([[{ collapsed: new Set(["g1", "g2"]) }], [{ collapsed: new Set() }]]);
  });

  it("offers neither collapse nor expand in a plan with no group", async () => {
    const t = await made([{ id: "a", name: "A", start: "2026-11-10", dur: 2 }]);
    expect(ids(harness(t).ctx).filter((x) => x.endsWith("-all"))).toEqual([]);
  });
});

describe("update commands", () => {
  const updatesIn = (state: UpdateState): Updates & { check: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn> } => ({
    state: () => state,
    subscribe: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    check: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
  });

  const STATES: readonly (readonly [UpdateState, boolean])[] = [
    [{ k: "idle" }, false],
    [{ k: "checking" }, false],
    [{ k: "current", at: 0 }, false],
    [{ k: "available", version: "0.2.0" }, true],
    [{ k: "downloading", version: "0.2.0", percent: 10 }, false],
    [{ k: "installing", version: "0.2.0" }, false],
    [{ k: "checkFailed", message: "offline" }, false],
    [{ k: "installFailed", version: "0.2.0", message: "x" }, true],
    [{ k: "closeFailed", version: "0.2.0", line: "x" }, false],
    [{ k: "restartFailed", version: "0.2.0", line: "x" }, false],
  ];

  it.each(STATES)("in %j lists Check for updates always and Install update and restart only when it can install (%s)", async (state, installable) => {
    const t = await made(SMALL);
    const h = harness(t);
    const u = updatesIn(state);
    const ctx: CommandCtx = { ...h.ctx, updates: u };
    const update = commands(ctx).filter((c) => c.id === "update-check" || c.id === "update-install");
    expect(update.map((c) => [c.id, c.group, c.label])).toEqual([
      ["update-check", "Help", "Check for updates"],
      ...(installable ? [["update-install", "Help", "Install update and restart"]] : []),
    ]);
    const none: CommandCtx = { ...ctx, session: null, run: null, undo: null, redo: null };
    expect(ids(none).filter((x) => x.startsWith("update-"))).toEqual(installable ? ["update-check", "update-install"] : ["update-check"]);
  });

  it("Check for updates checks and Install update and restart installs", async () => {
    const t = await made(SMALL);
    const u = updatesIn({ k: "available", version: "0.2.0" });
    const ctx: CommandCtx = { ...harness(t).ctx, updates: u };
    find(ctx, "update-check").run();
    expect(u.check).toHaveBeenCalledTimes(1);
    expect(u.install).not.toHaveBeenCalled();
    find(ctx, "update-install").run();
    expect(u.install).toHaveBeenCalledTimes(1);
  });

  it("without updates (a phone or iPad) neither command is listed", async () => {
    const t = await made(SMALL);
    expect(ids(harness(t).ctx).filter((x) => x.startsWith("update-"))).toEqual([]);
  });
});

describe("duplicate (product-7)", () => {
  it("is offered for a live selection only, with ⌘D on macOS and Ctrl D elsewhere", async () => {
    const t = await made(SMALL);
    const d = find(harness(t, { selected: "a" }).ctx, "duplicate");
    expect([d.label, d.group, d.keys]).toEqual(["Duplicate “A”", "Edit", "⌘D"]);
    expect(find({ ...harness(t, { selected: "u" }).ctx, mac: false }, "duplicate").keys).toBe("Ctrl D");
    expect(ids(harness(t).ctx)).not.toContain("duplicate");
    t.session.apply({ t: "trash", items: ["one"] });
    expect(ids(harness(t, { selected: "one" }).ctx)).not.toContain("duplicate");
  });

  it("runs the duplicate intent and selects and follows the copy on the timeline", async () => {
    const t = await made(SMALL);
    const apply = vi.spyOn(t.session, "apply");
    const h = harness(t, { selected: "one" });
    find(h.ctx, "duplicate").run();
    expect(created(apply)).toEqual([{ t: "duplicate", item: "one" }]);
    const copy = childrenOf(t.session.view().plan, null).find((i) => i.name === "One day copy");
    if (copy === undefined) throw new Error("no copy");
    expect(h.setUi.mock.calls).toEqual([[{ selected: copy.id, follow: copy.id }]]);
  });
});

describe("print (product-8)", () => {
  it("prints the open plan from the File group with ⌘P on macOS and Ctrl P on Linux", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    const p = find(h.ctx, "print");
    expect([p.label, p.group, p.keys]).toEqual(["Print…", "File", "⌘P"]);
    p.run();
    expect(h.print).toHaveBeenCalledTimes(1);
    const linux = harness(t, {}, [], { device: { deviceId: "pc", name: "pop-os", platform: "linux" } });
    expect(find({ ...linux.ctx, mac: false }, "print").keys).toBe("Ctrl P");
  });

  it("is not offered without a plan, or on iOS", async () => {
    const t = await made(SMALL);
    const h = harness(t);
    expect(ids({ ...h.ctx, session: null, run: null, undo: null, redo: null })).not.toContain("print");
    const ipad = harness(t, {}, [], { device: { deviceId: "ipad", name: "iPad", platform: "ios" } });
    expect(ids(ipad.ctx)).not.toContain("print");
  });
});
