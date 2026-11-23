import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { defaultsOf, projectDefaults, type DefaultsProjection } from "../domain/defaults";
import { derive } from "../domain/derive";
import type { ItemId, PersonId, PlanState, StepId } from "../domain/model";
import { peopleOf, projectPeople } from "../domain/people";
import { projectBoard, stepModeOf, stepsOf, type BoardProjection } from "../domain/steps";
import { LogState } from "../log/state";
import type { Action, DeviceId } from "../log/types";
import { defaultNames, formerPeople } from "../plan/former";
import { planRules } from "../plan/rules";
import { decodeAs, key, parseKey } from "../plan/units";
import { CH_ZH } from "../test/fixtures/calendars";
import { ctxOf, FIXTURE_DEVICES } from "../test/planCtx";
import { simulate, SIM_TODAY, type SimOptions, type SimResult } from "../test/sim";
import { actionOf, lostWrites, viewOf } from "../test/simChecks";
import { buildAction, initialAction } from "./build";
import type { Intent } from "./intents";
import { newItemIntent } from "./newItem";
import { buildResolve } from "./resolve";

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
const PARAMS: fc.Parameters<[number]> = { numRuns: NUM_RUNS, seed: 20261124, endOnFailure: true };
const TIMEOUT = { timeout: 120_000 };
const SIM_OPTS: SimOptions = { steps: true, people: true, defaults: true };

const memo = new Map<number, SimResult>();

const run = (seed: number): SimResult => {
  const known = memo.get(seed);
  if (known !== undefined) return known;
  ids.reset(seed);
  const result = simulate(seed, SIM_OPTS);
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
        console.error(`simulate(${seed}, ${JSON.stringify(SIM_OPTS)}) failed`);
        throw e;
      }
    }),
    PARAMS,
  );

const defaultsOfLog = (log: LogState): DefaultsProjection => {
  const plan = viewOf(log).plan;
  return projectDefaults(plan, defaultNames(log, plan));
};

const boardOf = (log: LogState): BoardProjection => {
  const v = viewOf(log);
  return projectBoard(v.plan, derive(v.plan, v.held, SIM_TODAY));
};

const unfollowable = (plan: PlanState, d: DefaultsProjection): string[] => {
  const stored = defaultsOf(plan);
  const group = d.group === null ? undefined : plan.items.get(d.group);
  const step = d.step === null ? undefined : stepsOf(plan).find((x) => x.id === d.step);
  const problems: [boolean, string][] = [
    [JSON.stringify(d.stored) !== JSON.stringify(plan.defaults), `stored ${JSON.stringify(d.stored)} is not plan.defaults ${JSON.stringify(plan.defaults)}`],
    [d.dur !== stored.dur || d.dated !== stored.dated, `dur ${d.dur} dated ${d.dated} differ from the stored ${stored.dur} ${stored.dated}`],
    [d.who !== null && !peopleOf(plan).some((p) => p.id === d.who), `who ${d.who} is not a live person`],
    [d.group !== null && (group === undefined || group.kind !== "group" || group.trashed), `group ${d.group} is not a live group`],
    [d.step !== null && (stepModeOf(plan) !== "steps" || step === undefined || step.completes), `step ${d.step} is not a live open step by steps`],
    [d.gone.some((g) => stored[g.field] !== g.id), `gone ${JSON.stringify(d.gone)} names ids that are not stored`],
    [d.gone.some((g) => d[g.field] !== null), `gone ${JSON.stringify(d.gone)} is also followed`],
  ];
  return problems.filter(([bad]) => bad).map(([, what]) => what);
};

const createdOf = (a: Action): { id: ItemId; kind: string } | null => {
  const e = a.w.find((x) => parseKey(x.u).kind === "e");
  if (e === undefined) return null;
  return { id: parseKey(e.u).arg, kind: decodeAs("existence", e.u, e.v).k };
};

