import { describe, expect, it } from "vitest";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf } from "../test/planCtx";
import { buildAction } from "./build";
import { Refused, type Built, type Ctx, type Intent } from "./intents";
import { buildRevert, buildUndo, OfferRefused, undoOffer } from "./undo";

const TODAY = "2026-11-09";

const mac = { dev: "d1" };
const iph = { dev: "d2" };
const ipad = { dev: "d3" };

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const sched = (start: string | null, dur: number): unknown[] => [start, dur, "todo", 0, "later"];

const item = (id: string, name: string, order: string, s: unknown[]): Write[] => [
  w(`e:${id}`, { k: "task", t: false }),
  w(`n:${id}`, name),
  w(`s:${id}`, s),
  w(`p:${id}`, [null, order]),
];

const ROOT: Write[] = [
  w("pn", "Plan"),
  w("cw", [1, 2, 3, 4, 5]),
  w("cr", null),
  ...item("PR", "Plan review", "a0", sched("2026-11-16", 2)),
  ...item("A", "A", "a1", sched("2026-11-18", 3)),
  ...item("Q", "Q", "a2", sched("2026-11-23", 2)),
  w("l:A>Q", ["FS", 0]),
];

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  expect(log.pending).toEqual([]);
  return log;
};

const a0 = act("a0", [], ROOT);

const ctxFrom = (...rest: Action[]): Ctx => ctxOf(logOf(a0, ...rest), "d1", TODAY);

const on = (ctx: Ctx, dev: string): Ctx => ctxOf(ctx.log, dev, TODAY, ctx.devices);

const add = (ctx: Ctx, ...actions: Action[]): Ctx => {
  const delta = ctx.log.add(actions);
  expect(delta.refused).toEqual([]);
  return ctxOf(ctx.log, ctx.dev, TODAY, ctx.devices);
};

const applied = (ctx: Ctx, b: Built): Ctx => add(ctx, b.action);

const valueOf = (ctx: Ctx, u: string): unknown => ctx.log.unit(u)?.value;

const plainUnits = (log: LogState): Map<string, unknown> =>
  new Map([...log.units()].filter(([u]) => !u.startsWith("a:")).map(([u, s]) => [u, s.value]));

const refusedWith = (ctx: Ctx, build: () => unknown, message: string): void => {
  const before = [...ctx.log.order()];
  let caught: unknown = null;
  try {
    build();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Refused);
  expect((caught as Refused).message).toBe(message);
  expect([...ctx.log.order()]).toEqual(before);
};

const rng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const NAMES = ["Draft", "Review", "Plan review", "Ship", "Q", "A"];

const randomIntent = (ctx: Ctx, r: () => number): Intent => {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const all = [...ctx.view.plan.items.values()];
  const live = all.filter((i) => !i.trashed);
  const trashed = all.filter((i) => i.trashed);
  const kinds = ["create", "rename", "move", "resize", "status", "link", "trash", "restore"] as const;
  const kind = pick(kinds);
  if (kind === "create" || live.length === 0) return { t: "create", kind: "task", name: pick(NAMES), parent: null, after: null, start: "2026-11-17", dur: 2 };
  const it = pick(live);
  switch (kind) {
    case "rename":
      return { t: "rename", item: it.id, name: pick(NAMES) };
    case "move":
      return { t: "move", items: [it.id], days: pick([-3, -2, -1, 1, 2, 3]) };
    case "resize":
      return { t: "resize", item: it.id, dur: pick([1, 2, 3, 4, 5]) };
    case "status":
      return { t: "schedule", item: it.id, set: { status: pick(["todo", "doing", "done"] as const) } };
    case "link":
      return { t: "link", from: it.id, to: pick(live).id, type: pick(["FS", "SS", "FF", "SF"] as const), lag: pick([0, 1]) };
    case "trash":
      return { t: "trash", items: [it.id] };
    case "restore":
      return trashed.length === 0 ? { t: "rename", item: it.id, name: pick(NAMES) } : { t: "restore", items: [pick(trashed).id] };
  }
};

