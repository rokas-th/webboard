import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LogState, replay } from "./state";
import { OWNER_CAUSES, type Action, type ActionId, type Cause, type Rules, type UnitKey, type UnitState, type Write } from "./types";
import { oracle, type OracleResult } from "../test/logOracle";

const rules: Rules = {
  same: (_u, a, b) => JSON.stringify(a) === JSON.stringify(b),
  mergeDerived: (_u, a, b) => ((a.v as number) > (b.v as number) ? a : b),
};

type W = readonly [UnitKey, unknown, Cause?];

const act = (id: ActionId, par: readonly ActionId[], writes: readonly W[], dev = "d1"): Action => ({
  id,
  dev,
  ses: "s-" + dev,
  at: 0,
  par,
  lbl: id,
  w: writes.map(([u, v, c]): Write => ({ u, v, c: c ?? "own" })),
});

const logOf = (...actions: Action[]) => {
  const log = new LogState(rules);
  log.add(actions);
  return log;
};

describe("LogState", () => {
  it("names exactly the owner causes", () => {
    expect([...OWNER_CAUSES].sort()).toEqual(["own", "resolution", "revert", "undo"]);
  });

  it("refuses an action that writes one unit twice, before storing it", () => {
    const log = logOf(act("a", [], [["x", 1]]));
    expect(() => log.add([act("b", ["a"], [["x", 1], ["y", 2], ["x", 3]])])).toThrow("Action b writes x twice");
    expect(log.get("b")).toBeUndefined();
    expect(log.order()).toEqual(["a"]);
    expect(() => log.add([act("p", ["missing"], [["a:a", false], ["a:a", true]])])).toThrow(
      "Action p writes a:a twice",
    );
    expect(log.pending).toEqual([]);
  });

  it("refuses an activity write to an action it has not seen, leaving the log unchanged", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", [], [["x", 2]]));
    const before = log.units();
    expect(() => log.add([act("u", ["a"], [["y", 5], ["a:b", false, "undo"]])])).toThrow(
      "Action u writes a:b without having seen it",
    );
    expect(() => log.add([act("v", ["a"], [["a:v", false, "undo"]])])).toThrow(
      "Action v writes a:v without having seen it",
    );
    expect(() => log.add([act("n", ["a"], [["a:nobody", false, "undo"]])])).toThrow(
      "Action n writes a:nobody without having seen it",
    );
    expect(log.units()).toEqual(before);
    expect(log.order()).toEqual(["a", "b"]);
    expect(log.active("b")).toBe(true);
  });

  it("refuses a pending action's unseen activity write when its parent arrives, storing neither", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", [], [["x", 2]]));
    log.add([act("u", ["c"], [["a:b", false, "undo"]])]);
    expect(log.pending).toEqual(["u"]);
    expect(() => log.add([act("c", ["a"], [["x", 3]])])).toThrow("Action u writes a:b without having seen it");
    expect(log.get("c")).toBeUndefined();
    expect(log.pending).toEqual(["u"]);
    expect(log.order()).toEqual(["a", "b"]);
    expect(log.unit("x")?.value).toBe(2);
  });

  it("refuses an activity value that is not a boolean", () => {
    const log = logOf(act("a", [], [["x", 1]]));
    expect(() => log.add([act("u", ["a"], [["a:a", 0, "undo"]])])).toThrow(
      "Action u writes a:a with a value that is not true or false",
    );
    expect(log.get("u")).toBeUndefined();
  });

  it("lets a later write supersede the one it has seen", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", ["a"], [["x", 2]]));
    expect(log.unit("x")).toEqual({ value: 2, from: "b", clash: null });
    expect(log.writers("x")).toEqual(["a", "b"]);
  });

  it("clashes owner writes made apart, taking the later value in replay order", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", [], [["x", 2]], "d2"));
    expect(log.unit("x")).toEqual({ value: 2, from: "b", clash: ["a", "b"] });
  });

  it("does not clash owner writes made apart with the same value", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", [], [["x", 1]], "d2"));
    expect(log.unit("x")).toEqual({ value: 1, from: "b", clash: null });
  });

  it("lets an owner write beat a derived write made apart", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", [], [["x", 9, "push"]], "d2"));
    expect(log.unit("x")).toEqual({ value: 1, from: "a", clash: null });
  });

  it("merges derived writes made apart through mergeDerived", () => {
    const log = logOf(act("a", [], [["x", 7, "push"]]), act("b", [], [["x", 4, "recalendar"]], "d2"));
    expect(log.unit("x")).toEqual({ value: 7, from: "a", clash: null });
    const tie = logOf(act("a", [], [["x", 4, "push"]]), act("b", [], [["x", 4, "push"]], "d2"));
    expect(tie.unit("x")).toEqual({ value: 4, from: "b", clash: null });
  });

  it("refuses a derived merge that returns neither of its writes", () => {
    const log = new LogState({ ...rules, mergeDerived: (u, a) => ({ u, v: a.v, c: a.c }) });
    expect(() => log.add([act("a", [], [["x", 4, "push"]]), act("b", [], [["x", 7, "push"]], "d2")])).toThrow(
      "mergeDerived for x returned a write that is neither of its two",
    );
  });

  it("clashes a late edit with the resolution, not with the rejected side", () => {
    const log = logOf(
      act("a", [], [["x", 1]]),
      act("b", [], [["x", 2]], "d2"),
      act("r", ["a", "b"], [["x", 1, "resolution"]]),
      act("c", ["b"], [["x", 3]], "d2"),
    );
    expect(log.unit("x")).toEqual({ value: 1, from: "r", clash: ["c", "r"] });
  });

  it("drops an undone action's writes and brings them back when the undo is undone", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", ["a"], [["x", 2]]));
    expect(log.valueWithout("x", new Set(["b"]))).toEqual({ value: 1, from: "a", clash: null });
    expect(log.active("b")).toBe(true);
    log.add([act("u", ["b"], [["a:b", false, "undo"]])]);
    expect(log.unit("x")).toEqual({ value: 1, from: "a", clash: null });
    expect(log.active("b")).toBe(false);
    expect(log.writers("x")).toEqual(["a", "b"]);
    log.add([act("r", ["u"], [["a:u", false, "undo"]])]);
    expect(log.unit("x")).toEqual({ value: 2, from: "b", clash: null });
    expect(log.active("b")).toBe(true);
    expect(log.active("u")).toBe(false);
  });

  it("cascades through an undo of a redo of an undo", () => {
    const log = logOf(
      act("a", [], [["x", 1]]),
      act("b", ["a"], [["x", 2]]),
      act("u1", ["b"], [["a:b", false, "undo"]]),
      act("u2", ["u1"], [["a:u1", false, "undo"]]),
    );
    expect(log.unit("x")?.value).toBe(2);
    expect([log.active("b"), log.active("u1"), log.active("u2")]).toEqual([true, false, true]);
    const delta = log.add([act("u3", ["u2"], [["a:u2", false, "undo"]])]);
    expect(log.unit("x")).toEqual({ value: 1, from: "a", clash: null });
    expect([log.active("b"), log.active("u1"), log.active("u2"), log.active("u3")]).toEqual([false, true, false, true]);
    expect([...delta.activity].sort()).toEqual(["b", "u1", "u2"]);
    expect([...delta.units].sort()).toEqual(["a:b", "a:u1", "a:u2", "x"]);
    expect(delta.added).toEqual(["u3"]);
    const late = logOf(
      act("u3", ["u2"], [["a:u2", false, "undo"]]),
      act("u2", ["u1"], [["a:u1", false, "undo"]]),
      act("u1", ["b"], [["a:b", false, "undo"]]),
      act("b", ["a"], [["x", 2]]),
      act("a", [], [["x", 1]]),
    );
    expect(late.units()).toEqual(log.units());
    expect(late.order()).toEqual(["a", "b", "u1", "u2", "u3"]);
  });

  it("clashes two activity writes made apart", () => {
    const log = logOf(
      act("a", [], [["x", 1]]),
      act("b", ["a"], [["x", 2]]),
      act("u1", ["b"], [["a:b", false, "undo"]]),
      act("u2", ["b"], [["a:b", true, "revert"]], "d2"),
    );
    expect(log.unit("a:b")).toEqual({ value: true, from: "u2", clash: ["u1", "u2"] });
    expect(log.active("b")).toBe(true);
    expect(log.unit("x")?.value).toBe(2);
  });

  it("answers ancestry, lookups and activity for ready and pending actions", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", ["a"], [["x", 2]]), act("p", ["missing"], [["x", 5]]));
    expect(log.get("a")?.lbl).toBe("a");
    expect(log.get("p")).toBeUndefined();
    expect(log.get("nope")).toBeUndefined();
    expect(log.seen("a", "b")).toBe(true);
    expect(log.seen("b", "b")).toBe(true);
    expect(log.seen("b", "a")).toBe(false);
    expect(log.seen("p", "b")).toBe(false);
    expect(log.seen("nope", "b")).toBe(false);
    expect(() => log.seen("a", "p")).toThrow("Action p is not ready");
    expect(log.pending).toEqual(["p"]);
    expect(log.heads).toEqual(["b"]);
    expect(log.unit("missing-unit")).toBeUndefined();
    expect(log.writers("missing-unit")).toEqual([]);
    expect(log.valueWithout("missing-unit", new Set())).toBeUndefined();
  });

  it("reports a head action's units and itself", () => {
    const log = logOf(act("a", [], [["x", 1]]));
    const delta = log.add([act("b", ["a"], [["x", 2], ["y", 3]])]);
    expect([...delta.units].sort()).toEqual(["x", "y"]);
    expect([...delta.activity]).toEqual([]);
    expect(delta.added).toEqual(["b"]);
  });

  it("lists a flipped action in the delta's activity", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", ["a"], [["x", 2]]));
    const delta = log.add([act("u", ["b"], [["a:b", false, "undo"]])]);
    expect([...delta.activity]).toEqual(["b"]);
    expect([...delta.units].sort()).toEqual(["a:b", "x"]);
  });

  it("keeps a pending child out of every unit until its parent arrives", () => {
    const log = logOf(act("a", [], [["x", 1]]));
    const delta = log.add([act("c", ["b"], [["x", 3], ["z", 1]])]);
    expect([...delta.units]).toEqual([]);
    expect(delta.added).toEqual([]);
    expect(log.unit("z")).toBeUndefined();
    expect(log.writers("x")).toEqual(["a"]);
    const released = log.add([act("b", ["a"], [["y", 2]])]);
    expect(released.added).toEqual(["b", "c"]);
    expect([...released.units].sort()).toEqual(["x", "y", "z"]);
    expect(log.unit("x")).toEqual({ value: 3, from: "c", clash: null });
  });

  it("leaves the original unchanged when a fork takes more actions", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", ["a"], [["x", 2]]), act("p", ["q"], [["x", 8]]));
    const fork = log.fork();
    fork.add([act("u", ["b"], [["a:b", false, "undo"]]), act("q", ["a"], [["y", 1]])]);
    expect(fork.unit("x")?.value).toBe(8);
    expect(fork.active("b")).toBe(false);
    expect(log.unit("x")).toEqual({ value: 2, from: "b", clash: null });
    expect(log.active("b")).toBe(true);
    expect(log.unit("y")).toBeUndefined();
    expect(log.pending).toEqual(["p"]);
    expect(log.order()).toEqual(["a", "b"]);
    expect(log.writers("x")).toEqual(["a", "b"]);
    expect(log.get("u")).toBeUndefined();
  });

  it("replays to the same state as incremental adds", () => {
    const all = [
      act("a", [], [["x", 1]]),
      act("b", ["a"], [["x", 2]]),
      act("c", ["a"], [["x", 3]], "d2"),
      act("u", ["b"], [["a:b", false, "undo"]]),
    ];
    const inc = new LogState(rules);
    all.forEach((a) => inc.add([a]));
    const full = replay(all, rules);
    expect(full.units()).toEqual(inc.units());
    expect(full.order()).toEqual(inc.order());
    expect(full.unit("x")).toEqual({ value: 3, from: "c", clash: null });
  });
});

