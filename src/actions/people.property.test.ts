import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { ItemId, PersonId, PlanState } from "../domain/model";
import { peopleOf, projectPeople, type PeopleProjection } from "../domain/people";
import { LogState } from "../log/state";
import type { Action, DeviceId } from "../log/types";
import { formerPeople } from "../plan/former";
import { planRules } from "../plan/rules";
import { decodeAs, parseKey } from "../plan/units";
import { CH_ZH } from "../test/fixtures/calendars";
import { ctxOf, FIXTURE_DEVICES } from "../test/planCtx";
import { simulate, SIM_TODAY, type SimResult } from "../test/sim";
import { actionOf, lostWrites, viewOf } from "../test/simChecks";
import { buildAction, initialAction } from "./build";
import type { Intent } from "./intents";
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
const PARAMS: fc.Parameters<[number]> = { numRuns: NUM_RUNS, seed: 20261123, endOnFailure: true };
const TIMEOUT = { timeout: 120_000 };
const SIM_OPTS = { steps: true, people: true };

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

const peopleOfLog = (log: LogState): PeopleProjection => {
  const plan = viewOf(log).plan;
  return projectPeople(plan, formerPeople(log, plan));
};

const projectedIds = (p: PeopleProjection, item: ItemId): PersonId[] => (p.assignees.get(item) ?? []).map((a) => (a.kind === "live" ? a.person.id : a.id));

const droppedIds = (plan: PlanState, p: PeopleProjection): string[] =>
  [...plan.people.assignees].flatMap(([item, stored]) => {
    const want = [...(stored ?? [])].sort();
    const got = projectedIds(p, item).sort();
    return want.length === got.length && want.every((x, n) => x === got[n]) ? [] : [`${item}: stored ${JSON.stringify(want)}, projected ${JSON.stringify(got)}`];
  });

const PEOPLE_UNITS = new Set(["pp", "pa"]);

describe("simulated devices with people", () => {
  it(
    "devices and the shuffled log agree on plan, choices, held and projectPeople",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        const expected = viewOf(sim.shuffled);
        const people = peopleOfLog(sim.shuffled);
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
          expect(peopleOfLog(d.log)).toEqual(people);
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
    "projectPeople never throws or drops an id, on any built view or final log",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        const views = [...sim.built.map((b) => ({ plan: b.view.plan, people: b.view.people })), ...[sim.shuffled, ...sim.devices.map((d) => d.log)].map((log) => ({ plan: viewOf(log).plan, people: peopleOfLog(log) }))];
        const dropped = views.flatMap((v) => droppedIds(v.plan, v.people));
        expect(dropped).toEqual([]);
        views.forEach((v) => expect(v.people.people.map((p) => p.id)).toEqual(peopleOf(v.plan).map((p) => p.id)));
      });
    },
  );

  it(
    "the runs exercise person edits, assignments, removals, people clashes, refusals and former assignees",
    TIMEOUT,
    () => {
      const seeds = fc.sample(arbSeed, { numRuns: NUM_RUNS, seed: PARAMS.seed });
      const sims = seeds.map(run);
      const count = (f: (s: SimResult) => boolean): number => sims.filter(f).length;
      const finals = (s: SimResult): PeopleProjection[] => [...s.built.map((b) => b.view.people), peopleOfLog(s.shuffled)];
      const hits = {
        personEdits: count((s) => s.built.some((b) => b.kind === "person")),
        assigns: count((s) => s.built.some((b) => b.kind === "assign")),
        unassigns: count((s) => s.built.some((b) => b.kind === "unassign")),
        assigneeSets: count((s) => s.built.some((b) => b.kind === "assignees")),
        removals: count((s) => s.built.some((b) => b.kind === "person" && b.action.w.some((x) => parseKey(x.u).kind === "pp" && x.v === null))),
        peopleChoices: count((s) => [...s.built.map((b) => b.view.choices), viewOf(s.shuffled).choices].some((cs) => cs.some((c) => c.units.some((u) => PEOPLE_UNITS.has(parseKey(u).kind))))),
        nameRefusals: count((s) => s.steps.some((x) => x.includes("There is already a person named"))),
        formerAssignees: count((s) => finals(s).some((p) => [...p.assignees.values()].some((list) => list.some((a) => a.kind === "former")))),
        peopleUndos: count((s) =>
          s.built
            .filter((b) => b.kind === "undo" || b.kind === "redo" || b.kind === "revert")
            .some((b) => b.action.w.some((x) => (s.shuffled.get(parseKey(x.u).arg)?.w ?? []).some((y) => PEOPLE_UNITS.has(parseKey(y.u).kind)))),
        ),
      };
      console.info(`people simulation coverage over ${NUM_RUNS} runs: ${JSON.stringify(hits)}`);
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
): Scenario => {
  ids.reset(n * 7919);
  let clock = 0;
  const devices = [...FIXTURE_DEVICES.keys()].slice(0, n);
  const ctx = (log: LogState, dev: DeviceId) => ctxOf(log, dev, SIM_TODAY, FIXTURE_DEVICES, { now: (clock += 60_000) });
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

const personNamed = (log: LogState, name: string): PersonId => {
  const p = peopleOf(viewOf(log).plan).find((x) => x.name === name);
  if (p === undefined) throw new Error(`No person ${name}`);
  return p.id;
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
      const people = peopleOfLog(logs[0]);
      logs.forEach((log) => {
        const v = viewOf(log);
        expect(v.plan).toEqual(first.plan);
        expect(v.choices).toEqual(first.choices);
        expect(peopleOfLog(log)).toEqual(people);
        check(log);
      });
    }),
    { numRuns: 50, seed: 20261123 },
  );
};

