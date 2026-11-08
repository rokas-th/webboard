import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Graph } from "./graph";
import type { Action, ActionId } from "./types";

const act = (id: ActionId, par: readonly ActionId[] = [], ses = "s1"): Action => ({
  id,
  dev: "d-" + ses,
  ses,
  at: 0,
  par,
  lbl: id,
  w: [{ u: "pn", v: { name: id, list: [1, 2] }, c: "own" }],
});

const ids = (actions: readonly Action[]) => actions.map((a) => a.id);

const graphOf = (actions: readonly Action[]) => {
  const g = new Graph();
  actions.forEach((a) => g.add(a));
  return g;
};

describe("Graph", () => {
  it("tracks heads, depths and ancestry along a chain", () => {
    const g = graphOf([act("a"), act("b", ["a"]), act("c", ["b"])]);
    expect(g.heads).toEqual(["c"]);
    expect(["a", "b", "c"].map((id) => g.depth(id))).toEqual([0, 1, 2]);
    expect(g.seen("a", "c")).toBe(true);
    expect(g.seen("c", "a")).toBe(false);
    expect(g.seen("b", "b")).toBe(true);
    expect(g.has("a") && g.ready("c")).toBe(true);
    expect(g.pending).toEqual([]);
  });

  it("orders siblings by depth, then id, and keeps them unseen by each other", () => {
    const g = graphOf([act("a"), act("z", ["a"], "s2"), act("m", ["a"], "s1")]);
    expect(g.order()).toEqual(["a", "m", "z"]);
    expect(g.heads).toEqual(["m", "z"]);
    expect(g.seen("m", "z")).toBe(false);
    expect(g.seen("z", "m")).toBe(false);
    expect(g.before("a", "m")).toBe(true);
    expect(g.before("m", "z")).toBe(true);
    expect(g.before("z", "m")).toBe(false);
    expect(g.before("m", "m")).toBe(false);
  });

  it("holds children until their parent arrives", () => {
    const g = new Graph();
    expect(g.add(act("c", ["b"]))).toEqual([]);
    expect(g.add(act("b", ["a"]))).toEqual([]);
    expect(g.pending).toEqual(["b", "c"]);
    expect(g.has("b")).toBe(true);
    expect(g.ready("b")).toBe(false);
    expect(g.has("a")).toBe(false);
    expect(ids(g.add(act("a")))).toEqual(["a", "b", "c"]);
    expect(g.pending).toEqual([]);
    expect(g.heads).toEqual(["c"]);
    expect(g.order()).toEqual(["a", "b", "c"]);
  });

  it("keeps an action whose parent never arrives pending", () => {
    const g = graphOf([act("a"), act("b", ["a", "x"])]);
    expect(g.pending).toEqual(["b"]);
    expect(g.order()).toEqual(["a"]);
    expect(g.heads).toEqual(["a"]);
  });

  it("knows what a merge point has seen across sessions", () => {
    const g = graphOf([
      act("a1", [], "S1"),
      act("a2", ["a1"], "S1"),
      act("a3", ["a2"], "S1"),
      act("b1", ["a1"], "S2"),
      act("b2", ["b1", "a2"], "S2"),
    ]);
    expect(g.seen("a2", "b2")).toBe(true);
    expect(g.seen("a1", "b2")).toBe(true);
    expect(g.seen("b1", "b2")).toBe(true);
    expect(g.seen("a3", "b2")).toBe(false);
    expect(g.seen("b1", "a3")).toBe(false);
    expect(g.seen("b2", "a3")).toBe(false);
    expect(g.depth("b2")).toBe(2);
    expect(g.heads).toEqual(["a3", "b2"]);
  });

  it("treats a forked session as two chains", () => {
    const g = graphOf([act("a1"), act("b", ["a1"]), act("c", ["a1"])]);
    expect(g.seen("b", "c")).toBe(false);
    expect(g.seen("c", "b")).toBe(false);
    expect(g.seen("a1", "b") && g.seen("a1", "c")).toBe(true);
    g.add(act("d", ["b", "c"]));
    expect(g.seen("b", "d") && g.seen("c", "d")).toBe(true);
    expect(g.heads).toEqual(["d"]);
  });

  it("ignores a repeat and refuses a different record under the same id", () => {
    const g = graphOf([act("a1")]);
    expect(g.add(act("a1"))).toEqual([]);
    expect(g.add(structuredClone(act("a1")))).toEqual([]);
    expect(g.order()).toEqual(["a1"]);
    expect(() => g.add({ ...act("a1"), lbl: "other" })).toThrow("Action a1 arrived twice with different contents");
    expect(() => g.add({ ...act("a1"), w: [{ u: "pn", v: { name: "a1", list: [2, 1] }, c: "own" }] })).toThrow(
      "Action a1 arrived twice with different contents",
    );
    expect(() => g.add({ ...act("a1"), meta: { undo: "x" } })).toThrow(
      "Action a1 arrived twice with different contents",
    );
    g.add(act("p", ["missing"]));
    expect(g.add(act("p", ["missing"]))).toEqual([]);
    expect(() => g.add(act("p", ["other"]))).toThrow("Action p arrived twice with different contents");
    expect(g.pending).toEqual(["p"]);
  });

  it("throws on questions about actions that are not ready", () => {
    const g = graphOf([act("a"), act("b", ["x"])]);
    expect(() => g.depth("b")).toThrow("Action b is not ready");
    expect(() => g.seen("a", "nope")).toThrow("Action nope is not ready");
    expect(() => g.before("nope", "a")).toThrow("Action nope is not ready");
  });
});