const DEVICES = ["d1", "d2", "d3"];
const CAUSES: readonly Cause[] = ["own", "push", "recalendar", "undo", "revert", "resolution"];
const MAX_ACTIONS = 120;
const NUM_RUNS = 300;
const PARAMS: fc.Parameters<[Case]> = { numRuns: NUM_RUNS, seed: 20261108 };

interface Case {
  actions: Action[];
  delivery: number[];
  cuts: number[];
}

const arbWrite = fc.record({
  activity: fc.boolean(),
  unit: fc.nat(5),
  value: fc.nat(3),
  cause: fc.nat(CAUSES.length - 1),
  target: fc.nat(),
  toActivity: fc.boolean(),
  flag: fc.boolean(),
  revert: fc.boolean(),
});

const arbCase: fc.Arbitrary<Case> = fc
  .record({
    specs: fc.array(
      fc.record({
        dev: fc.nat(DEVICES.length - 1),
        tag: fc.constantFrom("a", "b", "c"),
        picks: fc.array(fc.nat(), { maxLength: 2 }),
        writes: fc.array(arbWrite, { minLength: 1, maxLength: 3 }),
      }),
      { minLength: 1, maxLength: MAX_ACTIONS, size: "max" },
    ),
    repeats: fc.array(fc.nat(), { maxLength: 10 }),
    cuts: fc.array(fc.integer({ min: 1, max: 12 }), { maxLength: 40, size: "max" }),
  })
  .chain(({ specs, repeats, cuts }) => {
    const tips = new Map<string, ActionId>();
    const anc = new Map<ActionId, Set<ActionId>>();
    const undoers = new Set<ActionId>();
    const ids = specs.map((s, i) => s.tag + i);
    const actions = specs.map((s, i) => {
      const dev = DEVICES[s.dev];
      const own = tips.get(dev);
      const par = [...new Set([...(own === undefined ? [] : [own]), ...(i === 0 ? [] : s.picks.map((p) => ids[p % i]))])];
      const seen = new Set(par.flatMap((p) => [p, ...(anc.get(p) ?? [])]));
      anc.set(ids[i], seen);
      tips.set(dev, ids[i]);
      const pool = [...seen].sort();
      const undoPool = pool.filter((x) => undoers.has(x));
      const writes = s.writes.flatMap((w): W[] => {
        if (!w.activity || pool.length === 0) return [["x" + w.unit, w.value, CAUSES[w.cause]]];
        const from = w.toActivity && undoPool.length > 0 ? undoPool : pool;
        return [["a:" + from[w.target % from.length], w.flag, w.revert ? "revert" : "undo"]];
      });
      const unique = writes.filter((w, k) => writes.findIndex((o) => o[0] === w[0]) === k);
      if (unique.some((w) => w[0].startsWith("a:"))) undoers.add(ids[i]);
      return act(ids[i], par, unique, dev);
    });
    const all = [...actions.map((_, i) => i), ...repeats.map((r) => r % actions.length)];
    return fc
      .shuffledSubarray(all, { minLength: all.length, maxLength: all.length })
      .map((delivery) => ({ actions, delivery, cuts }));
  })
  .map((c) =>
    Object.assign(c, {
      [fc.toStringMethod]: () =>
        `actions:\n${c.actions
          .map((a) => `  ${a.id} [${a.par.join(",")}] ${a.w.map((w) => `${w.u}=${String(w.v)}/${w.c}`).join(" ")}`)
          .join("\n")}\ndelivery ${c.delivery.join(",")}\ncuts ${c.cuts.join(",")}`,
    }),
  );

