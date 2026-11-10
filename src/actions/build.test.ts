import { describe, expect, it } from "vitest";
import type { Calendar, HolidayYear } from "../domain/calendar";
import { toDay } from "../domain/dates";
import { derive } from "../domain/derive";
import type { Conflict } from "../domain/schedule";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import { applyWrites, projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf, FIXTURE_DEVICES } from "../test/planCtx";
import { buildAction, initialAction, normalizeName, planAfter, withDerived } from "./build";
import { HeldRefused, Refused, type Built, type Ctx, type Intent } from "./intents";
import { buildUndo } from "./undo";
import { childrenOf } from "../plan/project";

const TODAY = "2026-11-09";

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const sched = (start: string | null, dur: number, status = "todo", progress = 0, horizon = "later"): unknown[] => [start, dur, status, progress, horizon];

const item = (id: string, kind: "task" | "milestone" | "group", name: string, parent: string | null, order: string, s?: unknown[]): Write[] => [
  w(`e:${id}`, { k: kind, t: false }),
  w(`n:${id}`, name),
  ...(s === undefined ? [] : [w(`s:${id}`, s)]),
  w(`p:${id}`, [parent, order]),
];

const ROOT: Write[] = [w("pn", "Plan"), w("cw", [1, 2, 3, 4, 5]), w("cr", null)];

const ROOT_CAL = (): Calendar => ({ region: null, workdays: [1, 2, 3, 4, 5], closures: new Map(), tuning: new Map(), holidays: new Map() });

const CHAIN: Write[] = [
  ...ROOT,
  ...item("PFF", "task", "Plan file format", null, "a0", sched("2026-11-16", 3)),
  ...item("Spec", "task", "Spec", null, "a1", sched("2026-11-19", 3)),
  ...item("Build", "task", "Build", null, "a2", sched("2026-11-24", 5)),
  ...item("Review", "task", "Review", null, "a3", sched("2026-12-01", 2)),
  ...item("Ship", "task", "Ship", null, "a4", sched("2026-12-03", 1)),
  ...item("Admin", "task", "Admin", null, "a5", sched("2026-11-23", 2)),
  ...item("Launch", "milestone", "Launch", null, "a6", sched("2027-01-15", 0)),
  ...item("Kickoff", "milestone", "Kickoff", null, "a7", sched("2026-11-16", 0)),
  w("l:PFF>Spec", ["FS", 0]),
  w("l:Spec>Build", ["FS", 0]),
  w("l:Build>Review", ["FS", 0]),
  w("l:Review>Ship", ["FS", 0]),
  w("l:Ship>Launch", ["FS", 0]),
  w("b:B1", { name: "Before", at: "2026-11-01", dates: {} }),
];

const GROUPS: Write[] = [
  ...ROOT,
  ...item("S4", "group", "Sprint 4", null, "a0"),
  ...item("G", "group", "Phase", null, "a0"),
  ...item("U", "task", "Unscheduled", null, "a1", sched(null, 3)),
  ...item("R", "task", "Review", "S4", "a0", sched("2026-12-01", 2)),
  ...item("C", "group", "Inner", "G", "a0"),
];

const replaced = (base: readonly Write[], over: readonly Write[]): Write[] => [
  ...base.filter((x) => !over.some((o) => o.u === x.u)),
  ...over.filter((o) => !base.some((x) => x.u === o.u)),
  ...base.filter((x) => over.some((o) => o.u === x.u)).map((x) => over.find((o) => o.u === x.u) as Write),
];

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  expect(log.pending).toEqual([]);
  return log;
};

const ctxFrom = (root: readonly Write[], ...rest: Action[]): Ctx => ctxOf(logOf(act("a0", [], root), ...rest), "d1", TODAY);

const chain = (...rest: Action[]): Ctx => ctxFrom(CHAIN, ...rest);

const groups = (): Ctx => ctxFrom(GROUPS);

const applied = (ctx: Ctx, built: Built, o: Parameters<typeof ctxOf>[4] = {}): Ctx => {
  expect(ctx.log.add([built.action]).refused).toEqual([]);
  return ctxOf(ctx.log, ctx.dev, ctx.view.today, ctx.devices, o);
};

const units = (b: Built): string[] => b.action.w.map((x) => x.u);

const writeOf = (b: Built, u: string): Write => {
  const found = b.action.w.find((x) => x.u === u);
  if (found === undefined) throw new Error(`no write to ${u}`);
  return found;
};

const startOf = (b: Built, u: string): unknown => (writeOf(b, u).v as unknown[])[0];

const refusal = (ctx: Ctx, intent: Intent): Refused => {
  const before = [...ctx.log.order()];
  try {
    buildAction(ctx, intent);
  } catch (e) {
    expect(e).toBeInstanceOf(Refused);
    expect([...ctx.log.order()]).toEqual(before);
    return e as Refused;
  }
  throw new Error(`intent ${intent.t} was not refused`);
};

const refusedWith = (ctx: Ctx, intent: Intent, message: string): void => {
  expect(refusal(ctx, intent).message).toBe(message);
};

const PUSHED = ["s:Spec", "s:Build", "s:Review", "s:Ship"];

