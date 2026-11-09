import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { toDay } from "../domain/dates";
import { schedView } from "../domain/derive";
import type { ItemId } from "../domain/model";
import { replay, type LogState } from "../log/state";
import { OWNER_CAUSES, type Action, type ActionId, type UnitKey, type Write } from "../log/types";
import { choices, heldItems, type Choice, type ChoiceSide } from "../plan/choices";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { decodeAs, parseKey } from "../plan/units";
import { PLAN, simulate, type SimBuilt, type SimResult } from "../test/sim";
import { FIXTURE_DEVICES } from "../test/planCtx";

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

const NUM_RUNS = 200;
const PARAMS: fc.Parameters<[number]> = { numRuns: NUM_RUNS, seed: 20261108, endOnFailure: true };
const TIMEOUT = { timeout: 120_000 };

const memo = new Map<number, SimResult>();

const run = (seed: number): SimResult => {
  const known = memo.get(seed);
  if (known !== undefined) return known;
  ids.reset(seed);
  const result = simulate(seed);
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
        console.error(`simulate(${seed}) failed`);
        throw e;
      }
    }),
    PARAMS,
  );

const viewOf = (log: LogState) => {
  const plan = projectPlan(PLAN, log);
  const cs = choices(log, plan, FIXTURE_DEVICES);
  return { plan, choices: cs, held: heldItems(cs, plan) };
};

const actionOf = (log: LogState, id: ActionId): Action => {
  const a = log.get(id);
  if (a === undefined) throw new Error(`Action ${id} is not ready`);
  return a;
};

const ancestry = (sim: SimResult, par: readonly ActionId[]): Action[] => {
  const byId = new Map([sim.root, ...sim.built.map((b) => b.action)].map((a) => [a.id, a]));
  const seen = new Map<ActionId, Action>();
  const visit = (id: ActionId): void => {
    if (seen.has(id)) return;
    const a = byId.get(id);
    if (a === undefined) throw new Error(`Action ${id} is unknown to the simulation`);
    seen.set(id, a);
    a.par.forEach(visit);
  };
  par.forEach(visit);
  return [...seen.values()];
};

const logAt = (sim: SimResult, b: SimBuilt): LogState => {
  const log = replay(ancestry(sim, b.action.par), planRules);
  expect(log.pending).toEqual([]);
  expect(projectPlan(PLAN, log)).toEqual(b.view.plan);
  return log;
};

const startOf = (u: UnitKey, v: unknown): number => {
  const start = decodeAs("sched", u, v).start;
  if (start === null) throw new Error(`${u} has no start`);
  return toDay(start);
};

const heldFor = (b: SimBuilt): ReadonlySet<ItemId> => {
  if (b.kind !== "resolve") return b.view.held;
  const choice = b.choice;
  if (choice === undefined) throw new Error(`Resolution ${b.action.id} has no choice`);
  const own = heldItems([choice], b.view.plan);
  return new Set([...b.view.held].filter((i) => !own.has(i)));
};

const lockOf = (b: SimBuilt, item: ItemId): string | null => {
  const s = schedView(b.view.plan, heldFor(b)).items.get(item);
  if (s === undefined) return "not scheduled";
  return s.lock;
};

const sideValue = (log: LogState, choice: Choice, side: ChoiceSide, u: UnitKey): unknown => {
  const mine = [...side.actions]
    .reverse()
    .map((a) => actionOf(log, a).w.find((x) => x.u === u))
    .find((x) => x !== undefined);
  if (mine !== undefined) return mine.v;
  const others = new Set(choice.sides.filter((s) => s.key !== side.key).flatMap((s) => s.actions));
  return log.valueWithout(u, others)?.value;
};

const matches = (x: Write, v: unknown): boolean =>
  v !== undefined && (planRules.same(x.u, x.v, v) || (parseKey(x.u).kind === "s" && startOf(x.u, x.v) > startOf(x.u, v)));

const r17Violations = (sim: SimResult, b: SimBuilt): string[] => {
  if (b.kind === "undo" || b.kind === "redo" || b.kind === "revert") {
    return b.action.w.filter((x) => parseKey(x.u).kind !== "a").map((x) => `${b.kind} ${b.action.id} writes ${x.u}`);
  }
  if (b.kind !== "resolve") return [];
  const { choice, pick, opts } = b;
  if (choice === undefined || pick === undefined || opts === undefined) throw new Error(`Resolution ${b.action.id} lacks its choice`);
  const log = logAt(sim, b);
  const keys = new Set([pick.side, ...(pick.perUnit?.values() ?? [])]);
  const others = choice.sides.filter((s) => !keys.has(s.key));
  const picked = choice.sides.find((s) => s.key === pick.side);
  if (picked === undefined) throw new Error(`Choice ${choice.id} has no side ${pick.side}`);
  const participants = new Set(choice.sides.flatMap((s) => s.actions).flatMap((a) => actionOf(log, a).w.map((x) => x.u)));
  const ok = (x: Write): boolean => {
    if (choice.units.includes(x.u)) return true;
    const item = parseKey(x.u).arg;
    if (x.c === "push") {
      if (!opts.pushFromPredecessors && choice.kind !== "calendar") return false;
      const before = b.view.plan.items.get(item)?.schedule?.start ?? null;
      return before !== null && startOf(x.u, x.v) > toDay(before) && lockOf(b, item) === null;
    }
    if (x.c === "recalendar") return choice.kind === "calendar" && lockOf(b, item) === null;
    if (x.c !== "resolution") return false;
    if (opts.returnPushed && others.some((s) => matches(x, log.valueWithout(x.u, new Set(s.actions))?.value))) return true;
    return choice.kind === "resolutions" && participants.has(x.u) && matches(x, sideValue(log, choice, picked, x.u));
  };
  return b.action.w.filter((x) => !ok(x)).map((x) => `resolution ${b.action.id} of ${choice.kind} ${choice.id} writes ${x.u} (${x.c}) = ${JSON.stringify(x.v)}`);
};

