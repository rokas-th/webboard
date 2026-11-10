import { fmtShort, toIso, weekday, type Day } from "../../domain/dates";
import { goneSet } from "../../domain/derive";
import type { ItemId, ItemKind } from "../../domain/model";
import { childrenOf } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { ghostIds } from "../ghosts";

export interface PrintRow {
  id: ItemId;
  depth: number;
  kind: ItemKind;
  span: { start: Day; end: Day } | null;
}

export interface Tick {
  at: Day;
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const WEEKS_UP_TO = 62;
const MONTHS_UP_TO = 550;

const spanOf = (view: PlanView, id: ItemId): PrintRow["span"] => {
  const start = view.derived.start.get(id);
  const end = view.derived.end.get(id);
  if (start === undefined && end === undefined) return null;
  if (start === undefined || end === undefined) throw new Error(`Print: item ${id} has a ${start === undefined ? "end" : "start"} but no ${start === undefined ? "start" : "end"}`);
  return { start, end };
};

export function printRows(view: PlanView): PrintRow[] {
  const gone = goneSet(view.plan);
  const ghosts = ghostIds(view);
  const walk = (parent: ItemId | null, depth: number): PrintRow[] =>
    childrenOf(view.plan, parent)
      .filter((it) => !gone.has(it.id) && !ghosts.has(it.id))
      .flatMap((it) => [{ id: it.id, depth, kind: it.kind, span: spanOf(view, it.id) }, ...(it.kind === "group" ? walk(it.id, depth + 1) : [])]);
  return walk(null, 0);
}

export const pct = (d: Day, first: Day, days: number): number => ((d - first) / days) * 100;

const parts = (d: Day): { y: number; m: number; day: number } => {
  const iso = toIso(d);
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
};

const withYears = (ticks: readonly { at: Day; label: string }[]): Tick[] =>
  ticks.map((t, n) => {
    const y = parts(t.at).y;
    return n === 0 || parts(ticks[n - 1].at).y !== y ? { at: t.at, label: `${t.label} ${y}` } : t;
  });

const between = (first: Day, last: Day): Day[] => Array.from({ length: last - first + 1 }, (_, i) => first + i);

export function printScale(first: Day, last: Day): Tick[] {
  if (last < first) throw new Error(`Print: the chart ends on ${toIso(last)}, before it starts on ${toIso(first)}`);
  const days = last - first + 1;
  const all = between(first, last);
  if (days <= WEEKS_UP_TO) return withYears(all.filter((d) => weekday(d) === 1).map((d) => ({ at: d, label: fmtShort(toIso(d)) })));
  const starts = all.filter((d) => parts(d).day === 1);
  if (days <= MONTHS_UP_TO) return withYears(starts.map((d) => ({ at: d, label: MONTHS[parts(d).m - 1] })));
  return withYears(starts.filter((d) => (parts(d).m - 1) % 3 === 0).map((d) => ({ at: d, label: `Q${(parts(d).m - 1) / 3 + 1}` })));
}