describe("buildAction: push", () => {
  it("moves an item later and pushes its four successors", () => {
    const ctx = chain();
    const b = buildAction(ctx, { t: "move", items: ["PFF"], days: 6 });
    expect(b.action.lbl).toBe("Moved “Plan file format” later by 6 working days; 4 dependent items moved");
    expect(b.toast).toBe("Moved “Plan file format” later by 6 working days; 4 dependent items moved.");
    expect(b.action.w.map((x) => [x.u, x.c])).toEqual([["s:PFF", "own"], ...PUSHED.map((u) => [u, "push"])]);
    expect(writeOf(b, "s:PFF").v).toEqual(sched("2026-11-24", 3));
    expect(PUSHED.map((u) => startOf(b, u))).toEqual(["2026-11-27", "2026-12-02", "2026-12-09", "2026-12-11"]);
    expect(b.action.par).toEqual(ctx.log.heads);
    expect(b.action.dev).toBe("d1");
    expect(b.action.ses).toBe("s-d1");
    expect(b.newNotes).toEqual([]);
    expect(b.preview.movedLater).toBe(4);
    expect(b.preview.itemsChanged).toBe(5);
    expect(b.preview.endsChanged).toBe(5);
    expect(b.preview.stopped).toEqual([]);
    expect(b.preview.conflictsAfter).toBe(0);
    expect(b.preview.kept).toEqual([]);
  });

  it("moves an item earlier without pulling anything", () => {
    const b = buildAction(chain(), { t: "move", items: ["Admin"], days: -2 });
    expect(b.action.lbl).toBe("Moved “Admin” earlier by 2 working days");
    expect(units(b)).toEqual(["s:Admin"]);
    expect(startOf(b, "s:Admin")).toBe("2026-11-19");
  });

  it("moves several items with one count", () => {
    const b = buildAction(chain(), { t: "move", items: ["Admin", "Kickoff"], days: 1 });
    expect(b.action.lbl).toBe("Moved 2 items later by 1 working day");
    expect(units(b)).toEqual(["s:Admin", "s:Kickoff"]);
  });

  it("schedules a start 6 working days later and pushes the four successors", () => {
    const b = buildAction(chain(), { t: "schedule", item: "PFF", set: { start: "2026-11-24" } });
    expect(b.action.lbl).toBe("Scheduled “Plan file format” from 24 Nov; 4 dependent items moved");
    expect(units(b)).toEqual(["s:PFF", ...PUSHED]);
    expect(PUSHED.map((u) => writeOf(b, u).c)).toEqual(["push", "push", "push", "push"]);
  });

  it("names a start and duration set together as a change, with the same pushes", () => {
    const b = buildAction(chain(), { t: "schedule", item: "PFF", set: { start: "2026-11-24", dur: 2 } });
    expect(b.action.lbl).toBe("Changed “Plan file format”; 4 dependent items moved");
    expect(units(b)).toEqual(["s:PFF", ...PUSHED]);
    expect(writeOf(b, "s:PFF").v).toEqual(sched("2026-11-24", 2));
    expect(PUSHED.map((u) => startOf(b, u))).toEqual(["2026-11-26", "2026-12-01", "2026-12-08", "2026-12-10"]);
  });

  it("stops at a held item and says so", () => {
    const ctx = chain(
      act("m", ["a0"], [w("s:Review", sched("2026-12-01", 2, "todo", 0, "next"))], { dev: "d1" }),
      act("p", ["a0"], [w("s:Review", sched("2026-12-01", 2, "todo", 0, "now"))], { dev: "d2" }),
    );
    expect(ctx.view.held.has("Review")).toBe(true);
    const b = buildAction(ctx, { t: "move", items: ["PFF"], days: 6 });
    expect(b.toast).toBe("Moved “Plan file format” later by 6 working days; 2 moved, stopped at held “Review”.");
    expect(units(b)).toEqual(["s:PFF", "s:Spec", "s:Build"]);
    expect(b.action.par).toEqual(["m", "p"]);
    expect(b.preview.stopped).toEqual([{ id: "Review", reason: "held" }]);
  });

  it("stops at a done item and at an item in progress", () => {
    const done = ctxFrom(replaced(CHAIN, [w("s:Review", sched("2026-12-01", 2, "done", 100))]));
    expect(buildAction(done, { t: "move", items: ["PFF"], days: 6 }).action.lbl).toBe(
      "Moved “Plan file format” later by 6 working days; 2 moved, stopped at done “Review”",
    );
    const doing = ctxFrom(replaced(CHAIN, [w("s:Review", sched("2026-12-01", 2, "doing", 50))]));
    const b = buildAction(doing, { t: "move", items: ["PFF"], days: 6 });
    expect(b.action.lbl).toBe("Moved “Plan file format” later by 6 working days; 2 moved, stopped at in progress “Review”");
    expect(units(b)).toEqual(["s:PFF", "s:Spec", "s:Build"]);
    expect(b.preview.conflictsAfter).toBe(1);
  });

  it("makes an after plan of a move that applyWrites takes", () => {
    const ctx = chain();
    const b = buildAction(ctx, { t: "move", items: ["PFF"], days: 6 });
    const after = planAfter(ctx.view.plan, b.action.w);
    const next = applyWrites(after, [w("n:Spec", "Spec it")]);
    const log = ctx.log.fork();
    expect(log.add([b.action, act("h1", [b.action.id], [w("n:Spec", "Spec it")])]).refused).toEqual([]);
    expect(next).toEqual(projectPlan(ctx.view.plan.id, log));
  });

  it("seed 2147483625: a link into a milestone stored as in progress stops at it instead of moving it", () => {
    const ctx = ctxFrom([
      ...ROOT,
      ...item("T", "task", "Task", null, "a0", sched("2026-11-16", 5)),
      ...item("M", "milestone", "Milestone", null, "a1", sched("2026-11-17", 0, "doing")),
    ]);
    expect(ctx.view.derived.status.get("M")).toBe("doing");
    const b = buildAction(ctx, { t: "link", from: "T", to: "M", type: "FS", lag: 0 });
    expect(units(b)).toEqual(["l:T>M"]);
    expect(b.preview.stopped).toEqual([{ id: "M", reason: "doing" }]);
    expect(b.preview.conflictsAfter).toBe(1);
    const after = applied(ctx, b);
    expect(after.view.derived.conflicts.map((c) => (c.kind === "early" ? c.link : c.kind))).toEqual(["T>M"]);
  });
});

describe("buildAction: own starts (refinement 29)", () => {
  it("stores a start set on a Saturday as the next working day", () => {
    const ctx = chain();
    const b = buildAction(ctx, { t: "schedule", item: "Admin", set: { start: "2026-11-14" } });
    expect(writeOf(b, "s:Admin").v).toEqual(sched("2026-11-16", 2));
    expect(b.toast).toBe("Scheduled “Admin” from 16 Nov.");
    const after = applied(ctx, b);
    expect(after.view.derived.conflicts.filter((c) => c.kind === "dayoff")).toEqual([]);
  });

  it("stores a created item's start as the next working day", () => {
    const b = buildAction(chain(), { t: "create", kind: "task", name: "Prep", parent: null, after: null, start: "2026-11-15" });
    const id = b.newNotes[0];
    expect(writeOf(b, `s:${id}`).v).toEqual(sched("2026-11-16", 3));
  });
});

describe("buildAction: merging writes on one unit", () => {
  it("moves two linked items together with one write per unit", () => {
    const b = buildAction(chain(), { t: "move", items: ["PFF", "Spec"], days: 6 });
    expect(b.action.w.map((x) => [x.u, x.c])).toEqual([
      ["s:PFF", "own"],
      ["s:Spec", "own"],
      ["s:Build", "push"],
      ["s:Review", "push"],
      ["s:Ship", "push"],
    ]);
    expect(startOf(b, "s:Spec")).toBe("2026-11-27");
  });

  it("turns an own write and a push on one unit into one own write with the pushed value", () => {
    const ctx = chain();
    const d = withDerived(ctx, [w("s:PFF", sched("2026-11-24", 3)), w("s:Spec", sched("2026-11-19", 3, "todo", 0, "now"))], ["PFF"], ctx.view.held);
    expect(d.writes.map((x) => [x.u, x.c])).toEqual([
      ["s:PFF", "own"],
      ["s:Spec", "own"],
      ["s:Build", "push"],
      ["s:Review", "push"],
      ["s:Ship", "push"],
    ]);
    expect(d.writes[1].v).toEqual(sched("2026-11-27", 3, "todo", 0, "now"));
  });

  it("keeps an own value over a recalendar write on the same unit", () => {
    const ctx = chain();
    const mine = w("s:Ship", sched("2026-12-03", 1, "todo", 0, "now"));
    const d = withDerived(ctx, [w("cc:c1", ["2026-12-03", "2026-12-03", "Offsite"]), mine], [], ctx.view.held);
    expect(d.recal?.starts.has("Ship")).toBe(true);
    expect(d.writes.filter((x) => x.u === "s:Ship")).toEqual([mine]);
  });

  it("merges a recalendar start and a push on one unit into one derived write", () => {
    const ctx = chain();
    const b = buildAction(ctx, {
      t: "calendar",
      next: { ...ctx.view.plan.calendar, closures: new Map([["c1", { id: "c1", from: "2026-11-17", to: "2026-11-19", name: "Offsite" }]]) },
    });
    expect(b.action.w.filter((x) => x.u === "s:Spec")).toEqual([w("s:Spec", sched("2026-11-24", 3), "push")]);
  });

  it("refuses a derived write on a unit the action unschedules", () => {
    const ctx = chain();
    expect(() =>
      withDerived(ctx, [w("cc:c1", ["2026-11-19", "2026-11-20", "Offsite"]), w("s:Spec", sched(null, 3))], [], ctx.view.held),
    ).toThrow(new Error("Derived write to s:Spec, which this action unschedules"));
  });
});

