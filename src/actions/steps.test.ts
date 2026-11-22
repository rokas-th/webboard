import { generateKeyBetween } from "fractional-indexing";
import { describe, expect, it } from "vitest";
import type { ItemId, StepColour, StepId } from "../domain/model";
import { projectBoard, stepModeOf } from "../domain/steps";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf } from "../test/planCtx";
import { buildAction } from "./build";
import { Refused, type Built, type Ctx, type Intent } from "./intents";
import { switchWrites } from "./steps";
import { buildUndo } from "./undo";

const TODAY = "2026-11-09";
const SWITCHED = "Cards now keep their steps. Undo goes back to dates.";

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const sched = (start: string | null, dur: number, status = "todo", progress = 0, horizon = "later"): unknown[] => [start, dur, status, progress, horizon];

const item = (id: string, kind: "task" | "milestone" | "group", name: string, parent: string | null, order: string, s?: unknown[], trashed = false): Write[] => [
  w(`e:${id}`, { k: kind, t: trashed }),
  w(`n:${id}`, name),
  ...(s === undefined ? [] : [w(`s:${id}`, s)]),
  w(`p:${id}`, [parent, order]),
];

const DATES: Write[] = [
  w("pn", "MESA 1.0"),
  w("cw", [1, 2, 3, 4, 5]),
  w("cr", null),
  ...item("T1", "task", "Mirror test", null, "a0", sched("2026-11-16", 3)),
  ...item("T2", "task", "Dome survey", null, "a1", sched("2026-12-14", 3)),
  ...item("T3", "task", "Ship", null, "a2", sched("2027-03-01", 2)),
  ...item("M1", "milestone", "First light", null, "a3", sched("2027-03-15", 0)),
  ...item("D1", "task", "Draft", null, "a4", sched("2026-11-02", 2, "done", 100)),
  ...item("U1", "task", "Lens order", null, "a5", sched(null, 3, "todo", 0, "next")),
  ...item("G", "group", "Phase", null, "a6"),
  ...item("C1", "task", "Wire", "G", "a0", sched("2026-11-18", 2)),
  ...item("X", "task", "Old", null, "a7", sched("2026-11-20", 2), true),
  ...item("M2", "milestone", "Review gate", null, "a8", sched("2026-12-01", 0)),
  w("l:T3>M1", ["FS", 0]),
];

const QA = { n: "QA", c: "amber", o: "a1V", l: 3 };

const STEPS: Write[] = [...DATES, w("ws:qa", QA), w("wi:T1", "qa"), w("wi:X", "qa")];

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  expect(log.pending).toEqual([]);
  return log;
};

const ctxFrom = (root: readonly Write[]): Ctx => ctxOf(logOf(act("a0", [], root)), "d1", TODAY);

const dates = (): Ctx => ctxFrom(DATES);
const steps = (): Ctx => ctxFrom(STEPS);

const applied = (ctx: Ctx, b: Built): Ctx => {
  expect(ctx.log.add([b.action]).refused).toEqual([]);
  return ctxOf(ctx.log, ctx.dev, TODAY, ctx.devices);
};

const units = (b: Built): string[] => b.action.w.map((x) => x.u);

const valueAt = (b: Built, u: string): unknown => {
  const found = b.action.w.find((x) => x.u === u);
  if (found === undefined) throw new Error(`no write to ${u}`);
  return found.v;
};

const newStepUnit = (b: Built): string => {
  const found = units(b).filter((u) => u.startsWith("ws:"));
  expect(found).toHaveLength(1);
  return found[0];
};

const refusedWith = (ctx: Ctx, intent: Intent, message: string): void => {
  const before = [...ctx.log.order()];
  let caught: unknown = null;
  try {
    buildAction(ctx, intent);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Refused)) throw new Error(`expected a Refused, caught ${String(caught)}`);
  expect(caught.message).toBe(message);
  expect([...ctx.log.order()]).toEqual(before);
};

