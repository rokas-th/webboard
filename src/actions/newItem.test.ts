import { describe, expect, it } from "vitest";
import type { DefaultsValue } from "../domain/model";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf } from "../test/planCtx";
import { buildAction } from "./build";
import type { Ctx } from "./intents";
import { newItemIntent } from "./newItem";

const TODAY = "2026-11-13";
const NEXT = "2026-11-16";

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const sched = (start: string | null, dur: number): unknown[] => [start, dur, "todo", 0, "later"];

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
  ...item("G", "group", "Commission", null, "a0"),
  ...item("T1", "task", "Polish mirror", "G", "a0", sched("2026-11-16", 3)),
  ...item("TG", "group", "Shelved", null, "a1", undefined, true),
  w("pp:mira", { n: "Mira Okafor", i: "MO", c: "cyan", o: "a0" }),
];

const STEPS: Write[] = [...DATES, w("ws:review", { n: "Review", c: "amber", o: "a15" }), w("wi:T1", "review")];

const ctxFrom = (root: readonly Write[], ...rest: Action[]): Ctx => {
  const log = new LogState(planRules);
  expect(log.add([act("a0", [], root), ...rest]).refused).toEqual([]);
  return ctxOf(log, "d1", TODAY);
};

const pd = (o: Partial<DefaultsValue>): Action => act("a1", ["a0"], [w("pd", { dur: 3, dated: true, who: null, group: null, step: null, ...o })]);

const TOP = { parent: null, after: null };

describe("newItemIntent", () => {
  it("without pd every path writes what 5d95e96 wrote", () => {
    const ctx = ctxFrom(STEPS);
    const view = ctx.view;
    expect(newItemIntent(view, TODAY, "task", "New task", TOP)).toEqual({ t: "create", kind: "task", name: "New task", parent: null, after: null, start: NEXT, dur: 3 });
    expect(newItemIntent(view, TODAY, "milestone", "New milestone", { parent: "G", after: "T1" })).toEqual({ t: "create", kind: "milestone", name: "New milestone", parent: "G", after: "T1", start: NEXT });
    expect(newItemIntent(view, TODAY, "group", "New group", { parent: "G", after: null })).toEqual({ t: "create", kind: "group", name: "New group", parent: "G", after: null, start: null });
    expect(newItemIntent(view, TODAY, "task", "Polish", { column: "review" })).toEqual({ t: "create", kind: "task", name: "Polish", parent: null, after: null, start: null, step: "review" });
  });

  it("makes undated tasks and milestones when the plan's new items are undated, groups as before", () => {
    const view = ctxFrom(DATES, pd({ dated: false })).view;
    expect(newItemIntent(view, TODAY, "task", "New task", TOP)).toEqual({ t: "create", kind: "task", name: "New task", parent: null, after: null, start: null, dur: 3 });
    expect(newItemIntent(view, TODAY, "milestone", "New milestone", TOP)).toEqual({ t: "create", kind: "milestone", name: "New milestone", parent: null, after: null, start: null });
    expect(newItemIntent(view, TODAY, "group", "New group", TOP)).toEqual({ t: "create", kind: "group", name: "New group", parent: null, after: null, start: null });
  });

  it("gives a new task the plan's duration", () => {
    const view = ctxFrom(DATES, pd({ dur: 5 })).view;
    expect(newItemIntent(view, TODAY, "task", "New task", TOP)).toEqual({ t: "create", kind: "task", name: "New task", parent: null, after: null, start: NEXT, dur: 5 });
  });

  it("assigns tasks and milestones to the default person, never a group, and omits a removed one", () => {
    const view = ctxFrom(DATES, pd({ who: "mira" })).view;
    expect(newItemIntent(view, TODAY, "task", "New task", TOP)).toMatchObject({ who: "mira" });
    expect(newItemIntent(view, TODAY, "milestone", "New milestone", TOP)).toMatchObject({ who: "mira" });
    expect(newItemIntent(view, TODAY, "group", "New group", TOP)).not.toHaveProperty("who");
    const removed = ctxFrom(DATES, pd({ who: "mira" }), act("a2", ["a1"], [w("pp:mira", null)])).view;
    expect(removed.defaults.gone).toEqual([{ field: "who", id: "mira", name: "Mira Okafor", why: "removed" }]);
    expect(newItemIntent(removed, TODAY, "task", "New task", TOP)).toEqual({ t: "create", kind: "task", name: "New task", parent: null, after: null, start: NEXT, dur: 3 });
  });

  it("puts a column's new task into the default group, and at the root when that group is trashed", () => {
    const into = ctxFrom(STEPS, pd({ group: "G", dur: 5 })).view;
    expect(newItemIntent(into, TODAY, "task", "Polish", { column: "review" })).toEqual({ t: "create", kind: "task", name: "Polish", parent: "G", after: null, start: null, step: "review" });
    const trashed = ctxFrom(STEPS, pd({ group: "G" }), act("a2", ["a1"], [w("e:G", { k: "group", t: true })])).view;
    expect(newItemIntent(trashed, TODAY, "task", "Polish", { column: "review" })).toMatchObject({ parent: null });
  });

  it("a column ignores dated, and the build reads the duration from the plan", () => {
    const ctx = ctxFrom(STEPS, pd({ dur: 5, dated: true, who: "mira" }));
    const intent = newItemIntent(ctx.view, TODAY, "task", "Polish", { column: "review" });
    expect(intent).toEqual({ t: "create", kind: "task", name: "Polish", parent: null, after: null, start: null, step: "review", who: "mira" });
    const b = buildAction(ctx, intent);
    const id = b.newNotes[0];
    expect(b.action.w.find((x) => x.u === `s:${id}`)?.v).toEqual(sched(null, 5));
    expect(b.action.w.find((x) => x.u === `pa:${id}`)?.v).toEqual(["mira"]);
  });

  it("a selection ignores the default group", () => {
    const view = ctxFrom(DATES, pd({ group: "G" })).view;
    expect(newItemIntent(view, TODAY, "task", "New task", { parent: null, after: "TG" })).toMatchObject({ parent: null, after: "TG" });
    expect(newItemIntent(view, TODAY, "task", "New task", TOP)).toMatchObject({ parent: null, after: null });
  });

  it("throws for a column's milestone or group", () => {
    const view = ctxFrom(STEPS).view;
    expect(() => newItemIntent(view, TODAY, "milestone", "Gate", { column: "review" })).toThrow("Board + adds tasks only, not a milestone");
    expect(() => newItemIntent(view, TODAY, "group", "Phase", { column: "review" })).toThrow("Board + adds tasks only, not a group");
  });
});
