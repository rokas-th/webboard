import { workCalendar, type WorkCalendar } from "../../domain/calendar";
import { toDay, weekday, type Day } from "../../domain/dates";
import type { ItemId } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import type { FixedZoom, Zoom } from "../state";

export const PPD: Readonly<Record<FixedZoom, number>> = { W: 40, M: 16, Q: 6 };
export const ROW = 34;
export const LEAD = 160;
export const FIT_MIN = 2;
export const FIT_MAX = 40;
export const DAY_TICKS_PPD = 28;
export const WEEK_TICKS_PPD = 10;

const FIXED: readonly FixedZoom[] = ["Q", "M", "W"];

export const leadFor = (visible: number): number => Math.max(0, Math.min(LEAD, Math.floor(visible / 3)));

export function fitSpan(view: PlanView): { first: Day; last: Day } {
  const today = toDay(view.today);
  const starts = [...view.derived.start.values()];
  const ends = [...view.derived.end.values()];
  return {
    first: (starts.length === 0 ? today : Math.min(...starts)) - 7,
    last: (ends.length === 0 ? today : Math.max(...ends)) + 7,
  };
}

export function fitPpd(view: PlanView, visible: number): number {
  const { first, last } = fitSpan(view);
  return Math.min(FIT_MAX, Math.max(FIT_MIN, visible / (last - first + 1)));
}

export function pinched(ppd: number, step: 1 | -1): FixedZoom | null {
  const next = step === 1 ? FIXED.find((z) => PPD[z] > ppd) : [...FIXED].reverse().find((z) => PPD[z] < ppd);
  return next ?? null;
}

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

function ppdOf(view: PlanView, zoom: Zoom, visible: number | undefined): number {
  if (zoom !== "F") return PPD[zoom];
  if (visible === undefined) throw new Error("Fit zoom needs the visible chart width");
  return fitPpd(view, visible);
}

export function geometry(view: PlanView, zoom: Zoom, visible?: number): Geometry {
  const today = toDay(view.today);
  const { start, end } = view.derived;
  const lo = Math.min(today, ...start.values());
  const hi = Math.max(today, ...end.values());
  const monday = lo - 7 - (weekday(lo - 7) - 1);
  const days = hi + 35 - monday + 1;
  const ppd = ppdOf(view, zoom, visible);
  return {
    origin: monday,
    days,
    ppd,
    width: Math.round(days * ppd),
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
