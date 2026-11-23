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

const parseDay = (d: string): Day | null => {
  if (!ISO_SHAPE.test(d)) return null;
  const [y, m, dd] = d.split("-").map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, dd);
  const day = t.getTime() / MS_PER_DAY;
  return toIso(day) === d ? day : null;
};

export function toDay(d: IsoDate): Day {
  const day = parseDay(d);
  if (day === null) throw new RangeError(`not a calendar date: ${JSON.stringify(d)}`);
  return day;
}

export const isCalendarDate = (d: string): boolean => parseDay(d) !== null;

export const FIRST_PLAN_DATE: IsoDate = "1900-01-01";
export const LAST_PLAN_DATE: IsoDate = "2199-12-31";

export const inPlanWindow = (d: string): boolean => isCalendarDate(d) && d >= FIRST_PLAN_DATE && d <= LAST_PLAN_DATE;

export const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

export function weekday(d: Day): Weekday {
  return WEEKDAYS[(((checkDay(d) + 3) % 7) + 7) % 7];
}

export function yearOf(d: Day): number {
  return Number(toIso(d).slice(0, 4));
}

export function localToday(now: Date = new Date()): IsoDate {
  if (Number.isNaN(now.getTime())) throw new RangeError("not a date: Invalid Date");
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}

export type DateFormat = "system" | "iso" | "dmy";
export type WeekStart = 1 | 7;
export type DayOrder = "dm" | "md";

export interface DateStyle {
  format: DateFormat;
  order: DayOrder;
}

export const DATE_FORMATS: readonly DateFormat[] = ["system", "iso", "dmy"];
export const WEEK_STARTS: readonly WeekStart[] = [1, 7];

export const LOG_STYLE: DateStyle = Object.freeze({ format: "system", order: "dm" });

const ORDER_PROBE = new Date(Date.UTC(2027, 2, 15));

export function dayOrderOf(locale: string): DayOrder {
  const parts = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).formatToParts(ORDER_PROBE);
  const day = parts.findIndex((x) => x.type === "day");
  const month = parts.findIndex((x) => x.type === "month");
  if (day < 0 || month < 0) throw new Error(`the ${locale} locale writes a date without a day or a month`);
  return day < month ? "dm" : "md";
}

const partsOf = (d: IsoDate): { y: string; m: string; day: number } => {
  toDay(d);
  return { y: d.slice(0, 4), m: MONTHS[Number(d.slice(5, 7)) - 1], day: Number(d.slice(8, 10)) };
};

export function fmtShort(d: IsoDate, style: DateStyle): string {
  const { y, m, day } = partsOf(d);
  switch (style.format) {
    case "iso":
      return d;
    case "dmy":
      return `${day}.${Number(d.slice(5, 7))}.${y}`;
    case "system":
      return style.order === "dm" ? `${day} ${m}` : `${m} ${day}`;
  }
}

export function fmtFull(d: IsoDate, style: DateStyle): string {
  const { y, m, day } = partsOf(d);
  if (style.format !== "system") return fmtShort(d, style);
  return style.order === "dm" ? `${day} ${m} ${y}` : `${m} ${day} ${y}`;
}

export function fmtNear(d: IsoDate, today: IsoDate, style: DateStyle): string {
  return d.slice(0, 4) === today.slice(0, 4) ? fmtShort(d, style) : fmtFull(d, style);
}

export function weekStartOf(day: Day, week: WeekStart): Day {
  return day - ((weekday(day) - week + 7) % 7);
}

export function weekdaysFrom(week: WeekStart): readonly Weekday[] {
  return WEEKDAYS.map((_, i) => WEEKDAYS[(week - 1 + i) % 7]);
}
