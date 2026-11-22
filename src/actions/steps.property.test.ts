import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { derive } from "../domain/derive";
import type { IsoDate } from "../domain/dates";
import type { ItemId, StepId } from "../domain/model";
import { projectBoard, stepModeOf, stepsOf, type BoardProjection } from "../domain/steps";
import { LogState } from "../log/state";
import type { Action, DeviceId } from "../log/types";
import { applyWrites } from "../plan/project";
import { planRules } from "../plan/rules";
import { decodeAs, parseKey } from "../plan/units";
import { CH_ZH } from "../test/fixtures/calendars";
import { ctxOf, FIXTURE_DEVICES } from "../test/planCtx";
import { simulate, SIM_TODAY, type SimResult } from "../test/sim";
import { actionOf, lostWrites, viewOf } from "../test/simChecks";
import { buildAction, initialAction } from "./build";
import type { Intent } from "./intents";
import { buildResolve } from "./resolve";
import { switchWrites } from "./steps";

const ids = vi.hoisted(() => {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let s = 1;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    reset(seed: number): void {
      s = seed >>> 0;
    },
    newId(): string {
      return Array.from({ length: 11 }, () => ALPHABET[next() % 64]).join("");
    },
  };
});

vi.mock("../log/ids", () => ({ newId: () => ids.newId() }));

const NUM_RUNS = 100;
const PARAMS: fc.Parameters<[number]> = { numRuns: NUM_RUNS, seed: 20261122, endOnFailure: true };
const TIMEOUT = { timeout: 120_000 };

const memo = new Map<number, SimResult>();

const run = (seed: number): SimResult => {
  const known = memo.get(seed);
  if (known !== undefined) return known;
  ids.reset(seed);
  const result = simulate(seed, { steps: true });
  memo.set(seed, result);
  return result;
};

const arbSeed = fc.integer({ min: 0, max: 2 ** 31 - 1 });

const property = (check: (seed: number, sim: SimResult) => void): void =>
  fc.assert(
    fc.property(arbSeed, (seed) => {
      try {
        check(seed, run(seed));
      } catch (e) {
        console.error(`simulate(${seed}, { steps: true }) failed`);
        throw e;
      }
    }),
    PARAMS,
  );

const boardOf = (log: LogState): BoardProjection => {
  const v = viewOf(log);
  return projectBoard(v.plan, derive(v.plan, v.held, SIM_TODAY));
};

const STEP_KINDS = new Set(["step", "toStep", "create"]);

