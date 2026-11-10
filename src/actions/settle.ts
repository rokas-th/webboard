import type { ItemId, PlanState } from "../domain/model";
import { newId } from "../log/ids";
import type { LogState } from "../log/state";
import { OWNER_CAUSES, type Action, type UnitKey, type Write } from "../log/types";
import { choices, type Choice } from "../plan/choices";
import { applyWrites, projectPlan } from "../plan/project";
import { parseKey, type UnitKind } from "../plan/units";
import { items, q } from "./copy";
import type { Ctx } from "./intents";
import { baselineName } from "./names";

export const CALENDAR_UNITS: ReadonlySet<UnitKind> = new Set<UnitKind>(["cr", "cw", "cc", "ct", "ch"]);

export const isCalendarWrite = (x: Write): boolean => CALENDAR_UNITS.has(parseKey(x.u).kind);

export const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

const ITEM_KINDS: ReadonlySet<UnitKind> = new Set<UnitKind>(["e", "n", "s", "p", "r"]);

export const itemOfUnit = (u: UnitKey): ItemId | null => {
  const k = parseKey(u);
  if (ITEM_KINDS.has(k.kind)) return k.arg;
  if (k.kind === "l") {
    if (k.to === undefined) throw new Error(`Link ${u} has no successor`);
    return k.to;
  }
  return null;
};

export const forkWith = (log: LogState, a: Action): LogState => {
  const fork = log.fork();
  const delta = fork.add([a]);
  if (delta.refused.length > 0) throw new Error(delta.refused.map((r) => r.message).join("; "));
  if (!delta.added.includes(a.id)) throw new Error(`Action ${a.id} was not applied (pending)`);
  return fork;
};

const nameIn = (plans: readonly PlanState[], id: ItemId): string => {
  const it = plans.map((p) => p.items.get(id)).find((x) => x !== undefined);
  if (it === undefined) throw new Error(`No item ${id}`);
  return it.name;
};

const unitSubject = (log: LogState, plans: readonly PlanState[], u: UnitKey): string => {
  const k = parseKey(u);
  if (CALENDAR_UNITS.has(k.kind)) return "the calendar";
  if (k.kind === "pn") return "the plan name";
  if (k.kind === "a") return "the change";
  if (k.kind === "b") return `baseline ${q(baselineName(log, plans, u, k.arg))}`;
  throw new Error(`No subject for ${u}`);
};

export const subjectOf = (log: LogState, plans: readonly PlanState[], ids: readonly ItemId[], units: readonly UnitKey[]): string => {
  if (ids.length === 1) return q(nameIn(plans, ids[0]));
  if (ids.length > 1) return items(ids.length);
  return unique(units.map((u) => unitSubject(log, plans, u))).join(" and ");
};

const capital = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

const remainText = (n: number): string =>
  n === 0 ? "no items remain." : n === 1 ? "1 item in this choice remains." : `${n} items in this choice remain.`;

const itemLess = (c: Choice): boolean => c.kind === "activity" || c.items.length === 0;

export function settleText(ctx: Ctx, w: readonly Write[]): string | null {
  const touched = new Set(w.filter((x) => OWNER_CAUSES.has(x.c)).map((x) => x.u));
  const hit = ctx.view.choices.filter((c) => c.units.some((u) => touched.has(u)));
  if (hit.length === 0) return null;
  const probe: Action = { id: newId(), dev: ctx.dev, ses: ctx.ses, at: ctx.now, par: [...ctx.log.heads], lbl: "", w };
  const fork = forkWith(ctx.log, probe);
  const open = choices(fork, projectPlan(ctx.view.plan.id, fork), ctx.devices);
  const openUnits = new Set(open.flatMap((o) => o.units));
  const stillOpen = new Set(open.flatMap((o) => o.units.flatMap((u) => {
    const id = itemOfUnit(u);
    return id === null ? [] : [id];
  })));
  const named = [applyWrites(ctx.view.plan, w.filter((x) => parseKey(x.u).kind !== "a")), ctx.view.plan];
  const sentences = hit.flatMap((c): string[] => {
    if (itemLess(c)) {
      return c.units.some((u) => openUnits.has(u)) ? [] : [`${capital(subjectOf(fork, named, [], c.units))} is settled.`];
    }
    const settled = unique(
      c.units
        .filter((u) => touched.has(u))
        .flatMap((u) => {
          const id = itemOfUnit(u);
          return id === null ? [] : [id];
        }),
    ).filter((id) => !stillOpen.has(id));
    if (settled.length === 0) return [];
    const parts = new Set(c.sides.flatMap((s) => s.actions));
    const remain = c.items.filter((id) => open.some((o) => o.items.includes(id) && o.sides.some((s) => s.actions.some((a) => parts.has(a)))));
    const subject = subjectOf(fork, named, settled, []);
    const lead = settled.length > 1 ? `${subject} are settled` : `${subject} is settled`;
    return [`${lead}; ${remainText(remain.length)}`];
  });
  return sentences.length === 0 ? null : sentences.join(" ");
}