const DIGEST_SEEDS = [11, 222, 3333, 44444, 555555];
const DIGEST_OPTS: readonly SimOptions[] = [{ steps: false }, { steps: true }, { steps: true, people: true }];
const DIGESTS: Readonly<Record<string, string>> = {
  '11 {"steps":false}': "9d692d86",
  '11 {"steps":true}': "eb5405a3",
  '11 {"steps":true,"people":true}': "e8831287",
  '222 {"steps":false}': "3f37bacf",
  '222 {"steps":true}': "2a29199c",
  '222 {"steps":true,"people":true}': "2e8f8a36",
  '3333 {"steps":false}': "7aef2866",
  '3333 {"steps":true}': "b8188dee",
  '3333 {"steps":true,"people":true}': "9621b27b",
  '44444 {"steps":false}': "c8b3e3de",
  '44444 {"steps":true}': "f3704eb1",
  '44444 {"steps":true,"people":true}': "8c826154",
  '555555 {"steps":false}': "e831d6d6",
  '555555 {"steps":true}': "b99aac3c",
  '555555 {"steps":true,"people":true}': "502ebbdb",
};

const fnv = (text: string): string => {
  const h = [...text].reduce((acc, ch) => Math.imul(acc ^ ch.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
  return h.toString(16).padStart(8, "0");
};

const digestOf = (seed: number, opts: SimOptions): string => {
  ids.reset(seed);
  const sim = simulate(seed, opts);
  return fnv(JSON.stringify([sim.steps, sim.built.map((b) => b.action), sim.shuffled.order(), [...sim.lost], sim.stalePops]));
};

describe("simulated devices with plan defaults", () => {
  it("without the defaults option the simulated stream is what it was before the option existed", () => {
    const runs = DIGEST_SEEDS.flatMap((seed) => DIGEST_OPTS.map((opts) => ({ seed, opts })));
    expect(Object.fromEntries(runs.map(({ seed, opts }) => [`${seed} ${JSON.stringify(opts)}`, digestOf(seed, opts)]))).toEqual(DIGESTS);
    expect(Object.fromEntries(runs.map(({ seed, opts }) => [`${seed} ${JSON.stringify(opts)}`, digestOf(seed, { ...opts, defaults: false })]))).toEqual(DIGESTS);
  });

  it(
    "devices and the shuffled log agree on plan, choices, held and projectDefaults",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        const expected = viewOf(sim.shuffled);
        const defaults = defaultsOfLog(sim.shuffled);
        const all = new Set([sim.root.id, ...sim.built.map((b) => b.action.id)].filter((id) => !sim.lost.has(id)));
        expect(new Set(sim.shuffled.order())).toEqual(all);
        expect(sim.shuffled.pending).toEqual([]);
        sim.devices.forEach((d) => {
          expect(new Set(d.log.order())).toEqual(all);
          expect(d.log.pending).toEqual([]);
          const v = viewOf(d.log);
          expect(v.plan).toEqual(expected.plan);
          expect(v.choices).toEqual(expected.choices);
          expect(v.held).toEqual(expected.held);
          expect(defaultsOfLog(d.log)).toEqual(defaults);
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
    "projectDefaults never throws and follows only live targets, on any built view or final log",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        const views = [...sim.built.map((b) => ({ plan: b.view.plan, defaults: b.view.defaults })), ...[sim.shuffled, ...sim.devices.map((d) => d.log)].map((log) => ({ plan: viewOf(log).plan, defaults: defaultsOfLog(log) }))];
        expect(views.flatMap((v) => unfollowable(v.plan, v.defaults))).toEqual([]);
      });
    },
  );

  it(
    "every create writes the default assignee its view followed, in the same action",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        const bad = sim.built
          .filter((b) => b.kind === "create")
          .flatMap((b) => {
            const made = createdOf(b.action);
            if (made === null) throw new Error(`Create ${b.action.id} writes no e: unit`);
            const pa = b.action.w.filter((x) => x.u === key.pa(made.id)).map((x) => decodeAs("assignees", x.u, x.v));
            const want = made.kind === "group" || b.view.defaults.who === null ? [] : [[b.view.defaults.who]];
            return JSON.stringify(pa) === JSON.stringify(want) ? [] : [`${b.action.id} ${made.kind} writes ${JSON.stringify(pa)}, the view followed ${JSON.stringify(b.view.defaults.who)}`];
          });
        expect(bad).toEqual([]);
      });
    },
  );

  it(
    "the runs exercise default edits, pd clashes, column creates, gone defaults, refusals and default undos",
    TIMEOUT,
    () => {
      const seeds = fc.sample(arbSeed, { numRuns: NUM_RUNS, seed: PARAMS.seed });
      const sims = seeds.map(run);
      const count = (f: (s: SimResult) => boolean): number => sims.filter(f).length;
      const projections = (s: SimResult): DefaultsProjection[] => [...s.built.map((b) => b.view.defaults), defaultsOfLog(s.shuffled)];
      const goneWhy = (why: string) => count((s) => projections(s).some((d) => d.gone.some((g) => g.why === why)));
      const hits = {
        defaultEdits: count((s) => s.steps.some((x) => x.endsWith(" defaults"))),
        pdChoices: count((s) => [...s.built.map((b) => b.view.choices), viewOf(s.shuffled).choices].some((cs) => cs.some((c) => c.units.includes(key.pd)))),
        assignedCreates: count((s) => s.built.some((b) => b.kind === "create" && b.action.w.some((x) => parseKey(x.u).kind === "pa"))),
        columnCreates: count((s) => s.built.some((b) => b.kind === "create" && b.view.defaults.group !== null && b.action.w.some((x) => parseKey(x.u).kind === "p" && decodeAs("place", x.u, x.v).parent === b.view.defaults.group))),
        undatedCreates: count((s) => s.built.some((b) => b.kind === "create" && !b.view.defaults.dated)),
        goneRemoved: goneWhy("removed"),
        goneTrashed: goneWhy("trashed"),
        goneDeleted: goneWhy("deleted"),
        refusals: count((s) => s.steps.some((x) => x.includes(" defaults refused"))),
        defaultUndos: count((s) =>
          s.built
            .filter((b) => b.kind === "undo" || b.kind === "redo" || b.kind === "revert")
            .some((b) => b.action.w.some((x) => (s.shuffled.get(parseKey(x.u).arg)?.w ?? []).some((y) => y.u === key.pd))),
        ),
      };
      console.info(`defaults simulation coverage over ${NUM_RUNS} runs: ${JSON.stringify(hits)}`);
      Object.values(hits).forEach((n) => expect(n).toBeGreaterThanOrEqual(NUM_RUNS / 20));
    },
  );
});

