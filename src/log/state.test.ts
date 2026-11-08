import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LogState, replay } from "./state";
import { OWNER_CAUSES, type Action, type ActionId, type Cause, type Rules, type UnitKey, type UnitState, type Write } from "./types";
import { oracle, type OracleResult } from "../test/logOracle";

const num = (w: Write): number => {
  if (typeof w.v !== "number") throw new Error(`the test rules merge numbers only, not ${JSON.stringify(w.v)}`);
  return w.v;
};

const rules: Rules = {
  same: (_u, a, b) => JSON.stringify(a) === JSON.stringify(b),
  mergeDerived: (_u, a, b) => (num(a) > num(b) ? a : b),
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

  it("refuses each bad action with its message, storing nothing and keeping the first record", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", [], [["x", 2]], "d2"), act("p", ["q"], [["y", 1]]));
    const before = log.units();
    const cases: [Action, string][] = [
      [act("t", ["a"], [["x", 1], ["y", 2], ["x", 3]]), "Action t writes x twice"],
      [act("pt", ["missing"], [["a:a", false, "undo"], ["a:a", true, "undo"]]), "Action pt writes a:a twice"],
      [act("u", ["a"], [["y", 5], ["a:b", false, "undo"]]), "Action u writes a:b without having seen it"],
      [act("v", ["a"], [["a:v", false, "undo"]]), "Action v writes a:v without having seen it"],
      [act("pv", ["missing"], [["a:pv", true, "undo"]]), "Action pv writes a:pv without having seen it"],
      [act("w", ["a"], [["a:nobody", false, "undo"]]), "Action w writes a:nobody without having seen it"],
      [act("n", ["a"], [["a:a", 0, "undo"]]), "Action n writes a:a with a value that is not true or false"],
      [act("m", ["a"], [["y", new Map([["k", 1]])]]), "Action m holds a value that is not plain JSON"],
      [act("o", ["a", "o"], [["y", 1]]), "Action o lists itself as a parent"],
      [act("q", ["p"], [["y", 2]]), "Action q closes a parent cycle"],
      [act("a", [], [["x", 9]]), "Action a arrived twice with different contents"],
    ];
    const deltas = cases.map(([bad]) => log.add([bad]));
    expect(deltas.map((d) => d.refused)).toEqual(cases.map(([bad, message]) => [{ id: bad.id, message }]));
    expect(deltas.map((d) => [...d.units, ...d.activity, ...d.added])).toEqual(cases.map(() => []));
    expect(log.units()).toEqual(before);
    expect(log.order()).toEqual(["a", "b"]);
    expect(log.pending).toEqual(["p"]);
    expect(log.get("a")?.w).toEqual([{ u: "x", v: 1, c: "own" }]);
    expect(cases.slice(0, -1).filter(([bad]) => log.get(bad.id) !== undefined)).toEqual([]);
    expect(log.active("b")).toBe(true);
  });

  it("applies the valid actions of a call and lists the refused ones", () => {
    const log = logOf(act("a", [], [["x", 1]]));
    const delta = log.add([
      act("b", ["a"], [["x", 2]]),
      act("c", ["b"], [["y", 1], ["y", 2]]),
      act("d", ["b"], [["z", 3]]),
    ]);
    expect(delta.added).toEqual(["b", "d"]);
    expect(delta.refused).toEqual([{ id: "c", message: "Action c writes y twice" }]);
    expect([...delta.units].sort()).toEqual(["x", "z"]);
    expect(log.unit("x")).toEqual({ value: 2, from: "b", clash: null });
    expect(log.unit("y")).toBeUndefined();
    expect(log.get("c")).toBeUndefined();
    expect(log.heads).toEqual(["d"]);
  });

  it("refuses a pending child when its parent arrives, applying the parent and keeping the grandchild pending", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", [], [["x", 2]], "d2"));
    const u = act("u", ["c"], [["y", 1], ["a:b", false, "undo"]]);
    log.add([u, act("g", ["u"], [["x", 4]]), act("h", ["c"], [["z", 1]])]);
    expect(log.pending).toEqual(["g", "h", "u"]);
    const delta = log.add([act("c", ["a"], [["x", 3]])]);
    expect(delta.added).toEqual(["c", "h"]);
    expect(delta.refused).toEqual([{ id: "u", message: "Action u writes a:b without having seen it" }]);
    expect([...delta.units].sort()).toEqual(["x", "z"]);
    expect(log.pending).toEqual(["g"]);
    expect(log.get("u")).toBeUndefined();
    expect(log.get("c")?.id).toBe("c");
    expect(log.unit("x")).toEqual({ value: 3, from: "c", clash: ["b", "c"] });
    expect(log.unit("y")).toBeUndefined();
    expect(log.active("b")).toBe(true);
    expect(log.add([u]).refused).toEqual([]);
    expect(log.add([{ ...u, w: [{ u: "y", v: 1, c: "own" }] }]).refused).toEqual([
      { id: "u", message: "Action u arrived twice with different contents" },
    ]);
    expect(log.pending).toEqual(["g"]);
  });

  it("remembers a refused record, so a different repeat ends the same whichever arrives first", () => {
    const a = act("a", [], [["x", 1]]);
    const b = act("b", [], [["x", 2]], "d2");
    const u = act("u", ["c"], [["a:b", false, "undo"]]);
    const other = act("u", ["c"], [["y", 1]]);
    const g = act("g", ["u"], [["x", 4]]);
    const c = act("c", ["a"], [["x", 3]]);
    const twice = "Action u arrived twice with different contents";
    const unseen = "Action u writes a:b without having seen it";
    const run = (batches: Action[][]) => {
      const log = new LogState(rules);
      const refused = batches.map((batch) => log.add(batch).refused);
      return { log, refused };
    };
    const early = run([[a, b, u, g], [other], [c]]);
    const late = run([[a, b, u, g], [c], [other]]);
    expect(early.refused).toEqual([[], [{ id: "u", message: twice }], [{ id: "u", message: unseen }]]);
    expect(late.refused).toEqual([[], [{ id: "u", message: unseen }], [{ id: "u", message: twice }]]);
    [early.log, late.log].forEach((log) => {
      expect(log.order()).toEqual(["a", "b", "c"]);
      expect(log.pending).toEqual(["g"]);
      expect(log.get("u")).toBeUndefined();
      expect(log.unit("y")).toBeUndefined();
      expect(log.unit("x")).toEqual({ value: 3, from: "c", clash: ["b", "c"] });
    });
    expect(early.log.units()).toEqual(late.log.units());
    expect(late.log.fork().add([other]).refused).toEqual([{ id: "u", message: twice }]);
  });

  it("checks identity before contents, so a different repeat that writes a unit twice arrived twice", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("p", ["missing"], [["y", 1]]));
    log.add([act("t", ["a"], [["z", 1], ["z", 2]])]);
    const twice = (id: ActionId) => ({ id, message: `Action ${id} arrived twice with different contents` });
    expect(log.add([act("a", [], [["x", 1], ["x", 2]])]).refused).toEqual([twice("a")]);
    expect(log.add([act("p", ["missing"], [["y", 1], ["y", 2]])]).refused).toEqual([twice("p")]);
    expect(log.add([act("t", ["a"], [["z", 1], ["z", 3], ["z", 4]])]).refused).toEqual([twice("t")]);
    expect(log.add([act("t", ["a"], [["z", 1], ["z", 2]])]).refused).toEqual([]);
    expect(log.get("a")?.w).toEqual([{ u: "x", v: 1, c: "own" }]);
  });

  it("lists a refused id at most once per call", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", [], [["x", 2]], "d2"));
    const t = act("t", ["a"], [["z", 1], ["z", 2]]);
    expect(log.add([t, t, structuredClone(t)]).refused).toEqual([{ id: "t", message: "Action t writes z twice" }]);
    const other = act("a", [], [["x", 7]]);
    expect(log.add([other, other, act("a", [], [["x", 8]])]).refused).toEqual([
      { id: "a", message: "Action a arrived twice with different contents" },
    ]);
    const u = act("u", ["c"], [["a:b", false, "undo"]]);
    log.add([u]);
    const delta = log.add([act("c", ["a"], [["x", 3]]), act("u", ["c"], [["y", 1]]), u]);
    expect(delta.refused).toEqual([{ id: "u", message: "Action u writes a:b without having seen it" }]);
    expect(delta.added).toEqual(["c"]);
  });

  it("refuses the same actions in a replay as in incremental adds", () => {
    const all = [
      act("a", [], [["x", 1]]),
      act("b", [], [["x", 2]], "d2"),
      act("c", ["a"], [["x", 3]]),
      act("u", ["c"], [["a:b", false, "undo"]]),
      act("g", ["u"], [["y", 1]]),
      act("t", ["a"], [["z", 1], ["z", 2]]),
      act("k", ["c"], [["a:c", false, "undo"]]),
      act("n", ["c"], [["a:a", "no", "undo"]], "d2"),
    ];
    const byId = (r: readonly { id: ActionId; message: string }[]) => [...r].sort((x, y) => (x.id < y.id ? -1 : 1));
    const inc = new LogState(rules);
    const incRefused = [...all].reverse().flatMap((a) => inc.add([a]).refused);
    const full = new LogState(rules);
    const fullRefused = full.add(all).refused;
    expect(byId(incRefused)).toEqual(byId(fullRefused));
    expect(byId(fullRefused).map((r) => r.id)).toEqual(["n", "t", "u"]);
    const replayed = replay(all, rules);
    expect(replayed.units()).toEqual(inc.units());
    expect(replayed.pending).toEqual(["g"]);
    expect(inc.pending).toEqual(["g"]);
    expect(replayed.active("c")).toBe(false);
  });

  it("becomes unusable after a rules callback throws partway through a call", () => {
    const log = new LogState({
      ...rules,
      mergeDerived: () => {
        throw new Error("merge broke");
      },
    });
    log.add([act("a", [], [["x", 1]])]);
    const earlier = log.fork();
    expect(() =>
      log.add([act("p", [], [["y", 4, "push"]]), act("q", [], [["y", 7, "push"]], "d2"), act("r", ["a"], [["z", 1]])]),
    ).toThrow("merge broke");
    const unusable = "LogState is unusable after an earlier error: merge broke";
    expect(() => log.units()).toThrow(unusable);
    expect(() => log.add([act("s", [], [["w", 1]])])).toThrow(unusable);
    expect(() => log.fork()).toThrow(unusable);
    expect(() => log.heads).toThrow(unusable);
    expect(() => log.pending).toThrow(unusable);
    expect(() => log.get("a")).toThrow(unusable);
    expect(() => log.unit("x")).toThrow(unusable);
    expect(() => log.active("a")).toThrow(unusable);
    expect(() => log.seen("a", "a")).toThrow(unusable);
    expect(() => log.valueWithout("x", new Set())).toThrow(unusable);
    expect(() => log.order()).toThrow(unusable);
    expect(() => log.writers("x")).toThrow(unusable);
    expect(earlier.unit("x")).toEqual({ value: 1, from: "a", clash: null });
    expect(earlier.order()).toEqual(["a"]);
  });

  it("lets a later write supersede the one it has seen", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", ["a"], [["x", 2]]));
    expect(log.unit("x")).toEqual({ value: 2, from: "b", clash: null });
    expect(log.writers("x")).toEqual(["a", "b"]);
  });

  it("reports a unit's frontier: both writes made apart, then only a later write that saw both", () => {
    const log = logOf(act("a", [], [["x", 1]]), act("b", [], [["x", 2]], "d2"));
    expect(log.frontier("x")).toEqual(["a", "b"]);
    log.add([act("c", ["a", "b"], [["x", 3]])]);
    expect(log.frontier("x")).toEqual(["c"]);
    expect(log.frontier("y")).toEqual([]);
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

  it("takes the larger of two derived pushes, 4 then 7", () => {
    const apart = logOf(act("a", [], [["x", 4, "push"]]), act("b", [], [["x", 7, "push"]], "d2"));
    expect(apart.unit("x")).toEqual({ value: 7, from: "b", clash: null });
    const chained = logOf(act("a", [], [["x", 4, "push"]]), act("b", ["a"], [["x", 7, "push"]]));
    expect(chained.unit("x")).toEqual({ value: 7, from: "b", clash: null });
  });

  it("becomes unusable after a derived merge returns neither of its writes", () => {
    const log = new LogState({ ...rules, mergeDerived: (u, a) => ({ u, v: a.v, c: a.c }) });
    const message = "mergeDerived for x returned a write that is neither of its two inputs";
    expect(() => log.add([act("a", [], [["x", 4, "push"]]), act("b", [], [["x", 7, "push"]], "d2")])).toThrow(message);
    expect(() => log.unit("x")).toThrow(`LogState is unusable after an earlier error: ${message}`);
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

type Fate = "normal" | "unseen" | "loose" | "twice" | "withheld" | "doomed";

const fateOf = (n: number): Fate =>
  n === 0 ? "unseen" : n === 1 ? "loose" : n === 2 ? "twice" : n === 3 ? "withheld" : n <= 5 ? "doomed" : "normal";

const arbCase: fc.Arbitrary<Case> = fc
  .record({
    specs: fc.array(
      fc.record({
        dev: fc.nat(DEVICES.length - 1),
        tag: fc.constantFrom("a", "b", "c"),
        picks: fc.array(fc.nat(), { maxLength: 2 }),
        writes: fc.array(arbWrite, { minLength: 1, maxLength: 3 }),
        fate: fc.nat(39),
        aim: fc.nat(),
        variant: fc.nat(9),
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
    const normal: ActionId[] = [];
    const off: ActionId[] = [];
    const withheld = new Set<ActionId>();
    const variants: Action[] = [];
    const actions = specs.map((s, i) => {
      const id = ids[i];
      const fate = fateOf(s.fate);
      const dev = DEVICES[s.dev];
      const own = tips.get(dev);
      const from = fate === "normal" ? normal : ids.slice(0, i);
      const picked = from.length === 0 ? [] : s.picks.map((p) => from[p % from.length]);
      const doom = fate === "doomed" && off.length > 0 ? [off[s.aim % off.length]] : [];
      const par = [...new Set([...(own === undefined ? [] : [own]), ...picked, ...doom])];
      const seen = new Set(par.flatMap((p) => [p, ...(anc.get(p) ?? [])]));
      anc.set(id, seen);
      const pool = [...seen].sort();
      const undoPool = pool.filter((x) => undoers.has(x));
      const writes = s.writes.flatMap((w): W[] => {
        if (!w.activity || pool.length === 0) return [["x" + w.unit, w.value, CAUSES[w.cause]]];
        const targets = w.toActivity && undoPool.length > 0 ? undoPool : pool;
        return [["a:" + targets[w.target % targets.length], w.flag, w.revert ? "revert" : "undo"]];
      });
      const unique = writes.filter((w, k) => writes.findIndex((o) => o[0] === w[0]) === k);
      const unseen = ids.filter((x) => !seen.has(x));
      const bad: W[] =
        fate === "unseen"
          ? [["a:" + unseen[s.aim % unseen.length], false, "undo"]]
          : fate === "loose"
            ? [["a:" + (pool.length === 0 ? id : pool[s.aim % pool.length]), s.aim % 3, "undo"]]
            : fate === "twice"
              ? [[unique[0][0], 9, "own"]]
              : [];
      if (fate === "normal") {
        tips.set(dev, id);
        normal.push(id);
        if (unique.some((w) => w[0].startsWith("a:"))) undoers.add(id);
      } else off.push(id);
      if (fate === "withheld") withheld.add(id);
      if (s.variant < (fate === "normal" ? 1 : 5)) variants.push({ ...act(id, par, unique, dev), lbl: id + "'" });
      return act(id, par, [...unique, ...bad], dev);
    });
    const records = [...actions, ...variants];
    const sent = actions.flatMap((a, i) => (withheld.has(a.id) ? [] : [i]));
    const twins = variants.map((_, k) => actions.length + k);
    const all = [...sent, ...twins, ...(sent.length === 0 ? [] : repeats.map((r) => sent[r % sent.length]))];
    return fc
      .shuffledSubarray(all, { minLength: all.length, maxLength: all.length })
      .map((delivery) => ({ actions: records, delivery, cuts }));
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

const touchedBy = (o: OracleResult, actions: ReadonlyMap<ActionId, Action>, added: readonly ActionId[]) => {
  const reach = new Set<ActionId>();
  const queue = [...added];
  for (const id of queue) {
    const a = actions.get(id);
    if (a === undefined) throw new Error(`no action ${id}`);
    a.w.forEach((w) => {
      const t = w.u.startsWith("a:") ? w.u.slice(2) : null;
      if (t !== null && !reach.has(t) && o.order.includes(t)) {
        reach.add(t);
        queue.push(t);
      }
    });
  }
  return new Set(queue.flatMap((id) => actions.get(id)?.w.map((w) => w.u) ?? []));
};

const TWICE = (id: ActionId) => `Action ${id} arrived twice with different contents`;

const allowed = (o: OracleResult, id: ActionId, message: string) =>
  o.refused.get(id) === message || (o.conflicts.has(id) && message === TWICE(id));

describe("LogState properties", () => {
  it("incremental adds equal a full replay and the brute-force oracle, refusals and pending included", () => {
    let flips = 0;
    let clashes = 0;
    let largest = 0;
    let refusedRuns = 0;
    let releasedRefusals = 0;
    let pendingRuns = 0;
    let conflictRuns = 0;
    let readinessConflicts = 0;
    fc.assert(
      fc.property(arbCase, (c) => {
        largest = Math.max(largest, new Set(c.actions.map((a) => a.id)).size);
        const byId = new Map<ActionId, Action>();
        const log = new LogState(rules);
        const delivered: Action[] = [];
        const refusedSoFar = new Map<ActionId, Set<string>>();
        const problems: string[] = [];
        batchesOf(c).forEach((batch, k) => {
          const prior = oracle(delivered, rules);
          delivered.push(...batch);
          batch.forEach((a) => {
            if (!byId.has(a.id)) byId.set(a.id, a);
          });
          const different = new Set(batch.filter((a) => byId.get(a.id) !== a).map((a) => a.id));
          const delta = log.add(batch);
          const now = oracle(delivered, rules);
          const got = snapshot(log, now.order);
          expect(got).toEqual(expected(now));
          const changed = [...new Set([...prior.units.keys(), ...now.units.keys()])].filter(
            (u) => !sameState(prior.units.get(u), now.units.get(u)),
          );
          const missed = changed.filter((u) => !delta.units.has(u));
          if (missed.length > 0) problems.push(`batch ${k}: delta.units misses ${missed.join(",")}`);
          const added = now.order.filter((id) => !prior.order.includes(id));
          const touched = touchedBy(now, byId, added);
          const extra = [...delta.units].filter((u) => !touched.has(u));
          if (extra.length > 0) problems.push(`batch ${k}: delta.units lists untouched ${extra.join(",")}`);
          const flipped = now.order.filter((id) => (prior.active.get(id) ?? true) !== now.active.get(id));
          if (JSON.stringify([...delta.activity].sort()) !== JSON.stringify(flipped.sort())) {
            problems.push(`batch ${k}: activity ${[...delta.activity].join(",")} vs ${flipped.join(",")}`);
          }
          if (JSON.stringify(delta.added) !== JSON.stringify(added)) {
            problems.push(`batch ${k}: added ${delta.added.join(",")} vs ${added.join(",")}`);
          }
          const inBatch = new Set(batch.map((a) => a.id));
          const fresh = [...now.refused.keys()].filter((id) => !prior.refused.has(id));
          const listed = new Set(delta.refused.map((r) => r.id));
          if (listed.size !== delta.refused.length) problems.push(`batch ${k}: an id listed twice in refused`);
          const unknown = [...different].filter((id) => !now.conflicts.has(id));
          if (unknown.length > 0) problems.push(`batch ${k}: oracle misses conflicts ${unknown.join(",")}`);
          delta.refused.forEach((r) => {
            const judged = fresh.includes(r.id) && now.refused.get(r.id) === r.message;
            const repeated = different.has(r.id) && r.message === TWICE(r.id);
            if (!judged && !repeated) problems.push(`batch ${k}: refused ${r.id} "${r.message}"`);
            if (!inBatch.has(r.id) && !fresh.includes(r.id)) problems.push(`batch ${k}: refused ${r.id} again unasked`);
            refusedSoFar.set(r.id, new Set([...(refusedSoFar.get(r.id) ?? []), r.message]));
            if (judged && prior.pending.includes(r.id)) releasedRefusals += 1;
          });
          const unlisted = [...fresh, ...different].filter((id) => !listed.has(id));
          if (unlisted.length > 0) problems.push(`batch ${k}: refused but not listed ${unlisted.join(",")}`);
          flips += flipped.length;
        });
        expect(problems).toEqual([]);
        const final = oracle(delivered, rules);
        const full = replay(delivered, rules);
        expect(snapshot(full, final.order)).toEqual(expected(final));
        expect(snapshot(log, final.order)).toEqual(snapshot(full, final.order));
        const expectedIds = [...new Set([...final.refused.keys(), ...final.conflicts])].sort();
        const once = new LogState(rules).add(delivered).refused;
        expect(once.map((r) => r.id).sort()).toEqual(expectedIds);
        expect(once.filter((r) => !allowed(final, r.id, r.message))).toEqual([]);
        expect([...refusedSoFar.keys()].sort()).toEqual(expectedIds);
        expect([...refusedSoFar].flatMap(([id, ms]) => [...ms].filter((m) => !allowed(final, id, m)))).toEqual([]);
        conflictRuns += final.conflicts.size > 0 ? 1 : 0;
        readinessConflicts += [...final.conflicts].filter((id) => {
          const first = byId.get(id);
          const m = final.refused.get(id);
          return first !== undefined && m !== undefined && m.endsWith("without having seen it") &&
            !first.w.some((w) => w.u === "a:" + id);
        }).length;
        clashes += [...final.units.values()].filter((s) => s.clash !== null).length > 0 ? 1 : 0;
        refusedRuns += final.refused.size > 0 ? 1 : 0;
        pendingRuns += final.pending.length > 0 ? 1 : 0;
      }),
      PARAMS,
    );
    expect(largest).toBeGreaterThan(MAX_ACTIONS / 2);
    expect(flips).toBeGreaterThan(NUM_RUNS);
    expect(clashes).toBeGreaterThan(NUM_RUNS / 4);
    expect(refusedRuns).toBeGreaterThan(NUM_RUNS / 2);
    expect(releasedRefusals).toBeGreaterThan(NUM_RUNS / 10);
    expect(pendingRuns).toBeGreaterThan(NUM_RUNS / 2);
    expect(conflictRuns).toBeGreaterThan(NUM_RUNS / 2);
    expect(readinessConflicts).toBeGreaterThan(NUM_RUNS / 10);
  }, 120_000);
});