const errorWith = (ctx: Ctx, intent: Intent, message: string): void => {
  let caught: unknown = null;
  try {
    buildAction(ctx, intent);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Error)) throw new Error(`expected an Error, caught ${String(caught)}`);
  expect(caught).not.toBeInstanceOf(Refused);
  expect(caught.message).toBe(message);
};

const columns = (ctx: Ctx): Map<ItemId, StepId | null> => new Map(projectBoard(ctx.view.plan, ctx.view.derived).columnOf);

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

const SWITCH_UNITS = ["wi:C1", "wi:M1", "wi:M2", "wi:T1", "wi:T2", "wi:T3"];

describe("step add", () => {
  it("adds a step after another with a fresh id and a normalised name", () => {
    const b = buildAction(steps(), { t: "step", op: "add", name: "  Review\n", colour: "violet", after: "now" });
    const u = newStepUnit(b);
    expect(units(b)).toEqual([u]);
    expect(u).toMatch(/^ws:[A-Za-z0-9_-]+$/);
    expect(valueAt(b, u)).toEqual({ n: "Review", c: "violet", o: generateKeyBetween("a0", "a1") });
    expect(b.action.lbl).toBe("Added step “Review”");
    expect(b.toast).toBe("Added step “Review”.");
  });

  it("adds a step first when after is null", () => {
    const b = buildAction(steps(), { t: "step", op: "add", name: "Inbox", colour: "sky", after: null });
    expect(valueAt(b, newStepUnit(b))).toEqual({ n: "Inbox", c: "sky", o: generateKeyBetween(null, "a0") });
  });

  it("adds after a step whose next live step is stored", () => {
    const b = buildAction(steps(), { t: "step", op: "add", name: "Polish", colour: "coral", after: "next" });
    expect(valueAt(b, newStepUnit(b))).toEqual({ n: "Polish", c: "coral", o: generateKeyBetween("a1", "a1V") });
  });

  it("rekeys a tied run of orders as orderAfter does", () => {
    const ctx = ctxFrom([...STEPS, w("ws:now", { n: "Now", c: "cyan", o: "a1" })]);
    const b = buildAction(ctx, { t: "step", op: "add", name: "Between", colour: "sky", after: "next" });
    const fresh = units(b).filter((u) => u !== "ws:next" && u !== "ws:now");
    expect(fresh).toHaveLength(1);
    const added = fresh[0];
    const after = applied(ctx, b);
    const order = projectBoard(after.view.plan, after.view.derived).steps.map((s) => s.id);
    expect(order.slice(0, 3)).toEqual(["next", added.slice(3), "now"]);
    expect(sorted(units(b))).toEqual(sorted([added, "ws:next", "ws:now"]));
  });

  it("refuses a long name, a taken name and an empty name", () => {
    refusedWith(steps(), { t: "step", op: "add", name: "x".repeat(33), colour: "cyan", after: null }, "A step name has at most 32 characters.");
    refusedWith(steps(), { t: "step", op: "add", name: "qa", colour: "cyan", after: null }, "There is already a step named “QA”.");
    refusedWith(steps(), { t: "step", op: "add", name: "  ", colour: "cyan", after: null }, "The name is empty. Type at least one character.");
  });

  it("counts the length in code points", () => {
    const b = buildAction(steps(), { t: "step", op: "add", name: "🔭".repeat(32), colour: "cyan", after: null });
    expect(b.action.lbl).toBe(`Added step “${"🔭".repeat(32)}”`);
  });

  it("throws for an unknown colour or an unknown after", () => {
    const teal = "teal" as StepColour;
    errorWith(steps(), { t: "step", op: "add", name: "A", colour: teal, after: null },"Step colour teal is not one of cyan, violet, magenta, lime, amber, coral, sky, slate");
    errorWith(steps(), { t: "step", op: "add", name: "A", colour: "cyan", after: "zz" }, "Step zz is not in this plan");
  });
});

