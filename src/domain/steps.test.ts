import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LogState, replay } from "../log/state";
import type { Action, Write } from "../log/types";
import { choices, heldItems } from "../plan/choices";
import { applyWrites, childrenOf, projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { bigLog } from "../test/fixtures/bigLog";
import { FIXTURE_DEVICES } from "../test/planCtx";
import { simulate } from "../test/sim";
import { derive, goneSet, type Derived } from "./derive";
import type { Item, ItemId, PlanState } from "./model";
import { MAX_STEP_LIMIT, MAX_STEP_NAME, projectBoard, STEP_COLOURS, stepModeOf, stepsOf, storedStepOf, VIRTUAL_STEPS, type BoardProjection } from "./steps";

const TODAY = "2026-11-09";

const w = (u: string, v: unknown): Write => ({ u, v, c: "own" });

const task = (id: string, o: { start?: string | null; status?: "todo" | "doing" | "done"; horizon?: "now" | "next" | "later"; parent?: string | null; order: string }): Write[] => [
  w(`e:${id}`, { k: "task", t: false }),
  w(`n:${id}`, `Task ${id}`),
  w(`s:${id}`, [o.start ?? null, 3, o.status ?? "todo", o.status === "done" ? 100 : 0, o.horizon ?? "later"]),
  w(`p:${id}`, [o.parent ?? null, o.order]),
];

const group = (id: string, order: string): Write[] => [w(`e:${id}`, { k: "group", t: false }), w(`n:${id}`, `Group ${id}`), w(`p:${id}`, [null, order])];

const HEAD: Write[] = [w("pn", "MESA 1.0"), w("cw", [1, 2, 3, 4, 5]), w("cr", null)];

const BASE: Write[] = [
  ...HEAD,
  ...task("A", { start: "2026-11-10", horizon: "later", order: "a0" }),
  ...task("B", { start: null, horizon: "next", order: "a1" }),
  ...group("G", "a2"),
  ...task("C", { start: "2027-06-01", horizon: "now", parent: "G", order: "a0" }),
  ...task("D", { start: "2026-11-02", status: "done", horizon: "now", parent: "G", order: "a1" }),
];

const planOf = (...writes: Write[][]): PlanState => {
  const log = new LogState(planRules);
  const actions: Action[] = writes.map((ws, i) => act(`x${i}`, i === 0 ? [] : [`x${i - 1}`], ws));
  expect(log.add(actions).refused).toEqual([]);
  return projectPlan("P", log);
};

const board = (plan: PlanState): BoardProjection => projectBoard(plan, derive(plan, new Set(), TODAY));

const shape = (b: BoardProjection): [string | null, ItemId[]][] => b.columns.map((c) => [c.step === null ? null : c.step.id, c.items.map((i) => i.id)]);

const outline = (plan: PlanState): Item[] => {
  const gone = goneSet(plan);
  const walk = (parent: ItemId | null): Item[] => childrenOf(plan, parent).flatMap((i) => (gone.has(i.id) ? [] : i.kind === "group" ? walk(i.id) : [i]));
  return walk(null);
};

const byDates = (plan: PlanState, derived: Derived): void => {
  const b = projectBoard(plan, derived);
  expect(b.mode).toBe("dates");
  expect(b.steps.map((s) => s.id)).toEqual(["now", "next", "later", "done"]);
  expect(b.completing?.id).toBe("done");
  expect(b.hiddenDone).toBe(0);
  expect(b.problems).toEqual([]);
  const items = outline(plan);
  const expected = new Map(
    items.map((i): [ItemId, string] => {
      const h = derived.horizon.get(i.id);
      if (h !== undefined) return [i.id, h];
      expect(derived.status.get(i.id)).toBe("done");
      return [i.id, "done"];
    }),
  );
  expect(b.columnOf).toEqual(expected);
  expect(shape(b)).toEqual(["now", "next", "later", "done"].map((s) => [s, items.filter((i) => expected.get(i.id) === s).map((i) => i.id)]));
};

describe("steps", () => {
  it("four virtual steps in order Now, Next, Later, Done", () => {
    expect(STEP_COLOURS).toEqual(["cyan", "violet", "magenta", "lime", "amber", "coral", "sky", "slate"]);
    expect(MAX_STEP_NAME).toBe(32);
    expect(MAX_STEP_LIMIT).toBe(99);
    expect(VIRTUAL_STEPS).toEqual(
      new Map([
        ["now", { n: "Now", c: "cyan", o: "a0" }],
        ["next", { n: "Next", c: "violet", o: "a1" }],
        ["later", { n: "Later", c: "slate", o: "a2" }],
        ["done", { n: "Done", c: "lime", o: "a3", d: true }],
      ]),
    );
    const plan = planOf(BASE);
    expect(stepModeOf(plan)).toBe("dates");
    expect(stepsOf(plan)).toEqual([
      { id: "now", name: "Now", colour: "cyan", order: "a0", completes: false, limit: null },
      { id: "next", name: "Next", colour: "violet", order: "a1", completes: false, limit: null },
      { id: "later", name: "Later", colour: "slate", order: "a2", completes: false, limit: null },
      { id: "done", name: "Done", colour: "lime", order: "a3", completes: true, limit: null },
    ]);
  });

  it("a stored step overrides, null removes", () => {
    const plan = planOf(BASE, [w("ws:next", { n: "Review", c: "amber", o: "a5", l: 4 }), w("ws:later", null), w("ws:qa", { n: "QA", c: "sky", o: "a0V" }), w("ws:zz", { n: "Ship", c: "coral", o: "a5" })]);
    expect(stepModeOf(plan)).toBe("steps");
    expect(stepsOf(plan)).toEqual([
      { id: "now", name: "Now", colour: "cyan", order: "a0", completes: false, limit: null },
      { id: "qa", name: "QA", colour: "sky", order: "a0V", completes: false, limit: null },
      { id: "done", name: "Done", colour: "lime", order: "a3", completes: true, limit: null },
      { id: "next", name: "Review", colour: "amber", order: "a5", completes: false, limit: 4 },
      { id: "zz", name: "Ship", colour: "coral", order: "a5", completes: false, limit: null },
    ]);
    expect(stepModeOf(planOf(BASE, [w("wi:A", "now")]))).toBe("steps");
  });

  it("a plan without units projects as derived.horizon", () => {
    byDates(planOf(BASE), derive(planOf(BASE), new Set(), TODAY));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const log = replay(bigLog(200, seed).actions, planRules);
        const plan = projectPlan("P", log);
        const cs = choices(log, plan, FIXTURE_DEVICES);
        expect(outline(plan).length).toBeGreaterThan(0);
        byDates(plan, derive(plan, heldItems(cs, plan), TODAY));
      }),
      { numRuns: 8, seed: 20261122 },
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const built = simulate(seed).built;
        expect(built.filter((b) => outline(b.view.plan).length > 0).length).toBeGreaterThan(10);
        built.forEach((b) => byDates(b.view.plan, b.view.derived));
      }),
      { numRuns: 3, seed: 20261122 },
    );
  });

  it("by steps an item takes wi, else s.horizon; a date change moves no card", () => {
    const plan = planOf(BASE, [w("wi:B", "now")]);
    const derived = derive(plan, new Set(), TODAY);
    expect(derived.horizon.get("A")).toBe("now");
    expect(derived.horizon.get("C")).toBe("later");
    const item = (id: ItemId): Item => {
      const it = plan.items.get(id);
      if (it === undefined) throw new Error(`no item ${id}`);
      return it;
    };
    expect(storedStepOf(plan, item("A"))).toBe("later");
    expect(storedStepOf(plan, item("B"))).toBe("now");
    expect(() => storedStepOf(plan, item("G"))).toThrow("no schedule for item G");
    const b = projectBoard(plan, derived);
    expect(b.mode).toBe("steps");
    expect(shape(b)).toEqual([
      ["now", ["B", "C"]],
      ["next", []],
      ["later", ["A"]],
      ["done", ["D"]],
    ]);
    expect(b.columnOf).toEqual(new Map([["A", "later"], ["B", "now"], ["C", "now"], ["D", "done"]]));
    const moved = applyWrites(plan, [w("s:A", ["2028-01-03", 3, "todo", 0, "later"]), w("s:C", ["2026-11-09", 3, "todo", 0, "now"])]);
    expect(shape(board(moved))).toEqual(shape(b));
  });

  it("a done item goes to the completing step whatever its wi", () => {
    const plan = planOf(BASE, [w("wi:D", "now"), w("wi:A", "next")]);
    const b = board(plan);
    expect(b.completing?.id).toBe("done");
    expect(b.columnOf.get("D")).toBe("done");
    expect(shape(b)).toEqual([
      ["now", ["C"]],
      ["next", ["A", "B"]],
      ["later", []],
      ["done", ["D"]],
    ]);
  });

  it("without a completing step done items count in hiddenDone", () => {
    const plan = planOf(BASE, [...task("E", { status: "done", order: "a3" }), w("ws:done", null)]);
    const b = board(plan);
    expect(b.completing).toBeNull();
    expect(b.hiddenDone).toBe(2);
    expect(b.columnOf.has("D")).toBe(false);
    expect(b.columnOf.has("E")).toBe(false);
    expect(shape(b)).toEqual([
      ["now", ["C"]],
      ["next", ["B"]],
      ["later", ["A"]],
    ]);
  });

  it("a wi to a deleted step lands in No step, listed first", () => {
    const plan = planOf(BASE, [w("wi:A", "qa"), w("ws:next", null)]);
    const b = board(plan);
    expect(shape(b)).toEqual([
      [null, ["A", "B"]],
      ["now", ["C"]],
      ["later", []],
      ["done", ["D"]],
    ]);
    expect(b.columnOf.get("A")).toBeNull();
    expect(b.columnOf.get("B")).toBeNull();
    expect(shape(board(planOf(BASE, [w("ws:next", null)])))).toEqual([
      [null, ["B"]],
      ["now", ["C"]],
      ["later", ["A"]],
      ["done", ["D"]],
    ]);
    expect(shape(board(planOf(BASE, [w("wi:B", "later"), w("ws:next", null)])))[0]).toEqual(["now", ["C"]]);
  });

  it("two completing steps: the first completes, completesTwice names both", () => {
    const plan = planOf(BASE, [w("ws:ship", { n: "Ship", c: "coral", o: "a2V", d: true })]);
    const b = board(plan);
    expect(b.completing?.id).toBe("ship");
    expect(b.problems).toEqual([{ kind: "completesTwice", steps: ["ship", "done"] }]);
    expect(b.columnOf.get("D")).toBe("ship");
    expect(shape(b)).toEqual([
      ["now", ["C"]],
      ["next", ["B"]],
      ["later", ["A"]],
      ["ship", ["D"]],
      ["done", []],
    ]);
  });

  it("an open item whose step completes stays in that column and is named by openInCompleting", () => {
    const b = board(planOf(BASE, [w("wi:B", "done")]));
    expect(b.columnOf.get("B")).toBe("done");
    expect(shape(b)).toEqual([
      ["now", ["C"]],
      ["next", []],
      ["later", ["A"]],
      ["done", ["B", "D"]],
    ]);
    expect(b.problems).toEqual([{ kind: "openInCompleting", steps: ["done"], items: ["B"] }]);
    expect(board(planOf(BASE, [w("wi:B", "done"), w("ws:done", { n: "Done", c: "lime", o: "a3" })])).problems).toEqual([]);
  });

  it("sameName names both", () => {
    const plan = planOf(BASE, [w("ws:qa", { n: "NOW", c: "sky", o: "a4" }), w("ws:later", { n: "next", c: "slate", o: "a2" })]);
    expect(board(plan).problems).toEqual([
      { kind: "sameName", steps: ["now", "qa"] },
      { kind: "sameName", steps: ["next", "later"] },
    ]);
    expect(board(planOf(BASE, [w("ws:now", null), w("ws:qa", { n: "Now", c: "sky", o: "a4" })])).problems).toEqual([]);
  });

  it("leaves trashed items and groups out", () => {
    const plan = planOf(BASE, [w("wi:C", "next"), w("e:G", { k: "group", t: true })]);
    const b = board(plan);
    expect(shape(b)).toEqual([
      ["now", []],
      ["next", ["B"]],
      ["later", ["A"]],
      ["done", []],
    ]);
  });
});