const OPTS = { pushFromPredecessors: true, returnPushed: true };

interface Scenario {
  devices: readonly DeviceId[];
  actions: readonly Action[];
  base: LogState;
  race: readonly Action[];
}

type Setup = Intent | ((log: LogState) => Intent);

const ctxAt = (log: LogState, dev: DeviceId, now: number) => ctxOf(log, dev, SIM_TODAY, FIXTURE_DEVICES, { now });

const scenario = (n: number, setup: readonly Setup[], race: (log: LogState) => readonly Intent[]): Scenario => {
  ids.reset(n * 7919);
  let clock = 0;
  const devices = [...FIXTURE_DEVICES.keys()].slice(0, n);
  const log = new LogState(planRules);
  const root = initialAction({ dev: "d1", ses: "s-d1", now: 0, name: "MESA 1.0", calendar: CH_ZH });
  const actions: Action[] = [root];
  const apply = (l: LogState, dev: DeviceId, intent: Intent): Action => {
    const a = buildAction(ctxAt(l, dev, (clock += 60_000)), intent).action;
    const delta = l.add([a]);
    if (delta.refused.length > 0) throw new Error(`Refused ${a.id}`);
    actions.push(a);
    return a;
  };
  log.add([root]);
  apply(log, "d1", { t: "create", kind: "task", name: "Mirror", parent: null, after: null, start: "2026-11-20", dur: 2 });
  setup.forEach((intent) => apply(log, "d1", typeof intent === "function" ? intent(log) : intent));
  const intents = race(log);
  if (intents.length !== n) throw new Error(`Race has ${intents.length} intents for ${n} devices`);
  const raced = intents.map((intent, k) => apply(log.fork(), devices[k], intent));
  return { devices, actions, base: log, race: raced };
};

const createdBy = (a: Action): ItemId => {
  const made = createdOf(a);
  if (made === null) throw new Error(`Action ${a.id} creates nothing`);
  return made.id;
};

const groupNamed = (log: LogState, name: string): ItemId => {
  const g = [...viewOf(log).plan.items.values()].find((x) => x.kind === "group" && x.name === name);
  if (g === undefined) throw new Error(`No group ${name}`);
  return g.id;
};