const batchesOf = ({ actions, delivery, cuts }: Case): Action[][] => {
  const out: Action[][] = [];
  let at = 0;
  cuts.forEach((n) => {
    if (at >= delivery.length) return;
    out.push(delivery.slice(at, at + n).map((k) => actions[k]));
    at += n;
  });
  if (at < delivery.length) out.push(delivery.slice(at).map((k) => actions[k]));
  return out;
};

const snapshot = (log: LogState, ids: readonly ActionId[]) => ({
  units: log.units(),
  order: log.order(),
  heads: log.heads,
  pending: log.pending,
  active: new Map(ids.map((id) => [id, log.active(id)])),
});

const expected = (o: OracleResult) => ({
  units: o.units,
  order: o.order,
  heads: o.heads,
  pending: o.pending,
  active: new Map(o.order.map((id) => [id, o.active.get(id)])),
});

const sameState = (a: UnitState | undefined, b: UnitState | undefined) => JSON.stringify(a) === JSON.stringify(b);

describe("LogState properties", () => {
  it("incremental adds equal a full replay and the brute-force oracle", () => {
    let flips = 0;
    let clashes = 0;
    let largest = 0;
    fc.assert(
      fc.property(arbCase, (c) => {
        largest = Math.max(largest, c.actions.length);
        const log = new LogState(rules);
        const delivered: Action[] = [];
        const problems: string[] = [];
        batchesOf(c).forEach((batch, k) => {
          const prior = oracle(delivered, rules);
          delivered.push(...batch);
          const delta = log.add(batch);
          const now = oracle(delivered, rules);
          const got = snapshot(log, now.order);
          expect(got).toEqual(expected(now));
          const changed = [...new Set([...prior.units.keys(), ...now.units.keys()])].filter(
            (u) => !sameState(prior.units.get(u), now.units.get(u)),
          );
          const missed = changed.filter((u) => !delta.units.has(u));
          if (missed.length > 0) problems.push(`batch ${k}: delta.units misses ${missed.join(",")}`);
          const flipped = now.order.filter((id) => (prior.active.get(id) ?? true) !== now.active.get(id));
          if (JSON.stringify([...delta.activity].sort()) !== JSON.stringify(flipped.sort())) {
            problems.push(`batch ${k}: activity ${[...delta.activity].join(",")} vs ${flipped.join(",")}`);
          }
          const added = now.order.filter((id) => !prior.order.includes(id));
          if (JSON.stringify(delta.added) !== JSON.stringify(added)) {
            problems.push(`batch ${k}: added ${delta.added.join(",")} vs ${added.join(",")}`);
          }
          flips += flipped.length;
        });
        expect(problems).toEqual([]);
        const final = oracle(c.actions, rules);
        const full = replay(c.actions, rules);
        expect(snapshot(full, final.order)).toEqual(expected(final));
        expect(snapshot(log, final.order)).toEqual(snapshot(full, final.order));
        clashes += [...final.units.values()].filter((s) => s.clash !== null).length > 0 ? 1 : 0;
      }),
      PARAMS,
    );
    expect(largest).toBeGreaterThan(MAX_ACTIONS / 2);
    expect(flips).toBeGreaterThan(NUM_RUNS);
    expect(clashes).toBeGreaterThan(NUM_RUNS / 4);
  }, 120_000);
});