const MIRA: Intent = { t: "person", op: "add", name: "Mira Okafor", initials: "MO", colour: "cyan", after: null };
const OLE = (_items: ReadonlyMap<string, ItemId>, log: LogState): Intent => ({ t: "person", op: "add", name: "Ole Berg", initials: "OB", colour: "lime", after: personNamed(log, "Mira Okafor") });
const ANA = (_items: ReadonlyMap<string, ItemId>, log: LogState): Intent => ({ t: "person", op: "add", name: "Ana Ruiz", initials: "AR", colour: "amber", after: personNamed(log, "Ole Berg") });

describe("people scenarios", () => {
  it.each([2, 3])("remove racing assignments, %i devices", (n) => {
    let mira = "";
    const s = scenario(n, [MIRA], (items, log) => {
      mira = personNamed(log, "Mira Okafor");
      const race: Intent[] = [
        { t: "person", op: "remove", person: mira, to: null },
        { t: "assign", items: [named(items, "Mirror")], person: mira },
        { t: "assign", items: [named(items, "Dome")], person: mira },
      ];
      return race.slice(0, n);
    });
    const held = (n === 3 ? ["Mirror", "Dome"] : ["Mirror"]).map((name) => itemOf(s, name));
    converged(s, (log) => {
      const v = viewOf(log);
      expect(v.choices).toEqual([]);
      expect(peopleOf(v.plan)).toEqual([]);
      expect([...v.plan.people.assignees.keys()].sort()).toEqual([...held].sort());
      held.forEach((item) => {
        expect(v.plan.people.assignees.get(item)).toEqual([mira]);
        expect(peopleOfLog(log).assignees.get(item)).toEqual([{ kind: "former", id: mira, name: "Mira Okafor", initials: "MO", colour: "cyan" }]);
      });
    });
  });

  it.each([2, 3])("the same person assigned on every device raises no choice, %i devices", (n) => {
    let mira = "";
    const s = scenario(n, [MIRA], (items, log) => {
      mira = personNamed(log, "Mira Okafor");
      const assign: Intent = { t: "assign", items: [named(items, "Mirror")], person: mira };
      return Array.from({ length: n }, () => assign);
    });
    const mirror = itemOf(s, "Mirror");
    converged(s, (log) => {
      const v = viewOf(log);
      expect(v.choices).toEqual([]);
      expect(v.plan.people.assignees.get(mirror)).toEqual([mira]);
      expect(peopleOfLog(log).assignees.get(mirror)?.map((a) => a.kind)).toEqual(["live"]);
    });
  });

  it.each([2, 3])("a different person assigned on each device raises one pa choice with a side per device, %i devices", (n) => {
    let mira = "";
    let ole = "";
    let ana = "";
    const s = scenario(n, [MIRA, OLE, ANA], (items, log) => {
      mira = personNamed(log, "Mira Okafor");
      ole = personNamed(log, "Ole Berg");
      ana = personNamed(log, "Ana Ruiz");
      const mirror = named(items, "Mirror");
      const race: Intent[] = [
        { t: "assign", items: [mirror], person: mira },
        { t: "assign", items: [mirror], person: ole },
        { t: "assign", items: [mirror], person: ana },
      ];
      return race.slice(0, n);
    });
    const mirror = itemOf(s, "Mirror");
    converged(s, (log) => {
      const cs = viewOf(log).choices;
      expect(cs.length).toBe(1);
      expect(cs[0].units).toEqual([`pa:${mirror}`]);
      expect(cs[0].items).toEqual([mirror]);
      expect(cs[0].sides.length).toBe(n);
    });
    const log = deliver(s.actions, s.actions.map((_, k) => k));
    const ctx = ctxOf(log, "d1", SIM_TODAY);
    const choice = ctx.view.choices[0];
    const side = choice.sides[1];
    const picked = side.actions
      .flatMap((id) => actionOf(ctx.log, id).w)
      .filter((x) => x.u === `pa:${mirror}`)
      .map((x) => decodeAs("assignees", x.u, x.v));
    expect(picked.length).toBe(1);
    const resolved = buildResolve(ctx, choice, { side: side.key }, OPTS).action;
    converged({ ...s, actions: [...s.actions, resolved] }, (l) => {
      const v = viewOf(l);
      expect(v.choices).toEqual([]);
      expect(v.plan.people.assignees.get(mirror)).toEqual(picked[0]);
      expect([[mira], [ole], [ana]].slice(0, n)).toContainEqual(picked[0]);
    });
  });

  it.each([2, 3])("reorder racing rename and colour raises one pp choice with a side per device, %i devices", (n) => {
    let mira = "";
    const s = scenario(n, [MIRA, OLE], (_items, log) => {
      mira = personNamed(log, "Mira Okafor");
      const ole = personNamed(log, "Ole Berg");
      const race: Intent[] = [
        { t: "person", op: "reorder", person: mira, after: ole },
        { t: "person", op: "rename", person: mira, name: "Mira Okafor-Berg" },
        { t: "person", op: "colour", person: mira, colour: "coral" },
      ];
      return race.slice(0, n);
    });
    converged(s, (log) => {
      const cs = viewOf(log).choices;
      expect(cs.length).toBe(1);
      expect(cs[0].units).toEqual([`pp:${mira}`]);
      expect(cs[0].items).toEqual([]);
      expect(cs[0].sides.length).toBe(n);
      expect(peopleOfLog(log).people.map((p) => p.id)).toContain(mira);
    });
  });

  it.each([2, 3])("namesakes added on different devices show one sameName problem naming all of them, %i devices", (n) => {
    const names = ["Mira Okafor", "mira okafor", "MIRA OKAFOR"].slice(0, n);
    const s = scenario(n, [], () => names.map((name): Intent => ({ t: "person", op: "add", name, initials: "MO", colour: "cyan", after: null })));
    converged(s, (log) => {
      const people = peopleOfLog(log);
      expect(people.people.map((p) => p.name).sort()).toEqual([...names].sort());
      expect(people.problems).toEqual([{ kind: "sameName", people: people.people.map((p) => p.id) }]);
      expect(viewOf(log).choices).toEqual([]);
    });
  });
});
