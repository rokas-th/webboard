import { workCalendar, type WorkCalendar } from "../domain/calendar";
import type { Day } from "../domain/dates";
import { derive, schedView, type Derived } from "../domain/derive";
import type { ItemId, PlanState } from "../domain/model";
import { newId } from "../log/ids";
import type { LogState } from "../log/state";
import type { Action, ActionId, UnitKey, Write } from "../log/types";
import { heldItems, type Choice, type ChoiceSide } from "../plan/choices";
import { applyWrites, cmp, liveLinks, projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { decodeAs, parseKey, validateWrite } from "../plan/units";
import { previewOf, withDerived, type Derivation } from "./build";
import { calendarSuffix, items, toastOf } from "./copy";
import type { Built, Ctx, Preview } from "./intents";
import { forkWith, subjectOf, unique } from "./settle";

export { settleText } from "./settle";

export interface Pick {
  side: string;
  perUnit?: ReadonlyMap<UnitKey, string>;
}

export interface ResolveOptions {
  pushFromPredecessors: boolean;
  returnPushed: boolean;
}

export interface OutcomeRow {
  item: ItemId;
  group: ItemId | null;
  before: { start: Day; end: Day } | null;
  after: { start: Day; end: Day } | null;
  shift: number;
}

export interface ResolvePreview {
  preview: Preview;
  rows: readonly OutcomeRow[];
}

const resolution = (u: UnitKey, v: unknown): Write => ({ u, v, c: "resolution" });

const isActivity = (u: UnitKey): boolean => parseKey(u).kind === "a";

const actionOf = (log: LogState, id: ActionId): Action => {
  const a = log.get(id);
  if (a === undefined) throw new Error(`Action ${id} is not ready`);
  return a;
};

const sideOf = (choice: Choice, side: string): ChoiceSide => {
  const s = choice.sides.find((x) => x.key === side);
  if (s === undefined) throw new Error(`Choice ${choice.id} has no side ${side}`);
  return s;
};

const othersOf = (choice: Choice, side: ChoiceSide): ReadonlySet<ActionId> =>
  new Set(choice.sides.filter((s) => s.key !== side.key).flatMap((s) => s.actions));

const valueApart = (ctx: Ctx, u: UnitKey, others: ReadonlySet<ActionId>): { v: unknown } | null => {
  const without = ctx.log.valueWithout(u, others);
  if (without !== undefined) return { v: without.value };
  const ws = ctx.log.writers(u).filter((id) => !others.has(id));
  if (ws.length === 0) return null;
  const last = ws[ws.length - 1];
  const x = actionOf(ctx.log, last).w.find((y) => y.u === u);
  if (x === undefined) throw new Error(`Action ${last} holds no write to ${u}`);
  return { v: x.v };
};

const valueOn = (ctx: Ctx, choice: Choice, side: ChoiceSide, u: UnitKey): { v: unknown } | null => {
  if (side.values.has(u)) return { v: side.values.get(u) };
  const others = othersOf(choice, side);
  if (isActivity(u)) {
    const without = ctx.log.valueWithout(u, others);
    return { v: without === undefined ? true : without.value };
  }
  return valueApart(ctx, u, others);
};

const latestOn = (ctx: Ctx, choice: Choice, side: ChoiceSide, u: UnitKey): { v: unknown } | null => {
  const mine = [...side.actions]
    .reverse()
    .map((a) => actionOf(ctx.log, a).w.find((x) => x.u === u))
    .find((x) => x !== undefined);
  if (mine !== undefined) return { v: mine.v };
  return valueApart(ctx, u, othersOf(choice, side));
};

export function canPick(ctx: Ctx, choice: Choice, sideKey: string, u: UnitKey): boolean {
  if (!choice.units.includes(u)) throw new Error(`Unit ${u} is not in choice ${choice.id}`);
  return valueOn(ctx, choice, sideOf(choice, sideKey), u) !== null;
}

const draftOf = (ctx: Ctx, choice: Choice, w: readonly Write[]): Action => ({
  id: newId(),
  dev: ctx.dev,
  ses: ctx.ses,
  at: ctx.now,
  par: [...ctx.log.heads],
  lbl: "",
  w,
  meta: { resolves: choice.id },
});

const combined = (chosen: readonly Write[], rest: readonly Write[]): Write[] => {
  const taken = new Set(chosen.map((x) => x.u));
  const kept = rest
    .filter((x) => !taken.has(x.u))
    .reduce((m, x) => {
      const earlier = m.get(x.u);
      if (earlier === undefined) return m.set(x.u, x);
      if (!planRules.same(x.u, earlier.v, x.v)) throw new Error(`Unit ${x.u} gets two different values in one resolution`);
      return m;
    }, new Map<UnitKey, Write>());
  return [...chosen, ...kept.values()];
};

const ownWrites = (ctx: Ctx, choice: Choice, pick: Pick, opts: ResolveOptions): Write[] => {
  const picked = sideOf(choice, pick.side);
  const perUnit = pick.perUnit ?? new Map<UnitKey, string>();
  [...perUnit].forEach(([u, s]) => {
    if (!canPick(ctx, choice, s, u)) throw new Error(`Side ${s} has no version of ${u}`);
  });
  const chosen = choice.units.flatMap((u): Write[] => {
    const got = valueOn(ctx, choice, sideOf(choice, perUnit.get(u) ?? picked.key), u);
    return got === null ? [] : [resolution(u, got.v)];
  });
  const extras =
    choice.kind !== "resolutions"
      ? []
      : unique(choice.sides.flatMap((s) => s.actions).flatMap((a) => actionOf(ctx.log, a).w.map((x) => x.u)))
          .filter((u) => !choice.units.includes(u))
          .flatMap((u): Write[] => {
            const got = latestOn(ctx, choice, picked, u);
            if (got === null) return [];
            const current = ctx.log.unit(u);
            return current !== undefined && planRules.same(u, got.v, current.value) ? [] : [resolution(u, got.v)];
          });
  const keys = new Set([picked.key, ...perUnit.values()]);
  const losing = choice.sides.filter((s) => !keys.has(s.key)).flatMap((s) => s.actions);
  const lost = new Set(losing);
  const returns = !opts.returnPushed
    ? []
    : losing.flatMap((a) =>
        actionOf(ctx.log, a)
          .w.filter((x) => x.c === "push" && ctx.log.unit(x.u)?.from === a)
          .flatMap((x): Write[] => {
            const before = valueApart(ctx, x.u, lost);
            return before === null ? [] : [resolution(x.u, before.v)];
          }),
      );
  return combined(chosen, [...extras, ...returns]);
};

interface Resolved {
  built: Built;
  after: PlanState;
}

const activityLabel = (ctx: Ctx, choice: Choice, side: ChoiceSide, w: readonly Write[]): string => {
  const units = choice.units.filter(isActivity);
  if (units.length !== 1) return `Kept the ${side.label} version of ${units.length} changes`;
  const u = units[0];
  const x = w.find((y) => y.u === u);
  if (x === undefined) throw new Error(`Resolution of choice ${choice.id} writes no ${u}`);
  const target = actionOf(ctx.log, parseKey(u).arg);
  return `Kept the ${side.label} version, so ${target.lbl} ${decodeAs("activity", u, x.v) ? "stays" : "is undone"}`;
};

const labelOf = (ctx: Ctx, choice: Choice, side: ChoiceSide, w: readonly Write[], after: PlanState, preview: Preview): string => {
  if (choice.kind === "resolutions") return `Kept the version where ${side.label}`;
  if (choice.kind === "activity") return activityLabel(ctx, choice, side, w);
  const head = `Kept the ${side.label} version of`;
  if (choice.kind === "calendar") return `${head} the calendar${calendarSuffix(preview.endsChanged, preview.movedLater)}`;
  return `${head} ${subjectOf(ctx.log, [after, ctx.view.plan], choice.items, choice.units)}`;
};

const resolved = (ctx: Ctx, choice: Choice, pick: Pick, opts: ResolveOptions): Resolved => {
  const plan = ctx.view.plan;
  const own = ownWrites(ctx, choice, pick, opts);
  const planWrites = own.filter((x) => !isActivity(x.u));
  const activity = own.filter((x) => isActivity(x.u));
  const held = heldItems(
    ctx.view.choices.filter((c) => c.id !== choice.id),
    plan,
  );
  const placed = applyWrites(plan, planWrites);
  const scheduled = schedView(placed, held).items;
  const targets = new Set(choice.items);
  const roots = opts.pushFromPredecessors
    ? unique(liveLinks(placed).filter((l) => targets.has(l.to) && scheduled.has(l.from)).map((l) => l.from))
    : [];
  const d: Derivation = withDerived(ctx, planWrites, roots, held);
  const w = [...d.writes, ...activity];
  w.forEach(validateWrite);
  const draft = draftOf(ctx, choice, w);
  const after = projectPlan(plan.id, forkWith(ctx.log, draft));
  const preview = previewOf(ctx, after, d, []);
  const lbl = labelOf(ctx, choice, sideOf(choice, pick.side), w, after, preview);
  const moved = d.push?.moves.size ?? 0;
  const action: Action = { ...draft, lbl };
  return { built: { action, newNotes: [], toast: toastOf(lbl, moved === 0 ? [] : [`${items(moved)} moved.`]), preview }, after };
};

export function buildResolve(ctx: Ctx, choice: Choice, pick: Pick, opts: ResolveOptions): Built {
  return resolved(ctx, choice, pick, opts).built;
}

const span = (dv: Derived, id: ItemId): { start: Day; end: Day } | null => {
  const start = dv.start.get(id);
  const end = dv.end.get(id);
  if (start === undefined && end === undefined) return null;
  if (end === undefined) throw new Error(`Item ${id} has a start without an end`);
  if (start === undefined) throw new Error(`Item ${id} has an end without a start`);
  return { start, end };
};

const shiftOf = (cal: WorkCalendar, before: Day, after: Day): number =>
  after > before ? cal.workBetween(before, after - 1) : after < before ? -cal.workBetween(after, before - 1) : 0;

const groupOf = (plans: readonly PlanState[], id: ItemId): ItemId | null => {
  const plan = plans.find((p) => p.items.has(id));
  if (plan === undefined) throw new Error(`No item ${id}`);
  const up = (at: ItemId | null): ItemId | null => {
    if (at === null) return null;
    const p = plan.items.get(at);
    if (p === undefined) throw new Error(`Item ${id} has an ancestor ${at} that is not in the plan`);
    return p.kind === "group" ? p.id : up(p.place.parent);
  };
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`No item ${id}`);
  return up(it.place.parent);
};

export function previewResolve(ctx: Ctx, choice: Choice, pick: Pick, opts: ResolveOptions): ResolvePreview {
  const { built, after } = resolved(ctx, choice, pick, opts);
  const before = ctx.view.derived;
  const next = derive(after, ctx.view.held, ctx.view.today);
  const cal = workCalendar(after.calendar);
  const plans = [after, ctx.view.plan];
  const same = (a: { start: Day; end: Day } | null, b: { start: Day; end: Day } | null): boolean =>
    a === null || b === null ? a === b : a.start === b.start && a.end === b.end;
  const row = (id: ItemId): OutcomeRow => {
    const b = span(before, id);
    const a = span(next, id);
    return { item: id, group: groupOf(plans, id), before: b, after: a, shift: b === null || a === null ? 0 : shiftOf(cal, b.start, a.start) };
  };
  const listed = new Set(choice.items);
  const others = unique([...ctx.view.plan.items.values(), ...after.items.values()].filter((i) => i.kind !== "group").map((i) => i.id))
    .filter((id) => !listed.has(id) && !same(span(before, id), span(next, id)))
    .sort(cmp);
  return { preview: built.preview, rows: [...choice.items, ...others].map(row) };
}
