import { workCalendar, type WorkCalendar } from "../../domain/calendar";
import { toDay, type IsoDate } from "../../domain/dates";
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