describe("buildAction: preview", () => {
  it("counts changed items and ends from derive, not from written units", () => {
    const ctx = ctxFrom([
      ...ROOT,
      ...item("T1", "task", "T1", null, "a0", sched("2026-11-16", 5)),
      ...item("T2", "task", "T2", null, "a1", sched("2026-11-17", 3)),
    ]);
    const cal = ctx.view.plan.calendar;
    const next: Calendar = { ...cal, closures: new Map([["off1", { id: "off1", from: "2026-11-18", to: "2026-11-20", name: "Offsite" }]]) };
    const b = buildAction(ctx, { t: "calendar", next });
    expect(units(b)).toEqual(["cc:off1"]);
    expect(b.preview.itemsChanged).toBe(2);
    expect(b.preview.endsChanged).toBe(2);
    expect(b.preview.movedLater).toBe(0);
    expect(b.action.lbl).toBe("Changed the calendar; 2 end dates changed");
    expect(b.toast).toBe("Changed the calendar; 2 end dates changed. Undo puts the old one back.");
    const after = applied(ctx, b).view.derived;
    expect(after.end.get("T1")).toBe(toDay("2026-11-25"));
    expect(after.end.get("T2")).toBe(toDay("2026-11-24"));
  });

  it("shows only the stops a calendar change causes", () => {
    const done = replaced(CHAIN, [w("s:Review", sched("2026-12-01", 2, "done", 100))]);
    const closure = (from: string, to: string): Calendar => ({
      ...ROOT_CAL(),
      closures: new Map([["c1", { id: "c1", from, to, name: "Offsite" }]]),
    });
    const before = ctxFrom(done, act("a1", ["a0"], [w("s:Build", sched("2026-11-30", 5))]));
    expect(before.view.derived.conflicts.some((c) => c.kind === "early" && c.succ === "Review")).toBe(true);
    expect(buildAction(before, { t: "calendar", next: closure("2027-02-01", "2027-02-01") }).preview.stopped).toEqual([]);
    const caused = buildAction(ctxFrom(done), { t: "calendar", next: closure("2026-11-25", "2026-11-25") });
    expect(caused.preview.stopped).toEqual([{ id: "Review", reason: "done" }]);
  });

  it("counts a held item's new day off among the conflicts after", () => {
    const ctx = chain(
      act("m", ["a0"], [w("s:Review", sched("2026-12-01", 2, "todo", 0, "next"))], { dev: "d1" }),
      act("p", ["a0"], [w("s:Review", sched("2026-12-01", 2, "todo", 0, "now"))], { dev: "d2" }),
    );
    expect(ctx.view.derived.conflicts).toEqual([]);
    const b = buildAction(ctx, {
      t: "calendar",
      next: { ...ctx.view.plan.calendar, closures: new Map([["c1", { id: "c1", from: "2026-12-01", to: "2026-12-01", name: "Offsite" }]]) },
    });
    expect(units(b)).not.toContain("s:Review");
    expect(b.preview.conflictsAfter).toBe(1);
    expect(applied(ctx, b).view.derived.conflicts).toEqual([{ kind: "dayoff", item: "Review", shownFrom: toDay("2026-12-02") }]);
  });

  it("counts a trashed group's descendants, not the group (PF27)", () => {
    const b = buildAction(groups(), { t: "trash", items: ["S4"] });
    expect(b.preview.itemsChanged).toBe(1);
  });
});

describe("buildAction: names (Review Focus 4)", () => {
  it("puts pasted lines on one line and trims", () => {
    expect(normalizeName("  Plan\nreview \r\n v2 ")).toBe("Plan review v2");
    expect(normalizeName("a\tb")).toBe("a b");
    expect(normalizeName("a  b")).toBe("a  b");
  });

  it("refuses an empty name", () => {
    expect(() => normalizeName("   \n ")).toThrow(new Refused("The name is empty. Type at least one character."));
    refusedWith(chain(), { t: "rename", item: "Admin", name: "   \n " }, "The name is empty. Type at least one character.");
  });

  it("keeps long and non-Latin names", () => {
    const long = "x".repeat(320);
    expect(normalizeName(long)).toBe(long);
    expect(normalizeName("Ü 📅 مراجعة")).toBe("Ü 📅 مراجعة");
    const b = buildAction(chain(), { t: "rename", item: "Admin", name: long });
    expect(writeOf(b, "n:Admin").v).toBe(long);
  });
});

