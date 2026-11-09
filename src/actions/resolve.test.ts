import { describe, expect, it } from "vitest";
import { toDay } from "../domain/dates";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import type { Choice } from "../plan/choices";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf } from "../test/planCtx";
import { buildAction } from "./build";
import type { Built, Ctx } from "./intents";
import { buildResolve, previewResolve, settleText, type ResolveOptions, type ResolvePreview } from "./resolve";
import { buildRevert, buildUndo } from "./undo";

const TODAY = "2026-11-09";

const mac = { dev: "d1" };
const iph = { dev: "d2" };

const ON: ResolveOptions = { pushFromPredecessors: true, returnPushed: true };
const OFF: ResolveOptions = { pushFromPredecessors: false, returnPushed: false };

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const sched = (start: string | null, dur: number, status = "todo", progress = 0): unknown[] => [start, dur, status, progress, "later"];

const item = (id: string, kind: "task" | "milestone" | "group", name: string, parent: string | null, order: string, s?: unknown[]): Write[] => [
  w(`e:${id}`, { k: kind, t: false }),
  w(`n:${id}`, name),
  ...(s === undefined ? [] : [w(`s:${id}`, s)]),
  w(`p:${id}`, [parent, order]),
];

const ROOT: Write[] = [w("pn", "Plan"), w("cw", [1, 2, 3, 4, 5]), w("cr", null)];

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  expect(log.pending).toEqual([]);
  return log;
};

const ctxFrom = (root: readonly Write[], ...rest: Action[]): Ctx => ctxOf(logOf(act("a0", [], [...ROOT, ...root]), ...rest), "d1", TODAY);

const add = (ctx: Ctx, ...actions: Action[]): Ctx => {
  const delta = ctx.log.add(actions);
  expect(delta.refused).toEqual([]);
  actions.forEach((a) => expect(delta.added).toContain(a.id));
  expect(ctx.log.pending).toEqual([]);
  return ctxOf(ctx.log, ctx.dev, TODAY, ctx.devices);
};

const applied = (ctx: Ctx, b: Built): Ctx => add(ctx, b.action);

const on = (ctx: Ctx, dev: string): Ctx => ctxOf(ctx.log, dev, TODAY, ctx.devices);

const only = (ctx: Ctx): Choice => {
  expect(ctx.view.choices).toHaveLength(1);
  return ctx.view.choices[0];
};

const sideKey = (c: Choice, label: string): string => {
  const s = c.sides.find((x) => x.label === label);
  if (s === undefined) throw new Error(`No side labelled ${label}: ${c.sides.map((x) => x.label).join(", ")}`);
  return s.key;
};

const writes = (b: Built): Map<string, Write> => new Map(b.action.w.map((x) => [x.u, x]));

const valueOf = (ctx: Ctx, u: string): unknown => ctx.log.unit(u)?.value;

const moving = (rp: ResolvePreview): number => rp.rows.filter((r) => JSON.stringify(r.before) !== JSON.stringify(r.after)).length;

const snapshot = (log: LogState) => ({ order: [...log.order()], units: new Map(log.units()) });