interface Dag {
  actions: Action[];
  delivery: number[];
}

const SESSIONS = ["S1", "S2", "S3", "S4"];

const arbDag: fc.Arbitrary<Dag> = fc
  .array(fc.record({ ses: fc.nat(3), picks: fc.array(fc.nat(), { maxLength: 3 }), fork: fc.boolean() }), {
    minLength: 1,
    maxLength: 200,
    size: "max",
  })
  .chain((specs) => {
    const tips = new Map<string, number>();
    const actions = specs.map((s, i) => {
      const ses = SESSIONS[s.ses];
      const own = tips.get(ses);
      const others = i === 0 ? [] : s.picks.map((p) => p % i);
      const par = [...new Set([...(own !== undefined && !s.fork ? [own] : []), ...others])].map((k) => "x" + k);
      tips.set(ses, i);
      return act("x" + i, par, ses);
    });
    return fc.shuffledSubarray(
      actions.map((_, i) => i),
      { minLength: actions.length, maxLength: actions.length },
    ).map((delivery) => ({ actions, delivery }));
  });

const ancestorsOf = (actions: readonly Action[]): Map<ActionId, Set<ActionId>> => {
  const anc = new Map<ActionId, Set<ActionId>>();
  actions.forEach((a) => anc.set(a.id, new Set([a.id, ...a.par.flatMap((p) => [...(anc.get(p) ?? [])])])));
  return anc;
};

const PARAMS: fc.Parameters<[Dag]> = { numRuns: 200, seed: 20261108 };

describe("Graph properties", () => {
  it("seen equals brute-force ancestry and order does not depend on delivery", () => {
    fc.assert(
      fc.property(arbDag, ({ actions, delivery }) => {
        const inOrder = graphOf(actions);
        const g = new Graph();
        const released = delivery.flatMap((k) => ids(g.add(actions[k])));
        expect(g.pending).toEqual([]);
        expect([...released].sort()).toEqual(actions.map((a) => a.id).sort());
        expect(g.order()).toEqual(inOrder.order());
        expect(g.heads).toEqual(inOrder.heads);
        const anc = ancestorsOf(actions);
        const step = Math.max(1, Math.floor(actions.length / 25));
        const sample = actions.filter((_, i) => i % step === 0);
        sample.forEach((x) =>
          actions.forEach((y) => {
            expect(g.seen(x.id, y.id)).toBe(anc.get(y.id)?.has(x.id) ?? false);
            expect(g.seen(y.id, x.id)).toBe(anc.get(x.id)?.has(y.id) ?? false);
          }),
        );
        const order = g.order();
        order.slice(1).forEach((id, i) => expect(g.before(order[i], id)).toBe(true));
        const depth = new Map<ActionId, number>();
        actions.forEach((a) => depth.set(a.id, Math.max(-1, ...a.par.map((p) => depth.get(p) ?? NaN)) + 1));
        actions.forEach((a) => expect(g.depth(a.id)).toBe(depth.get(a.id)));
        actions.forEach((a) => a.par.forEach((p) => expect(g.before(p, a.id)).toBe(true)));
        const byDepthThenId = actions
          .map((a) => a.id)
          .sort((x, y) => (depth.get(x) ?? NaN) - (depth.get(y) ?? NaN) || (x < y ? -1 : x > y ? 1 : 0));
        expect(order).toEqual(byDepthThenId);
      }),
      PARAMS,
    );
  });
});