describe("buildAction: refusals", () => {
  it("refuses a link that closes a loop, naming it in loop order", () => {
    refusedWith(
      chain(),
      { t: "link", from: "Ship", to: "PFF", type: "FS", lag: 0 },
      "This link would close a loop: “Ship” → “Plan file format” → “Spec” → “Build” → “Review” → “Ship”.",
    );
  });

  it("refuses a calendar without working days", () => {
    const ctx = chain();
    refusedWith(ctx, { t: "calendar", next: { ...ctx.view.plan.calendar, workdays: [] } }, "A calendar needs at least one working day.");
  });

  it("refuses each invalid edit with its reason", () => {
    const ctx = chain();
    const cal = ctx.view.plan.calendar;
    const closure = (from: string, to: string, name: string): Calendar => ({ ...cal, closures: new Map([["c1", { id: "c1", from, to, name }]]) });
    refusedWith(ctx, { t: "link", from: "PFF", to: "PFF", type: "FS", lag: 0 }, "An item cannot depend on itself.");
    refusedWith(ctx, { t: "calendar", next: closure("2026-11-18", "2026-11-20", "  ") }, "A closure needs a name and a first day.");
    refusedWith(ctx, { t: "calendar", next: closure("", "2026-11-20", "Offsite") }, "A closure needs a name and a first day.");
    refusedWith(ctx, { t: "calendar", next: closure("2026-11-20", "2026-11-18", "Offsite") }, "The last day is before the first day.");
    refusedWith(ctx, { t: "calendar", next: closure("2026-12-24", "2027-12-25", "Offsite") }, "A closure can last at most 366 days.");
    refusedWith(ctx, { t: "calendar", next: closure("2026-12-24", "9999-12-31", "Offsite") }, "Dates run from 1 Jan 1900 to 31 Dec 2199.");
    expect(buildAction(ctx, { t: "calendar", next: closure("2026-12-24", "2027-12-24", "Offsite") }).action.w).toContainEqual({
      u: "cc:c1",
      v: ["2026-12-24", "2027-12-24", "Offsite"],
      c: "own",
    });
    refusedWith(ctx, { t: "resize", item: "Admin", dur: 0 }, "A task lasts 1 to 3650 working days.");
    refusedWith(ctx, { t: "resize", item: "Launch", dur: 2 }, "Milestones have no duration.");
    refusedWith(ctx, { t: "schedule", item: "Admin", set: { progress: 101 } }, "Progress is a whole number from 0 to 100.");
    refusedWith(ctx, { t: "schedule", item: "Admin", set: { progress: 4.5 } }, "Progress is a whole number from 0 to 100.");
    refusedWith(ctx, { t: "schedule", item: "Admin", set: { status: "done", progress: 40 } }, "A done item is at 100 %.");
    const done = ctxFrom(replaced(CHAIN, [w("s:Admin", sched("2026-11-23", 2, "done", 100))]));
    refusedWith(done, { t: "schedule", item: "Admin", set: { progress: 40 } }, "“Admin” is done. Mark it in progress to set its progress.");
  });

  it("refuses only a long closure the action writes, so a 400-day one from the log does not block other calendar edits", () => {
    const ctx = ctxFrom(replaced(CHAIN, [w("cc:Z", ["2026-01-01", "2027-02-04", "Sabbatical"])]));
    const cal = ctx.view.plan.calendar;
    expect(cal.closures.get("Z")).toEqual({ id: "Z", from: "2026-01-01", to: "2027-02-04", name: "Sabbatical" });
    const fourDays = buildAction(ctx, { t: "calendar", next: { ...cal, workdays: [1, 2, 3, 4] } });
    expect(units(fourDays).filter((u) => u.startsWith("c"))).toEqual(["cw"]);
    const added = new Map([...cal.closures, ["Y", { id: "Y", from: "2026-12-24", to: "2026-12-31", name: "Offsite" }]]);
    expect(units(buildAction(ctx, { t: "calendar", next: { ...cal, closures: added } })).filter((u) => u.startsWith("c"))).toEqual(["cc:Y"]);
    refusedWith(ctx, { t: "calendar", next: { ...cal, closures: new Map([["Z", { id: "Z", from: "2026-01-01", to: "2027-02-04", name: "Leave" }]]) } }, "A closure can last at most 366 days.");
    expect(writeOf(buildAction(ctx, { t: "calendar", next: { ...cal, closures: new Map() } }), "cc:Z").v).toBeNull();
  });

  it("refuses edits on groups, trashed items and unscheduled items", () => {
    const ctx = groups();
    refusedWith(ctx, { t: "link", from: "S4", to: "R", type: "FS", lag: 0 }, "Groups take no dependencies; link the tasks inside them.");
    refusedWith(ctx, { t: "move", items: ["U"], days: 2 }, "“Unscheduled” has no dates yet. Schedule it first.");
    refusedWith(ctx, { t: "resize", item: "U", dur: 4 }, "“Unscheduled” has no dates yet. Schedule it first.");
    refusedWith(ctx, { t: "snap", item: "U" }, "“Unscheduled” has no dates yet. Schedule it first.");
    refusedWith(ctx, { t: "place", item: "G", parent: "C", after: null }, "A group cannot go inside itself.");
    refusedWith(ctx, { t: "place", item: "G", parent: "G", after: null }, "A group cannot go inside itself.");
    const trashed = buildAction(ctx, { t: "trash", items: ["S4"] });
    expect(trashed.action.w).toEqual([w("e:S4", { k: "group", t: true })]);
    expect(trashed.toast).toBe("Moved “Sprint 4” to the Trash. Undo brings it back.");
    const after = applied(ctx, trashed);
    refusedWith(after, { t: "rename", item: "R", name: "Review 2" }, "“Review” is inside “Sprint 4”, which is in the Trash. Restore “Sprint 4” first.");
    refusedWith(after, { t: "rename", item: "S4", name: "Sprint 5" }, "“Sprint 4” is in the Trash. Restore it first.");
  });

  it("refuses a status on a milestone with predecessors, and takes one on a milestone without", () => {
    const ctx = chain();
    refusedWith(ctx, { t: "schedule", item: "Launch", set: { status: "done" } }, "“Launch” is done when its predecessors are done.");
    const b = buildAction(ctx, { t: "schedule", item: "Kickoff", set: { status: "done" } });
    expect(b.action.lbl).toBe("Marked “Kickoff” done");
    expect(b.action.w).toEqual([w("s:Kickoff", sched("2026-11-16", 0, "done", 100))]);
  });

  it("takes a status on a milestone whose only predecessor is inside a trashed group", () => {
    const ctx = ctxFrom(
      replaced(GROUPS, [...item("M", "milestone", "Gate", null, "a2", sched("2026-12-10", 0)), w("l:R>M", ["FS", 0]), w("e:S4", { k: "group", t: true })]),
    );
    const b = buildAction(ctx, { t: "schedule", item: "M", set: { status: "done" } });
    expect(b.action.lbl).toBe("Marked “Gate” done");
  });
});

describe("buildAction: nothing to change (refinement 36)", () => {
  it("refuses intents whose own writes equal the current values", () => {
    const ctx = chain();
    const c = ctx.view.plan.calendar;
    refusedWith(ctx, { t: "rename", item: "Admin", name: "  Admin " }, "Nothing to change.");
    refusedWith(ctx, { t: "schedule", item: "Admin", set: { status: "todo" } }, "Nothing to change.");
    refusedWith(ctx, { t: "move", items: ["Admin"], days: 0 }, "Nothing to change.");
    refusedWith(ctx, { t: "calendar", next: c, base: c }, "Nothing to change.");
  });

  it("lets a refusal of its own win", () => {
    refusedWith(chain(), { t: "schedule", item: "Launch", set: { status: "todo" } }, "“Launch” is done when its predecessors are done.");
  });

  it("ends a group move without scheduled descendants in nothing to change", () => {
    refusedWith(groups(), { t: "move", items: ["G"], days: 2 }, "Nothing to change.");
  });
});