describe("step rename, colour, limit, reorder", () => {
  it("renames a virtual step with its full value", () => {
    const b = buildAction(steps(), { t: "step", op: "rename", step: "now", name: "Today" });
    expect(units(b)).toEqual(["ws:now"]);
    expect(valueAt(b, "ws:now")).toEqual({ n: "Today", c: "cyan", o: "a0" });
    expect(b.action.lbl).toBe("Renamed step “Now” to “Today”");
  });

  it("renames a step to a case change of its own name, refuses another step's name and the same name", () => {
    expect(valueAt(buildAction(steps(), { t: "step", op: "rename", step: "qa", name: "Qa" }), "ws:qa")).toEqual({ ...QA, n: "Qa" });
    refusedWith(steps(), { t: "step", op: "rename", step: "qa", name: "NOW" }, "There is already a step named “Now”.");
    refusedWith(steps(), { t: "step", op: "rename", step: "now", name: "Now" }, "Nothing to change.");
    refusedWith(steps(), { t: "step", op: "rename", step: "qa", name: "y".repeat(33) }, "A step name has at most 32 characters.");
  });

  it("colours a step", () => {
    const b = buildAction(steps(), { t: "step", op: "colour", step: "qa", colour: "lime" });
    expect(valueAt(b, "ws:qa")).toEqual({ ...QA, c: "lime" });
    expect(b.action.lbl).toBe("Coloured step “QA” lime");
  });

  it("sets and removes a limit", () => {
    const set = buildAction(steps(), { t: "step", op: "limit", step: "next", limit: 5 });
    expect(valueAt(set, "ws:next")).toEqual({ n: "Next", c: "violet", o: "a1", l: 5 });
    expect(set.action.lbl).toBe("Set the limit of “Next” to 5");
    const removed = buildAction(steps(), { t: "step", op: "limit", step: "qa", limit: null });
    expect(valueAt(removed, "ws:qa")).toEqual({ n: "QA", c: "amber", o: "a1V" });
    expect(removed.action.lbl).toBe("Removed the limit of “QA”");
  });

  it("refuses a limit outside 1 to 99 or not whole", () => {
    [0, 100, 1.5, -1].forEach((limit) => refusedWith(steps(), { t: "step", op: "limit", step: "qa", limit }, "A limit is a whole number from 1 to 99."));
    refusedWith(steps(), { t: "step", op: "limit", step: "qa", limit: 3 }, "Nothing to change.");
  });

  it("reorders a step", () => {
    const b = buildAction(steps(), { t: "step", op: "reorder", step: "qa", after: null });
    expect(valueAt(b, "ws:qa")).toEqual({ ...QA, o: generateKeyBetween(null, "a0") });
    expect(b.action.lbl).toBe("Reordered step “QA”");
    const late = buildAction(steps(), { t: "step", op: "reorder", step: "now", after: "done" });
    expect(valueAt(late, "ws:now")).toEqual({ n: "Now", c: "cyan", o: generateKeyBetween("a3", null) });
  });

  it("refuses a reorder to where the step already is, and throws for a reorder after itself", () => {
    refusedWith(steps(), { t: "step", op: "reorder", step: "qa", after: "next" }, "Nothing to change.");
    errorWith(steps(), { t: "step", op: "reorder", step: "qa", after: "qa" }, "Step qa cannot follow itself");
  });

  it("throws for an op on an unknown or deleted step", () => {
    errorWith(steps(), { t: "step", op: "colour", step: "zz", colour: "lime" }, "Step zz is not in this plan");
    errorWith(ctxFrom([...STEPS, w("ws:later", null)]), { t: "step", op: "rename", step: "later", name: "Soon" }, "Step later is not in this plan");
  });
});