describe("simulated devices with steps", () => {
  it(
    "devices and the shuffled log agree on plan, choices, held and projectBoard",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        const expected = viewOf(sim.shuffled);
        const board = boardOf(sim.shuffled);
        const ids = new Set([sim.root.id, ...sim.built.map((b) => b.action.id)].filter((id) => !sim.lost.has(id)));
        expect(new Set(sim.shuffled.order())).toEqual(ids);
        expect(sim.shuffled.pending).toEqual([]);
        sim.devices.forEach((d) => {
          expect(new Set(d.log.order())).toEqual(ids);
          expect(d.log.pending).toEqual([]);
          const v = viewOf(d.log);
          expect(v.plan).toEqual(expected.plan);
          expect(v.choices).toEqual(expected.choices);
          expect(v.held).toEqual(expected.held);
          expect(boardOf(d.log)).toEqual(board);
        });
      });
    },
  );

  it(
    "no owner write is lost",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        expect(lostWrites(sim.shuffled)).toEqual([]);
      });
    },
  );

  it(
    "undo, redo, revert write only a: units",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        const bad = sim.built
          .filter((b) => b.kind === "undo" || b.kind === "redo" || b.kind === "revert")
          .flatMap((b) => b.action.w.filter((x) => parseKey(x.u).kind !== "a").map((x) => `${b.kind} ${b.action.id} writes ${x.u}`));
        expect(bad).toEqual([]);
      });
    },
  );

  it(
    "a switch moves no card on its own device",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        const base = ctxOf(sim.shuffled, "d1", SIM_TODAY);
        const moved = sim.built
          .filter((b) => STEP_KINDS.has(b.kind) && stepModeOf(b.view.plan) === "dates")
          .flatMap((b) => {
            const sw = switchWrites({ ...base, view: b.view });
            if (sw.length === 0) return [];
            const plan = applyWrites(b.view.plan, sw);
            const before = projectBoard(b.view.plan, b.view.derived).columnOf;
            const after = projectBoard(plan, derive(plan, b.view.held, SIM_TODAY)).columnOf;
            expect(stepModeOf(plan)).toBe("steps");
            return [...before].filter(([id, at]) => after.get(id) !== at).map(([id, at]) => `${b.action.id}: ${id} ${at} -> ${after.get(id)}`);
          });
        expect(moved).toEqual([]);
      });
    },
  );

  it(
    "projectBoard never throws on any built view",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        sim.built.forEach((b) => {
          const board = projectBoard(b.view.plan, b.view.derived);
          expect(board.mode).toBe(stepModeOf(b.view.plan));
        });
      });
    },
  );

  it(
    "the runs exercise step edits, card moves, the switch, step clashes, refusals and No step",
    TIMEOUT,
    () => {
      const seeds = fc.sample(arbSeed, { numRuns: NUM_RUNS, seed: PARAMS.seed });
      const sims = seeds.map(run);
      const count = (f: (s: SimResult) => boolean): number => sims.filter(f).length;
      const hits = {
        stepEdits: count((s) => s.built.some((b) => b.kind === "step")),
        cardMoves: count((s) => s.built.some((b) => b.kind === "toStep")),
        switches: count((s) => s.built.some((b) => stepModeOf(b.view.plan) === "dates" && b.action.w.some((x) => parseKey(x.u).kind === "wi"))),
        stepChoices: count((s) => s.built.some((b) => b.view.choices.some((c) => c.units.some((u) => parseKey(u).kind === "ws" || parseKey(u).kind === "wi")))),
        nameRefusals: count((s) => s.steps.some((x) => x.includes("There is already a step named"))),
        stepUndos: count((s) => s.built.some((b) => b.kind === "undo" && stepModeOf(b.view.plan) === "steps")),
        noStep: count((s) => [...s.built.map((b) => projectBoard(b.view.plan, b.view.derived)), boardOf(s.shuffled)].some((board) => board.columns.some((c) => c.step === null))),
      };
      console.info(`steps simulation coverage over ${NUM_RUNS} runs: ${JSON.stringify(hits)}`);
      Object.values(hits).forEach((n) => expect(n).toBeGreaterThanOrEqual(NUM_RUNS / 20));
    },
  );
});

const OPTS = { pushFromPredecessors: true, returnPushed: true };

interface Scenario {
  devices: readonly DeviceId[];
  actions: readonly Action[];
  base: LogState;
  ids: ReadonlyMap<string, ItemId>;
}

type Setup = Intent | ((items: ReadonlyMap<string, ItemId>, log: LogState) => Intent);

const scenario = (
  n: number,
  setup: readonly Setup[],
  race: (items: ReadonlyMap<string, ItemId>, log: LogState) => readonly Intent[],
  todays: readonly IsoDate[] = [],
): Scenario => {
  ids.reset(n * 7919);
  let clock = 0;
  const devices = [...FIXTURE_DEVICES.keys()].slice(0, n);
  const todayOf = (dev: DeviceId): IsoDate => todays[devices.indexOf(dev)] ?? SIM_TODAY;
  const ctx = (log: LogState, dev: DeviceId) => ctxOf(log, dev, todayOf(dev), FIXTURE_DEVICES, { now: (clock += 60_000) });
  const log = new LogState(planRules);
  const root = initialAction({ dev: "d1", ses: "s-d1", now: 0, name: "MESA 1.0", calendar: CH_ZH });
  const actions: Action[] = [root];
  const apply = (l: LogState, dev: DeviceId, intent: Intent): Action => {
    const a = buildAction(ctx(l, dev), intent).action;
    const delta = l.add([a]);
    if (delta.refused.length > 0) throw new Error(`Refused ${a.id}`);
    actions.push(a);
    return a;
  };
  log.add([root]);
  const items = new Map<string, ItemId>();
  const created = (name: string, start: string): void => {
    const a = apply(log, "d1", { t: "create", kind: "task", name, parent: null, after: null, start, dur: 2 });
    const e = a.w.find((x) => parseKey(x.u).kind === "e");
    if (e === undefined) throw new Error(`Create of ${name} writes no e: unit`);
    items.set(name, parseKey(e.u).arg);
  };
  created("Mirror", "2026-11-20");
  created("Dome", "2026-12-21");
  setup.forEach((intent) => apply(log, "d1", typeof intent === "function" ? intent(items, log) : intent));
  const intents = race(items, log);
  if (intents.length !== n) throw new Error(`Race has ${intents.length} intents for ${n} devices`);
  intents.forEach((intent, k) => apply(log.fork(), devices[k], intent));
  return { devices, actions, base: log, ids: items };
};