describe("buildAction: calendar (refinement 34)", () => {
  const CH = { src: "openholidays", country: "CH", subdivision: "CH-ZH" } as const;
  const year = (days: { date: string; name: string }[]): HolidayYear => ({
    region: "oh:CH:CH-ZH",
    year: 2027,
    days: days.map((d) => ({ ...d, kind: "public", sourceId: d.date, scope: null })),
    fetchedAt: "2026-11-01",
  });
  const NEUJAHR = { date: "2027-01-01", name: "Neujahrstag" };
  const BERCHTOLD = { date: "2027-01-02", name: "Berchtoldstag" };

  it("writes only where next differs from base, keeping what changed meanwhile", () => {
    const ctx = ctxFrom([w("pn", "Plan"), w("cw", [1, 2, 3, 4, 5]), w("cr", CH), w("ch:2027", year([NEUJAHR]))]);
    const base = ctx.view.plan.calendar;
    const offsite = buildAction(ctx, {
      t: "calendar",
      next: { ...base, closures: new Map([["X", { id: "X", from: "2027-03-01", to: "2027-03-05", name: "Offsite" }]]) },
    });
    expect(offsite.action.w).toEqual([w("cc:X", ["2027-03-01", "2027-03-05", "Offsite"])]);
    const after = applied(ctx, offsite);
    const next: Calendar = { ...base, holidays: new Map([[2027, year([NEUJAHR, BERCHTOLD])]]) };
    const b = buildAction(after, { t: "calendar", next, base });
    expect(units(b)).toEqual(["ch:2027"]);
    const projected = applied(after, b).view.plan.calendar;
    expect([...projected.closures.keys()]).toEqual(["X"]);
    expect(projected.holidays.get(2027)?.days.map((d) => d.date)).toEqual(["2027-01-01", "2027-01-02"]);
  });

  it("compares with the current calendar without a base", () => {
    const ctx = ctxFrom([w("pn", "Plan"), w("cw", [1, 2, 3, 4, 5]), w("cr", CH), w("ch:2027", year([NEUJAHR]))]);
    const base = ctx.view.plan.calendar;
    const after = applied(
      ctx,
      buildAction(ctx, { t: "calendar", next: { ...base, closures: new Map([["X", { id: "X", from: "2027-03-01", to: "2027-03-05", name: "Offsite" }]]) } }),
    );
    const next: Calendar = { ...base, holidays: new Map([[2027, year([NEUJAHR, BERCHTOLD])]]) };
    const b = buildAction(after, { t: "calendar", next });
    expect(units(b).sort()).toEqual(["cc:X", "ch:2027"]);
    expect(writeOf(b, "cc:X").v).toBeNull();
    refusedWith(after, { t: "calendar", next: base, base }, "Nothing to change.");
  });

  it("recalendars a closure over Spec, with counts matching the label", () => {
    const ctx = chain();
    const cal = ctx.view.plan.calendar;
    const b = buildAction(ctx, {
      t: "calendar",
      next: { ...cal, closures: new Map([["c1", { id: "c1", from: "2026-11-19", to: "2026-11-20", name: "Offsite" }]]) },
    });
    expect(b.action.lbl).toBe("Changed the calendar; 4 end dates changed, 3 items moved later");
    expect(b.action.w.map((x) => [x.u, x.c])).toEqual([
      ["cc:c1", "own"],
      ["s:Spec", "recalendar"],
      ["s:Build", "push"],
      ["s:Review", "push"],
      ["s:Ship", "push"],
    ]);
    expect(startOf(b, "s:Spec")).toBe("2026-11-23");
    expect(b.preview.endsChanged).toBe(4);
    expect(b.preview.movedLater).toBe(3);
  });

  const yearOf = (y: number, region = "oh:CH:CH-ZH", days: HolidayYear["days"] = []): HolidayYear => ({ region, year: y, days, fetchedAt: "2026-11-01" });
  const cachedRoot = (): Write[] => replaced(CHAIN, [w("cr", CH), w("ch:2026", yearOf(2026)), w("ch:2027", yearOf(2027))]);

  it("snaps an own start to the calendar after the new holiday year", () => {
    const log = logOf(act("a0", [], cachedRoot()));
    const neujahr = yearOf(2031, "oh:CH:CH-ZH", [{ date: "2031-01-01", name: "Neujahrstag", kind: "public", sourceId: "n", scope: null }]);
    const ctx = ctxOf(log, "d1", TODAY, FIXTURE_DEVICES, { cachedHolidays: (r, y) => (r === "oh:CH:CH-ZH" && y === 2031 ? neujahr : null) });
    const b = buildAction(ctx, { t: "schedule", item: "Ship", set: { start: "2031-01-01" } });
    expect(writeOf(b, "ch:2031").v).toEqual(neujahr);
    expect(writeOf(b, "s:Ship")).toEqual(w("s:Ship", sched("2031-01-02", 1)));
    expect(b.action.lbl).toBe("Scheduled “Ship” from 2 Jan 2031; 1 dependent item moved");
    const after = applied(ctx, b, { cachedHolidays: ctx.cachedHolidays });
    expect(after.view.derived.conflicts.filter((c) => c.kind === "dayoff")).toEqual([]);
  });

  it("adds a holiday year that a push carries a successor into", () => {
    const log = logOf(act("a0", [], cachedRoot()));
    const ctx = ctxOf(log, "d1", TODAY, FIXTURE_DEVICES, { cachedHolidays: (r, y) => (r === "oh:CH:CH-ZH" && y === 2031 ? yearOf(2031) : null) });
    const b = buildAction(ctx, { t: "schedule", item: "Build", set: { start: "2030-12-23" } });
    expect(startOf(b, "s:Ship")).toBe("2031-01-01");
    expect(units(b).filter((u) => u.startsWith("ch:"))).toEqual(["ch:2031"]);
  });

  it("adds no cached year that was already missing under a new region", () => {
    const log = logOf(act("a0", [], cachedRoot()));
    const ctx = ctxOf(log, "d1", TODAY, FIXTURE_DEVICES, { cachedHolidays: (r, y) => yearOf(y, r) });
    const b = buildAction(ctx, { t: "calendar", next: { ...ctx.view.plan.calendar, region: { ...CH, subdivision: "CH-BE" } } });
    expect(units(b)).toEqual(["cr"]);
  });

  it("adds a newly needed holiday year from the cache, and none without one", () => {
    const root = cachedRoot();
    const log = logOf(act("a0", [], root));
    const cached = ctxOf(log, "d1", TODAY, FIXTURE_DEVICES, {
      cachedHolidays: (r, y) => (r === "oh:CH:CH-ZH" && y === 2031 ? yearOf(2031) : null),
    });
    expect(cached.view.derived.missingYears).toEqual([]);
    const intent: Intent = { t: "schedule", item: "Ship", set: { start: "2031-03-03" } };
    const b = buildAction(cached, intent);
    expect(units(b).filter((u) => u.startsWith("ch:"))).toEqual(["ch:2031"]);
    expect(writeOf(b, "ch:2031")).toEqual(w("ch:2031", yearOf(2031)));
    expect(writeOf(b, "s:Ship").v).toEqual(sched("2031-03-03", 1));
    const none = buildAction(ctxOf(log, "d1", TODAY), intent);
    expect(units(none).filter((u) => u.startsWith("ch:"))).toEqual([]);
  });
});