describe("step completes", () => {
  const trashOnly = (): Ctx => ctxFrom([...DATES, w("ws:qa", QA), w("wi:X", "qa")]);

  it("completes moves d off the old step in one action", () => {
    const ctx = trashOnly();
    const b = buildAction(ctx, { t: "step", op: "completes", step: "qa", completes: true });
    expect(sorted(units(b))).toEqual(["ws:done", "ws:qa"]);
    expect(valueAt(b, "ws:qa")).toEqual({ ...QA, d: true });
    expect(valueAt(b, "ws:done")).toEqual({ n: "Done", c: "lime", o: "a3" });
    expect(b.action.lbl).toBe("“QA” now completes items");
    const after = applied(ctx, b);
    const board = projectBoard(after.view.plan, after.view.derived);
    expect(board.completing?.id).toBe("qa");
    expect(board.problems).toEqual([]);
    expect(board.columnOf.get("D1")).toBe("qa");
  });

  it("clears every other completing step", () => {
    const ctx = ctxFrom([...DATES, w("ws:qa", QA), w("wi:X", "qa"), w("ws:next", { n: "Next", c: "violet", o: "a1", d: true })]);
    const b = buildAction(ctx, { t: "step", op: "completes", step: "qa", completes: true });
    expect(sorted(units(b))).toEqual(["ws:done", "ws:next", "ws:qa"]);
    expect(valueAt(b, "ws:next")).toEqual({ n: "Next", c: "violet", o: "a1" });
  });

  it("refuses to make a step that holds open items complete, and the only step", () => {
    refusedWith(steps(), { t: "step", op: "completes", step: "qa", completes: true }, "“QA” holds 1 item that is not done. Move it to another step first.");
    refusedWith(steps(), { t: "step", op: "completes", step: "later", completes: true }, "“Later” holds 5 items that are not done. Move them to another step first.");
    refusedWith(dates(), { t: "step", op: "completes", step: "now", completes: true }, "“Now” holds 2 items that are not done. Move them to another step first.");
    const only = ctxFrom([...DATES, w("ws:next", null), w("ws:later", null), w("ws:done", null)]);
    refusedWith(only, { t: "step", op: "completes", step: "now", completes: true }, "A plan keeps at least one step that does not complete items.");
  });

  it("an open item left in the completing step stays on the Board as a problem", () => {
    const ctx = ctxFrom([...DATES, w("ws:qa", { ...QA, d: true }), w("ws:done", { n: "Done", c: "lime", o: "a3" }), w("wi:T1", "qa")]);
    const board = projectBoard(ctx.view.plan, ctx.view.derived);
    expect(board.columnOf.get("T1")).toBe("qa");
    expect(board.columnOf.get("D1")).toBe("qa");
    expect(board.problems).toEqual([{ kind: "openInCompleting", steps: ["qa"], items: ["T1"] }]);
  });

  it("completes false removes d", () => {
    const b = buildAction(steps(), { t: "step", op: "completes", step: "done", completes: false });
    expect(units(b)).toEqual(["ws:done"]);
    expect(valueAt(b, "ws:done")).toEqual({ n: "Done", c: "lime", o: "a3" });
    expect(b.action.lbl).toBe("“Done” no longer completes items");
  });

  it("refuses a completes that changes nothing", () => {
    refusedWith(steps(), { t: "step", op: "completes", step: "done", completes: true }, "Nothing to change.");
    refusedWith(steps(), { t: "step", op: "completes", step: "qa", completes: false }, "Nothing to change.");
  });
});