describe("buildResolve", () => {
  const THREE: Write[] = [
    ...item("A", "task", "A", null, "a0", sched("2026-11-16", 2)),
    ...item("B", "task", "B", null, "a1", sched("2026-11-16", 2)),
    ...item("C", "task", "C", null, "a2", sched("2026-11-16", 2)),
  ];
  const m1 = act("m1", ["a0"], [w("s:A", sched("2026-11-17", 2)), w("s:B", sched("2026-11-17", 2)), w("s:C", sched("2026-11-17", 2))], mac);
  const p1 = act("p1", ["a0"], [w("s:A", sched("2026-11-18", 2)), w("s:B", sched("2026-11-18", 2)), w("s:C", sched("2026-11-18", 2))], iph);

  it("keeps one side for the whole choice: every unit written, cause resolution, meta.resolves", () => {
    const ctx = ctxFrom(THREE, m1, p1);
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: sideKey(c, "iPhone") }, ON);
    expect(b.action.meta).toEqual({ resolves: c.id });
    expect(b.action.par).toEqual([...ctx.log.heads]);
    expect(b.action.w).toEqual(["s:A", "s:B", "s:C"].map((u) => w(u, sched("2026-11-18", 2), "resolution")));
    expect(b.action.lbl).toBe("Kept the iPhone version of 3 items");
    expect(b.toast).toBe("Kept the iPhone version of 3 items.");
    const after = applied(ctx, b);
    expect(after.view.choices).toEqual([]);
    ["s:A", "s:B", "s:C"].forEach((u) => expect(valueOf(after, u)).toEqual(sched("2026-11-18", 2)));
  });

  it("picks per unit with side keys", () => {
    const ctx = ctxFrom(THREE, m1, p1);
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac"), perUnit: new Map([["s:B", sideKey(c, "iPhone")]]) }, ON);
    const after = applied(ctx, b);
    expect(after.view.choices).toEqual([]);
    expect(valueOf(after, "s:A")).toEqual(sched("2026-11-17", 2));
    expect(valueOf(after, "s:B")).toEqual(sched("2026-11-18", 2));
    expect(valueOf(after, "s:C")).toEqual(sched("2026-11-17", 2));
    expect(b.action.lbl).toBe("Kept the Mac version of 3 items");
  });

  it("refuses a side label or an unknown unit in place of a key", () => {
    const ctx = ctxFrom(THREE, m1, p1);
    const c = only(ctx);
    expect(() => buildResolve(ctx, c, { side: "iPhone" }, ON)).toThrow(`Choice ${c.id} has no side iPhone`);
    expect(() => buildResolve(ctx, c, { side: sideKey(c, "Mac"), perUnit: new Map([["s:Z", sideKey(c, "iPhone")]]) }, ON)).toThrow(
      `Unit s:Z is not in choice ${c.id}`,
    );
  });

  const PUSHED: Write[] = [
    ...item("A", "task", "A", null, "a0", sched("2026-11-16", 2)),
    ...item("D", "task", "D", null, "a1", sched("2026-11-18", 2)),
    w("l:A>D", ["FS", 0]),
  ];
  const mp = act("m1", ["a0"], [w("s:A", sched("2026-11-17", 2)), w("s:D", sched("2026-11-19", 2), "push")], mac);
  const pp = act("p1", ["a0"], [w("s:A", sched("2026-11-23", 2)), w("s:D", sched("2026-11-25", 2), "push")], iph);

  it("returns the items the other side's push moved", () => {
    const ctx = ctxFrom(PUSHED, mp, pp);
    expect(valueOf(ctx, "s:D")).toEqual(sched("2026-11-25", 2));
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(b.action.w).toEqual([w("s:A", sched("2026-11-17", 2), "resolution"), w("s:D", sched("2026-11-19", 2), "resolution")]);
    expect(b.action.lbl).toBe("Kept the Mac version of “A”");
    const after = applied(ctx, b);
    expect(valueOf(after, "s:D")).toEqual(sched("2026-11-19", 2));
    expect(after.view.choices).toEqual([]);
  });

  it("leaves a pushed item alone with the option off", () => {
    const ctx = ctxFrom(PUSHED, mp, pp);
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, { pushFromPredecessors: true, returnPushed: false });
    expect([...writes(b).keys()]).toEqual(["s:A"]);
  });

  it("returns an item only the iPhone pushed to its base value", () => {
    const early = act("m1", ["a0"], [w("s:A", sched("2026-11-10", 2))], mac);
    const ctx = ctxFrom(PUSHED, early, pp);
    expect(valueOf(ctx, "s:D")).toEqual(sched("2026-11-25", 2));
    const c = only(ctx);
    expect(c.units).toEqual(["s:A"]);
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(b.action.w).toEqual([w("s:A", sched("2026-11-10", 2), "resolution"), w("s:D", sched("2026-11-18", 2), "resolution")]);
    const after = applied(ctx, b);
    expect(valueOf(after, "s:D")).toEqual(sched("2026-11-18", 2));
    expect(after.view.choices).toEqual([]);
  });

  it("does not return an item the owner moved since", () => {
    const moved = act("o1", ["m1", "p1"], [w("s:D", sched("2026-11-30", 2))], mac);
    const ctx = ctxFrom(PUSHED, mp, pp, moved);
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect([...writes(b).keys()]).toEqual(["s:A"]);
    expect(valueOf(applied(ctx, b), "s:D")).toEqual(sched("2026-11-30", 2));
  });

  const FS: Write[] = [
    ...item("A", "task", "A", null, "a0", sched("2026-11-16", 3)),
    ...item("B", "task", "B", null, "a1", sched("2026-11-19", 2)),
    w("l:A>B", ["FS", 0]),
  ];
  const fm = act("m1", ["a0"], [w("s:B", sched("2026-11-17", 2))], mac);
  const fp = act("p1", ["a0"], [w("s:B", sched("2026-11-18", 2))], iph);

  it("pushes a picked start that breaks a link from its predecessor", () => {
    const ctx = ctxFrom(FS, fm, fp);
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(b.action.w).toEqual([w("s:B", sched("2026-11-19", 2), "resolution")]);
    expect(b.preview.conflictsAfter).toBe(0);
    expect(b.preview.movedLater).toBe(1);
    expect(b.toast).toBe("Kept the Mac version of “B”. 1 item moved.");
    const off = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, OFF);
    expect(off.action.w).toEqual([w("s:B", sched("2026-11-17", 2), "resolution")]);
    expect(off.preview.conflictsAfter).toBe(1);
    expect(off.toast).toBe("Kept the Mac version of “B”.");
  });

  it("previews each side differently with and without the push", () => {
    const ctx = ctxFrom(FS, fm, fp);
    const c = only(ctx);
    const was = { start: toDay("2026-11-18"), end: toDay("2026-11-19") };
    const rowsOf = (label: string, opts: ResolveOptions): ResolvePreview => previewResolve(ctx, c, { side: sideKey(c, label) }, opts);
    const macOn = rowsOf("Mac", ON);
    const macOff = rowsOf("Mac", OFF);
    const iphOn = rowsOf("iPhone", ON);
    const iphOff = rowsOf("iPhone", OFF);
    expect(macOn.rows).toEqual([{ item: "B", group: null, before: was, after: { start: toDay("2026-11-19"), end: toDay("2026-11-20") }, shift: 1 }]);
    expect(macOff.rows).toEqual([{ item: "B", group: null, before: was, after: { start: toDay("2026-11-17"), end: toDay("2026-11-18") }, shift: -1 }]);
    expect(iphOn.rows).toEqual([{ item: "B", group: null, before: was, after: { start: toDay("2026-11-19"), end: toDay("2026-11-20") }, shift: 1 }]);
    expect(iphOff.rows).toEqual([{ item: "B", group: null, before: was, after: was, shift: 0 }]);
    [macOn, iphOn].forEach((rp) => expect(rp.preview.conflictsAfter).toBe(0));
    [macOff, iphOff].forEach((rp) => expect(rp.preview.conflictsAfter).toBe(1));
  });

  it("counts every pushed item in the toast", () => {
    const CHAIN: Write[] = [...FS, ...item("C", "task", "C", null, "a2", sched("2026-11-20", 2)), w("l:B>C", ["FS", 0])];
    const ctx = ctxFrom(CHAIN, fm, fp);
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(b.action.w).toEqual([w("s:B", sched("2026-11-19", 2), "resolution"), w("s:C", sched("2026-11-23", 2), "push")]);
    expect(b.preview.movedLater).toBe(2);
    expect(b.toast).toBe("Kept the Mac version of “B”. 2 items moved.");
  });

  it("names sides from ctx.devices, unknown devices by their id", () => {
    const ctx = ctxFrom(
      item("A", "task", "Draft", null, "a0", sched("2026-11-16", 2)),
      act("m1", ["a0"], [w("n:A", "One")], mac),
      act("p1", ["a0"], [w("n:A", "Review")], { dev: "ab12cd34ef5" }),
    );
    const c = only(ctx);
    expect(c.sides.map((s) => s.label)).toEqual(["Mac", "Device ab12"]);
    const b = buildResolve(ctx, c, { side: c.sides[1].key }, ON);
    expect(b.action.lbl).toBe("Kept the Device ab12 version of “Review”");
  });

  const DELETE: Write[] = [...item("S", "group", "Sprint 4", null, "a0"), ...item("R", "task", "Retro", "S", "a0", sched("2026-11-16", 2))];
  const trash = act("m1", ["a0"], [w("e:S", { k: "group", t: true })], mac);
  const edit = act("p1", ["a0"], [w("n:R", "Retro notes")], iph);

  it("delete: the trash side keeps the group trashed and the old name", () => {
    const ctx = ctxFrom(DELETE, trash, edit);
    const c = only(ctx);
    expect(c.kind).toBe("delete");
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(b.action.w).toEqual([w("e:S", { k: "group", t: true }, "resolution"), w("n:R", "Retro", "resolution")]);
    expect(b.action.lbl).toBe("Kept the Mac version of 2 items");
    expect(b.toast).toBe("Kept the Mac version of 2 items.");
    const after = applied(ctx, b);
    expect(after.view.plan.items.get("S")?.trashed).toBe(true);
    expect(valueOf(after, "n:R")).toBe("Retro");
    expect(after.view.choices).toEqual([]);
  });

  it("delete: the edit side restores the group with the edit", () => {
    const ctx = ctxFrom(DELETE, trash, edit);
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: sideKey(c, "iPhone") }, ON);
    expect(b.action.w).toEqual([w("e:S", { k: "group", t: false }, "resolution"), w("n:R", "Retro notes", "resolution")]);
    expect(b.action.lbl).toBe("Kept the iPhone version of 2 items");
    expect(b.toast).toBe("Kept the iPhone version of 2 items.");
    const after = applied(ctx, b);
    expect(after.view.plan.items.get("S")?.trashed).toBe(false);
    expect(after.view.plan.items.get("R")?.name).toBe("Retro notes");
    expect(after.view.choices).toEqual([]);
  });
});