describe("buildAction: fix (§6.4)", () => {
  const late = act("a1", ["a0"], [w("s:Build", sched("2026-11-30", 5))]);
  const early = (ctx: Ctx): Conflict => {
    const c = ctx.view.derived.conflicts.find((x) => x.kind === "early");
    if (c === undefined) throw new Error("no early conflict");
    return c;
  };

  it("pushes a todo successor to its earliest allowed date", () => {
    const ctx = chain(late);
    const conflict = early(ctx);
    expect(conflict).toMatchObject({ link: "Build>Review", need: toDay("2026-12-07"), succLock: null });
    const b = buildAction(ctx, { t: "fix", conflict, how: "push" });
    expect(b.action.lbl).toBe("Moved “Review” to its earliest allowed date, 7 Dec; 1 dependent item moved");
    expect(units(b)).toEqual(["s:Review", "s:Ship"]);
    expect(startOf(b, "s:Review")).toBe("2026-12-07");
  });

  it("shortens the lag to the value that holds and removes the link", () => {
    const ctx = chain(late);
    const shorten = buildAction(ctx, { t: "fix", conflict: early(ctx), how: "shorten" });
    expect(shorten.action.lbl).toBe("Shortened the lag of “Build” → “Review” to −4 working days");
    expect(shorten.action.w).toEqual([w("l:Build>Review", ["FS", -4])]);
    expect(applied(ctx, shorten).view.derived.conflicts).toEqual([]);
    const remove = buildAction(chain(late), { t: "fix", conflict: early(ctx), how: "remove" });
    expect(remove.action.lbl).toBe("Removed the link “Build” → “Review”");
    expect(remove.action.w).toEqual([w("l:Build>Review", null)]);
  });

  it("refuses to push a done successor and one in progress", () => {
    const ctx = ctxFrom(replaced(CHAIN, [w("s:Review", sched("2026-12-01", 2, "done", 100))]), late);
    refusedWith(
      ctx,
      { t: "fix", conflict: early(ctx), how: "push" },
      "“Review” is done; done and in-progress items keep their dates. Shorten the lag or remove the link.",
    );
    const doing = ctxFrom(replaced(CHAIN, [w("s:Review", sched("2026-12-01", 2, "doing", 50))]), late);
    refusedWith(
      doing,
      { t: "fix", conflict: early(doing), how: "push" },
      "“Review” is in progress; done and in-progress items keep their dates. Shorten the lag or remove the link.",
    );
  });

  it("opens the choice of a held item whose start is a day off", () => {
    const ctx = chain(
      act("m", ["a0"], [w("s:Review", sched("2026-11-28", 2, "todo", 0, "next"))], { dev: "d1" }),
      act("p", ["a0"], [w("s:Review", sched("2026-11-28", 2, "todo", 0, "now"))], { dev: "d2" }),
    );
    const conflict = ctx.view.derived.conflicts.find((c) => c.kind === "dayoff");
    if (conflict === undefined) throw new Error("no dayoff conflict");
    const e = refusal(ctx, { t: "fix", conflict, how: "push" });
    expect(e).toBeInstanceOf(HeldRefused);
    expect(e.message).toBe("“Review” is held in an open choice. Choose a version first.");
    expect((e as HeldRefused).choice).toBe(ctx.view.choices[0].id);
  });

  it("opens the choice of a held successor", () => {
    const ctx = chain(
      late,
      act("m", ["a1"], [w("s:Review", sched("2026-12-01", 2, "todo", 0, "next"))], { dev: "d1" }),
      act("p", ["a1"], [w("s:Review", sched("2026-12-01", 2, "todo", 0, "now"))], { dev: "d2" }),
    );
    const e = refusal(ctx, { t: "fix", conflict: early(ctx), how: "push" });
    expect(e).toBeInstanceOf(HeldRefused);
    expect(e.message).toBe("“Review” is held in an open choice. Choose a version first.");
    expect((e as HeldRefused).choice).toBe(ctx.view.choices[0].id);
  });

  it("fixes a loop only by removing a link", () => {
    const ctx = chain(act("a1", ["a0"], [w("l:Ship>PFF", ["FS", 0])]));
    const loop: Conflict = { kind: "loop", link: "Ship>PFF" };
    refusedWith(ctx, { t: "fix", conflict: loop, how: "push" }, "A loop is fixed by removing one of its links.");
    refusedWith(ctx, { t: "fix", conflict: loop, how: "shorten" }, "A loop is fixed by removing one of its links.");
    const b = buildAction(ctx, { t: "fix", conflict: loop, how: "remove" });
    expect(b.action.w).toEqual([w("l:Ship>PFF", null)]);
    expect(b.action.lbl).toBe("Removed the link “Ship” → “Plan file format”");
  });

  it("snaps a start on a day off", () => {
    const ctx = chain(act("a1", ["a0"], [w("s:Admin", sched("2026-11-21", 2))]));
    const conflict = ctx.view.derived.conflicts.find((c) => c.kind === "dayoff");
    if (conflict === undefined) throw new Error("no dayoff conflict");
    const b = buildAction(ctx, { t: "fix", conflict, how: "push" });
    expect(b.action.lbl).toBe("Moved “Admin” to its first working day, 23 Nov");
    expect(b.action.w).toEqual([w("s:Admin", sched("2026-11-23", 2))]);
  });

  it("refuses a conflict that is no longer derived", () => {
    const ctx = chain();
    refusedWith(
      ctx,
      { t: "fix", conflict: { kind: "early", link: "Build>Review", pred: "Build", succ: "Review", need: toDay("2026-12-07"), succLock: null }, how: "push" },
      "This conflict is already fixed.",
    );
  });
});

describe("buildAction: new items and places", () => {
  it("orders a new item after a sibling and first", () => {
    const ctx = groups();
    const after = buildAction(ctx, { t: "create", kind: "task", name: "New", parent: null, after: "S4", start: null });
    const id = after.newNotes[0];
    expect(writeOf(after, `p:${id}`).v).toEqual([null, "a0V"]);
    const first = buildAction(ctx, { t: "create", kind: "task", name: "New", parent: null, after: null, start: null });
    expect(writeOf(first, `p:${first.newNotes[0]}`).v).toEqual([null, "Zz"]);
  });

  it("writes the defaults of each kind and one note", () => {
    const ctx = chain();
    const task = buildAction(ctx, { t: "create", kind: "task", name: "Prep", parent: null, after: null, start: null });
    const id = task.newNotes[0];
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(task.newNotes).toEqual([id]);
    expect(task.action.lbl).toBe("Added task “Prep”");
    expect(task.action.w).toEqual([
      w(`e:${id}`, { k: "task", t: false }),
      w(`n:${id}`, "Prep"),
      w(`p:${id}`, [null, "Zz"]),
      w(`s:${id}`, sched(null, 3)),
    ]);
    const ms = buildAction(ctx, { t: "create", kind: "milestone", name: "Gate", parent: null, after: null, start: "2026-11-20" });
    expect(ms.action.lbl).toBe("Added milestone “Gate”");
    expect(writeOf(ms, `s:${ms.newNotes[0]}`).v).toEqual(sched("2026-11-20", 0));
    const group = buildAction(ctx, { t: "create", kind: "group", name: "Sprint", parent: null, after: null, start: null });
    expect(group.action.lbl).toBe("Added group “Sprint”");
    expect(units(group)).toEqual([`e:${group.newNotes[0]}`, `n:${group.newNotes[0]}`, `p:${group.newNotes[0]}`]);
    const sized = buildAction(ctx, { t: "create", kind: "task", name: "Long", parent: null, after: null, start: null, dur: 8 });
    expect(writeOf(sized, `s:${sized.newNotes[0]}`).v).toEqual(sched(null, 8));
  });

  it("marks a task done with progress 100", () => {
    const b = buildAction(chain(), { t: "schedule", item: "Admin", set: { status: "done" } });
    expect(b.action.w).toEqual([w("s:Admin", sched("2026-11-23", 2, "done", 100))]);
    expect(b.action.lbl).toBe("Marked “Admin” done");
  });

  it("places items into a group, to the top level, and reorders", () => {
    const ctx = groups();
    const top = buildAction(ctx, { t: "place", item: "R", parent: null, after: null });
    expect(top.action.lbl).toBe("Moved “Review” to the top level");
    expect(top.action.w).toEqual([w("p:R", [null, "Zz"])]);
    const into = buildAction(ctx, { t: "place", item: "U", parent: "S4", after: null });
    expect(into.action.lbl).toBe("Moved “Unscheduled” into “Sprint 4”");
    expect(into.action.w).toEqual([w("p:U", ["S4", "Zz"])]);
    const reorder = buildAction(ctx, { t: "place", item: "U", parent: null, after: null });
    expect(reorder.action.lbl).toBe("Reordered “Unscheduled”");
    expect(reorder.action.w).toEqual([w("p:U", [null, "Zz"])]);
    refusedWith(ctx, { t: "place", item: "U", parent: null, after: "S4" }, "Nothing to change.");
  });
});