describe("step delete", () => {
  it("delete with items moves them, trashed included, in one action; undo restores both", () => {
    const ctx = steps();
    const b = buildAction(ctx, { t: "step", op: "delete", step: "qa", to: "now" });
    expect(sorted(units(b))).toEqual(["wi:T1", "wi:X", "ws:qa"]);
    expect(valueAt(b, "ws:qa")).toBeNull();
    expect(valueAt(b, "wi:T1")).toBe("now");
    expect(valueAt(b, "wi:X")).toBe("now");
    expect(b.action.lbl).toBe("Deleted step “QA” and moved 2 items to “Now”");
    const after = applied(ctx, b);
    expect(after.view.plan.workflow.steps.get("qa")).toBeNull();
    expect(columns(after).get("T1")).toBe("now");
    const undone = applied(after, buildUndo(after, b.action.id));
    expect(undone.view.plan.workflow.steps.get("qa")).toEqual(QA);
    expect(undone.view.plan.workflow.items.get("T1")).toBe("qa");
    expect(undone.view.plan.workflow.items.get("X")).toBe("qa");
  });

  it("writes no status when deleting the completing step", () => {
    const b = buildAction(ctxFrom([...STEPS, w("wi:D1", "done")]), { t: "step", op: "delete", step: "done", to: "later" });
    expect(sorted(units(b))).toEqual(["wi:D1", "ws:done"]);
    expect(b.action.lbl).toBe("Deleted step “Done” and moved 1 item to “Later”");
  });

  it("deletes an empty step without moving anything", () => {
    const b = buildAction(steps(), { t: "step", op: "delete", step: "now", to: null });
    expect(units(b)).toEqual(["ws:now"]);
    expect(b.action.lbl).toBe("Deleted step “Now”");
  });

  it("refuses to delete a step holding items without a target, and the last step", () => {
    refusedWith(steps(), { t: "step", op: "delete", step: "qa", to: null }, "“QA” holds 2 items, 1 of them done or in the Trash. Choose a step to move them to.");
    refusedWith(ctxFrom([...STEPS, w("wi:T2", "qa"), w("wi:T3", "qa")]), { t: "step", op: "delete", step: "qa", to: null }, "“QA” holds 4 items, 1 of them done or in the Trash. Choose a step to move them to.");
    const last = ctxFrom([...DATES, w("ws:now", null), w("ws:next", null), w("ws:later", null)]);
    refusedWith(last, { t: "step", op: "delete", step: "done", to: null }, "A plan keeps at least one step.");
  });

  it("names the hidden items when the step's only items are trashed or done", () => {
    const trashed = ctxFrom([...DATES, w("ws:qa", QA), w("wi:X", "qa")]);
    refusedWith(trashed, { t: "step", op: "delete", step: "qa", to: null }, "“QA” holds 1 item that is done or in the Trash. Choose a step to move them to.");
    const both = ctxFrom([...DATES, w("ws:qa", QA), w("wi:X", "qa"), w("wi:D1", "qa")]);
    refusedWith(both, { t: "step", op: "delete", step: "qa", to: null }, "“QA” holds 2 items that are done or in the Trash. Choose a step to move them to.");
    const b = buildAction(trashed, { t: "step", op: "delete", step: "qa", to: "next" });
    expect(sorted(units(b))).toEqual(["wi:X", "ws:qa"]);
  });

  it("refuses a delete that leaves only completing steps", () => {
    const ctx = ctxFrom([...DATES, w("ws:now", null), w("ws:next", null)]);
    refusedWith(ctx, { t: "step", op: "delete", step: "later", to: "done" }, "A plan keeps at least one step that does not complete items.");
  });

  it("a delete into the completing step marks the open items done, and moves trashed ones without a status", () => {
    const ctx = steps();
    const b = buildAction(ctx, { t: "step", op: "delete", step: "qa", to: "done" });
    expect(sorted(units(b))).toEqual(["s:T1", "wi:T1", "wi:X", "ws:qa"]);
    expect(valueAt(b, "s:T1")).toEqual(sched("2026-11-16", 3, "done", 100));
    expect(valueAt(b, "wi:X")).toBe("done");
    expect(b.action.lbl).toBe("Deleted step “QA” and moved 2 items to “Done”");
    const after = applied(ctx, b);
    const board = projectBoard(after.view.plan, after.view.derived);
    expect(board.columnOf.get("T1")).toBe("done");
    expect(board.problems).toEqual([]);
    refusedWith(ctxFrom([...STEPS, w("wi:M1", "qa")]), { t: "step", op: "delete", step: "qa", to: "done" }, "“First light” is done when its predecessors are done.");
  });

  it("throws for a delete into itself or an unknown step", () => {
    errorWith(steps(), { t: "step", op: "delete", step: "qa", to: "qa" }, "Step qa cannot take its own items");
    errorWith(steps(), { t: "step", op: "delete", step: "zz", to: "now" }, "Step zz is not in this plan");
    errorWith(steps(), { t: "step", op: "delete", step: "qa", to: "zz" }, "Step zz is not in this plan");
  });
});

