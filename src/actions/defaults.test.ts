import { describe, expect, it } from "vitest";
import type { DefaultsValue } from "../domain/model";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf } from "../test/planCtx";
import { buildAction } from "./build";
import { refusal } from "./copy";
import { Refused, type Built, type Ctx, type Intent } from "./intents";
import { buildUndo } from "./undo";

const TODAY = "2026-11-09";

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const sched = (start: string | null, dur: number): unknown[] => [start, dur, "todo", 0, "later"];

const item = (id: string, kind: "task" | "milestone" | "group", name: string, parent: string | null, order: string, s?: unknown[], trashed = false): Write[] => [
  w(`e:${id}`, { k: kind, t: trashed }),
  w(`n:${id}`, name),
  ...(s === undefined ? [] : [w(`s:${id}`, s)]),
  w(`p:${id}`, [parent, order]),
];

const MIRA = { n: "Mira Okafor", i: "MO", c: "cyan", o: "a0" };
const REVIEW = { n: "Review", c: "amber", o: "a15" };

const DATES: Write[] = [
  w("pn", "MESA 1.0"),
  w("cw", [1, 2, 3, 4, 5]),
  w("cr", null),
  ...item("G", "group", "Commission", null, "a0"),
  ...item("G2", "group", "Mirror cell", "G", "a0"),
  ...item("T1", "task", "Polish mirror", "G2", "a0", sched("2026-11-16", 3)),
  ...item("TG", "group", "Shelved", null, "a1", undefined, true),
  ...item("IN", "group", "Inside shelved", "TG", "a0"),
  w("pp:mira", MIRA),
  w("pp:dana", { n: "Dana Lee", i: "DL", c: "lime", o: "a1" }),
];

const STEPS: Write[] = [...DATES, w("ws:review", REVIEW), w("ws:qa", { n: "QA", c: "coral", o: "a16" }), w("wi:T1", "review")];

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  return log;
};

const ctxFrom = (root: readonly Write[], ...rest: Action[]): Ctx => ctxOf(logOf(act("a0", [], root), ...rest), "d1", TODAY);

const applied = (ctx: Ctx, b: Built): Ctx => {
  expect(ctx.log.add([b.action]).refused).toEqual([]);
  return ctxOf(ctx.log, ctx.dev, TODAY, ctx.devices);
};

const stored = (o: Partial<DefaultsValue>): DefaultsValue => ({ dur: 3, dated: true, who: null, group: null, step: null, ...o });

const refusedWith = (ctx: Ctx, intent: Intent, message: string): void => {
  let caught: unknown = null;
  try {
    buildAction(ctx, intent);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Refused)) throw new Error(`expected a Refused, caught ${String(caught)}`);
  expect(caught.message).toBe(message);
};

const thrownWith = (ctx: Ctx, intent: Intent, message: string): void => {
  let caught: unknown = null;
  try {
    buildAction(ctx, intent);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Error) || caught instanceof Refused) throw new Error(`expected an Error, caught ${String(caught)}`);
  expect(caught.message).toBe(message);
};

