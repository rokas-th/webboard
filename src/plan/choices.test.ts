import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { choiceOf, choices, fnv1a64, heldItems, sideText, type Choice } from "./choices";
import { projectPlan } from "./project";
import { planRules } from "./rules";
import { LogState } from "../log/state";
import type { Action, Cause, DeviceId, Write } from "../log/types";
import { act } from "../test/act";

const DEVICES: ReadonlyMap<DeviceId, string> = new Map([
  ["d1", "Mac"],
  ["d2", "iPhone"],
  ["d3", "iPad"],
]);

const mac = { dev: "d1" };
const iph = { dev: "d2" };
const ipad = { dev: "d3" };

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const sched = (start: string | null, dur = 3): unknown[] => [start, dur, "todo", 0, "later"];

const item = (id: string, kind: "task" | "milestone" | "group", name: string, parent: string | null, order: string, s?: unknown[]): Write[] => [
  w(`e:${id}`, { k: kind, t: false }),
  w(`n:${id}`, name),
  ...(s === undefined ? [] : [w(`s:${id}`, s)]),
  w(`p:${id}`, [parent, order]),
];

const plan0 = [w("pn", "Plan"), w("cw", [1, 2, 3, 4, 5]), w("cr", null)];

const a0 = act("a0", [], [
  ...plan0,
  ...item("A", "task", "Alpha", null, "a0", sched("2026-11-16")),
  ...item("B", "task", "Beta", null, "a1", sched("2026-11-19")),
  w("l:A>B", ["FS", 1]),
  ...item("S", "group", "Sprint 4", null, "a2"),
  ...item("R", "task", "Review", "S", "a0", sched("2026-11-23")),
  ...item("GA", "group", "Design", null, "a3"),
  ...item("GB", "group", "Build", null, "a4"),
  w("b:X", { name: "Baseline", at: "2026-11-01", dates: {} }),
]);

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  expect(log.pending).toEqual([]);
  return log;
};

const run = (...actions: Action[]) => {
  const log = logOf(a0, ...actions);
  const plan = projectPlan("P", log);
  const cs = choices(log, plan, DEVICES);
  return { log, plan, cs, held: heldItems(cs, plan) };
};

const only = (cs: readonly Choice[]): Choice => {
  expect(cs).toHaveLength(1);
  return cs[0];
};

const labels = (c: Choice) => c.sides.map((s) => s.label);

describe("fnv1a64", () => {
  it("matches the published FNV-1a 64 vectors as 11-char base64url", () => {
    expect(fnv1a64("")).toBe("y_Kc5IQiIyU");
    expect(fnv1a64("a")).toBe("r2PcTIYB7Iw");
    expect(fnv1a64("foobar")).toBe("hZRBcfc5Z-g");
  });
});