describe("toStep", () => {
  it("moves an item to a step", () => {
    const b = buildAction(steps(), { t: "toStep", items: ["T3"], step: "qa" });
    expect(units(b)).toEqual(["wi:T3"]);
    expect(valueAt(b, "wi:T3")).toBe("qa");
    expect(b.action.lbl).toBe("Moved “Ship” to “QA”");
  });

  it("names several items by count and skips the ones already there", () => {
    const b = buildAction(steps(), { t: "toStep", items: ["T1", "T2", "U1"], step: "qa" });
    expect(units(b)).toEqual(["wi:T2", "wi:U1"]);
    expect(b.action.lbl).toBe("Moved 2 items to “QA”");
    refusedWith(steps(), { t: "toStep", items: ["T1"], step: "qa" }, "Nothing to change.");
  });

  it("names the one item that moved, after repeats and skips", () => {
    const twice = buildAction(steps(), { t: "toStep", items: ["T3", "T3"], step: "qa" });
    expect(units(twice)).toEqual(["wi:T3"]);
    expect(twice.action.lbl).toBe("Moved “Ship” to “QA”");
    expect(buildAction(steps(), { t: "toStep", items: ["T1", "T2"], step: "qa" }).action.lbl).toBe("Moved “Dome survey” to “QA”");
  });

  it("into Done sets done and keeps wi; out of Done sets todo and the step", () => {
    const ctx = steps();
    const into = buildAction(ctx, { t: "toStep", items: ["T1"], step: "done" });
    expect(units(into)).toEqual(["s:T1"]);
    expect(valueAt(into, "s:T1")).toEqual(sched("2026-11-16", 3, "done", 100));
    expect(into.action.lbl).toBe("Moved “Mirror test” to “Done”");
    const after = applied(ctx, into);
    expect(after.view.plan.workflow.items.get("T1")).toBe("qa");
    expect(columns(after).get("T1")).toBe("done");
    const out = buildAction(after, { t: "toStep", items: ["T1", "D1"], step: "next" });
    expect(sorted(units(out))).toEqual(["s:D1", "s:T1", "wi:D1", "wi:T1"]);
    expect(valueAt(out, "s:T1")).toEqual(sched("2026-11-16", 3, "todo", 0));
    expect(valueAt(out, "s:D1")).toEqual(sched("2026-11-02", 2, "todo", 0));
    expect(valueAt(out, "wi:T1")).toBe("next");
    refusedWith(after, { t: "toStep", items: ["T1"], step: "done" }, "Nothing to change.");
  });

  it("refuses a milestone with predecessors in or out of the completing step, and a trashed item", () => {
    refusedWith(steps(), { t: "toStep", items: ["M1"], step: "done" }, "“First light” is done when its predecessors are done.");
    expect(units(buildAction(steps(), { t: "toStep", items: ["M1"], step: "qa" }))).toEqual(["wi:M1"]);
    refusedWith(steps(), { t: "toStep", items: ["X"], step: "now" }, "“Old” is in the Trash. Restore it first.");
  });

  it("throws for a group, an unknown target and a deleted target", () => {
    errorWith(steps(), { t: "toStep", items: ["G"], step: "now" }, "Group G has no step");
    errorWith(steps(), { t: "toStep", items: ["T2"], step: "zz" }, "Step zz is not in this plan");
    errorWith(ctxFrom([...STEPS, w("ws:later", null)]), { t: "toStep", items: ["T2"], step: "later" }, "Step later is not in this plan");
  });
});