describe("resolving a calendar choice", () => {
  const CAL: Write[] = [
    ...item("T", "task", "T", null, "a0", sched("2026-11-20", 2)),
    ...item("U", "task", "U", null, "a1", sched("2026-11-16", 5)),
    ...item("V", "task", "V", null, "a2", sched("2026-11-24", 1)),
    ...item("D", "task", "D", null, "a3", sched("2026-11-12", 4, "done", 100)),
    w("l:T>V", ["FS", 0]),
  ];
  const m1 = act("m1", ["a0"], [w("cw", [1, 2, 3, 4])], mac);
  const p1 = act("p1", ["a0"], [w("cw", [1, 2, 3, 4, 5, 6])], iph);

  it("applies the calendar-change rules from the interim calendar to the picked one", () => {
    const ctx = ctxFrom(CAL, m1, p1);
    expect(valueOf(ctx, "cw")).toEqual([1, 2, 3, 4, 5, 6]);
    const c = only(ctx);
    expect(c.kind).toBe("calendar");
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(b.action.w).toEqual([
      w("cw", [1, 2, 3, 4], "resolution"),
      w("s:T", sched("2026-11-23", 2), "recalendar"),
      w("s:D", sched("2026-11-12", 2, "done", 100), "recalendar"),
      w("s:V", sched("2026-11-25", 1), "push"),
    ]);
    expect(b.action.lbl).toBe("Kept the Mac version of the calendar; 3 end dates changed, 1 item moved later");
    expect(b.preview).toEqual({ itemsChanged: 3, endsChanged: 3, movedLater: 1, stopped: [], conflictsAfter: 0, kept: [] });
    const after = applied(ctx, b);
    expect(after.view.choices).toEqual([]);
    expect(after.view.derived.end.get("D")).toBe(toDay("2026-11-16"));
    expect(after.view.derived.end.get("U")).toBe(toDay("2026-11-23"));
  });
});