describe("buildAction: every intent's copy", () => {
  it("rename, plan name, resize and schedule fields", () => {
    const ctx = chain();
    const one = (i: Intent) => {
      const b = buildAction(ctx, i);
      return [b.action.lbl, units(b)];
    };
    expect(one({ t: "rename", item: "Admin", name: "Admin work" })).toEqual(["Renamed “Admin” to “Admin work”", ["n:Admin"]]);
    expect(one({ t: "planName", name: "Launch plan" })).toEqual(["Renamed the plan to “Launch plan”", ["pn"]]);
    expect(one({ t: "resize", item: "Admin", dur: 8 })).toEqual(["Resized “Admin” to 8 working days", ["s:Admin"]]);
    expect(one({ t: "resize", item: "Review", dur: 3 })).toEqual(["Resized “Review” to 3 working days; 1 dependent item moved", ["s:Review", "s:Ship"]]);
    expect(one({ t: "schedule", item: "Admin", set: { start: null } })).toEqual(["Unscheduled “Admin”", ["s:Admin"]]);
    expect(one({ t: "schedule", item: "Admin", set: { status: "doing" } })).toEqual(["Marked “Admin” in progress", ["s:Admin"]]);
    expect(one({ t: "schedule", item: "Kickoff", set: { status: "doing" } })).toEqual(["Marked “Kickoff” in progress", ["s:Kickoff"]]);
    expect(one({ t: "schedule", item: "Admin", set: { progress: 40 } })).toEqual(["Set “Admin” to 40 %", ["s:Admin"]]);
    expect(one({ t: "schedule", item: "Admin", set: { horizon: "next" } })).toEqual(["Moved “Admin” to Next", ["s:Admin"]]);
    expect(one({ t: "schedule", item: "Admin", set: { dur: 4 } })).toEqual(["Resized “Admin” to 4 working days", ["s:Admin"]]);
    expect(one({ t: "schedule", item: "Admin", set: { progress: 40, horizon: "now" } })).toEqual(["Changed “Admin”", ["s:Admin"]]);
  });

  it("marks a done item to do", () => {
    const ctx = ctxFrom(replaced(CHAIN, [w("s:Admin", sched("2026-11-23", 2, "done", 100))]));
    expect(buildAction(ctx, { t: "schedule", item: "Admin", set: { status: "todo" } }).action.lbl).toBe("Marked “Admin” to do");
  });

  it("trash, restore, link, unlink and snap", () => {
    const ctx = chain();
    const several = buildAction(ctx, { t: "trash", items: ["Admin", "Kickoff", "Launch"] });
    expect(several.action.lbl).toBe("Moved 3 items to the Trash");
    expect(several.toast).toBe("Moved 3 items to the Trash. Undo brings them back.");
    expect(several.action.w).toEqual([
      w("e:Admin", { k: "task", t: true }),
      w("e:Kickoff", { k: "milestone", t: true }),
      w("e:Launch", { k: "milestone", t: true }),
    ]);
    const after = applied(ctx, buildAction(ctx, { t: "trash", items: ["Admin"] }));
    const restore = buildAction(after, { t: "restore", items: ["Admin"] });
    expect(restore.action.lbl).toBe("Restored “Admin” from the Trash");
    expect(restore.action.w).toEqual([w("e:Admin", { k: "task", t: false })]);
    const linked = buildAction(chain(), { t: "link", from: "Admin", to: "Kickoff", type: "FS", lag: 0 });
    expect(linked.action.lbl).toBe("Linked “Admin” → “Kickoff” (FS); 1 dependent item moved");
    expect(units(linked)).toEqual(["l:Admin>Kickoff", "s:Kickoff"]);
    expect(startOf(linked, "s:Kickoff")).toBe("2026-11-24");
    const changed = buildAction(chain(), { t: "link", from: "PFF", to: "Spec", type: "FS", lag: 2 });
    expect(changed.action.lbl).toBe("Changed the link “Plan file format” → “Spec”; 4 dependent items moved");
    expect(units(changed)).toEqual(["l:PFF>Spec", ...PUSHED]);
    refusedWith(chain(), { t: "link", from: "PFF", to: "Spec", type: "FS", lag: 0 }, "Nothing to change.");
    const unlinked = buildAction(chain(), { t: "unlink", link: "Review>Ship" });
    expect(unlinked.action.lbl).toBe("Removed the link “Review” → “Ship”");
    expect(unlinked.action.w).toEqual([w("l:Review>Ship", null)]);
    const off = chain(act("a1", ["a0"], [w("s:Admin", sched("2026-11-21", 2))]));
    const snap = buildAction(off, { t: "snap", item: "Admin" });
    expect(snap.action.lbl).toBe("Moved “Admin” to its first working day, 23 Nov");
    expect(snap.action.w).toEqual([w("s:Admin", sched("2026-11-23", 2))]);
    refusedWith(chain(), { t: "snap", item: "Admin" }, "Nothing to change.");
  });

  it("restores a group from the Trash", () => {
    const ctx = groups();
    const after = applied(ctx, buildAction(ctx, { t: "trash", items: ["S4"] }));
    const b = buildAction(after, { t: "restore", items: ["S4"] });
    expect(b.action.lbl).toBe("Restored “Sprint 4” from the Trash");
    refusedWith(after, { t: "restore", items: ["R"] }, "“Review” is inside “Sprint 4”, which is in the Trash. Restore “Sprint 4” first.");
  });

  it("moves a group's scheduled descendants", () => {
    const b = buildAction(groups(), { t: "move", items: ["S4"], days: 1 });
    expect(b.action.lbl).toBe("Moved “Sprint 4” later by 1 working day");
    expect(b.action.w).toEqual([w("s:R", sched("2026-12-02", 2))]);
  });

  it("leaves the items of a trashed inner group where they are", () => {
    const ctx = ctxFrom(
      replaced(GROUPS, [
        w("e:C", { k: "group", t: true }),
        ...item("T", "task", "Deep", "C", "a0", sched("2026-12-01", 2)),
        ...item("V", "task", "Visible", "G", "a1", sched("2026-12-02", 1)),
      ]),
    );
    const b = buildAction(ctx, { t: "move", items: ["G"], days: 1 });
    expect(b.action.w).toEqual([w("s:V", sched("2026-12-03", 1))]);
  });

  it("baselines: save, rename and remove", () => {
    const ctx = chain();
    const save = buildAction(ctx, { t: "baseline", op: "save", name: "Kickoff plan" });
    expect(save.action.lbl).toBe("Saved baseline “Kickoff plan”");
    expect(save.action.w).toHaveLength(1);
    const saved = save.action.w[0];
    expect(saved.u).toMatch(/^b:[A-Za-z0-9_-]{11}$/);
    const value = saved.v as { name: string; at: string; dates: Record<string, { start: string; dur: number }> };
    expect(value.name).toBe("Kickoff plan");
    expect(value.at).toBe(TODAY);
    expect(Object.keys(value.dates).sort()).toEqual(["Admin", "Build", "Kickoff", "Launch", "PFF", "Review", "Ship", "Spec"]);
    expect(value.dates.PFF).toEqual({ start: "2026-11-16", dur: 3 });
    const rename = buildAction(ctx, { t: "baseline", op: "rename", id: "B1", name: "After" });
    expect(rename.action.lbl).toBe("Renamed baseline “Before” to “After”");
    expect(rename.action.w).toEqual([w("b:B1", { name: "After", at: "2026-11-01", dates: {} })]);
    const remove = buildAction(ctx, { t: "baseline", op: "remove", id: "B1" });
    expect(remove.action.lbl).toBe("Removed baseline “Before”");
    expect(remove.action.w).toEqual([w("b:B1", null)]);
  });
});