describe("the switch", () => {
  it("writes a wi per live, dated, not-done task and milestone holding the derived horizon", () => {
    const ctx = dates();
    const sw = switchWrites(ctx);
    expect(sorted(sw.map((x) => x.u))).toEqual(SWITCH_UNITS);
    expect(Object.fromEntries(sw.map((x) => [x.u, x.v]))).toEqual({
      "wi:T1": "now",
      "wi:T2": "next",
      "wi:T3": "later",
      "wi:M1": "later",
      "wi:M2": "next",
      "wi:C1": "now",
    });
    expect(sw.every((x) => x.c === "own")).toBe(true);
    expect(switchWrites(steps())).toEqual([]);
  });

  it("the switch writes the edit plus a wi per dated not-done task and milestone, and every columnOf is unchanged except the moved item", () => {
    const ctx = dates();
    const before = columns(ctx);
    const b = buildAction(ctx, { t: "toStep", items: ["T3"], step: "now" });
    expect(sorted(units(b))).toEqual(SWITCH_UNITS);
    expect(units(b)[units(b).length - 1]).toBe("wi:T3");
    expect(valueAt(b, "wi:T3")).toBe("now");
    expect(b.action.lbl).toBe("Moved “Ship” to “Now”");
    expect(b.toast).toBe(`Moved “Ship” to “Now”. ${SWITCHED}`);
    const after = applied(ctx, b);
    expect(stepModeOf(after.view.plan)).toBe("steps");
    const moved = columns(after);
    expect(moved.get("T3")).toBe("now");
    expect(new Map([...moved].filter(([id]) => id !== "T3"))).toEqual(new Map([...before].filter(([id]) => id !== "T3")));
  });

  it("a step edit by dates switches too", () => {
    const b = buildAction(dates(), { t: "step", op: "rename", step: "later", name: "Someday" });
    expect(sorted(units(b))).toEqual(sorted([...SWITCH_UNITS, "ws:later"]));
    expect(b.toast).toBe(`Renamed step “Later” to “Someday”. ${SWITCHED}`);
  });

  it("refuses an edit that changes nothing without switching", () => {
    refusedWith(dates(), { t: "step", op: "rename", step: "later", name: "Later" }, "Nothing to change.");
    refusedWith(dates(), { t: "toStep", items: ["T1"], step: "now" }, "Nothing to change.");
  });

  it("writes no wi for a trashed dated item, which a restore after the switch puts in its stored horizon", () => {
    const ctx = dates();
    const trashed = applied(ctx, buildAction(ctx, { t: "trash", items: ["T1"] }));
    expect(switchWrites(trashed).map((x) => x.u)).not.toContain("wi:T1");
    const sw = applied(trashed, buildAction(trashed, { t: "step", op: "rename", step: "later", name: "Someday" }));
    expect(stepModeOf(sw.view.plan)).toBe("steps");
    const restored = applied(sw, buildAction(sw, { t: "restore", items: ["T1"] }));
    expect(restored.view.derived.horizon.get("T1")).toBe("now");
    expect(columns(restored).get("T1")).toBe("later");
  });

  it("undo of the switch returns to dates", () => {
    const ctx = dates();
    const before = columns(ctx);
    const after = applied(ctx, buildAction(ctx, { t: "toStep", items: ["T3"], step: "now" }));
    const undone = applied(after, buildUndo(after, after.log.order()[after.log.order().length - 1]));
    expect(stepModeOf(undone.view.plan)).toBe("dates");
    expect(undone.view.plan.workflow.steps.size + undone.view.plan.workflow.items.size).toBe(0);
    expect(columns(undone)).toEqual(before);
  });
});