describe("buildUndo", () => {
  it("undoes 30 random intents and redoes them all", () => {
    const r = rng(2026);
    let ctx = ctxFrom();
    const before = plainUnits(ctx.log);
    const done: string[] = [];
    while (done.length < 30) {
      const intent = randomIntent(ctx, r);
      let b: Built;
      try {
        b = buildAction(ctx, intent);
      } catch (e) {
        if (e instanceof Refused) continue;
        throw e;
      }
      ctx = applied(ctx, b);
      done.push(b.action.id);
    }
    const after = plainUnits(ctx.log);
    const undos = [...done].reverse().map((id) => {
      const u = buildUndo(ctx, id);
      expect(u.action.w).toEqual([{ u: `a:${id}`, v: false, c: "undo" }]);
      ctx = applied(ctx, u);
      return u.action.id;
    });
    expect(plainUnits(ctx.log)).toEqual(before);
    [...undos].reverse().forEach((id) => {
      ctx = applied(ctx, buildUndo(ctx, id));
    });
    expect(plainUnits(ctx.log)).toEqual(after);
  });

  it("keeps the iPhone's later move of an item the Mac's undone action moved", () => {
    let ctx = ctxFrom();
    const m1 = buildAction(ctx, { t: "move", items: ["PR"], days: 2 });
    ctx = on(applied(ctx, m1), "d2");
    const m2 = buildAction(ctx, { t: "move", items: ["PR"], days: 1 });
    ctx = on(applied(ctx, m2), "d1");
    const u = buildUndo(ctx, m1.action.id);
    expect(u.action.w).toEqual([{ u: `a:${m1.action.id}`, v: false, c: "undo" }]);
    expect(u.action.meta).toEqual({ undo: m1.action.id });
    expect(u.preview.kept).toEqual(["“Plan review” was changed since on the iPhone — kept"]);
    expect(u.action.lbl).toBe("Undid: Moved “Plan review” later by 2 working days");
    expect(u.toast).toBe("Undid: Moved “Plan review” later by 2 working days. “Plan review” was changed since on the iPhone — kept");
    ctx = applied(ctx, u);
    expect(valueOf(ctx, "s:PR")).toEqual(m2.action.w[0].v);
  });

  it("names an unnamed device by the first four characters of its id", () => {
    let ctx = ctxFrom();
    const m1 = buildAction(ctx, { t: "move", items: ["PR"], days: 2 });
    ctx = on(applied(ctx, m1), "ab12cd34ef5");
    ctx = on(applied(ctx, buildAction(ctx, { t: "move", items: ["PR"], days: 1 })), "d1");
    expect(buildUndo(ctx, m1.action.id).preview.kept).toEqual(["“Plan review” was changed since on the Device ab12 — kept"]);
  });

  it("writes only activity, so restoring a predecessor's later date leaves an early conflict", () => {
    let ctx = ctxFrom();
    const m1 = buildAction(ctx, { t: "move", items: ["A"], days: -2 });
    ctx = applied(ctx, m1);
    ctx = applied(ctx, buildAction(ctx, { t: "move", items: ["Q"], days: -2 }));
    expect(ctx.view.derived.conflicts).toEqual([]);
    const u = buildUndo(ctx, m1.action.id);
    expect(u.action.w.every((x) => x.u.startsWith("a:"))).toBe(true);
    expect(u.preview.conflictsAfter).toBe(1);
    ctx = applied(ctx, u);
    expect(ctx.view.derived.conflicts.map((c) => c.kind === "early" && c.link)).toEqual(["A>Q"]);
  });

  it("undoing a resolution reopens the same choice", () => {
    let ctx = ctxFrom(act("x", ["a0"], [w("n:A", "X")], mac), act("y", ["a0"], [w("n:A", "Y")], iph));
    expect(ctx.view.choices).toHaveLength(1);
    const choice = ctx.view.choices[0];
    ctx = add(ctx, act("r", ["x", "y"], [w("n:A", "X", "resolution")], { dev: "d1", meta: { resolves: choice.id } }));
    expect(ctx.view.choices).toEqual([]);
    ctx = applied(ctx, buildUndo(ctx, "r"));
    expect(ctx.view.choices.map((c) => c.id)).toEqual([choice.id]);
  });

  it("previews a rename's undo as one changed item and no moves", () => {
    let ctx = ctxFrom();
    const b = buildAction(ctx, { t: "rename", item: "A", name: "B" });
    ctx = applied(ctx, b);
    const p = buildUndo(ctx, b.action.id).preview;
    expect([p.itemsChanged, p.endsChanged, p.movedLater]).toEqual([1, 0, 0]);
  });

  it("labels a redo with the original action's label", () => {
    let ctx = ctxFrom(act("b", ["a0"], [w("n:A", "B")], { dev: "d1", lbl: "Renamed “A” to “B”" }));
    const u = buildUndo(ctx, "b");
    ctx = applied(ctx, u);
    expect(valueOf(ctx, "n:A")).toBe("A");
    const redo = buildUndo(ctx, u.action.id);
    expect(redo.action.lbl).toBe("Redid: Renamed “A” to “B”");
    expect(redo.action.w).toEqual([{ u: "a:b", v: true, c: "undo" }]);
    expect(redo.action.meta).toEqual({ redo: u.action.id });
    expect(redo.preview.kept).toEqual([]);
    ctx = applied(ctx, redo);
    expect(valueOf(ctx, "n:A")).toBe("B");
    expect(buildUndo(ctx, redo.action.id).action.lbl).toBe("Undid: Redid: Renamed “A” to “B”");
  });

  it("a redo keeps the iPhone's edit made after the undo", () => {
    let ctx = ctxFrom(act("b", ["a0"], [w("n:A", "B")], { dev: "d1", lbl: "Renamed “A” to “B”" }));
    const u = buildUndo(ctx, "b");
    ctx = on(applied(ctx, u), "d2");
    ctx = on(applied(ctx, buildAction(ctx, { t: "rename", item: "A", name: "C" })), "d1");
    const redo = buildUndo(ctx, u.action.id);
    expect(redo.preview.kept).toEqual(["“C” was changed since on the iPhone — kept"]);
    ctx = applied(ctx, redo);
    expect(valueOf(ctx, "n:A")).toBe("C");
  });

  it("undoing a create the iPhone built on leaves the item in the Trash with the iPhone's name", () => {
    const create = act("c", ["a0"], item("X", "X", "a3", sched("2026-11-17", 2)), mac);
    const rename = act("r", ["c"], [w("n:X", "Y")], iph);
    let ctx = ctxFrom(create, rename);
    const u = buildUndo(ctx, "c");
    expect(u.action.w).toEqual([{ u: "a:c", v: false, c: "undo" }]);
    expect(u.preview.kept).toEqual(["“Y” was changed since on the iPhone — moved to the Trash"]);
    ctx = applied(ctx, u);
    const x = ctx.view.plan.items.get("X");
    expect(x?.trashed).toBe(true);
    expect(x?.name).toBe("Y");
    expect(ctx.view.choices).toEqual([]);
  });

  it("undoing a create before the iPhone's rename arrives is a delete choice once it does", () => {
    const create = act("c", ["a0"], item("X", "X", "a3", sched("2026-11-17", 2)), mac);
    let ctx = ctxFrom(create);
    const u = buildUndo(ctx, "c");
    expect(u.action.w).toEqual([{ u: "a:c", v: false, c: "undo" }]);
    expect(u.preview.kept).toEqual([]);
    ctx = applied(ctx, u);
    ctx = add(ctx, act("r", ["c"], [w("n:X", "Y")], iph));
    expect(ctx.view.choices.map((c) => [c.kind, c.units])).toEqual([["delete", ["e:X", "n:X"]]]);
  });

  it("refuses to undo the plan's first action and names an unknown one", () => {
    const ctx = ctxFrom();
    refusedWith(ctx, () => buildUndo(ctx, "a0"), "The action that created this plan cannot be undone.");
    const imported = ctxOf(logOf(act("i0", [], ROOT, { meta: { imported: "Launch.webboard" } })), "d1", TODAY);
    refusedWith(imported, () => buildUndo(imported, "i0"), "The action that created this plan cannot be undone.");
    expect(() => buildUndo(ctx, "x9")).toThrow(new Error("Action x9 is not in this plan"));
  });
});