describe("initialAction", () => {
  it("writes the name and every calendar unit and projects to them", () => {
    const calendar: Calendar = {
      region: { src: "openholidays", country: "CH", subdivision: "CH-ZH" },
      workdays: [1, 2, 3, 4],
      closures: new Map([["c1", { id: "c1", from: "2026-12-24", to: "2026-12-31", name: "Winter" }]]),
      tuning: new Map([["2026-11-20", { kind: "add", name: "Team day" }]]),
      holidays: new Map([
        [
          2026,
          {
            region: "oh:CH:CH-ZH",
            year: 2026,
            days: [{ date: "2026-12-25", name: "Weihnachten", kind: "public", sourceId: "x", scope: null }],
            fetchedAt: "2026-11-01",
          },
        ],
      ]),
    };
    const a = initialAction({ dev: "d1", ses: "s1", now: 5, name: "  Launch\n plan ", calendar });
    expect(a.par).toEqual([]);
    expect(a.dev).toBe("d1");
    expect(a.ses).toBe("s1");
    expect(a.at).toBe(5);
    expect(a.lbl).toBe("Created the plan “Launch plan”");
    expect(a.w.map((x) => x.u).sort()).toEqual(["cc:c1", "ch:2026", "cr", "ct:2026-11-20", "cw", "pn"]);
    expect(a.w.every((x) => x.c === "own")).toBe(true);
    const plan = projectPlan("P", logOf(a));
    expect(plan.name).toBe("Launch plan");
    expect(plan.calendar).toEqual(calendar);
    expect(derive(plan, new Set(), TODAY).conflicts).toEqual([]);
  });
});

describe("buildAction: tied order keys (schedule-2)", () => {
  const TIED: Write[] = [
    ...ROOT,
    ...item("A", "task", "A", null, "a1", sched("2026-11-16", 1)),
    ...item("M", "task", "M", null, "a2", sched("2026-11-16", 1)),
    ...item("P", "task", "P", null, "a2", sched("2026-11-16", 1)),
    ...item("Z", "task", "Z", null, "a3", sched("2026-11-16", 1)),
  ];
  const names = (ctx: Ctx): string[] => childrenOf(ctx.view.plan, null).map((i) => i.name);
  const orders = (ctx: Ctx): string[] => childrenOf(ctx.view.plan, null).map((i) => i.place.order);

  it("a new row after the first of a tied pair lands between them, and one undo restores every key", () => {
    const ctx = ctxFrom(TIED);
    expect(names(ctx)).toEqual(["A", "M", "P", "Z"]);
    const b = buildAction(ctx, { t: "create", kind: "task", name: "X", parent: null, after: "M", start: null });
    const after = applied(ctx, b);
    expect(names(after)).toEqual(["A", "M", "X", "P", "Z"]);
    expect(new Set(orders(after)).size).toBe(5);
    expect(units(b).filter((u) => u.startsWith("p:")).sort()).toEqual(["p:M", "p:P", `p:${b.newNotes[0]}`].sort());
    const undone = applied(after, buildUndo(after, b.action.id));
    expect(names(undone)).toEqual(["A", "M", "P", "Z"]);
    expect(orders(undone)).toEqual(["a1", "a2", "a2", "a3"]);
  });

  it("placing a row after the first of a tied pair puts it between them", () => {
    const ctx = ctxFrom(TIED);
    const b = buildAction(ctx, { t: "place", item: "A", parent: null, after: "M" });
    const after = applied(ctx, b);
    expect(names(after)).toEqual(["M", "A", "P", "Z"]);
    expect(new Set(orders(after)).size).toBe(4);
  });

  it("an untied neighbour writes only the moved row", () => {
    const ctx = ctxFrom(TIED);
    const b = buildAction(ctx, { t: "create", kind: "task", name: "X", parent: null, after: "A", start: null });
    expect(units(b).filter((u) => u.startsWith("p:"))).toHaveLength(1);
    expect(names(applied(ctx, b))).toEqual(["A", "X", "M", "P", "Z"]);
  });
});

describe("buildAction: the plan's limits (schedule-1)", () => {
  const RANGE = "Dates run from 1 Jan 1900 to 31 Dec 2199.";
  const DUR = "A task lasts 1 to 3650 working days.";
  const LAG = "A lag is at most 1000 working days either way.";

  it("refuses a start, a duration or a lag outside the limits, naming the limit", () => {
    const ctx = chain();
    refusedWith(ctx, { t: "schedule", item: "Admin", set: { start: "0026-11-16" } }, RANGE);
    refusedWith(ctx, { t: "schedule", item: "Admin", set: { start: "2200-01-05" } }, RANGE);
    refusedWith(ctx, { t: "create", kind: "task", name: "Far", parent: null, after: null, start: "1899-12-29" }, RANGE);
    refusedWith(ctx, { t: "create", kind: "task", name: "Long", parent: null, after: null, start: "2026-11-16", dur: 3651 }, DUR);
    refusedWith(ctx, { t: "resize", item: "Admin", dur: 1_000_000 }, DUR);
    refusedWith(ctx, { t: "schedule", item: "Admin", set: { dur: 3651 } }, DUR);
    refusedWith(ctx, { t: "link", from: "Admin", to: "Ship", type: "FS", lag: 1001 }, LAG);
    refusedWith(ctx, { t: "link", from: "Admin", to: "Ship", type: "SS", lag: -5_000_000 }, LAG);
    refusedWith(ctx, { t: "move", items: ["Launch"], days: 60_000 }, RANGE);
    refusedWith(ctx, { t: "schedule", item: "PFF", set: { start: "2199-12-16" } }, RANGE);
  });

  it("accepts the edges of the limits", () => {
    const ctx = chain();
    expect(units(buildAction(ctx, { t: "resize", item: "Admin", dur: 3650 }))).toContain("s:Admin");
    expect(units(buildAction(ctx, { t: "link", from: "Admin", to: "Launch", type: "SS", lag: -1000 }))).toContain("l:Admin>Launch");
    expect(units(buildAction(ctx, { t: "schedule", item: "Admin", set: { start: "2199-12-30" } }))).toContain("s:Admin");
  });

  it("names the year in a date toast when it is not this year", () => {
    const ctx = chain();
    expect(buildAction(ctx, { t: "schedule", item: "Admin", set: { start: "2026-11-30" } }).toast).toBe("Scheduled “Admin” from 30 Nov.");
    expect(buildAction(ctx, { t: "schedule", item: "Admin", set: { start: "2062-11-16" } }).toast).toBe("Scheduled “Admin” from 16 Nov 2062.");
  });
});
