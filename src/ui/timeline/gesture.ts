import type { Intent } from "../../actions/intents";
import { toIso, type Day } from "../../domain/dates";
import type { ItemId } from "../../domain/model";
import type { Geometry } from "./geometry";

export interface Gesture {
  kind: "move" | "resize" | "link";
  item: ItemId;
  dxPx: number;
  target?: ItemId;
}

const MIN_PX = 4;

const calendarDays = (geo: Geometry, dxPx: number): number => (Math.abs(dxPx) < MIN_PX ? 0 : Math.round(dxPx / geo.ppd));

const landed = (geo: Geometry, d: Day, days: number): Day => (days >= 0 ? geo.cal.snapF(d + days) : geo.cal.snapB(d + days));

const signedWork = (geo: Geometry, a: Day, b: Day): number =>
  a === b ? 0 : a < b ? geo.cal.workBetween(geo.cal.after(a), b) : -geo.cal.workBetween(geo.cal.after(b), a);

export function gestureIntent(geo: Geometry, g: Gesture): Intent | null {
  if (g.kind === "link") return g.target === undefined || g.target === g.item ? null : { t: "link", from: g.item, to: g.target, type: "FS", lag: 0 };
  const span = geo.span(g.item);
  const days = calendarDays(geo, g.dxPx);
  if (span === null || days === 0) return null;
  if (g.kind === "move") {
    const work = signedWork(geo, span.start, landed(geo, span.start, days));
    return work === 0 ? null : { t: "move", items: [g.item], days: work };
  }
  const end = Math.max(span.start, geo.cal.snapB(span.end + days));
  const dur = Math.max(1, geo.cal.workBetween(span.start, end));
  return dur === geo.cal.workBetween(span.start, span.end) ? null : { t: "resize", item: g.item, dur };
}

export function startIntent(geo: Geometry, item: ItemId, dxPx: number): Intent | null {
  const span = geo.span(item);
  const days = calendarDays(geo, dxPx);
  if (span === null || days === 0) return null;
  const start = Math.min(span.end, landed(geo, span.start, days));
  if (start === span.start) return null;
  return { t: "schedule", item, set: { start: toIso(start), dur: Math.max(1, geo.cal.workBetween(start, span.end)) } };
}

export function isClick(down: { x: number; y: number }, up: { x: number; y: number }): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) < MIN_PX;
}
