import { workCalendar, type WorkCalendar } from "../domain/calendar";
import type { Day } from "../domain/dates";
import { derive, schedView, type Derived } from "../domain/derive";
import type { ItemId, PlanState } from "../domain/model";
import { newId } from "../log/ids";
import type { LogState } from "../log/state";
import { OWNER_CAUSES, type Action, type ActionId, type UnitKey, type Write } from "../log/types";
import { choices, heldItems, type Choice, type ChoiceSide } from "../plan/choices";
import { applyWrites, liveLinks, projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { parseKey, validateWrite, type UnitKind } from "../plan/units";
import { previewOf, withDerived, type Derivation } from "./build";
import { calendarSuffix, items, q, toastOf } from "./copy";
import type { Built, Ctx, Preview } from "./intents";

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

const ITEM_KINDS: ReadonlySet<UnitKind> = new Set<UnitKind>(["e", "n", "s", "p", "r"]);
const CALENDAR_KINDS: ReadonlySet<UnitKind> = new Set<UnitKind>(["cr", "cw", "cc", "ct", "ch"]);

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const resolution = (u: UnitKey, v: unknown): Write => ({ u, v, c: "resolution" });

const itemOfUnit = (u: UnitKey): ItemId | null => {
  const k = parseKey(u);
  if (ITEM_KINDS.has(k.kind)) return k.arg;
  if (k.kind === "l") {
    if (k.to === undefined) throw new Error(`Link ${u} has no successor`);
    return k.to;
  }
  return null;
};

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

const valueOn = (choice: Choice, side: ChoiceSide, u: UnitKey): unknown => {
  if (side.values.has(u)) return side.values.get(u);
  if (parseKey(u).kind === "a") return true;
  throw new Error(`Side ${side.key} of choice ${choice.id} has no value for ${u}`);
};

const nameIn = (plans: readonly PlanState[], id: ItemId): string => {
  const it = plans.map((p) => p.items.get(id)).find((x) => x !== undefined);
  if (it === undefined) throw new Error(`No item ${id}`);
  return it.name;
};

const unitSubject = (plans: readonly PlanState[], u: UnitKey): string => {
  const k = parseKey(u);
  if (CALENDAR_KINDS.has(k.kind)) return "the calendar";
  if (k.kind === "pn") return "the plan name";
  if (k.kind === "a") return "the change";
  if (k.kind === "b") {
    const b = plans.map((p) => p.baselines.get(k.arg)).find((x) => x !== undefined);
    return b === undefined ? "a removed baseline" : `baseline ${q(b.name)}`;
  }
  throw new Error(`No subject for ${u}`);
};

const subjectOf = (plans: readonly PlanState[], ids: readonly ItemId[], units: readonly UnitKey[]): string => {
  if (ids.length === 1) return q(nameIn(plans, ids[0]));
  if (ids.length > 1) return items(ids.length);
  return unique(units.map((u) => unitSubject(plans, u))).join(" and ");
};

const ownWrites = (ctx: Ctx, choice: Choice, pick: Pick, opts: ResolveOptions): Write[] => {
  const picked = sideOf(choice, pick.side);
  const perUnit = pick.perUnit ?? new Map<UnitKey, string>();
  [...perUnit].forEach(([u, s]) => {
    if (!choice.units.includes(u)) throw new Error(`Unit ${u} is not in choice ${choice.id}`);
    sideOf(choice, s);
  });
  const chosen = choice.units.map((u) => resolution(u, valueOn(choice, sideOf(choice, perUnit.get(u) ?? picked.key), u)));
  const others = new Set(choice.sides.filter((s) => s.key !== picked.key).flatMap((s) => s.actions));
  const extras =
    choice.kind !== "resolutions"
      ? []
      : unique(choice.sides.flatMap((s) => s.actions).flatMap((a) => actionOf(ctx.log, a).w.map((x) => x.u)))
          .filter((u) => !choice.units.includes(u))
          .flatMap((u): Write[] => {
            const mine = [...picked.actions]
              .reverse()
              .map((a) => actionOf(ctx.log, a).w.find((x) => x.u === u))
              .find((x) => x !== undefined);
            const without = mine === undefined ? ctx.log.valueWithout(u, others) : undefined;
            if (mine === undefined && without === undefined) return [];
            const v = mine === undefined ? without?.value : mine.v;
            const current = ctx.log.unit(u);
            return current !== undefined && planRules.same(u, v, current.value) ? [] : [resolution(u, v)];
          });
  const keys = new Set([picked.key, ...perUnit.values()]);
  const returns = !opts.returnPushed
    ? []
    : choice.sides
        .filter((s) => !keys.has(s.key))
        .flatMap((s) => {
          const theirs = new Set(s.actions);
          return s.actions.flatMap((a) =>
            actionOf(ctx.log, a)
              .w.filter((x) => x.c === "push" && ctx.log.unit(x.u)?.from === a)
              .flatMap((x): Write[] => {
                const before = ctx.log.valueWithout(x.u, theirs);
                return before === undefined ? [] : [resolution(x.u, before.value)];
              }),
          );
        });
  return [...chosen, ...extras, ...returns].filter((x, i, all) => all.findIndex((y) => y.u === x.u) === i);
};

interface Resolved {
  built: Built;
  after: PlanState;
}

const added = (log: LogState, a: Action): LogState => {
  const fork = log.fork();
  const delta = fork.add([a]);
  if (delta.refused.length > 0) throw new Error(delta.refused.map((r) => r.message).join("; "));
  return fork;
};

const labelOf = (ctx: Ctx, choice: Choice, side: ChoiceSide, after: PlanState, preview: Preview): string => {
  const head = `Kept the ${side.label} version of`;
  if (choice.kind === "calendar") return `${head} the calendar${calendarSuffix(preview.endsChanged, preview.movedLater)}`;
  return `${head} ${subjectOf([after, ctx.view.plan], choice.items, choice.units)}`;
};

const resolved = (ctx: Ctx, choice: Choice, pick: Pick, opts: ResolveOptions): Resolved => {
  const plan = ctx.view.plan;
  const own = ownWrites(ctx, choice, pick, opts);
  const held = heldItems(
    ctx.view.choices.filter((c) => c.id !== choice.id),
    plan,
  );
  const placed = applyWrites(plan, own);
  const scheduled = schedView(placed, held).items;
  const targets = new Set(choice.items);
  const roots = opts.pushFromPredecessors
    ? unique(liveLinks(placed).filter((l) => targets.has(l.to) && scheduled.has(l.from)).map((l) => l.from))
    : [];
  const d: Derivation = withDerived(ctx, own, roots, held);
  d.writes.forEach(validateWrite);
  const draft: Action = {
    id: newId(),
    dev: ctx.dev,
    ses: ctx.ses,
    at: ctx.now,
    par: [...ctx.log.heads],
    lbl: "",
    w: d.writes,
    meta: { resolves: choice.id },
  };
  const after = projectPlan(plan.id, added(ctx.log, draft));
  const preview = previewOf(ctx, after, d, []);
  const lbl = labelOf(ctx, choice, sideOf(choice, pick.side), after, preview);
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
  return start === undefined || end === undefined ? null : { start, end };
};

const shiftOf = (cal: WorkCalendar, before: Day, after: Day): number =>
  after > before ? cal.workBetween(before, after - 1) : after < before ? -cal.workBetween(after, before - 1) : 0;

const groupOf = (plans: readonly PlanState[], id: ItemId): ItemId | null => {
  const plan = plans.find((p) => p.items.has(id));
  if (plan === undefined) throw new Error(`No item ${id}`);
  const up = (at: ItemId | null): ItemId | null => {
    if (at === null) return null;
    const p = plan.items.get(at);
    if (p === undefined) return null;
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

const remainText = (n: number): string =>
  n === 0 ? "no items remain." : n === 1 ? "1 item in this choice remains." : `${n} items in this choice remain.`;

export function settleText(ctx: Ctx, w: readonly Write[]): string | null {
  const touched = new Set(w.filter((x) => OWNER_CAUSES.has(x.c)).map((x) => x.u));
  const hit = ctx.view.choices.filter((c) => c.units.some((u) => touched.has(u)));
  if (hit.length === 0) return null;
  const probe: Action = { id: newId(), dev: ctx.dev, ses: ctx.ses, at: ctx.now, par: [...ctx.log.heads], lbl: "", w };
  const fork = added(ctx.log, probe);
  const open = choices(fork, projectPlan(ctx.view.plan.id, fork), ctx.devices);
  const named = [applyWrites(ctx.view.plan, w), ctx.view.plan];
  return hit
    .map((c) => {
      const units = c.units.filter((u) => touched.has(u));
      const settled = unique(units.flatMap((u) => {
        const id = itemOfUnit(u);
        return id === null ? [] : [id];
      }));
      const parts = new Set(c.sides.flatMap((s) => s.actions));
      const remain = c.items.filter((id) => open.some((o) => o.items.includes(id) && o.sides.some((s) => s.actions.some((a) => parts.has(a)))));
      const subject = subjectOf(named, settled, units);
      const lead = settled.length > 1 ? `${subject} are settled` : `${subject.charAt(0).toUpperCase()}${subject.slice(1)} is settled`;
      return `${lead}; ${remainText(remain.length)}`;
    })
    .join(" ");
}