describe("previewResolve", () => {
  const GROUPED: Write[] = [
    ...item("G", "group", "Phase", null, "a0"),
    ...item("A", "task", "A", "G", "a0", sched("2026-11-16", 3)),
    ...item("D", "task", "D", "G", "a1", sched("2026-11-19", 2)),
    w("l:A>D", ["FS", 0]),
  ];
  const m1 = act("m1", ["a0"], [w("s:A", sched("2026-11-17", 3)), w("s:D", sched("2026-11-20", 2), "push")], mac);
  const p1 = act("p1", ["a0"], [w("s:A", sched("2026-11-23", 3)), w("s:D", sched("2026-11-26", 2), "push")], iph);

  it("lists the choice's items, then everything that moves, with before and after", () => {
    const ctx = ctxFrom(GROUPED, m1, p1);
    expect(valueOf(ctx, "s:A")).toEqual(sched("2026-11-23", 3));
    expect(valueOf(ctx, "s:D")).toEqual(sched("2026-11-26", 2));
    const was = snapshot(ctx.log);
    const c = only(ctx);
    const keepMac = previewResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(keepMac.rows).toEqual([
      {
        item: "A",
        group: "G",
        before: { start: toDay("2026-11-23"), end: toDay("2026-11-25") },
        after: { start: toDay("2026-11-17"), end: toDay("2026-11-19") },
        shift: -4,
      },
      {
        item: "D",
        group: "G",
        before: { start: toDay("2026-11-26"), end: toDay("2026-11-27") },
        after: { start: toDay("2026-11-20"), end: toDay("2026-11-23") },
        shift: -4,
      },
    ]);
    expect(keepMac.preview.itemsChanged).toBe(2);
    expect(keepMac.preview.endsChanged).toBe(2);
    expect(keepMac.preview.movedLater).toBe(0);
    expect(keepMac.preview.conflictsAfter).toBe(0);
    expect(moving(keepMac)).toBe(2);
    const keepPhone = previewResolve(ctx, c, { side: sideKey(c, "iPhone") }, ON);
    expect(keepPhone.rows).toEqual([
      {
        item: "A",
        group: "G",
        before: { start: toDay("2026-11-23"), end: toDay("2026-11-25") },
        after: { start: toDay("2026-11-23"), end: toDay("2026-11-25") },
        shift: 0,
      },
    ]);
    expect(keepPhone.preview.itemsChanged).toBe(0);
    expect(keepPhone.preview.endsChanged).toBe(0);
    expect(moving(keepPhone)).toBe(0);
    expect(snapshot(ctx.log)).toEqual(was);
  });

  it("shows null for an item not scheduled on a side", () => {
    const ctx = ctxFrom(
      item("A", "task", "A", null, "a0", sched("2026-11-16", 2)),
      act("m1", ["a0"], [w("s:A", sched(null, 2))], mac),
      act("p1", ["a0"], [w("s:A", sched("2026-11-18", 2))], iph),
    );
    const c = only(ctx);
    const rp = previewResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(rp.rows).toEqual([{ item: "A", group: null, before: { start: toDay("2026-11-18"), end: toDay("2026-11-19") }, after: null, shift: 0 }]);
  });
});

