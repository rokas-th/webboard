import { describe, expect, it } from "vitest";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf } from "../test/planCtx";
import { buildAction } from "./build";
import { Refused, type Built, type Ctx, type Intent } from "./intents";
import { buildRevert, buildUndo, OfferRefused, undoChanges, undoOffer } from "./undo";

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
  expect(ctx.log.pending).toEqual([]);
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
  if (!(caught instanceof Refused)) throw new Error(`expected a Refused, caught ${String(caught)}`);
  expect(caught.message).toBe(message);
  expect([...ctx.log.order()]).toEqual(before);
};

const plainError = (ctx: Ctx, build: () => unknown, message: string): void => {
  const before = [...ctx.log.order()];
  let caught: unknown = null;
  try {
    build();
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Error)) throw new Error(`expected an Error, caught ${String(caught)}`);
  expect(caught).not.toBeInstanceOf(Refused);
  expect(caught.message).toBe(message);
  expect([...ctx.log.order()]).toEqual(before);
};

const BASELINE = (name: string): unknown => ({ name, at: "2026-11-09", dates: { A: { start: "2026-11-18", dur: 3 } } });

const keptAfterOverride = (base: readonly Action[], u: string, mine: unknown, theirs: unknown): readonly string[] => {
  const ctx = ctxFrom(...base, act("m1", [base.length === 0 ? "a0" : base[base.length - 1].id], [w(u, mine)], mac), act("m2", ["m1"], [w(u, theirs)], iph));
  return buildUndo(ctx, "m1").preview.kept;
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
    expect(u.toast).toBe("Undid: Moved “Plan review” later by 2 working days. “Plan review” was changed since on the iPhone — kept.");
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

  it("undoing a reopen brings back done, 100 and the group's progress with one write", () => {
    let ctx = ctxFrom(
      act("g", ["a0"], [w("e:G", { k: "group", t: false }), w("n:G", "Group"), w("p:G", [null, "a3"]), w("p:A", ["G", "a0"]), w("p:Q", ["G", "a1"]), w("s:A", ["2026-11-18", 3, "done", 100, "later"])], mac),
    );
    expect(ctx.view.derived.progress.get("G")).toBe(60);
    const b = buildAction(ctx, { t: "schedule", item: "A", set: { status: "doing" } });
    expect(b.action.w.filter((x) => !x.u.startsWith("a:")).map((x) => x.u)).toEqual(["s:A"]);
    ctx = applied(ctx, b);
    expect(valueOf(ctx, "s:A")).toEqual(["2026-11-18", 3, "doing", 0, "later"]);
    expect(ctx.view.derived.progress.get("G")).toBe(0);
    const u = buildUndo(ctx, b.action.id);
    expect(u.action.w.map((x) => x.u)).toEqual([`a:${b.action.id}`]);
    ctx = applied(ctx, u);
    expect(valueOf(ctx, "s:A")).toEqual(["2026-11-18", 3, "done", 100, "later"]);
    expect(ctx.view.derived.progress.get("G")).toBe(60);
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

  it("names the calendar, the plan name, a link and a baseline when another device changed them since", () => {
    expect(keptAfterOverride([], "cw", [1, 2, 3, 4], [1, 2, 3])).toEqual(["The calendar was changed since on the iPhone — kept"]);
    expect(keptAfterOverride([], "pn", "Plan 2", "Plan 3")).toEqual(["The plan name was changed since on the iPhone — kept"]);
    expect(keptAfterOverride([], "l:A>Q", ["FS", 1], ["SS", 1])).toEqual(["The link “A” → “Q” was changed since on the iPhone — kept"]);
    const saved = act("bs", ["a0"], [w("b:B1", BASELINE("Q2"))], mac);
    expect(keptAfterOverride([saved], "b:B1", BASELINE("Q3"), BASELINE("Q4"))).toEqual(["Baseline “Q4” was changed since on the iPhone — kept"]);
  });

  it("kept lines name a step and an item's step", () => {
    const step = (n: string): unknown => ({ n, c: "amber", o: "a1V" });
    expect(keptAfterOverride([], "ws:qa", step("QA"), step("Review"))).toEqual(["The step “Review” was changed since on the iPhone — kept"]);
    expect(keptAfterOverride([], "ws:now", step("Today"), null)).toEqual(["The removed step “Today” was changed since on the iPhone — kept"]);
    expect(keptAfterOverride([], "ws:later", null, null)).toEqual(["The removed step “Later” was changed since on the iPhone — kept"]);
    expect(keptAfterOverride([], "ws:zz", null, null)).toEqual(["A removed step was changed since on the iPhone — kept"]);
    expect(keptAfterOverride([], "wi:PR", "now", "next")).toEqual(["“Plan review” was changed since on the iPhone — kept"]);
  });

  it("kept lines name the plan's defaults", () => {
    const pd = (dur: number): unknown => ({ dur, dated: true, who: null, group: null, step: null });
    expect(keptAfterOverride([], "pd", pd(4), pd(5))).toEqual(["The plan’s defaults were changed since on the iPhone — kept"]);
  });

  it("kept lines keep was changed since for a singular subject", () => {
    expect(keptAfterOverride([], "pn", "Plan 2", "Plan 3")).toEqual(["The plan name was changed since on the iPhone — kept"]);
  });

  it("kept lines name a person, a removed person and an item's assignees", () => {
    const person = (n: string): unknown => ({ n, i: "MO", c: "cyan", o: "a0" });
    expect(keptAfterOverride([], "pp:mira", person("Mira"), person("Mira Okafor"))).toEqual(["The person “Mira Okafor” was changed since on the iPhone — kept"]);
    expect(keptAfterOverride([], "pp:mira", person("Mira Okafor"), null)).toEqual(["The removed person “Mira Okafor” was changed since on the iPhone — kept"]);
    expect(keptAfterOverride([], "pp:zz", null, null)).toEqual(["A removed person was changed since on the iPhone — kept"]);
    expect(keptAfterOverride([], "pa:PR", ["mira"], ["ole"])).toEqual(["“Plan review” was changed since on the iPhone — kept"]);
  });

  it("undo of a person removal restores the person and every list, keeping an assignee list changed since", () => {
    const person = (n: string, o: string): unknown => ({ n, i: "MO", c: "cyan", o });
    const people = act("pe", ["a0"], [w("pp:mira", person("Mira Okafor", "a0")), w("pp:ole", person("Ole Berg", "a1")), w("pa:PR", ["mira"]), w("pa:A", ["mira", "ole"])], mac);
    const ctx = ctxFrom(people);
    const removed = buildAction(ctx, { t: "person", op: "remove", person: "mira", to: "ole" });
    expect(removed.action.w.map((x) => x.u)).toEqual(["pp:mira", "pa:A", "pa:PR"]);
    const after = applied(ctx, removed);
    const theirs = buildAction(on(after, "d2"), { t: "assignees", item: "A", people: [] });
    const changed = applied(after, theirs);
    const undo = buildUndo(changed, removed.action.id);
    expect(undo.preview.kept).toEqual(["“A” was changed since on the iPhone — kept"]);
    const undone = applied(changed, undo);
    expect(undone.view.plan.people.persons.get("mira")).toEqual(person("Mira Okafor", "a0"));
    expect(undone.view.plan.people.assignees.get("PR")).toEqual(["mira"]);
    expect(undone.view.plan.people.assignees.get("A")).toBeNull();
  });

  it("an undone create that assigned people keeps no line for the orphaned assignees", () => {
    const made = act("c", ["a0"], [...item("X", "Coat", "a5", sched("2026-11-16", 2)), w("pa:X", ["mira"])], mac);
    const moved = act("m", ["c"], [w("pa:X", ["ole"])], iph);
    const ctx = ctxFrom(made, moved);
    expect(valueOf(ctx, "pa:X")).toEqual(["ole"]);
    const undo = buildUndo(ctx, "c");
    expect(undo.preview.kept).toEqual([]);
    const after = applied(ctx, undo);
    expect(after.view.plan.items.has("X")).toBe(false);
    expect(after.view.plan.people.assignees.has("X")).toBe(false);
  });

  it.each([
    ["this Mac", "d1"],
    ["a peer", "d2"],
  ])("undo and revert of a create by steps whose card was then moved on %s neither throw nor keep the orphaned step", (_where, dev) => {
    const base = ctxFrom(act("s1", ["a0"], [w("ws:qa", { n: "QA", c: "amber", o: "a1V" })], mac));
    const made = buildAction(base, { t: "create", kind: "task", name: "Coat", parent: null, after: null, start: null });
    const e = made.action.w.find((x) => x.u.startsWith("e:"));
    if (e === undefined) throw new Error("no create");
    const id = e.u.slice(2);
    expect(made.action.w.map((x) => x.u)).toContain(`wi:${id}`);
    const created = applied(base, made);
    const moved = applied(created, buildAction(on(created, dev), { t: "toStep", items: [id], step: "qa" }));
    const ctx = on(moved, "d1");
    expect(ctx.log.unit(`wi:${id}`)?.value).toBe("qa");
    const undo = buildUndo(ctx, made.action.id);
    expect(undo.preview.kept).toEqual([]);
    expect(undo.toast).toBe("Undid: Added task “Coat”.");
    const revert = buildRevert(ctx, made.action.id);
    expect(revert.preview.kept).toEqual([]);
    expect(revert.toast).toBe("Reverted: Added task “Coat”.");
    const after = applied(ctx, undo);
    expect(after.view.plan.items.has(id)).toBe(false);
    expect(after.view.plan.workflow.items.has(id)).toBe(false);
  });

  it("an item already in the Trash whose rename was overridden is kept, not moved to the Trash", () => {
    const ctx = ctxFrom(
      act("c", ["a0"], item("X", "X", "a3", sched("2026-11-17", 2)), mac),
      act("r1", ["c"], [w("n:X", "Y1")], mac),
      act("r2", ["r1"], [w("n:X", "Y2")], iph),
      act("u0", ["r2"], [w("a:c", false, "undo")], { dev: "d1", meta: { undo: "c" } }),
    );
    expect(ctx.view.plan.items.get("X")?.trashed).toBe(true);
    expect(buildUndo(ctx, "r1").preview.kept).toEqual(["“Y2” was changed since on the iPhone — kept"]);
  });

  it("refuses to undo an action that is already undone, building nothing", () => {
    let ctx = ctxFrom(act("b", ["a0"], [w("n:A", "B")], mac));
    const u = buildUndo(ctx, "b");
    ctx = applied(ctx, u);
    plainError(ctx, () => buildUndo(ctx, "b"), "Action b is already undone");
    ctx = applied(ctx, buildRevert(ctx, u.action.id));
    plainError(ctx, () => buildUndo(ctx, u.action.id), `Action ${u.action.id} is already undone`);
  });

  it("refuses a history action that writes anything but activity", () => {
    const ctx = ctxFrom(
      act("b", ["a0"], [w("n:A", "B")], mac),
      act("h", ["b"], [w("a:b", false, "undo"), w("n:A", "Z")], { dev: "d1", meta: { undo: "b" } }),
    );
    plainError(ctx, () => buildUndo(ctx, "h"), "History action h writes n:A; expected only a: units");
  });

  it("refuses to undo the plan's first action and names an unknown one", () => {
    const ctx = ctxFrom();
    refusedWith(ctx, () => buildUndo(ctx, "a0"), "The action that created this plan cannot be undone.");
    const imported = ctxOf(logOf(act("i0", [], ROOT, { meta: { imported: "Launch.webboard" } })), "d1", TODAY);
    refusedWith(imported, () => buildUndo(imported, "i0"), "The action that created this plan cannot be undone.");
    plainError(ctx, () => buildUndo(ctx, "x9"), "Action x9 is not in this plan");
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
    plainError(ctx, () => buildRevert(ctx, "x9"), "Action x9 is not in this plan");
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
    expect(choice.sides.map((s) => s.actions.includes(revert.action.id))).toEqual([true, false]);
    expect(undoOffer(ctx, revert.action.id)).toEqual({ choice: choice.id, side: choice.sides[1].key });
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

describe("kept lines for items that no longer project", () => {
  it("simulate(1566320693): reverting a link whose start item's create was reverted names the item by its last name", () => {
    const base = act("a0", [], [...ROOT, ...item("R", "R", "a3", sched("2026-11-25", 1))]);
    const c = act("c", ["a0"], item("D", "Draft", "a4", sched("2026-11-16", 2)), mac);
    const l = act("L", ["c"], [w("l:D>R", ["FS", 0])], mac);
    const x = act("X", ["L"], [w("l:D>R", null)], iph);
    const v = act("V", ["X"], [w("a:c", false, "revert")], { dev: "d1", meta: { revert: "c" } });
    const ctx = ctxOf(logOf(base, c, l, x, v), "d1", TODAY);
    expect(ctx.view.plan.items.has("D")).toBe(false);
    const b = buildRevert(ctx, "L");
    expect(b.action.w).toEqual([w("a:L", false, "revert")]);
    expect(b.preview.kept).toEqual(["The link “Draft” → “R” was changed since on the iPhone — kept"]);
  });

  it("reverting a baseline removal after a rename made apart and a second removal names the baseline by its last name", () => {
    const saved = act("a0", [], [...ROOT, w("b:B", BASELINE("Before"))]);
    const removed = act("x1", ["a0"], [w("b:B", null)], { dev: "d1", lbl: "Removed baseline “Before”" });
    const renamed = act("y1", ["a0"], [w("b:B", BASELINE("Launch plan"))], { dev: "d2", lbl: "Renamed baseline “Before” to “Launch plan”" });
    let again = ctxOf(logOf(saved, removed, renamed), "d1", TODAY);
    expect(again.view.plan.baselines.get("B")?.name).toBe("Launch plan");
    again = applied(again, buildAction(again, { t: "baseline", op: "remove", id: "B" }));
    expect(again.view.choices).toEqual([]);
    expect(undoOffer(again, "x1")).toBeNull();
    expect(buildRevert(again, "x1").preview.kept).toEqual(["Baseline “Launch plan” was changed since on the Mac — kept"]);

    let kept = ctxOf(logOf(saved, removed, renamed), "d1", TODAY);
    const choice = kept.view.choices[0];
    kept = add(kept, act("r", ["x1", "y1"], [w("b:B", null, "resolution")], { dev: "d1", meta: { resolves: choice.id } }));
    expect(kept.view.plan.baselines.has("B")).toBe(false);
    expect(undoOffer(kept, "x1")).toBeNull();
    expect(buildRevert(kept, "x1").preview.kept).toEqual(["Baseline “Launch plan” was changed since on the Mac — kept"]);
  });

  it("undoing a group's create that the iPhone placed an item inside names the item it moves to the top level", () => {
    const group = act("c", ["a0"], [w("e:G", { k: "group", t: false }), w("n:G", "Sprint 4"), w("p:G", [null, "a3"])], { dev: "d1", lbl: "Added group “Sprint 4”" });
    let ctx = on(ctxFrom(group), "d2");
    ctx = on(applied(ctx, buildAction(ctx, { t: "create", kind: "task", name: "Review", parent: "G", after: null, start: "2026-11-17", dur: 2 })), "d1");
    const u = buildUndo(ctx, "c");
    expect(u.preview.kept).toEqual(["“Review” was placed inside it on the iPhone — moved to the top level"]);
    expect(u.toast).toBe("Undid: Added group “Sprint 4”. “Review” was placed inside it on the iPhone — moved to the top level.");
    ctx = applied(ctx, u);
    const review = [...ctx.view.plan.items.values()].find((i) => i.name === "Review");
    expect(review?.place.parent).toBeNull();
    expect(ctx.view.plan.items.has("G")).toBe(false);
  });

  it("undoing a group's create that this device placed an item inside names the item without a device", () => {
    const group = act("c", ["a0"], [w("e:G", { k: "group", t: false }), w("n:G", "Sprint 4"), w("p:G", [null, "a3"])], { dev: "d1", lbl: "Added group “Sprint 4”" });
    let ctx = ctxFrom(group);
    ctx = applied(ctx, buildAction(ctx, { t: "create", kind: "task", name: "Review", parent: "G", after: null, start: "2026-11-17", dur: 2 }));
    const u = buildUndo(ctx, "c");
    expect(u.preview.kept).toEqual(["“Review” was placed inside it — moved to the top level"]);
    expect(u.toast).toBe("Undid: Added group “Sprint 4”. “Review” was placed inside it — moved to the top level.");
  });
});

describe("undo and redo labels", () => {
  it("an undo and redo cycle names the original action and never nests past one prefix", () => {
    let ctx = ctxFrom(act("b", ["a0"], [w("n:A", "B")], { dev: "d1", lbl: "Renamed “A” to “B”" }));
    const steps = Array.from({ length: 6 }).reduce<{ target: string; seen: [string, unknown][] }>(
      (acc) => {
        const built = buildUndo(ctx, acc.target);
        ctx = applied(ctx, built);
        return { target: built.action.id, seen: [...acc.seen, [built.action.lbl, valueOf(ctx, "n:A")]] };
      },
      { target: "b", seen: [] },
    );
    expect(steps.seen).toEqual([
      ["Undid: Renamed “A” to “B”", "A"],
      ["Redid: Renamed “A” to “B”", "B"],
      ["Undid: Redid: Renamed “A” to “B”", "A"],
      ["Redid: Renamed “A” to “B”", "B"],
      ["Undid: Redid: Renamed “A” to “B”", "A"],
      ["Redid: Renamed “A” to “B”", "B"],
    ]);
  });

  it("undoing a revert that brings the action back names the original action", () => {
    let ctx = ctxFrom(act("b", ["a0"], [w("n:A", "B")], { dev: "d1", lbl: "Renamed “A” to “B”" }));
    const v = buildRevert(ctx, "b");
    ctx = applied(ctx, v);
    const u = buildUndo(ctx, v.action.id);
    expect(u.action.w).toEqual([{ u: "a:b", v: true, c: "undo" }]);
    expect(u.action.lbl).toBe("Redid: Renamed “A” to “B”");
  });
});

describe("undoChanges", () => {
  it("is false for a redo whose action another device reverted meanwhile, and true for a plain undo and a redo that brings it back", () => {
    let mac = ctxFrom(act("b", ["a0"], [w("n:A", "B")], { dev: "d1", lbl: "Renamed “A” to “B”" }));
    expect(undoChanges(mac.log, "b")).toBe(true);
    let phone = ctxOf(mac.log.fork(), "d2", TODAY);
    const undone = buildUndo(mac, "b");
    mac = applied(mac, undone);
    expect(undoChanges(mac.log, undone.action.id)).toBe(true);
    const reverted = buildRevert(phone, "b");
    phone = applied(phone, reverted);
    mac = add(mac, reverted.action);
    expect(mac.view.choices).toEqual([]);
    expect(valueOf(mac, "n:A")).toBe("A");
    expect(undoChanges(mac.log, undone.action.id)).toBe(false);
  });
});

describe("parent loops closed by an undo", () => {
  const groups = act("a0", [], [
    w("pn", "Plan"),
    w("cw", [1, 2, 3, 4, 5]),
    w("cr", null),
    w("e:G1", { k: "group", t: false }),
    w("n:G1", "Design"),
    w("p:G1", [null, "a0"]),
    w("e:G2", { k: "group", t: false }),
    w("n:G2", "Build"),
    w("p:G2", [null, "a1"]),
  ]);

  const place = (ctx: Ctx, item: string, parent: string | null): Built => buildAction(ctx, { t: "place", item, parent, after: null });

  it("undoing a move out of a group the other group was then moved into raises the loop as an items choice", () => {
    let ctx = ctxOf(logOf(groups), "d1", TODAY);
    const into = place(ctx, "G1", "G2");
    ctx = applied(ctx, into);
    const out = place(ctx, "G1", null);
    ctx = applied(ctx, out);
    const back = place(ctx, "G2", "G1");
    ctx = applied(ctx, back);
    expect(undoOffer(ctx, out.action.id)).toBeNull();
    ctx = applied(ctx, buildUndo(ctx, out.action.id));
    expect(ctx.view.choices).toHaveLength(1);
    const c = ctx.view.choices[0];
    expect(c.kind).toBe("items");
    expect(c.units).toEqual(["p:G1", "p:G2"]);
    expect(c.sides.map((s) => s.actions)).toEqual([[into.action.id], [back.action.id]]);
    expect(c.sides.map((s) => [s.values.get("p:G1"), s.values.get("p:G2")])).toEqual([
      [into.action.w[0].v, [null, "a1"]],
      [[null, "a0"], back.action.w[0].v],
    ]);
  });

  it("an undo on the Mac apart from the iPhone's move closes the same loop and raises it as a choice on both", () => {
    let mac = ctxOf(logOf(groups), "d1", TODAY);
    const into = place(mac, "G1", "G2");
    mac = applied(mac, into);
    const out = place(mac, "G1", null);
    mac = applied(mac, out);
    let phone = ctxOf(mac.log.fork(), "d2", TODAY);
    const undo = buildUndo(mac, out.action.id);
    mac = applied(mac, undo);
    const back = place(phone, "G2", "G1");
    phone = applied(phone, back);
    mac = add(mac, back.action);
    phone = add(phone, undo.action);
    expect(mac.view.choices).toEqual(phone.view.choices);
    expect(mac.view.choices).toHaveLength(1);
    const c = mac.view.choices[0];
    expect(c.kind).toBe("items");
    expect(c.units).toEqual(["p:G1", "p:G2"]);
    expect(c.sides.map((s) => [s.label, s.actions])).toEqual([
      ["Mac", [into.action.id]],
      ["iPhone", [back.action.id]],
    ]);
  });
});
