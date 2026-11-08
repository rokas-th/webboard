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
    expect(g.has("a")).toBe(true);
    expect(g.ready("c")).toBe(true);
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
    expect(g.seen("a1", "b")).toBe(true);
    expect(g.seen("a1", "c")).toBe(true);
    g.add(act("d", ["b", "c"]));
    expect(g.seen("b", "d")).toBe(true);
    expect(g.seen("c", "d")).toBe(true);
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

  it("ignores a repeat of a pending action and releases it once", () => {
    const g = new Graph();
    expect(g.add(act("b", ["a"]))).toEqual([]);
    expect(g.add(act("b", ["a"]))).toEqual([]);
    expect(g.pending).toEqual(["b"]);
    expect(ids(g.add(act("a")))).toEqual(["a", "b"]);
    expect(g.add(act("b", ["a"]))).toEqual([]);
    expect(g.order()).toEqual(["a", "b"]);
    expect(g.pending).toEqual([]);
  });

  it("refuses a first arrival that holds values other than plain JSON, storing nothing", () => {
    const withV = (id: ActionId, v: unknown, par: readonly ActionId[] = []): Action => ({
      ...act(id, par),
      w: [{ u: "pn", v, c: "own" }],
    });
    const g = graphOf([act("r")]);
    expect(() => g.add(withV("m", new Map([["k", 1]])))).toThrow("Action m holds a value that is not plain JSON");
    expect(g.has("m")).toBe(false);
    expect(() => g.add(withV("d", new Date(0), ["missing"]))).toThrow("Action d holds a value that is not plain JSON");
    expect(g.has("d")).toBe(false);
    expect(() => g.add({ ...act("n", ["r"]), at: Number.NaN })).toThrow("Action n holds a value that is not plain JSON");
    expect(g.has("n")).toBe(false);
    expect(g.pending).toEqual([]);
    expect(g.order()).toEqual(["r"]);
    expect(ids(g.add(withV("ok", { n: 1, gone: undefined }, ["r"])))).toEqual(["ok"]);
  });

  it("refuses a repeat that holds values other than plain JSON", () => {
    const withV = (v: unknown): Action => ({ ...act("a1"), w: [{ u: "pn", v, c: "own" }] });
    const notPlain = "Action a1 holds a value that is not plain JSON";
    const plain = graphOf([withV({ n: 1 })]);
    expect(() => plain.add(withV(new Map([["k", 2]])))).toThrow(notPlain);
    expect(() => plain.add(withV(new Date(1)))).toThrow(notPlain);
    expect(() => plain.add(withV({ n: Number.NaN }))).toThrow(notPlain);
    expect(() => plain.add(withV({ n: Infinity }))).toThrow(notPlain);
    expect(() => plain.add(withV([undefined]))).toThrow(notPlain);
    expect(() => plain.add(withV(new Set([1])))).toThrow(notPlain);
    expect(plain.add(withV({ n: 1, gone: undefined }))).toEqual([]);
    expect(plain.order()).toEqual(["a1"]);
  });

  it("returns ready actions only from get", () => {
    const a = act("a");
    const g = graphOf([a, act("p", ["missing"])]);
    expect(g.get("a")).toBe(a);
    expect(g.get("p")).toBeUndefined();
    expect(g.get("nope")).toBeUndefined();
  });

  it("keeps a copy independent of the original", () => {
    const g = graphOf([act("a"), act("c", ["b"]), act("x", ["a", "y"], "s2")]);
    const c = g.copy();
    expect(ids(c.add(act("b", ["a"])))).toEqual(["b", "c"]);
    c.add(act("d", ["c"]));
    expect(c.order()).toEqual(["a", "b", "c", "d"]);
    expect(c.heads).toEqual(["d"]);
    expect(c.pending).toEqual(["x"]);
    expect(c.seen("a", "d")).toBe(true);
    expect(g.order()).toEqual(["a"]);
    expect(g.heads).toEqual(["a"]);
    expect(g.pending).toEqual(["c", "x"]);
    expect(g.has("b")).toBe(false);
    expect(ids(g.add(act("b", ["a"], "s3")))).toEqual(["b", "c"]);
    expect(g.seen("b", "c")).toBe(true);
    expect(c.pending).toEqual(["x"]);
  });

  it("runs a ready check on every action about to become ready, before storing any", () => {
    const g = graphOf([act("a"), act("z")]);
    g.add(act("c", ["b"]));
    g.add(act("d", ["c", "z"]));
    const asked: string[] = [];
    const check = (r: Action, saw: (x: ActionId) => boolean) => {
      asked.push(`${r.id}:${["a", "b", "c", "z", "d", "nope"].filter(saw).join("")}`);
    };
    const refuse = (r: Action) => {
      if (r.id === "d") throw new Error("no d");
    };
    expect(() => g.add(act("b", ["a"]), refuse)).toThrow("no d");
    expect(g.has("b")).toBe(false);
    expect(g.pending).toEqual(["c", "d"]);
    expect(g.order()).toEqual(["a", "z"]);
    expect(ids(g.add(act("b", ["a"]), check))).toEqual(["b", "c", "d"]);
    expect(asked).toEqual(["b:a", "c:ab", "d:abcz"]);
  });

  it("refuses an action that lists itself as a parent", () => {
    const g = graphOf([act("r")]);
    expect(() => g.add(act("a", ["a"]))).toThrow("Action a lists itself as a parent");
    expect(() => g.add(act("b", ["r", "b"]))).toThrow("Action b lists itself as a parent");
    expect(g.has("a")).toBe(false);
    expect(g.has("b")).toBe(false);
    expect(g.pending).toEqual([]);
  });

  it.each([
    [["b", "c"], "c"],
    [["c", "b"], "b"],
  ])("refuses a two-member parent cycle delivered as %j", (delivery, closer) => {
    const all: Record<string, Action> = { b: act("b", ["c"]), c: act("c", ["b"]) };
    const g = new Graph();
    const first = delivery[0];
    expect(g.add(all[first])).toEqual([]);
    expect(() => g.add(all[closer])).toThrow(`Action ${closer} closes a parent cycle`);
    expect(g.pending).toEqual([first]);
    expect(g.has(closer)).toBe(false);
  });

  it.each([
    [["b", "c", "d"], "d"],
    [["d", "c", "b"], "b"],
    [["b", "d", "c"], "c"],
    [["c", "b", "d"], "d"],
  ])("refuses a three-member parent cycle delivered as %j", (delivery, closer) => {
    const all: Record<string, Action> = { b: act("b", ["c", "r"]), c: act("c", ["d"]), d: act("d", ["b"]) };
    const g = graphOf([act("r")]);
    const [one, two, three] = delivery;
    expect(g.add(all[one])).toEqual([]);
    expect(g.add(all[two])).toEqual([]);
    expect(() => g.add(all[three])).toThrow(`Action ${closer} closes a parent cycle`);
    expect(g.pending).toEqual([one, two].sort());
    expect(g.has(closer)).toBe(false);
  });

  it("does not mistake a shared missing ancestor for a cycle", () => {
    const g = new Graph();
    expect(g.add(act("c", ["b"]))).toEqual([]);
    expect(g.add(act("d", ["b", "c"]))).toEqual([]);
    expect(g.add(act("b", ["a"]))).toEqual([]);
    expect(ids(g.add(act("a")))).toEqual(["a", "b", "c", "d"]);
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

const must = <K, V>(m: ReadonlyMap<K, V>, k: K): V => {
  const v = m.get(k);
  if (v === undefined) throw new Error(`oracle: no entry for ${String(k)}`);
  return v;
};

const arbDag: fc.Arbitrary<Dag> = fc
  .record({
    specs: fc.array(fc.record({ ses: fc.nat(3), picks: fc.array(fc.nat(), { maxLength: 3 }), fork: fc.boolean() }), {
      minLength: 1,
      maxLength: 200,
      size: "max",
    }),
    repeats: fc.array(fc.nat(), { maxLength: 30 }),
  })
  .chain(({ specs, repeats }) => {
    const tips = new Map<string, number>();
    const actions = specs.map((s, i) => {
      const ses = SESSIONS[s.ses];
      const own = tips.get(ses);
      const others = i === 0 ? [] : s.picks.map((p) => p % i);
      const par = [...new Set([...(own !== undefined && !s.fork ? [own] : []), ...others])].map((k) => "x" + k);
      tips.set(ses, i);
      return act("x" + i, par, ses);
    });
    const all = [...actions.map((_, i) => i), ...repeats.map((r) => r % actions.length)];
    return fc
      .shuffledSubarray(all, { minLength: all.length, maxLength: all.length })
      .map((delivery) => ({ actions, delivery }));
  });

const ancestorsOf = (actions: readonly Action[]): Map<ActionId, Set<ActionId>> => {
  const anc = new Map<ActionId, Set<ActionId>>();
  actions.forEach((a) => anc.set(a.id, new Set([a.id, ...a.par.flatMap((p) => [...must(anc, p)])])));
  return anc;
};

const depthsOf = (actions: readonly Action[]): Map<ActionId, number> => {
  const depth = new Map<ActionId, number>();
  actions.forEach((a) => depth.set(a.id, Math.max(-1, ...a.par.map((p) => must(depth, p))) + 1));
  return depth;
};

const PARAMS: fc.Parameters<[Dag]> = { numRuns: 200, seed: 20261108 };

describe("Graph properties", () => {
  it("seen equals brute-force ancestry and order does not depend on delivery", () => {
    fc.assert(
      fc.property(arbDag, ({ actions, delivery }) => {
        const byId = new Map(actions.map((a) => [a.id, a]));
        const depth = depthsOf(actions);
        const byDepthThenId = (x: ActionId, y: ActionId) => must(depth, x) - must(depth, y) || (x < y ? -1 : x > y ? 1 : 0);
        const inOrder = graphOf(actions);
        const g = new Graph();
        const delivered = new Set<ActionId>();
        const headMismatches: string[] = [];
        const repeatReleases: string[] = [];
        const released = delivery.flatMap((k) => {
          const a = actions[k];
          const out = ids(g.add(a));
          if (delivered.has(a.id) && out.length > 0) repeatReleases.push(`${a.id} -> ${out.join(",")}`);
          delivered.add(a.id);
          const ready = g.order();
          const named = new Set(ready.flatMap((id) => must(byId, id).par));
          const expected = ready.filter((id) => !named.has(id)).sort(byDepthThenId);
          if (JSON.stringify(g.heads) !== JSON.stringify(expected)) {
            headMismatches.push(`after ${a.id}: ${g.heads.join(",")} vs ${expected.join(",")}`);
          }
          return out;
        });
        expect(repeatReleases).toEqual([]);
        expect(headMismatches).toEqual([]);
        expect(g.pending).toEqual([]);
        expect([...released].sort()).toEqual(actions.map((a) => a.id).sort());
        expect(g.order()).toEqual(inOrder.order());
        expect(g.heads).toEqual(inOrder.heads);
        const anc = ancestorsOf(actions);
        const seenMismatches = actions.flatMap((x) =>
          actions
            .filter((y) => g.seen(x.id, y.id) !== must(anc, y.id).has(x.id))
            .map((y) => `seen(${x.id}, ${y.id})`),
        );
        expect(seenMismatches).toEqual([]);
        const order = g.order();
        order.slice(1).forEach((id, i) => expect(g.before(order[i], id)).toBe(true));
        actions.forEach((a) => expect(g.depth(a.id)).toBe(must(depth, a.id)));
        actions.forEach((a) => a.par.forEach((p) => expect(g.before(p, a.id)).toBe(true)));
        expect(order).toEqual(actions.map((a) => a.id).sort(byDepthThenId));
      }),
      PARAMS,
    );
  });
});