describe("defaults intents", () => {
  it("writes the whole value with the duration replaced, labelled", () => {
    const b = buildAction(ctxFrom(DATES), { t: "defaults", field: "dur", value: 5 });
    expect(b.action.w).toEqual([w("pd", stored({ dur: 5 }))]);
    expect(b.action.lbl).toBe("New tasks now last 5 working days");
    expect(b.toast).toBe("New tasks now last 5 working days.");
    expect(buildAction(ctxFrom(DATES), { t: "defaults", field: "dur", value: 1 }).action.lbl).toBe("New tasks now last 1 working day");
  });

  it("writes dated and undated", () => {
    const ctx = ctxFrom(DATES);
    const undated = buildAction(ctx, { t: "defaults", field: "dated", value: false });
    expect(undated.action.w).toEqual([w("pd", stored({ dated: false }))]);
    expect(undated.action.lbl).toBe("New items are now undated");
    const back = applied(ctx, undated);
    const dated = buildAction(back, { t: "defaults", field: "dated", value: true });
    expect(dated.action.w).toEqual([w("pd", stored({ dated: true }))]);
    expect(dated.action.lbl).toBe("New items are now dated");
  });

  it("writes an assignee and unassigned, keeping the other fields", () => {
    const ctx = ctxFrom(DATES, act("a1", ["a0"], [w("pd", stored({ dur: 7, dated: false }))]));
    const who = buildAction(ctx, { t: "defaults", field: "who", value: "mira" });
    expect(who.action.w).toEqual([w("pd", stored({ dur: 7, dated: false, who: "mira" }))]);
    expect(who.action.lbl).toBe("New items are now assigned to “Mira Okafor”");
    const none = buildAction(applied(ctx, who), { t: "defaults", field: "who", value: null });
    expect(none.action.w).toEqual([w("pd", stored({ dur: 7, dated: false, who: null }))]);
    expect(none.action.lbl).toBe("New items are now unassigned");
  });

  it("writes a group and the plan root", () => {
    const ctx = ctxFrom(DATES);
    const into = buildAction(ctx, { t: "defaults", field: "group", value: "G" });
    expect(into.action.w).toEqual([w("pd", stored({ group: "G" }))]);
    expect(into.action.lbl).toBe("Board + now adds to “Commission”");
    const root = buildAction(applied(ctx, into), { t: "defaults", field: "group", value: null });
    expect(root.action.w).toEqual([w("pd", stored({ group: null }))]);
    expect(root.action.lbl).toBe("Board + now adds to the plan root");
  });

  it("writes a step and the first open step by steps", () => {
    const ctx = ctxFrom(STEPS);
    const to = buildAction(ctx, { t: "defaults", field: "step", value: "review" });
    expect(to.action.w).toEqual([w("pd", stored({ step: "review" }))]);
    expect(to.action.lbl).toBe("New undated items now go to “Review”");
    const first = buildAction(applied(ctx, to), { t: "defaults", field: "step", value: null });
    expect(first.action.w).toEqual([w("pd", stored({ step: null }))]);
    expect(first.action.lbl).toBe("New undated items now go to the first open step");
    expect(buildAction(ctx, { t: "defaults", field: "step", value: "next" }).action.lbl).toBe("New undated items now go to “Next”");
  });

  it("refuses an unchanged field, also against the built-in value", () => {
    const ctx = ctxFrom(DATES);
    refusedWith(ctx, { t: "defaults", field: "dur", value: 3 }, refusal.nothing);
    refusedWith(ctx, { t: "defaults", field: "dated", value: true }, refusal.nothing);
    refusedWith(ctx, { t: "defaults", field: "who", value: null }, refusal.nothing);
    const set = ctxFrom(DATES, act("a1", ["a0"], [w("pd", stored({ who: "mira", group: "G" }))]));
    refusedWith(set, { t: "defaults", field: "who", value: "mira" }, refusal.nothing);
    refusedWith(set, { t: "defaults", field: "group", value: "G" }, refusal.nothing);
  });

  it("refuses a duration outside 1 to 3650 whole days", () => {
    const ctx = ctxFrom(DATES);
    expect(refusal.defaultDur).toBe("A new task lasts 1 to 3650 working days.");
    [0, -1, 3651, 2.5, Number.NaN].forEach((value) => refusedWith(ctx, { t: "defaults", field: "dur", value }, refusal.defaultDur));
    expect(buildAction(ctx, { t: "defaults", field: "dur", value: 3650 }).action.w).toEqual([w("pd", stored({ dur: 3650 }))]);
  });

  it("refuses a step by dates, even an open one", () => {
    expect(refusal.defaultStepByDates).toBe("This plan follows dates, so new undated items go to “Later”. Use steps first.");
    refusedWith(ctxFrom(DATES), { t: "defaults", field: "step", value: "next" }, refusal.defaultStepByDates);
  });

  it("refuses clearing a step kept from steps once the plan follows dates", () => {
    refusedWith(ctxFrom([...DATES, w("pd", stored({ step: "next" }))]), { t: "defaults", field: "step", value: null }, refusal.defaultStepByDates);
    refusedWith(ctxFrom(DATES), { t: "defaults", field: "step", value: null }, refusal.defaultStepByDates);
  });

  it("throws for a person who is not live, an item that is trashed, inside the Trash, absent or not a group, and a dead or completing step", () => {
    const ctx = ctxFrom(STEPS, act("a1", ["a0"], [w("pp:dana", null), w("ws:qa", null)]));
    thrownWith(ctx, { t: "defaults", field: "who", value: "dana" }, "Person dana is not in this plan");
    thrownWith(ctx, { t: "defaults", field: "who", value: "nobody" }, "Person nobody is not in this plan");
    thrownWith(ctx, { t: "defaults", field: "group", value: "TG" }, "Group TG is in the Trash");
    thrownWith(ctx, { t: "defaults", field: "group", value: "IN" }, "Group IN is in the Trash");
    thrownWith(ctx, { t: "defaults", field: "group", value: "T1" }, "Item T1 is not a group");
    thrownWith(ctx, { t: "defaults", field: "group", value: "ZZ" }, "Item ZZ is not in this plan");
    thrownWith(ctx, { t: "defaults", field: "step", value: "qa" }, "Step qa is not in this plan");
    thrownWith(ctx, { t: "defaults", field: "step", value: "done" }, "Step done completes items");
  });

  it("undoing the first write leaves the plan without defaults", () => {
    const ctx = ctxFrom(DATES);
    const b = buildAction(ctx, { t: "defaults", field: "dur", value: 5 });
    const after = applied(ctx, b);
    expect(after.view.plan.defaults).toEqual(stored({ dur: 5 }));
    expect(after.view.defaults.dur).toBe(5);
    const undo = buildUndo(after, b.action.id);
    expect(undo.action.w).toEqual([w(`a:${b.action.id}`, false, "undo")]);
    const back = applied(after, undo);
    expect(back.view.plan.defaults).toBeNull();
    expect(back.view.defaults.dur).toBe(3);
  });
});