describe("create, duplicate and schedule by steps", () => {
  const created = (b: Built): string => {
    const e = units(b).find((u) => u.startsWith("e:"));
    if (e === undefined) throw new Error("no create");
    return e.slice(2);
  };

  it("create with step writes wi and, by dates, the switch", () => {
    const b = buildAction(steps(), { t: "create", kind: "task", name: "Coat", parent: null, after: "T1", start: null, step: "qa" });
    const id = created(b);
    expect(valueAt(b, `wi:${id}`)).toBe("qa");
    expect(b.toast).toBe("Added task “Coat”.");
    const d = buildAction(dates(), { t: "create", kind: "milestone", name: "Gate", parent: null, after: null, start: "2026-11-20", step: "next" });
    const m = created(d);
    expect(valueAt(d, `wi:${m}`)).toBe("next");
    expect(sorted(units(d).filter((u) => u.startsWith("wi:") && u !== `wi:${m}`))).toEqual(SWITCH_UNITS);
    expect(d.toast).toBe(`Added milestone “Gate”. ${SWITCHED}`);
  });

  it("create by steps without a step goes to the first live step that does not complete", () => {
    const b = buildAction(ctxFrom([...STEPS, w("ws:now", null)]), { t: "create", kind: "task", name: "Coat", parent: null, after: null, start: null });
    expect(valueAt(b, `wi:${created(b)}`)).toBe("next");
  });

  it("create into the completing step makes the item done, by steps and by dates", () => {
    const ctx = steps();
    const b = buildAction(ctx, { t: "create", kind: "task", name: "Coat", parent: null, after: null, start: null, step: "done" });
    const id = created(b);
    expect(valueAt(b, `wi:${id}`)).toBe("done");
    expect(valueAt(b, `s:${id}`)).toEqual(sched(null, 3, "done", 100));
    const after = applied(ctx, b);
    const board = projectBoard(after.view.plan, after.view.derived);
    expect(board.columnOf.get(id)).toBe("done");
    expect(board.problems).toEqual([]);
    const d = buildAction(dates(), { t: "create", kind: "milestone", name: "Gate", parent: null, after: null, start: "2026-11-20", step: "done" });
    expect(valueAt(d, `s:${created(d)}`)).toEqual(sched("2026-11-20", 0, "done", 100));
  });

  it("create by steps without a step is refused when every step completes", () => {
    const only = ctxFrom([...DATES, w("ws:now", null), w("ws:next", null), w("ws:later", null)]);
    refusedWith(only, { t: "create", kind: "task", name: "Coat", parent: null, after: null, start: null }, "This plan has no step for new items. Add a step first.");
    expect(units(buildAction(only, { t: "create", kind: "group", name: "Phase 2", parent: null, after: null, start: null })).some((u) => u.startsWith("wi:"))).toBe(false);
  });

  it("create by dates without a step writes no wi, and a group takes no step", () => {
    const b = buildAction(dates(), { t: "create", kind: "task", name: "Coat", parent: null, after: null, start: null });
    expect(units(b).some((u) => u.startsWith("wi:"))).toBe(false);
    const g = buildAction(steps(), { t: "create", kind: "group", name: "Phase 2", parent: null, after: null, start: null });
    expect(units(g).some((u) => u.startsWith("wi:"))).toBe(false);
    errorWith(steps(), { t: "create", kind: "group", name: "Phase 2", parent: null, after: null, start: null, step: "qa" }, "A group has no step");
    errorWith(steps(), { t: "create", kind: "task", name: "Coat", parent: null, after: null, start: null, step: "zz" }, "Step zz is not in this plan");
  });

  it("duplicate copies wi", () => {
    const b = buildAction(steps(), { t: "duplicate", item: "T1" });
    const id = created(b);
    expect(valueAt(b, `wi:${id}`)).toBe("qa");
    expect(units(buildAction(steps(), { t: "duplicate", item: "T2" })).some((u) => u.startsWith("wi:"))).toBe(false);
  });

  it("schedule horizon is refused by steps", () => {
    refusedWith(steps(), { t: "schedule", item: "T2", set: { horizon: "now" } }, "This plan uses steps. Move the item to a step instead.");
    expect(units(buildAction(dates(), { t: "schedule", item: "T2", set: { horizon: "now" } }))).toEqual(["s:T2"]);
  });
});
