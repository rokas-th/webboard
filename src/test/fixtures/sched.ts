import { workCalendar, type WorkCalendar } from "../../domain/calendar";
import { toDay, type Day, type IsoDate } from "../../domain/dates";
import type { ItemId, Link, LinkType } from "../../domain/model";
import type { Lock, Sched, SchedView } from "../../domain/schedule";
import { CH_ZH } from "./calendars";

export const task = (id: ItemId, start: IsoDate, dur: number, lock: Lock | null = null): Sched => ({
  id,
  kind: "task",
  start: toDay(start),
  dur,
  lock,
});

export const ms = (id: ItemId, start: IsoDate, lock: Lock | null = null): Sched => ({
  id,
  kind: "milestone",
  start: toDay(start),
  dur: 0,
  lock,
});

export const ln = (from: ItemId, to: ItemId, type: LinkType = "FS", lag = 0): Link => ({ from, to, type, lag });

export const view = (
  items: readonly Sched[],
  links: readonly Link[],
  cal: WorkCalendar = workCalendar(CH_ZH),
): SchedView => ({
  items: new Map(items.map((s) => [s.id, s] as const)),
  links,
  cal,
});

export const PUSH_PLAN: SchedView = view(
  [
    task("U", "2026-10-26", 3),
    task("A", "2026-11-02", 10),
    task("B", "2026-11-09", 3),
    task("C", "2026-11-12", 2),
    task("D", "2026-11-10", 4),
    ms("E", "2026-11-16"),
    task("H", "2026-11-13", 2, "held"),
    task("K", "2026-11-16", 1),
  ],
  [ln("U", "A"), ln("A", "B"), ln("B", "C"), ln("B", "D", "SS", 1), ln("C", "E"), ln("D", "H"), ln("H", "K")],
);

export const applyMoves = (v: SchedView, moves: ReadonlyMap<ItemId, Day>): SchedView => {
  const missing = [...moves.keys()].filter((id) => !v.items.has(id));
  if (missing.length > 0) throw new Error(`applyMoves: no item ${missing.join(", ")}`);
  return {
    items: new Map([...v.items].map(([id, s]) => [id, moves.has(id) ? { ...s, start: moves.get(id) as Day } : s] as const)),
    links: v.links,
    cal: v.cal,
  };
};

export const storedStarts = (v: SchedView): ReadonlyMap<ItemId, Day> =>
  new Map([...v.items].map(([id, s]) => [id, s.start] as const));