const named = (items: ReadonlyMap<string, ItemId>, name: string): ItemId => {
  const id = items.get(name);
  if (id === undefined) throw new Error(`No item ${name}`);
  return id;
};

const itemOf = (s: Scenario, name: string): ItemId => named(s.ids, name);

const stepNamed = (log: LogState, name: string): StepId => {
  const s = stepsOf(viewOf(log).plan).find((x) => x.name === name);
  if (s === undefined) throw new Error(`No step ${name}`);
  return s.id;
};

const deliver = (actions: readonly Action[], order: readonly number[]): LogState => {
  const log = new LogState(planRules);
  order.forEach((k) => {
    const delta = log.add([actions[k]]);
    if (delta.refused.length > 0) throw new Error(`Refused ${actions[k].id}`);
  });
  expect(log.pending).toEqual([]);
  return log;
};

const converged = (s: Scenario, check: (log: LogState) => void): void => {
  const indices = s.actions.map((_, k) => k);
  const orders = fc.tuple(...s.devices.map(() => fc.shuffledSubarray(indices, { minLength: indices.length, maxLength: indices.length })));
  fc.assert(
    fc.property(orders, (perDevice) => {
      const logs = perDevice.map((order) => deliver(s.actions, order));
      const first = viewOf(logs[0]);
      const board = boardOf(logs[0]);
      logs.forEach((log) => {
        const v = viewOf(log);
        expect(v.plan).toEqual(first.plan);
        expect(v.choices).toEqual(first.choices);
        expect(boardOf(log)).toEqual(board);
        check(log);
      });
    }),
    { numRuns: 50, seed: 20261122 },
  );
};

const QA: Intent = { t: "step", op: "add", name: "QA", colour: "amber", after: "later" };