const personNamed = (log: LogState, name: string): PersonId => {
  const p = peopleOf(viewOf(log).plan).find((x) => x.name === name);
  if (p === undefined) throw new Error(`No person ${name}`);
  return p.id;
};

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

const inOrder = (actions: readonly Action[]): LogState => deliver(actions, actions.map((_, k) => k));

const converged = (s: Scenario, check: (log: LogState) => void): void => {
  const indices = s.actions.map((_, k) => k);
  const orders = fc.tuple(...s.devices.map(() => fc.shuffledSubarray(indices, { minLength: indices.length, maxLength: indices.length })));
  fc.assert(
    fc.property(orders, (perDevice) => {
      const logs = perDevice.map((order) => deliver(s.actions, order));
      const first = viewOf(logs[0]);
      const defaults = defaultsOfLog(logs[0]);
      logs.forEach((log) => {
        const v = viewOf(log);
        expect(v.plan).toEqual(first.plan);
        expect(v.choices).toEqual(first.choices);
        expect(defaultsOfLog(log)).toEqual(defaults);
        expect(unfollowable(v.plan, defaultsOfLog(log))).toEqual([]);
        check(log);
      });
    }),
    { numRuns: 50, seed: 20261124 },
  );
};

const viewAt = (log: LogState) => ctxAt(log, "d1", 0).view;

const QA: Intent = { t: "step", op: "add", name: "QA", colour: "amber", after: "later" };
const COMMISSION: Intent = { t: "create", kind: "group", name: "Commission", parent: null, after: null, start: null };
const MIRA: Intent = { t: "person", op: "add", name: "Mira Okafor", initials: "MO", colour: "cyan", after: null };