describe("two resolutions made apart", () => {
  const s = (start: string, dur: number) => sched(start, dur);
  const BASE: Write[] = [
    ...item("PFF", "task", "Plan file format", null, "a0", s("2026-11-16", 3)),
    ...item("Spec", "task", "Spec", null, "a1", s("2026-11-19", 3)),
    ...item("Build", "task", "Build", null, "a2", s("2026-11-24", 5)),
    ...item("Review", "task", "Review", null, "a3", s("2026-12-01", 2)),
    ...item("Ship", "task", "Ship", null, "a4", s("2026-12-03", 1)),
    w("l:PFF>Spec", ["FS", 0]),
    w("l:Spec>Build", ["FS", 0]),
    w("l:Build>Review", ["FS", 0]),
    w("l:Review>Ship", ["FS", 0]),
  ];
  const m1 = act("m1", ["a0"], [w("s:PFF", s("2026-11-19", 3))], mac);
  const p1 = act("p1", ["a0"], [
    w("s:PFF", s("2026-11-25", 3)),
    w("s:Spec", s("2026-11-30", 3), "push"),
    w("s:Build", s("2026-12-03", 5), "push"),
    w("s:Review", s("2026-12-10", 2), "push"),
    w("s:Ship", s("2026-12-14", 1), "push"),
  ], iph);

  const apart = (): Ctx => {
    const first = only(ctxFrom(BASE, m1, p1));
    const resolves = { resolves: first.id };
    const r1 = act("R1", ["m1", "p1"], [w("s:PFF", s("2026-11-25", 3), "resolution")], { dev: "d1", meta: resolves });
    const r2 = act("R2", ["m1", "p1"], [
      w("s:PFF", s("2026-11-19", 3), "resolution"),
      w("s:Spec", s("2026-11-19", 3), "resolution"),
      w("s:Build", s("2026-11-24", 5), "resolution"),
      w("s:Review", s("2026-12-01", 2), "resolution"),
      w("s:Ship", s("2026-12-03", 1), "resolution"),
    ], { dev: "d2", meta: resolves });
    return ctxFrom(BASE, m1, p1, r1, r2);
  };

  it("picking the side that pushed writes the pushed values back", () => {
    const ctx = apart();
    const c = only(ctx);
    expect(c.kind).toBe("resolutions");
    const side = sideKey(c, "“Plan file format” starts 25 Nov, 4 items move");
    const b = buildResolve(ctx, c, { side }, ON);
    expect(b.action.w).toEqual([
      w("s:PFF", s("2026-11-25", 3), "resolution"),
      w("s:Spec", s("2026-11-30", 3), "resolution"),
      w("s:Build", s("2026-12-03", 5), "resolution"),
      w("s:Review", s("2026-12-10", 2), "resolution"),
      w("s:Ship", s("2026-12-14", 1), "resolution"),
    ]);
    expect(b.action.meta).toEqual({ resolves: c.id });
    expect(b.action.lbl).toBe("Kept the version where “Plan file format” starts 25 Nov, 4 items move");
    expect(b.toast).toBe("Kept the version where “Plan file format” starts 25 Nov, 4 items move.");
    expect(applied(ctx, b).view.choices).toEqual([]);
  });

  it("picking the side that returned writes only the clashing unit", () => {
    const ctx = apart();
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: sideKey(c, "“Plan file format” starts 19 Nov") }, ON);
    expect(b.action.w).toEqual([w("s:PFF", s("2026-11-19", 3), "resolution")]);
    expect(b.action.lbl).toBe("Kept the version where “Plan file format” starts 19 Nov");
    expect(b.toast).toBe("Kept the version where “Plan file format” starts 19 Nov.");
    const after = applied(ctx, b);
    expect(after.view.choices).toEqual([]);
    expect(valueOf(after, "s:Spec")).toEqual(s("2026-11-19", 3));
  });

  it("refuses to pick a side that has no value for a unit the other side created", () => {
    const first = only(ctxFrom(BASE, m1, p1));
    const resolves = { resolves: first.id };
    const r1 = act("R1", ["m1", "p1"], [w("s:PFF", s("2026-11-25", 3), "resolution")], { dev: "d1", meta: resolves });
    const r2 = act("R2", ["m1", "p1"], [
      w("s:PFF", s("2026-11-19", 3), "resolution"),
      ...item("X", "task", "Extra", null, "a5", s("2026-11-16", 1)).map((x) => ({ ...x, c: "resolution" as const })),
    ], { dev: "d2", meta: resolves });
    const ctx = ctxFrom(BASE, m1, p1, r1, r2);
    const c = only(ctx);
    expect(c.kind).toBe("resolutions");
    const side = c.sides.find((x) => x.actions.includes("R1"));
    if (side === undefined) throw new Error("No side holds R1");
    expect(() => buildResolve(ctx, c, { side: side.key }, ON)).toThrow(`Unit e:X of choice ${c.id} has no value on side ${side.key}`);
  });
});