describe("step scenarios", () => {
  it.each([2, 3])("the switch racing a date edit, %i devices", (n) => {
    const s = scenario(n, [], (items) => {
      const race: Intent[] = [QA, { t: "schedule", item: named(items, "Mirror"), set: { start: "2027-03-01" } }, { t: "planName", name: "MESA 1.1" }];
      return race.slice(0, n);
    });
    const mirror = itemOf(s, "Mirror");
    expect(stepModeOf(viewOf(s.base).plan)).toBe("dates");
    converged(s, (log) => {
      const v = viewOf(log);
      expect(v.choices).toEqual([]);
      expect(stepModeOf(v.plan)).toBe("steps");
      expect(v.plan.items.get(mirror)?.schedule?.start).toBe("2027-03-01");
      expect(derive(v.plan, v.held, SIM_TODAY).horizon.get(mirror)).toBe("later");
      expect(boardOf(log).columnOf.get(mirror)).toBe("now");
    });
  });

  it.each([2, 3])("delete racing a move, %i devices", (n) => {
    const s = scenario(n, [QA], (items, log) => {
      const qa = stepNamed(log, "QA");
      const race: Intent[] = [
        { t: "toStep", items: [named(items, "Mirror")], step: qa },
        { t: "step", op: "delete", step: qa, to: null },
        { t: "planName", name: "MESA 1.1" },
      ];
      return race.slice(0, n);
    });
    const mirror = itemOf(s, "Mirror");
    converged(s, (log) => {
      const board = boardOf(log);
      expect(viewOf(log).choices).toEqual([]);
      expect(board.columnOf.get(mirror)).toBe(null);
      expect(board.columns[0].step).toBe(null);
      expect(board.columns[0].items.map((i) => i.id)).toEqual([mirror]);
      expect(board.steps.map((x) => x.name)).toEqual(["Now", "Next", "Later", "Done"]);
    });
  });

  it.each([2, 3])("two devices mark different steps completing, %i devices", (n) => {
    const toQa = (items: ReadonlyMap<string, ItemId>, log: LogState): Intent => ({ t: "toStep", items: [named(items, "Mirror"), named(items, "Dome")], step: stepNamed(log, "QA") });
    const s = scenario(n, [QA, toQa], () => {
      const race: Intent[] = [
        { t: "step", op: "completes", step: "later", completes: true },
        { t: "step", op: "completes", step: "next", completes: true },
        { t: "step", op: "completes", step: "now", completes: true },
      ];
      return race.slice(0, n);
    });
    const marked = ["now", "next", "later"].slice(3 - n);
    converged(s, (log) => {
      const board = boardOf(log);
      expect(board.completing?.id).toBe(marked[0]);
      expect(board.problems).toEqual([{ kind: "completesTwice", steps: marked }]);
      expect(board.steps.filter((x) => x.completes).map((x) => x.id)).toEqual(marked);
      expect(board.columns.filter((c) => c.step?.completes === true).length).toBe(n);
    });
  });

  it("two devices switching on the same day raise no choice", () => {
    const s = scenario(2, [], () => [QA, { t: "step", op: "rename", step: "later", name: "Someday" }], ["2026-11-06", "2026-11-06"]);
    converged(s, (log) => {
      expect(viewOf(log).choices).toEqual([]);
      expect(stepModeOf(viewOf(log).plan)).toBe("steps");
    });
  });

  it("two devices switching either side of midnight raise one choice per item whose horizon differs", () => {
    const s = scenario(2, [], () => [QA, { t: "step", op: "rename", step: "later", name: "Someday" }], ["2026-11-06", "2026-11-05"]);
    const mirror = itemOf(s, "Mirror");
    const dome = itemOf(s, "Dome");
    converged(s, (log) => {
      const cs = viewOf(log).choices;
      expect(cs.map((c) => c.units)).toEqual([[`wi:${mirror}`]]);
      expect(cs[0].items).toEqual([mirror]);
      expect(viewOf(log).plan.workflow.items.get(dome)).toBe("next");
    });
    const log = deliver(s.actions, s.actions.map((_, k) => k));
    const ctx = ctxOf(log, "d1", SIM_TODAY);
    const choice = ctx.view.choices[0];
    const resolved = buildResolve(ctx, choice, { side: choice.sides[0].key }, OPTS).action;
    converged({ ...s, actions: [...s.actions, resolved] }, (l) => {
      expect(viewOf(l).choices).toEqual([]);
      expect(boardOf(l).columnOf.get(mirror)).not.toBeNull();
    });
  });

  it.each([2, 3])("renames of one step raise one choice, %i devices", (n) => {
    const names = ["Someday", "Backlog", "Parked"].slice(0, n);
    const s = scenario(n, [QA], () => names.map((name): Intent => ({ t: "step", op: "rename", step: "later", name })));
    converged(s, (log) => {
      const cs = viewOf(log).choices;
      expect(cs.length).toBe(1);
      expect(cs[0].units).toEqual(["ws:later"]);
      expect(cs[0].items).toEqual([]);
      expect(cs[0].sides.length).toBe(n);
    });
    const log = deliver(s.actions, s.actions.map((_, k) => k));
    const ctx = ctxOf(log, "d1", SIM_TODAY);
    const choice = ctx.view.choices[0];
    const side = choice.sides[n - 1];
    const picked = side.actions
      .flatMap((id) => actionOf(ctx.log, id).w)
      .filter((x) => x.u === "ws:later")
      .map((x) => decodeAs("step", x.u, x.v)?.n);
    expect(picked.length).toBe(1);
    const resolved = buildResolve(ctx, choice, { side: side.key }, OPTS).action;
    const all = [...s.actions, resolved];
    converged({ ...s, actions: all }, (l) => {
      expect(viewOf(l).choices).toEqual([]);
      const later = stepsOf(viewOf(l).plan).find((x) => x.id === "later");
      expect(later?.name).toBe(picked[0]);
    });
  });
});