describe("buildRevert", () => {
  const renamed = (): Ctx => ctxFrom(act("b", ["a0"], [w("n:A", "B")], { dev: "d1", lbl: "Renamed “A” to “B”" }));

  it("reverts an active action", () => {
    let ctx = renamed();
    const v = buildRevert(ctx, "b");
    expect(v.action.w).toEqual([{ u: "a:b", v: false, c: "revert" }]);
    expect(v.action.meta).toEqual({ revert: "b" });
    expect(v.action.lbl).toBe("Reverted: Renamed “A” to “B”");
    expect(v.toast).toBe("Reverted: Renamed “A” to “B”.");
    ctx = applied(ctx, v);
    expect(ctx.log.active("b")).toBe(false);
    expect(valueOf(ctx, "n:A")).toBe("A");
  });

  it("brings an undone action back", () => {
    let ctx = renamed();
    ctx = applied(ctx, buildUndo(ctx, "b"));
    const v = buildRevert(ctx, "b");
    expect(v.action.w).toEqual([{ u: "a:b", v: true, c: "revert" }]);
    expect(v.action.meta).toEqual({ revert: "b" });
    expect(v.action.lbl).toBe("Brought back: Renamed “A” to “B”");
    expect(v.toast).toBe("Brought back: Renamed “A” to “B”.");
    ctx = applied(ctx, v);
    expect(ctx.log.active("b")).toBe(true);
    expect(valueOf(ctx, "n:A")).toBe("B");
  });

  it("reverting an undo brings its target back", () => {
    let ctx = renamed();
    const u = buildUndo(ctx, "b");
    ctx = applied(ctx, u);
    const v = buildRevert(ctx, u.action.id);
    expect(v.action.w).toEqual([{ u: `a:${u.action.id}`, v: false, c: "revert" }]);
    expect(v.action.meta).toEqual({ revert: u.action.id });
    ctx = applied(ctx, v);
    expect(ctx.log.active("b")).toBe(true);
    expect(valueOf(ctx, "n:A")).toBe("B");
  });

  it("reverting a revert writes only its activity", () => {
    let ctx = ctxFrom();
    const b = buildAction(ctx, { t: "move", items: ["A"], days: 2 });
    ctx = applied(ctx, b);
    const moved = valueOf(ctx, "s:A");
    const v = buildRevert(ctx, b.action.id);
    ctx = applied(ctx, v);
    const x = buildRevert(ctx, v.action.id);
    expect(x.action.w).toEqual([{ u: `a:${v.action.id}`, v: false, c: "revert" }]);
    ctx = applied(ctx, x);
    expect(ctx.log.active(b.action.id)).toBe(true);
    expect(ctx.log.active(v.action.id)).toBe(false);
    expect(valueOf(ctx, "s:A")).toEqual(moved);
  });

  it("reverting a resolution reopens its choice with the same sides", () => {
    let ctx = ctxFrom(act("x", ["a0"], [w("n:A", "X")], mac), act("y", ["a0"], [w("n:A", "Y")], iph));
    const choice = ctx.view.choices[0];
    ctx = add(ctx, act("r", ["x", "y"], [w("n:A", "Y", "resolution")], { dev: "d1", meta: { resolves: choice.id } }));
    const v = buildRevert(ctx, "r");
    expect(v.action.w).toEqual([{ u: "a:r", v: false, c: "revert" }]);
    ctx = applied(ctx, v);
    expect(ctx.view.choices.map((c) => c.id)).toEqual([choice.id]);
    expect(ctx.view.choices[0].sides).toEqual(choice.sides);
  });

  it("refuses the action that created the plan, also an imported one, and names an unknown one", () => {
    const ctx = ctxFrom();
    refusedWith(ctx, () => buildRevert(ctx, "a0"), "The action that created this plan cannot be reverted.");
    const imported = ctxOf(logOf(act("i0", [], ROOT, { meta: { imported: "Launch.webboard" } })), "d1", TODAY);
    refusedWith(imported, () => buildRevert(imported, "i0"), "The action that created this plan cannot be reverted.");
    expect(() => buildRevert(ctx, "x9")).toThrow(new Error("Action x9 is not in this plan"));
  });
});