describe("resolving an activity choice", () => {
  const clash = (): Ctx => {
    let ctx = ctxFrom(item("A", "task", "Alpha", null, "a0", sched("2026-11-16", 2)));
    const b = buildAction(ctx, { t: "rename", item: "A", name: "Beta" });
    ctx = applied(ctx, b);
    const revert = buildRevert(ctx, b.action.id);
    let phone = on(ctx, "d2");
    const u = buildUndo(phone, b.action.id);
    phone = applied(phone, u);
    const redo = buildUndo(phone, u.action.id);
    const both = add(on(phone, "d1"), redo.action, revert.action);
    expect(both.view.choices.map((c) => [c.kind, c.units])).toEqual([["activity", [`a:${b.action.id}`]]]);
    return both;
  };
  const row = { item: "A", group: null, before: { start: toDay("2026-11-16"), end: toDay("2026-11-17") }, after: { start: toDay("2026-11-16"), end: toDay("2026-11-17") }, shift: 0 };

  it("keeping the revert undoes the change", () => {
    const ctx = clash();
    const c = only(ctx);
    const u = c.units[0];
    const b = buildResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(b.action.w).toEqual([w(u, false, "resolution")]);
    expect(b.action.lbl).toBe("Kept the Mac version, so Renamed “Alpha” to “Beta” is undone");
    expect(b.toast).toBe("Kept the Mac version, so Renamed “Alpha” to “Beta” is undone.");
    const rp = previewResolve(ctx, c, { side: sideKey(c, "Mac") }, ON);
    expect(rp.rows).toEqual([row]);
    expect(rp.preview.itemsChanged).toBe(1);
    const after = applied(ctx, b);
    expect(valueOf(after, u)).toBe(false);
    expect(after.view.plan.items.get("A")?.name).toBe("Alpha");
    expect(after.view.choices).toEqual([]);
  });

  it("keeping the redo keeps the change", () => {
    const ctx = clash();
    const c = only(ctx);
    const u = c.units[0];
    const b = buildResolve(ctx, c, { side: sideKey(c, "iPhone") }, ON);
    expect(b.action.w).toEqual([w(u, true, "resolution")]);
    expect(b.action.lbl).toBe("Kept the iPhone version, so Renamed “Alpha” to “Beta” stays");
    expect(b.toast).toBe("Kept the iPhone version, so Renamed “Alpha” to “Beta” stays.");
    const rp = previewResolve(ctx, c, { side: sideKey(c, "iPhone") }, ON);
    expect(rp.rows).toEqual([row]);
    expect(rp.preview.itemsChanged).toBe(0);
    const after = applied(ctx, b);
    expect(valueOf(after, u)).toBe(true);
    expect(after.view.plan.items.get("A")?.name).toBe("Beta");
    expect(after.view.choices).toEqual([]);
  });
});