const lostWrites = (log: LogState): string[] =>
  log
    .order()
    .filter((id) => log.active(id))
    .flatMap((id) =>
      actionOf(log, id)
        .w.filter((x) => OWNER_CAUSES.has(x.c))
        .filter((x) => {
          const st = log.unit(x.u);
          if (st !== undefined && (st.from === id || planRules.same(x.u, st.value, x.v) || (st.clash ?? []).includes(id))) return false;
          return !log.writers(x.u).some((w) => w !== id && log.active(w) && log.seen(id, w));
        })
        .map((x) => `${id} ${x.u} = ${JSON.stringify(x.v)}, now ${JSON.stringify(stateOf(log, x.u))}`),
    );

const stateOf = (log: LogState, u: UnitKey) => log.unit(u) ?? null;

describe("simulated devices", () => {
  it(
    "every device and the shuffled log agree on plan, choices and held items",
    () => {
      property((_seed, sim) => {
        const expected = viewOf(sim.shuffled);
        const ids = new Set([sim.root.id, ...sim.built.map((b) => b.action.id)].filter((id) => !sim.lost.has(id)));
        expect(new Set(sim.shuffled.order())).toEqual(ids);
        expect(sim.shuffled.pending).toEqual([]);
        sim.devices.forEach((d) => {
          expect(new Set(d.log.order())).toEqual(ids);
          expect(d.log.pending).toEqual([]);
          expect(new Set([...d.doc.actions()].map((a) => a.id))).toEqual(ids);
          const v = viewOf(d.log);
          expect(v.plan).toEqual(expected.plan);
          expect(v.choices).toEqual(expected.choices);
          expect(v.held).toEqual(expected.held);
        });
      });
    },
    TIMEOUT,
  );

  it(
    "no owner write of an active action is lost",
    () => {
      property((_seed, sim) => {
        expect(lostWrites(sim.shuffled)).toEqual([]);
      });
    },
    TIMEOUT,
  );

  it(
    "undo, redo and revert write only a: units; a resolution only its choice, its pushes and its returns (refinement 17)",
    () => {
      property((_seed, sim) => {
        expect(sim.built.flatMap((b) => r17Violations(sim, b))).toEqual([]);
      });
    },
    TIMEOUT,
  );

  it(
    "no push write targets an item held, done or doing in the view it was built from",
    () => {
      property((_seed, sim) => {
        const bad = sim.built.flatMap((b) =>
          b.action.w
            .filter((x) => x.c === "push")
            .map((x) => ({ x, lock: lockOf(b, parseKey(x.u).arg) }))
            .filter(({ lock }) => lock !== null)
            .map(({ x, lock }) => `${b.kind} ${b.action.id} pushes ${x.u} (${lock})`),
        );
        expect(bad).toEqual([]);
      });
    },
    TIMEOUT,
  );

  it(
    "every typed note marker is in its note on every device",
    () => {
      property((_seed, sim) => {
        sim.devices.forEach((d) => {
          const missing = sim.notes.filter((n) => !d.doc.note(n.item).toString().includes(n.marker));
          expect(missing.map((n) => `${d.id} ${n.item} ${n.marker}`)).toEqual([]);
        });
      });
    },
    TIMEOUT,
  );

  it(
    "the runs exercise clashes, resolutions, undo, pushes into held items' neighbours, restores and note races",
    () => {
      const seeds = fc.sample(arbSeed, { numRuns: NUM_RUNS, seed: PARAMS.seed });
      const sims = seeds.map(run);
      const count = (f: (s: SimResult) => boolean): number => sims.filter(f).length;
      const hits = {
        choices: count((s) => s.built.some((b) => b.view.choices.length > 0)),
        resolves: count((s) => s.built.some((b) => b.kind === "resolve")),
        undos: count((s) => s.built.some((b) => b.kind === "undo")),
        redos: count((s) => s.built.some((b) => b.kind === "redo")),
        reverts: count((s) => s.built.some((b) => b.kind === "revert")),
        pushes: count((s) => s.built.some((b) => b.action.w.some((x) => x.c === "push"))),
        pushesWhileHeld: count((s) => s.built.some((b) => b.view.held.size > 0 && b.action.w.some((x) => x.c === "push"))),
        stopsAtHeld: count((s) => s.built.some((b) => b.action.lbl.includes("stopped at held"))),
        restores: count((s) => s.steps.some((x) => / restore at /.test(x))),
        lost: count((s) => s.lost.size > 0),
        notes: count((s) => s.notes.length > 0),
        threeDevices: count((s) => s.devices.length === 3),
      };
      console.info(`simulation coverage over ${NUM_RUNS} runs: ${JSON.stringify(hits)}`);
      Object.values(hits).forEach((n) => expect(n).toBeGreaterThanOrEqual(NUM_RUNS / 20));
    },
    TIMEOUT,
  );
});
