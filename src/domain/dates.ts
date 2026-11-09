export type IsoDate = string;
export type Day = number;
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const MS_PER_DAY = 86_400_000;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const checkDay = (d: Day): Day => {
  if (!Number.isInteger(d)) throw new RangeError(`not a day: ${d}`);
  return d;
};

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

export function toIso(d: Day): IsoDate {
  return new Date(checkDay(d) * MS_PER_DAY).toISOString().slice(0, 10);
}

export function toDay(d: IsoDate): Day {
  const refuse = () => new RangeError(`not a calendar date: ${JSON.stringify(d)}`);
  if (!ISO_SHAPE.test(d)) throw refuse();
  const [y, m, dd] = d.split("-").map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, dd);
  const day = t.getTime() / MS_PER_DAY;
  if (toIso(day) !== d) throw refuse();
  return day;
}

export function weekday(d: Day): Weekday {
  return ((((checkDay(d) + 3) % 7) + 7) % 7 + 1) as Weekday;
}

export function yearOf(d: Day): number {
  return Number(toIso(d).slice(0, 4));
}

export function localToday(now: Date = new Date()): IsoDate {
  if (Number.isNaN(now.getTime())) throw new RangeError("not a date: Invalid Date");
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}

export function fmtShort(d: IsoDate): string {
  toDay(d);
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}