describe("settling by edit", () => {
  const FOUR: Write[] = [
    ...item("P", "task", "Plan", null, "a0", sched("2026-11-16", 2)),
    ...item("R", "task", "Review", null, "a1", sched("2026-11-16", 2)),
    ...item("B", "task", "Build", null, "a2", sched("2026-11-16", 2)),
    ...item("S", "task", "Ship", null, "a3", sched("2026-11-16", 2)),
    ...item("O", "task", "Other", null, "a4", sched("2026-11-16", 2)),
  ];
  const renames = (ids: readonly string[], suffix: string): Write[] => ids.map((id) => w(`n:${id}`, `${id} ${suffix}`));
  const clash = (ids: readonly string[]): Ctx =>
    ctxFrom(FOUR, act("m1", ["a0"], renames(ids, "mac"), mac), act("p1", ["a0"], renames(ids, "phone"), iph));

  it("names the item after the edit and how many items remain", () => {
    const ctx = clash(["P", "R", "B", "S"]);
    expect(only(ctx).items).toHaveLength(4);
    const b = buildAction(ctx, { t: "rename", item: "R", name: "Final review" });
    expect(b.toast.endsWith("“Final review” is settled; 3 items in this choice remain.")).toBe(true);
    expect(b.action.lbl).toBe("Renamed “R phone” to “Final review”");
    const after = applied(ctx, b);
    expect(only(after).units).toEqual(["n:B", "n:P", "n:S"]);
    const undone = applied(after, buildUndo(after, b.action.id));
    expect(only(undone).units).toEqual(["n:B", "n:P", "n:R", "n:S"]);
  });

  it("settles nothing when another unit is edited", () => {
    const ctx = clash(["P", "R", "B", "S"]);
    const b = buildAction(ctx, { t: "rename", item: "O", name: "Elsewhere" });
    expect(b.toast).toBe("Renamed “Other” to “Elsewhere”.");
    expect(settleText(ctx, b.action.w)).toBeNull();
    expect(only(applied(ctx, b)).items).toHaveLength(4);
  });

  it("says one item remains", () => {
    const ctx = clash(["P", "R"]);
    const b = buildAction(ctx, { t: "rename", item: "P", name: "Kickoff" });
    expect(b.toast.endsWith("“Kickoff” is settled; 1 item in this choice remains.")).toBe(true);
  });

  it("says no items remain and leaves no choice", () => {
    const ctx = clash(["R"]);
    const b = buildAction(ctx, { t: "rename", item: "R", name: "Third name" });
    expect(b.toast).toBe("Renamed “R phone” to “Third name”. “Third name” is settled; no items remain.");
    expect(applied(ctx, b).view.choices).toEqual([]);
  });

  it("does not settle an item while another of its units still clashes", () => {
    const ctx = ctxFrom(
      FOUR,
      act("m1", ["a0"], [...renames(["P", "R", "B", "S"], "mac"), w("s:R", sched("2026-11-17", 2))], mac),
      act("p1", ["a0"], [...renames(["P", "R", "B", "S"], "phone"), w("s:R", sched("2026-11-18", 2))], iph),
    );
    const b = buildAction(ctx, { t: "rename", item: "R", name: "Final review" });
    expect(settleText(ctx, b.action.w)).toBeNull();
    expect(b.toast).toBe("Renamed “R phone” to “Final review”.");
    expect(only(applied(ctx, b)).units).toEqual(["n:B", "n:P", "n:S", "s:R"]);
  });

  it("settles the calendar only when the whole calendar choice is gone", () => {
    const clashing = (): Ctx =>
      ctxFrom(
        [],
        act("m1", ["a0"], [w("cw", [1, 2, 3, 4]), w("cr", { src: "opm" })], mac),
        act("p1", ["a0"], [w("cw", [1, 2, 3, 4, 5, 6]), w("cr", { src: "govuk", division: "scotland" })], iph),
      );
    const ctx = clashing();
    expect(only(ctx).kind).toBe("calendar");
    expect(only(ctx).units).toEqual(["cr", "cw"]);
    const cw = buildAction(ctx, { t: "calendar", next: { ...ctx.view.plan.calendar, workdays: [1, 2, 3] } });
    expect(settleText(ctx, cw.action.w)).toBeNull();
    expect(cw.toast).not.toContain("settled");
    const fresh = clashing();
    const both = buildAction(fresh, { t: "calendar", next: { ...fresh.view.plan.calendar, workdays: [1, 2, 3], region: { src: "opm" } } });
    expect(settleText(fresh, both.action.w)).toBe("The calendar is settled.");
    expect(both.toast.endsWith(" The calendar is settled.")).toBe(true);
    expect(applied(fresh, both).view.choices).toEqual([]);
  });

  it("settles a schedule clash by a direct move", () => {
    const ctx = ctxFrom(
      FOUR,
      act("m1", ["a0"], [w("s:P", sched("2026-11-17", 2)), w("s:R", sched("2026-11-17", 2))], mac),
      act("p1", ["a0"], [w("s:P", sched("2026-11-18", 2)), w("s:R", sched("2026-11-18", 2))], iph),
    );
    const b = buildAction(ctx, { t: "schedule", item: "R", set: { start: "2026-11-24" } });
    expect(b.toast).toBe("Scheduled “Review” from 24 Nov. “Review” is settled; 1 item in this choice remains.");
  });
});