describe("plan defaults scenarios", () => {
  it.each([2, 3])("a default group trashed while another device adds into it raises the existing delete choice, trashes the item with the group and brings it back on restore, %i devices", (n) => {
    let commission = "";
    let qa = "";
    const s = scenario(n, [QA, COMMISSION, (log) => ({ t: "defaults", field: "group", value: groupNamed(log, "Commission") })], (log) => {
      commission = groupNamed(log, "Commission");
      qa = stepNamed(log, "QA");
      const view = viewAt(log);
      const race: Intent[] = [
        { t: "trash", items: [commission] },
        newItemIntent(view, SIM_TODAY, "task", "Lens", { column: qa }),
        newItemIntent(view, SIM_TODAY, "task", "Filter", { column: "now" }),
      ];
      return race.slice(0, n);
    });
    const added = s.race.slice(1).map(createdBy);
    s.race.slice(1).forEach((a) => expect(a.w.find((x) => parseKey(x.u).kind === "p" && decodeAs("place", x.u, x.v).parent === commission)).toBeDefined());
    converged(s, (log) => {
      const v = viewOf(log);
      expect(v.choices.map((c) => ({ kind: c.kind, items: [...c.items].sort() }))).toEqual([{ kind: "delete", items: [commission, ...added].sort() }]);
      added.forEach((id) => {
        expect(v.plan.items.get(id)?.place.parent).toBe(commission);
        expect(v.plan.items.get(id)?.trashed).toBe(true);
      });
      const d = defaultsOfLog(log);
      expect(d.group).toBe(null);
      expect(d.gone).toEqual([{ field: "group", id: commission, name: "Commission", why: "trashed" }]);
      expect(newItemIntent(viewAt(log), SIM_TODAY, "task", "Lens 2", { column: qa }).parent).toBe(null);
    });
    const merged = inOrder(s.actions);
    const restored = buildAction(ctxAt(merged, "d1", 10 ** 9), { t: "restore", items: [commission] }).action;
    converged({ ...s, actions: [...s.actions, restored] }, (log) => {
      const v = viewOf(log);
      expect(v.choices).toEqual([]);
      added.forEach((id) => expect(v.plan.items.get(id)?.trashed).toBe(false));
      const d = defaultsOfLog(log);
      expect(d.group).toBe(commission);
      expect(d.gone).toEqual([]);
      expect(newItemIntent(viewAt(log), SIM_TODAY, "task", "Lens 2", { column: qa }).parent).toBe(commission);
    });
  });

  it.each([2, 3])("a default person removed racing a create leaves a former assignee, %i devices", (n) => {
    let mira = "";
    const s = scenario(n, [MIRA, (log) => ({ t: "defaults", field: "who", value: personNamed(log, "Mira Okafor") })], (log) => {
      mira = personNamed(log, "Mira Okafor");
      const view = viewAt(log);
      const race: Intent[] = [
        { t: "person", op: "remove", person: mira, to: null },
        newItemIntent(view, SIM_TODAY, "task", "Lens", { parent: null, after: null }),
        newItemIntent(view, SIM_TODAY, "milestone", "First light", { parent: null, after: null }),
      ];
      return race.slice(0, n);
    });
    const added = s.race.slice(1).map(createdBy);
    converged(s, (log) => {
      const v = viewOf(log);
      expect(v.choices).toEqual([]);
      expect(peopleOf(v.plan)).toEqual([]);
      const people = projectPeople(v.plan, formerPeople(log, v.plan));
      added.forEach((id) => {
        expect(v.plan.people.assignees.get(id)).toEqual([mira]);
        expect(people.assignees.get(id)).toEqual([{ kind: "former", id: mira, name: "Mira Okafor", initials: "MO", colour: "cyan" }]);
      });
      const d = defaultsOfLog(log);
      expect(d.who).toBe(null);
      expect(d.gone).toEqual([{ field: "who", id: mira, name: "Mira Okafor", why: "removed" }]);
      expect("who" in newItemIntent(viewAt(log), SIM_TODAY, "task", "Lens 2", { parent: null, after: null })).toBe(false);
    });
  });

  it.each([2, 3])("a default step deleted racing a create leaves the item in No step, %i devices", (n) => {
    let qa = "";
    const s = scenario(n, [QA, (log) => ({ t: "defaults", field: "step", value: stepNamed(log, "QA") })], (log) => {
      qa = stepNamed(log, "QA");
      const view = viewAt(log);
      const race: Intent[] = [
        { t: "step", op: "delete", step: qa, to: null },
        newItemIntent(view, SIM_TODAY, "task", "Lens", { parent: null, after: null }),
        newItemIntent(view, SIM_TODAY, "task", "Filter", { parent: null, after: null }),
      ];
      return race.slice(0, n);
    });
    const added = s.race.slice(1).map(createdBy);
    s.race.slice(1).forEach((a) => expect(a.w.some((x) => x.u === key.wi(createdBy(a)))).toBe(true));
    converged(s, (log) => {
      const v = viewOf(log);
      expect(v.choices).toEqual([]);
      const board = boardOf(log);
      added.forEach((id) => expect(board.columnOf.get(id)).toBe(null));
      expect(board.columns[0].step).toBe(null);
      const d = defaultsOfLog(log);
      expect(d.step).toBe(null);
      expect(d.gone).toEqual([{ field: "step", id: qa, name: "QA", why: "deleted" }]);
    });
  });

  it.each([2, 3])("two fields edited on two devices raise one pd choice, %i devices", (n) => {
    const s = scenario(n, [], () => {
      const race: Intent[] = [
        { t: "defaults", field: "dur", value: 5 },
        { t: "defaults", field: "dated", value: false },
        { t: "defaults", field: "dur", value: 8 },
      ];
      return race.slice(0, n);
    });
    converged(s, (log) => {
      const cs = viewOf(log).choices;
      expect(cs.length).toBe(1);
      expect(cs[0].kind).toBe("items");
      expect(cs[0].units).toEqual([key.pd]);
      expect(cs[0].items).toEqual([]);
      expect(cs[0].sides.length).toBe(n);
    });
    const log = inOrder(s.actions);
    const ctx = ctxOf(log, "d1", SIM_TODAY);
    const choice = ctx.view.choices[0];
    const side = choice.sides[1];
    const picked = side.actions
      .flatMap((id) => actionOf(ctx.log, id).w)
      .filter((x) => x.u === key.pd)
      .map((x) => decodeAs("defaults", x.u, x.v));
    expect(picked.length).toBe(1);
    const resolved = buildResolve(ctx, choice, { side: side.key }, OPTS).action;
    converged({ ...s, actions: [...s.actions, resolved] }, (l) => {
      const v = viewOf(l);
      expect(v.choices).toEqual([]);
      expect(v.plan.defaults).toEqual(picked[0]);
      expect(defaultsOfLog(l).stored).toEqual(picked[0]);
    });
  });
});
