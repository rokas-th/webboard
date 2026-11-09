import { workingDays } from "../../actions/copy";
import type { OutcomeRow, ResolvePreview } from "../../actions/resolve";
import type { Day } from "../../domain/dates";
import type { ItemId, PlanState } from "../../domain/model";
import { childrenOf } from "../../plan/project";
import { planGroupPath } from "../list/groups";
import { dayLabel } from "../timeline/Chart";

export interface RowSection {
  group: ItemId | null;
  title: string;
  rows: OutcomeRow[];
}

const NOT_IN_A_GROUP = "Not in a group";

type Span = { start: Day; end: Day } | null;

const differs = (a: Span, b: Span): boolean => (a === null || b === null ? a !== b : a.start !== b.start || a.end !== b.end);

export function sideSummary(rp: ResolvePreview): string {
  const moves = rp.rows.filter((r) => differs(r.before, r.after)).length;
  const k = rp.preview.conflictsAfter;
  return k > 0 ? `moves ${moves} · ${k} ${k === 1 ? "conflict" : "conflicts"}` : `moves ${moves}`;
}

const startText = (s: Span): string => (s === null ? "unscheduled" : dayLabel(s.start));

const shiftText = (shift: number): string => (shift === 0 ? "unchanged" : `${shift < 0 ? "−" : "+"}${workingDays(Math.abs(shift))}`);

export function outcomeLine(row: OutcomeRow, plan: PlanState): string {
  const it = plan.items.get(row.item);
  if (it === undefined) throw new Error(`No item ${row.item}`);
  const dates = `${it.name}  ${startText(row.before)} → ${startText(row.after)}`;
  return row.before === null || row.after === null ? dates : `${dates} · ${shiftText(row.shift)}`;
}

function treeOrder(plan: PlanState): ReadonlyMap<ItemId, number> {
  const walk = (parent: ItemId | null): ItemId[] => childrenOf(plan, parent).flatMap((i) => (i.kind === "group" ? [i.id, ...walk(i.id)] : [i.id]));
  return new Map(walk(null).map((id, i) => [id, i]));
}

export function groupRows(rows: readonly OutcomeRow[], plan: PlanState): RowSection[] {
  const order = treeOrder(plan);
  const at = (id: ItemId): number => {
    const n = order.get(id);
    if (n === undefined) throw new Error(`No item ${id}`);
    return n;
  };
  const groups = [...new Set(rows.map((r) => r.group))];
  const placed = groups
    .filter((g): g is ItemId => g !== null)
    .map((g) => ({ g, n: at(g) }))
    .sort((a, b) => a.n - b.n)
    .map((x) => x.g);
  const keys: (ItemId | null)[] = [...placed, ...(groups.includes(null) ? [null] : [])];
  return keys.map((group) => ({
    group,
    title: group === null ? NOT_IN_A_GROUP : planGroupPath(plan, group),
    rows: rows.filter((r) => r.group === group).sort((a, b) => at(a.item) - at(b.item)),
  }));
}