describe("undoOffer", () => {
  it("a revert against an undo then redo made apart is an activity choice and offers the other side", () => {
    let ctx = ctxFrom(act("b", ["a0"], [w("n:A", "B")], mac));
    const revert = buildRevert(ctx, "b");
    let phone = on(ctx, "d2");
    const u = buildUndo(phone, "b");
    phone = applied(phone, u);
    const redo = buildUndo(phone, u.action.id);
    expect(redo.action.w).toEqual([{ u: "a:b", v: true, c: "undo" }]);
    ctx = add(on(phone, "d1"), redo.action, revert.action);
    expect(ctx.view.choices.map((c) => [c.kind, c.units])).toEqual([["activity", ["a:b"]]]);
    const choice = ctx.view.choices[0];
    const other = choice.sides.find((s) => !s.actions.includes(revert.action.id));
    expect(undoOffer(ctx, revert.action.id)).toEqual({ choice: choice.id, side: other?.key });
    expect(undoOffer(ctx, "b")).toBeNull();
  });

  it("with three sides offers the first side that does not hold the target", () => {
    const ctx = ctxFrom(
      act("m", ["a0"], [w("s:A", sched("2026-11-19", 3))], mac),
      act("p", ["a0"], [w("s:A", sched("2026-11-20", 3))], iph),
      act("q", ["a0"], [w("s:A", sched("2026-11-23", 3))], ipad),
    );
    const choice = ctx.view.choices[0];
    expect(choice.sides).toHaveLength(3);
    expect(undoOffer(ctx, "m")).toEqual({ choice: choice.id, side: choice.sides[1].key });
    expect(undoOffer(ctx, "p")).toEqual({ choice: choice.id, side: choice.sides[0].key });
  });

  it("OfferRefused is a Refused carrying the offer", () => {
    const e = new OfferRefused({ choice: "c1", side: "m" });
    expect(e).toBeInstanceOf(Refused);
    expect(e.offer).toEqual({ choice: "c1", side: "m" });
    expect(e.message).toBe("This change is one side of an open choice. Keep the other version to undo it.");
  });

});