describe("sides with no value of their own", () => {
  const create = act("c", ["a0"], item("N", "task", "New", null, "a6", sched("2026-11-16", 2)), mac);
  const rename = act("r", ["c"], [w("n:N", "Newer")], iph);
  const undo = act("u0", ["c"], [w("a:c", false, "undo")], { dev: "d1", meta: { undo: "c" } });

  it("simulate(1566296047): the trash side of a delete over an undone create writes the create's name", () => {
    const ctx = ctxFrom([], create, rename, undo);
    const c = only(ctx);
    expect(c.kind).toBe("delete");
    expect(c.units).toEqual(["e:N", "n:N"]);
    const b = buildResolve(ctx, c, { side: "u0" }, ON);
    expect(b.action.w).toEqual([w("e:N", { k: "task", t: true }, "resolution"), w("n:N", "New", "resolution")]);
    const after = applied(ctx, b);
    expect(after.view.plan.items.get("N")?.trashed).toBe(true);
    expect(after.view.plan.items.get("N")?.name).toBe("New");
    expect(after.view.choices).toEqual([]);
  });

  it("simulate(1566296047): the rename side of that delete restores the item with the rename", () => {
    const ctx = ctxFrom([], create, rename, undo);
    const c = only(ctx);
    const b = buildResolve(ctx, c, { side: "r" }, ON);
    expect(b.action.w).toEqual([w("e:N", { k: "task", t: false }, "resolution"), w("n:N", "Newer", "resolution")]);
    const after = applied(ctx, b);
    expect(after.view.plan.items.get("N")?.trashed).toBe(false);
    expect(after.view.plan.items.get("N")?.name).toBe("Newer");
    expect(after.view.choices).toEqual([]);
  });

  it("simulate(47): the rename side of a trash apart from a rename, with the create reverted elsewhere, restores the item with the rename", () => {
    const ctx = ctxFrom(
      [],
      create,
      act("v", ["c"], [w("a:c", false, "revert")], { dev: "d1", meta: { revert: "c" } }),
      rename,
      act("t", ["c"], [w("e:N", { k: "task", t: true })], { dev: "d3" }),
    );
    const c = only(ctx);
    expect(c.kind).toBe("delete");
    expect(c.sides.map((s) => s.key)).toEqual(["r", "t"]);
    const b = buildResolve(ctx, c, { side: "r" }, ON);
    expect(b.action.w).toEqual([w("e:N", { k: "task", t: false }, "resolution"), w("n:N", "Newer", "resolution")]);
    const after = applied(ctx, b);
    expect(after.view.plan.items.get("N")?.trashed).toBe(false);
    expect(after.view.plan.items.get("N")?.name).toBe("Newer");
    expect(after.view.choices).toEqual([]);
  });

  it("returns an item two losing sides both pushed to its base value", () => {
    const ctx = ctxFrom(
      [...item("A", "task", "A", null, "a0", sched("2026-11-16", 2)), ...item("D", "task", "D", null, "a1", sched("2026-11-18", 2)), w("l:A>D", ["FS", 0])],
      act("m1", ["a0"], [w("s:A", sched("2026-11-17", 2)), w("s:D", sched("2026-11-19", 2), "push")], mac),
      act("p1", ["a0"], [w("s:A", sched("2026-11-23", 2)), w("s:D", sched("2026-11-25", 2), "push")], iph),
      act("q1", ["a0"], [w("s:A", sched("2026-11-10", 2))], { dev: "d3" }),
    );
    const c = only(ctx);
    expect(c.units).toEqual(["s:A"]);
    expect(c.sides).toHaveLength(3);
    const b = buildResolve(ctx, c, { side: sideKey(c, "iPad") }, ON);
    expect(b.action.w).toEqual([w("s:A", sched("2026-11-10", 2), "resolution"), w("s:D", sched("2026-11-18", 2), "resolution")]);
    const after = applied(ctx, b);
    expect(valueOf(after, "s:D")).toEqual(sched("2026-11-18", 2));
    expect(after.view.choices).toEqual([]);
  });
});
