import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { toDay } from "../domain/dates";
import { lockOf as statusLock, schedView } from "../domain/derive";
import type { ItemId } from "../domain/model";
import { replay, type LogState } from "../log/state";
import type { Action, ActionId, UnitKey, Write } from "../log/types";
import { heldItems, type Choice, type ChoiceSide } from "../plan/choices";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { decodeAs, parseKey } from "../plan/units";
import { buildResolve } from "./resolve";
import { act } from "../test/act";
import { simulate, SIM_TODAY, type SimBuilt, type SimResult } from "../test/sim";
import { ctxOf, PLAN_ID } from "../test/planCtx";
import { actionOf, lostWrites, viewOf } from "../test/simChecks";

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
  expect(projectPlan(PLAN_ID, log)).toEqual(b.view.plan);
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
  const held = heldFor(b);
  const s = schedView(b.view.plan, held).items.get(item);
  if (s !== undefined) return s.lock;
  const stored = b.view.plan.items.get(item);
  if (stored === undefined || !stored.trashed || stored.schedule === null) return "not scheduled";
  return statusLock(stored.schedule.status, held.has(item));
};

const valueApart = (log: LogState, u: UnitKey, without: ReadonlySet<ActionId>): unknown => {
  const st = log.valueWithout(u, without);
  if (st !== undefined) return st.value;
  const ws = log.writers(u).filter((id) => !without.has(id));
  if (ws.length === 0) return undefined;
  const last = ws[ws.length - 1];
  const x = actionOf(log, last).w.find((y) => y.u === u);
  if (x === undefined) throw new Error(`Action ${last} holds no write to ${u}`);
  return x.v;
};

const sideValue = (log: LogState, choice: Choice, side: ChoiceSide, u: UnitKey): unknown => {
  const mine = [...side.actions]
    .reverse()
    .map((a) => actionOf(log, a).w.find((x) => x.u === u))
    .find((x) => x !== undefined);
  if (mine !== undefined) return mine.v;
  return valueApart(log, u, new Set(choice.sides.filter((s) => s.key !== side.key).flatMap((s) => s.actions)));
};

const matches = (b: SimBuilt, x: Write, v: unknown): boolean => {
  if (v === undefined) return false;
  if (planRules.same(x.u, x.v, v)) return true;
  return parseKey(x.u).kind === "s" && startOf(x.u, x.v) > startOf(x.u, v) && lockOf(b, parseKey(x.u).arg) === null;
};

const r17Violations = (sim: SimResult, b: SimBuilt): string[] => {
  if (b.kind === "undo" || b.kind === "redo" || b.kind === "revert") {
    return b.action.w.filter((x) => parseKey(x.u).kind !== "a").map((x) => `${b.kind} ${b.action.id} writes ${x.u}`);
  }
  if (b.kind !== "resolve") return [];
  const { choice, pick, opts } = b;
  if (choice === undefined || pick === undefined || opts === undefined) throw new Error(`Resolution ${b.action.id} lacks its choice`);
  const log = logAt(sim, b);
  const keys = new Set([pick.side, ...(pick.perUnit?.values() ?? [])]);
  const losing = choice.sides.filter((s) => !keys.has(s.key)).flatMap((s) => s.actions);
  const lost = new Set(losing);
  const picked = choice.sides.find((s) => s.key === pick.side);
  if (picked === undefined) throw new Error(`Choice ${choice.id} has no side ${pick.side}`);
  const participants = new Set(choice.sides.flatMap((s) => s.actions).flatMap((a) => actionOf(log, a).w.map((x) => x.u)));
  const pushedByLoser = (u: UnitKey): boolean => losing.some((a) => actionOf(log, a).w.some((y) => y.u === u && y.c === "push"));
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
    if (opts.returnPushed && pushedByLoser(x.u) && matches(b, x, valueApart(log, x.u, lost))) return true;
    return choice.kind === "resolutions" && participants.has(x.u) && matches(b, x, sideValue(log, choice, picked, x.u));
  };
  return b.action.w.filter((x) => !ok(x)).map((x) => `resolution ${b.action.id} of ${choice.kind} ${choice.id} writes ${x.u} (${x.c}) = ${JSON.stringify(x.v)}`);
};

const pushViolations = (b: SimBuilt): string[] =>
  b.action.w
    .filter((x) => x.c === "push")
    .map((x) => ({ x, lock: lockOf(b, parseKey(x.u).arg) }))
    .filter(({ lock }) => lock !== null)
    .map(({ x, lock }) => `${b.kind} ${b.action.id} pushes ${x.u} (${lock})`);