describe("choices", () => {
  it("a rename made apart is an items choice with a side per device and holds nothing", () => {
    const { cs, held } = run(act("m1", ["a0"], [w("n:A", "Alpha one")], mac), act("p1", ["a0"], [w("n:A", "Alpha two")], iph));
    const c = only(cs);
    expect(c.kind).toBe("items");
    expect(c.units).toEqual(["n:A"]);
    expect(c.items).toEqual(["A"]);
    expect(labels(c)).toEqual(["Mac", "iPhone"]);
    expect(c.sides.map((s) => s.key)).toEqual(["m1", "p1"]);
    expect(c.sides.map((s) => s.actions)).toEqual([["m1"], ["p1"]]);
    expect(c.sides.map((s) => s.values.get("n:A"))).toEqual(["Alpha one", "Alpha two"]);
    expect(c.id).toBe(fnv1a64("m1,p1"));
    expect(c.id).toHaveLength(11);
    expect([...held]).toEqual([]);
  });

  it("the id hashes the sorted participant ids", () => {
    const { cs } = run(act("z1", ["a0"], [w("n:A", "Alpha one")], mac), act("b1", ["a0"], [w("n:A", "Alpha two")], iph));
    expect(only(cs).id).toBe(fnv1a64("b1,z1"));
  });

  it("three devices setting a schedule apart give three sides and hold the item", () => {
    const { cs, held } = run(
      act("m1", ["a0"], [w("s:A", sched("2026-11-17"))], mac),
      act("p1", ["a0"], [w("s:A", sched("2026-11-18"))], iph),
      act("t1", ["a0"], [w("s:A", sched("2026-11-20"))], ipad),
    );
    const c = only(cs);
    expect(c.kind).toBe("items");
    expect(labels(c)).toEqual(["Mac", "iPhone", "iPad"]);
    expect([...held]).toEqual(["A"]);
  });

  it("two moves on the Mac against one iPhone action form one choice with both Mac actions on one side", () => {
    const { cs } = run(
      act("m1", ["a0"], [w("s:A", sched("2026-11-17"))], mac),
      act("m2", ["m1"], [w("s:B", sched("2026-11-24"))], mac),
      act("p1", ["a0"], [w("s:A", sched("2026-11-18")), w("s:B", sched("2026-11-25"))], iph),
    );
    const c = only(cs);
    expect(c.units).toEqual(["s:A", "s:B"]);
    expect(c.items).toEqual(["A", "B"]);
    expect(c.sides.map((s) => s.actions)).toEqual([["m1", "m2"], ["p1"]]);
    expect(labels(c)).toEqual(["Mac", "iPhone"]);
    expect(c.sides[0].values.get("s:B")).toEqual(sched("2026-11-24"));
    expect(c.sides[1].values.get("s:A")).toEqual(sched("2026-11-18"));
  });

  it("a causal branch with Mac and iPhone actions is one side labelled Mac + iPhone", () => {
    const { cs } = run(
      act("m1", ["a0"], [w("n:A", "Alpha Mac")], mac),
      act("p2", ["m1"], [w("n:B", "Beta iPhone")], iph),
      act("t1", ["a0"], [w("n:A", "Alpha iPad"), w("n:B", "Beta iPad")], ipad),
    );
    const c = only(cs);
    expect(c.units).toEqual(["n:A", "n:B"]);
    expect(labels(c)).toEqual(["Mac + iPhone", "iPad"]);
    expect(c.sides.map((s) => s.actions)).toEqual([["m1", "p2"], ["t1"]]);
  });

  it("a backup of the Mac acting in a new session is the earlier copy", () => {
    const { cs } = run(
      act("m1", ["a0"], [w("n:A", "One")], mac),
      act("m2", ["m1"], [w("n:A", "Two")], mac),
      act("k1", ["a0"], [w("n:A", "Three")], { dev: "d1", ses: "restored" }),
    );
    expect(labels(only(cs))).toEqual(["Mac — earlier copy", "Mac"]);
  });

  it("an unknown device reads Device and the first four characters of its id", () => {
    const { cs } = run(act("m1", ["a0"], [w("n:A", "One")], mac), act("p1", ["a0"], [w("n:A", "Two")], { dev: "zq81xy" }));
    expect(labels(only(cs))).toEqual(["Mac", "Device zq81"]);
  });

  it("weekdays set apart are a calendar choice that holds nothing", () => {
    const { cs, held } = run(act("m1", ["a0"], [w("cw", [1, 2, 3, 4])], mac), act("p1", ["a0"], [w("cw", [1, 2, 3, 4, 5, 6])], iph));
    const c = only(cs);
    expect(c.kind).toBe("calendar");
    expect(c.units).toEqual(["cw"]);
    expect(c.items).toEqual([]);
    expect([...held]).toEqual([]);
  });

  it("a link clash holds its successor", () => {
    const { cs, held } = run(act("m1", ["a0"], [w("l:A>B", ["FS", 0])], mac), act("p1", ["a0"], [w("l:A>B", ["FS", 2])], iph));
    const c = only(cs);
    expect(c.kind).toBe("items");
    expect(c.units).toEqual(["l:A>B"]);
    expect(c.items).toEqual(["B"]);
    expect([...held]).toEqual(["B"]);
  });

  it("trashing a group while the iPhone renames a child is a delete choice", () => {
    const { cs, plan, held } = run(
      act("m1", ["a0"], [w("e:S", { k: "group", t: true })], mac),
      act("p1", ["a0"], [w("n:R", "Final review")], iph),
    );
    const c = only(cs);
    expect(c.kind).toBe("delete");
    expect(c.units).toEqual(["e:S", "n:R"]);
    expect(c.items).toEqual(["S", "R"]);
    expect(labels(c)).toEqual(["Mac", "iPhone"]);
    expect(c.sides[0].values.get("e:S")).toEqual({ k: "group", t: true });
    expect(c.sides[0].values.get("n:R")).toBe("Review");
    expect(c.sides[1].values.get("e:S")).toEqual({ k: "group", t: false });
    expect(c.sides[1].values.get("n:R")).toBe("Final review");
    expect(sideText(c, "m1", plan)).toBe("“Sprint 4” stays in the Trash");
    expect(sideText(c, "p1", plan)).toBe("“Sprint 4” is restored with the iPhone's edit");
    expect([...held]).toEqual([]);
  });

  it("a child moved out of the trashed group is said to move out of it", () => {
    const { cs, plan } = run(
      act("m1", ["a0"], [w("e:S", { k: "group", t: true })], mac),
      act("p1", ["a0"], [w("p:R", [null, "a5"])], iph),
    );
    const c = only(cs);
    expect(c.kind).toBe("delete");
    expect(c.units).toEqual(["e:S", "p:R"]);
    expect(sideText(c, "m1", plan)).toBe("“Sprint 4” stays in the Trash");
    expect(sideText(c, "p1", plan)).toBe("“Review” is moved out of it");
  });

  it("a second device editing the trashed group's child apart adds a third side", () => {
    const { cs, held } = run(
      act("m1", ["a0"], [w("e:S", { k: "group", t: true })], mac),
      act("p1", ["a0"], [w("n:R", "Final review")], iph),
      act("t1", ["a0"], [w("s:R", sched("2026-11-25"))], ipad),
    );
    const c = only(cs);
    expect(c.kind).toBe("delete");
    expect(c.units).toEqual(["e:S", "n:R", "s:R"]);
    expect(labels(c)).toEqual(["Mac", "iPhone", "iPad"]);
    expect([...held]).toEqual(["R"]);
  });

  it("undoing a create while the iPhone, having seen it, renames the item is a delete choice", () => {
    const { cs, plan } = run(
      act("c", ["a0"], item("N", "task", "New", null, "a6", sched("2026-11-16")), mac),
      act("r", ["c"], [w("n:N", "Newer")], iph),
      act("u0", ["c"], [w("a:c", false, "undo")], { dev: "d1", meta: { undo: "c" } }),
    );
    const c = only(cs);
    expect(c.kind).toBe("delete");
    expect(c.units).toEqual(["e:N", "n:N"]);
    expect(c.sides.map((s) => s.key)).toEqual(["r", "u0"]);
    expect(c.sides.find((s) => s.key === "u0")?.values.get("e:N")).toEqual({ k: "task", t: true });
    expect(c.sides.find((s) => s.key === "r")?.values.get("e:N")).toEqual({ k: "task", t: false });
    expect(sideText(c, "u0", plan)).toBe("“Newer” stays in the Trash");
    expect(sideText(c, "r", plan)).toBe("“Newer” is restored with the iPhone's edit");
  });

  it("an undo on the Mac against an undo then redo on the iPhone is an activity choice", () => {
    const { cs, held } = run(
      act("b", ["a0"], [w("n:A", "Alpha b")], mac),
      act("u0", ["b"], [w("a:b", false, "undo")], { dev: "d1", meta: { undo: "b" } }),
      act("u1", ["b"], [w("a:b", false, "undo")], { dev: "d2", meta: { undo: "b" } }),
      act("u2", ["u1"], [w("a:b", true, "undo")], { dev: "d2", meta: { redo: "u1" } }),
    );
    const c = only(cs);
    expect(c.kind).toBe("activity");
    expect(c.units).toEqual(["a:b"]);
    expect(c.items).toEqual(["A"]);
    expect(labels(c)).toEqual(["Mac", "iPhone"]);
    expect(c.sides.map((s) => s.actions)).toEqual([["u0"], ["u2"]]);
    expect([...held]).toEqual(["A"]);
  });

  it("three devices disagreeing on an undo give an activity choice with three sides", () => {
    const { cs } = run(
      act("b", ["a0"], [w("n:A", "Alpha b")], mac),
      act("u0", ["b"], [w("a:b", false, "undo")], { dev: "d1", meta: { undo: "b" } }),
      act("u1", ["b"], [w("a:b", false, "undo")], { dev: "d2", meta: { undo: "b" } }),
      act("u2", ["u1"], [w("a:b", true, "undo")], { dev: "d2", meta: { redo: "u1" } }),
      act("v0", ["b"], [w("a:b", false, "undo")], { dev: "d3", meta: { undo: "b" } }),
    );
    const c = only(cs);
    expect(c.kind).toBe("activity");
    expect(labels(c)).toEqual(["Mac", "iPad", "iPhone"]);
  });

  it("three devices setting weekdays apart give a calendar choice with three sides", () => {
    const { cs } = run(
      act("m1", ["a0"], [w("cw", [1, 2, 3, 4])], mac),
      act("p1", ["a0"], [w("cw", [1, 2, 3, 4, 5, 6])], iph),
      act("t1", ["a0"], [w("cw", [2, 3, 4, 5])], ipad),
    );
    const c = only(cs);
    expect(c.kind).toBe("calendar");
    expect(labels(c)).toEqual(["Mac", "iPhone", "iPad"]);
  });

  it("two resolutions made apart are a resolutions choice labelled by result", () => {
    const s = (start: string, dur: number) => [start, dur, "todo", 0, "later"];
    const base = act("a0", [], [
      ...plan0,
      ...item("PFF", "task", "Plan file format", null, "a0", s("2026-11-16", 3)),
      ...item("Spec", "task", "Spec", null, "a1", s("2026-11-19", 3)),
      ...item("Build", "task", "Build", null, "a2", s("2026-11-24", 5)),
      ...item("Review", "task", "Review", null, "a3", s("2026-12-01", 2)),
      ...item("Ship", "task", "Ship", null, "a4", s("2026-12-03", 1)),
      w("l:PFF>Spec", ["FS", 0]),
      w("l:Spec>Build", ["FS", 0]),
      w("l:Build>Review", ["FS", 0]),
      w("l:Review>Ship", ["FS", 0]),
    ]);
    const m1 = act("m1", ["a0"], [w("s:PFF", s("2026-11-19", 3))], mac);
    const p1 = act("p1", ["a0"], [
      w("s:PFF", s("2026-11-25", 3)),
      w("s:Spec", s("2026-11-30", 3), "push"),
      w("s:Build", s("2026-12-03", 5), "push"),
      w("s:Review", s("2026-12-10", 2), "push"),
      w("s:Ship", s("2026-12-14", 1), "push"),
    ], iph);
    const before = logOf(base, m1, p1);
    const c = only(choices(before, projectPlan("P", before), DEVICES));
    expect(c.kind).toBe("items");
    const resolves = { resolves: c.id };
    const r1 = act("R1", ["m1", "p1"], [w("s:PFF", s("2026-11-25", 3), "resolution")], { dev: "d1", meta: resolves });
    const r2 = act("R2", ["m1", "p1"], [
      w("s:PFF", s("2026-11-19", 3), "resolution"),
      w("s:Spec", s("2026-11-19", 3), "resolution"),
      w("s:Build", s("2026-11-24", 5), "resolution"),
      w("s:Review", s("2026-12-01", 2), "resolution"),
      w("s:Ship", s("2026-12-03", 1), "resolution"),
    ], { dev: "d2", meta: resolves });
    const log = logOf(base, m1, p1, r1, r2);
    const rc = only(choices(log, projectPlan("P", log), DEVICES));
    expect(rc.kind).toBe("resolutions");
    expect(rc.units).toEqual(["s:PFF"]);
    expect(rc.sides.map((x) => x.key)).toEqual(["R1", "R2"]);
    expect(labels(rc)).toEqual(["“Plan file format” starts 25 Nov, 4 items move", "“Plan file format” starts 19 Nov"]);
  });

  it("three different resolutions made apart are a resolutions choice with three sides", () => {
    const m1 = act("m1", ["a0"], [w("s:A", sched("2026-11-17"))], mac);
    const p1 = act("p1", ["a0"], [w("s:A", sched("2026-11-18"))], iph);
    const t1 = act("t1", ["a0"], [w("s:A", sched("2026-11-20"))], ipad);
    const first = only(run(m1, p1, t1).cs);
    const meta = { resolves: first.id };
    const par = ["m1", "p1", "t1"];
    const { cs } = run(
      m1,
      p1,
      t1,
      act("R1", par, [w("s:A", sched("2026-11-17"), "resolution")], { dev: "d1", meta }),
      act("R2", par, [w("s:A", sched("2026-11-18"), "resolution")], { dev: "d2", meta }),
      act("R3", par, [w("s:A", sched("2026-11-20"), "resolution")], { dev: "d3", meta }),
    );
    const c = only(cs);
    expect(c.kind).toBe("resolutions");
    expect(labels(c)).toEqual(["“Alpha” starts 17 Nov", "“Alpha” starts 18 Nov", "“Alpha” starts 20 Nov"]);
  });

  it("a resolution with no schedule difference is labelled by its history label", () => {
    const m1 = act("m1", ["a0"], [w("n:A", "One")], mac);
    const p1 = act("p1", ["a0"], [w("n:A", "Two")], iph);
    const meta = { resolves: only(run(m1, p1).cs).id };
    const { cs } = run(
      m1,
      p1,
      act("R1", ["m1", "p1"], [w("n:A", "One", "resolution")], { dev: "d1", meta, lbl: "Kept the Mac version of “One”" }),
      act("R2", ["m1", "p1"], [w("n:A", "Two", "resolution")], { dev: "d2", meta, lbl: "Kept the iPhone version of “Two”" }),
    );
    expect(labels(only(cs))).toEqual(["Kept the Mac version of “One”", "Kept the iPhone version of “Two”"]);
  });

  it("a parent loop made apart is an items choice, the same in every delivery order", () => {
    const all = [
      a0,
      act("m1", ["a0"], [w("p:GA", ["GB", "a0"])], mac),
      act("p1", ["a0"], [w("p:GB", ["GA", "a0"])], iph),
      act("t1", ["a0"], [w("n:A", "Alpha t")], ipad),
      act("m2", ["m1"], [w("n:B", "Beta m")], mac),
    ];
    const reference = (() => {
      const log = logOf(...all);
      return choices(log, projectPlan("P", log), DEVICES);
    })();
    const c = only(reference);
    expect(c.kind).toBe("items");
    expect(c.units).toEqual(["p:GA", "p:GB"]);
    expect(c.items).toEqual(["GA", "GB"]);
    expect(labels(c)).toEqual(["Mac", "iPhone"]);
    fc.assert(
      fc.property(fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }), (order) => {
        const log = new LogState(planRules);
        order.forEach((a) => expect(log.add([a]).refused).toEqual([]));
        expect(log.pending).toEqual([]);
        expect(choices(log, projectPlan("P", log), DEVICES)).toEqual(reference);
      }),
      { numRuns: 20 },
    );
  });

  it("a baseline renamed apart is an items choice with no items", () => {
    const { cs, held } = run(
      act("m1", ["a0"], [w("b:X", { name: "Before launch", at: "2026-11-01", dates: {} })], mac),
      act("p1", ["a0"], [w("b:X", { name: "Launch plan", at: "2026-11-01", dates: {} })], iph),
    );
    const c = only(cs);
    expect(c.kind).toBe("items");
    expect(c.units).toEqual(["b:X"]);
    expect(c.items).toEqual([]);
    expect(labels(c)).toEqual(["Mac", "iPhone"]);
    expect([...held]).toEqual([]);
  });

  it("orders choices by their first participant", () => {
    const { cs } = run(
      act("m1", ["a0"], [w("n:A", "Alpha one")], mac),
      act("p1", ["a0"], [w("n:A", "Alpha two")], iph),
      act("k1", ["a0"], [w("n:B", "Beta one")], mac),
      act("k2", ["a0"], [w("n:B", "Beta two")], iph),
    );
    expect(cs.map((c) => c.units)).toEqual([["n:B"], ["n:A"]]);
  });

  it("finds no choice when every device saw the other", () => {
    const { cs } = run(act("m1", ["a0"], [w("n:A", "Alpha one")], mac), act("p1", ["m1"], [w("n:A", "Alpha two")], iph));
    expect(cs).toEqual([]);
  });
});

describe("choiceOf and sideText", () => {
  it("finds the choice holding a unit", () => {
    const { cs, plan } = run(act("m1", ["a0"], [w("n:A", "Alpha one")], mac), act("p1", ["a0"], [w("n:A", "Alpha two")], iph));
    expect(choiceOf(cs, "n:A")).toBe(cs[0]);
    expect(choiceOf(cs, "n:Z")).toBeNull();
    expect(sideText(cs[0], "p1", plan)).toBe("iPhone");
    expect(() => sideText(cs[0], "zz", plan)).toThrow(`Choice ${cs[0].id} has no side zz`);
  });
});
