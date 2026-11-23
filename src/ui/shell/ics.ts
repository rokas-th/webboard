import { toIso, type Day } from "../../domain/dates";
import type { ItemId } from "../../domain/model";
import type { RowContext } from "../list/columns";
import { planOrder } from "../list/model";

export interface Ics {
  text: string;
  events: number;
  undated: number;
}

const EOL = "\r\n";
const FOLD_OCTETS = 75;

const encoder = new TextEncoder();

const octets = (s: string): number => encoder.encode(s).length;

export const icsText = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");

export function foldLine(line: string): string {
  const parts = Array.from(line).reduce<string[]>(
    (acc, ch) => {
      const last = acc[acc.length - 1];
      if (octets(last) + octets(ch) <= FOLD_OCTETS) acc[acc.length - 1] = last + ch;
      else acc.push(` ${ch}`);
      return acc;
    },
    [""],
  );
  return parts.join(EOL);
}

const icsDate = (d: Day): string => toIso(d).replace(/-/g, "");

const icsStamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

export function icsOf(ctx: RowContext, stamp: number): Ics {
  const plan = ctx.view.plan;
  const milestones = planOrder(ctx).filter((id) => !ctx.ghosts.has(id) && plan.items.get(id)?.kind === "milestone");
  const dated = milestones.flatMap((id): { id: ItemId; day: Day }[] => {
    const day = ctx.view.derived.start.get(id);
    return day === undefined ? [] : [{ id, day }];
  });
  const at = icsStamp(stamp);
  const nameOf = (id: ItemId): string => {
    const item = plan.items.get(id);
    if (item === undefined) throw new Error(`ICS: no item ${id}`);
    return item.name;
  };
  const events = dated.flatMap(({ id, day }) => [
    "BEGIN:VEVENT",
    `UID:${plan.id}-${id}@webboard`,
    `DTSTAMP:${at}`,
    `DTSTART;VALUE=DATE:${icsDate(day)}`,
    `DTEND;VALUE=DATE:${icsDate(day + 1)}`,
    `SUMMARY:${icsText(nameOf(id))}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ]);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WebBoard//Milestones//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(plan.name)}`,
    ...events,
    "END:VCALENDAR",
  ];
  return { text: lines.map((l) => `${foldLine(l)}${EOL}`).join(""), events: dated.length, undated: milestones.length - dated.length };
}