describe("simulated devices", () => {
  it(
    "every device and the shuffled log agree on plan, choices and held items",
    TIMEOUT,
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
  );

  it(
    "no owner write of an active action is lost",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        expect(lostWrites(sim.shuffled)).toEqual([]);
      });
    },
  );

  it(
    "undo, redo and revert write only a: units; a resolution only its choice, its pushes and its returns (refinement 17)",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        expect(sim.built.flatMap((b) => r17Violations(sim, b))).toEqual([]);
      });
    },
  );

  it(
    "no push write targets an item held, done or doing in the view it was built from",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        expect(sim.built.flatMap(pushViolations)).toEqual([]);
      });
    },
  );

  it(
    "every typed note marker is in its note on every device",
    TIMEOUT,
    () => {
      property((_seed, sim) => {
        sim.devices.forEach((d) => {
          const missing = sim.notes.filter((n) => !d.doc.note(n.item).toString().includes(n.marker));
          expect(missing.map((n) => `${d.id} ${n.item} ${n.marker}`)).toEqual([]);
        });
      });
    },
  );

  it("simulate(188) pops a stale undo or redo entry", () => {
    expect(run(188).stalePops).toBeGreaterThan(0);
  });

  it("simulate(1605) completes: a delete choice over an item created inside the trashed group resolves", () => {
    const sim = run(1605);
    expect(sim.built.filter((b) => b.kind === "resolve" && b.choice?.kind === "delete").length).toBeGreaterThan(0);
  });

  it("simulate(1485714804) completes: per-unit picks name only sides that have a version of the unit", () => {
    const sim = run(1485714804);
    expect(sim.built.some((b) => b.kind === "resolve")).toBe(true);
  });

  it("a push of an item the resolution restores from the Trash reads its lock from its stored status (Ruling restored push)", () => {
    const w = (u: UnitKey, v: unknown, c: Write["c"] = "own"): Write => ({ u, v, c });
    const root = act("a0", [], [
      w("pn", "Plan"),
      w("cw", [1, 2, 3, 4, 5]),
      w("cr", null),
      w("e:P", { k: "task", t: false }),
      w("n:P", "P"),
      w("s:P", ["2026-11-16", 2, "todo", 0, "later"]),
      w("p:P", [null, "a0"]),
      w("e:R", { k: "task", t: false }),
      w("n:R", "R"),
      w("s:R", ["2026-11-18", 1, "todo", 0, "later"]),
      w("p:R", [null, "a1"]),
      w("l:P>R", ["FS", 0]),
    ]);
    const trash = act("t", ["a0"], [w("e:R", { k: "task", t: true })], { dev: "d1" });
    const move = act("m", ["t"], [w("s:P", ["2026-11-23", 2, "todo", 0, "later"])], { dev: "d1" });
    const place = act("p", ["a0"], [w("p:R", [null, "a5"])], { dev: "d2" });
    const log = replay([root, trash, move, place], planRules);
    expect(log.pending).toEqual([]);
    const ctx = ctxOf(log, "d1", SIM_TODAY);
    const choice = ctx.view.choices.find((c) => c.units.includes("e:R"));
    if (choice === undefined) throw new Error("No choice over e:R");
    const pick = { side: "p" };
    const opts = { pushFromPredecessors: true, returnPushed: false };
    const b = buildResolve(ctx, choice, pick, opts);
    expect(b.action.w).toContainEqual(w("e:R", { k: "task", t: false }, "resolution"));
    expect(b.action.w).toContainEqual(w("p:R", [null, "a5"], "resolution"));
    expect(b.action.w).toContainEqual(w("s:R", ["2026-11-25", 1, "todo", 0, "later"], "push"));
    const resolved: SimBuilt = { action: b.action, kind: "resolve", view: ctx.view, choice, pick, opts };
    const sim: SimResult = {
      devices: [],
      shuffled: log,
      built: [trash, move, place].map((action): SimBuilt => ({ action, kind: "schedule", view: ctx.view })).concat([resolved]),
      notes: [],
      root,
      lost: new Set(),
      steps: [],
      stalePops: 0,
    };
    expect(lockOf(resolved, "R")).toBe(null);
    expect(r17Violations(sim, resolved)).toEqual([]);
    expect(pushViolations(resolved)).toEqual([]);
  });

  it(
    "the runs exercise clashes, resolutions, undo, pushes into held items' neighbours, restores and note races",
    TIMEOUT,
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
      const stale = { runs: count((s) => s.stalePops > 0), pops: sims.reduce((n, s) => n + s.stalePops, 0) };
      console.info(`simulation coverage over ${NUM_RUNS} runs: ${JSON.stringify(hits)}; stale undo or redo entries popped: ${JSON.stringify(stale)}`);
      Object.values(hits).forEach((n) => expect(n).toBeGreaterThanOrEqual(NUM_RUNS / 20));
    },
  );
});
