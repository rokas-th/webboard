import type { Preview } from "../../actions/intents";
import { fmtShort, localToday, type DateStyle, type IsoDate } from "../../domain/dates";

const two = (n: number): string => String(n).padStart(2, "0");

export function historyTime(at: number, today: IsoDate, style: DateStyle): string {
  const when = new Date(at);
  const time = `${two(when.getHours())}:${two(when.getMinutes())}`;
  const day = localToday(when);
  return day === today ? time : `${fmtShort(day, style)} ${time}`;
}

export function revertImpact(p: { itemsChanged: number; movedLater: number }): string {
  if (p.itemsChanged === 0) return "No item dates change.";
  const changes = `Changes ${p.itemsChanged} ${p.itemsChanged === 1 ? "item" : "items"}`;
  if (p.movedLater === 0) return changes;
  return `${changes}; ${p.movedLater} ${p.movedLater === 1 ? "moves" : "move"} later`;
}

export function revertText(label: string, p: Preview): readonly string[] {
  return [label, revertImpact(p), ...p.kept];
}
