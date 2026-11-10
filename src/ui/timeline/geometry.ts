import { workCalendar, type WorkCalendar } from "../../domain/calendar";
import { toDay, weekday, type Day } from "../../domain/dates";
import type { ItemId } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import type { Zoom } from "../state";

export const PPD: Readonly<Record<Zoom, number>> = { W: 40, M: 16, Q: 6 };
export const ROW = 34;
export const LEAD = 160;

export const leadFor = (visible: number): number => Math.max(0, Math.min(LEAD, Math.floor(visible / 3)));

export interface Geometry {
  origin: Day;
  days: number;
  ppd: number;
  width: number;
  cal: WorkCalendar;
  span(id: ItemId): { start: Day; end: Day } | null;
  x(d: Day): number;
  dayAt(px: number): Day;
}

export function geometry(view: PlanView, zoom: Zoom): Geometry {
  const today = toDay(view.today);
  const { start, end } = view.derived;
  const lo = Math.min(today, ...start.values());
  const hi = Math.max(today, ...end.values());
  const monday = lo - 7 - (weekday(lo - 7) - 1);
  const days = hi + 35 - monday + 1;
  const ppd = PPD[zoom];
  return {
    origin: monday,
    days,
    ppd,
    width: days * ppd,
    cal: workCalendar(view.plan.calendar),
    span: (id) => {
      const s = start.get(id);
      const e = end.get(id);
      return s === undefined || e === undefined ? null : { start: s, end: e };
    },
    x: (d) => Math.round((d - monday) * ppd),
    dayAt: (px) => monday + Math.floor(px / ppd),
  };
}
