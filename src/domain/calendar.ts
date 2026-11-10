import { toDay, toIso, weekday, yearOf, type Day, type IsoDate, type Weekday } from "./dates";

export type RegionRef =
  | { src: "openholidays"; country: string; subdivision: string | null }
  | { src: "govuk"; division: "england-and-wales" | "scotland" | "northern-ireland" }
  | { src: "opm" }
  | { src: "ics"; url: string; name: string };

export type HolidayKind = "public" | "optional" | "half";

export interface HolidayDay {
  date: IsoDate;
  name: string;
  kind: HolidayKind;
  sourceId: string;
  scope: string | null;
}

export interface HolidayYear {
  region: string;
  year: number;
  days: readonly HolidayDay[];
  fetchedAt: string;
}

export interface Closure {
  id: string;
  from: IsoDate;
  to: IsoDate;
  name: string;
}

export const MAX_CLOSURE_DAYS = 366;

export const CLOSURE_TOO_LONG = `A closure can last at most ${MAX_CLOSURE_DAYS} days.`;

export const closureTooLong = (from: IsoDate, to: IsoDate): boolean => toDay(to) - toDay(from) + 1 > MAX_CLOSURE_DAYS;

export type Tuning = { kind: "off" } | { kind: "work" } | { kind: "add"; name: string };

export interface Calendar {
  region: RegionRef | null;
  workdays: readonly Weekday[];
  closures: ReadonlyMap<string, Closure>;
  tuning: ReadonlyMap<IsoDate, Tuning>;
  holidays: ReadonlyMap<number, HolidayYear>;
}

export type OffOrigin = "official" | "optional-on" | "half-on" | "added" | "closure";

export interface OffDay {
  date: IsoDate;
  name: string;
  origin: OffOrigin;
  source: string | null;
}

export interface ListedDay {
  date: IsoDate;
  name: string;
  kind: HolidayKind | "added" | "closure";
  counted: boolean;
  tuned: boolean;
}

export interface WorkCalendar {
  isWork(d: Day): boolean;
  off(d: Day): OffDay | null;
  listed(from: Day, to: Day): readonly ListedDay[];
  missingYears(from: Day, to: Day): number[];
  snapF(d: Day): Day;
  snapB(d: Day): Day;
  after(d: Day): Day;
  addWork(d: Day, n: number): Day;
  subWork(d: Day, n: number): Day;
  workBetween(a: Day, b: Day): number;
}

export function regionKey(r: RegionRef): string {
  switch (r.src) {
    case "openholidays":
      return r.subdivision === null ? `oh:${r.country}` : `oh:${r.country}:${r.subdivision}`;
    case "govuk":
      return `govuk:${r.division}`;
    case "opm":
      return "opm";
    case "ics":
      return `ics:${r.url}`;
  }
}

const sourceName = (r: RegionRef): string => {
  switch (r.src) {
    case "openholidays":
      return "OpenHolidays";
    case "govuk":
      return "GOV.UK";
    case "opm":
      return "OPM";
    case "ics":
      return r.name;
  }
};

type Entry =
  | { kind: "added"; date: IsoDate; name: string }
  | { kind: "fetched"; date: IsoDate; day: HolidayDay }
  | { kind: "closure"; date: IsoDate; closure: Closure };

const fetchedOrigin = (day: HolidayDay, tuning: Tuning | undefined): OffOrigin | null => {
  if (day.kind === "public") return tuning?.kind === "work" ? null : "official";
  if (tuning?.kind !== "off") return null;
  return day.kind === "optional" ? "optional-on" : "half-on";
};

const tunes = (tuning: Tuning | undefined): boolean => tuning?.kind === "off" || tuning?.kind === "work";

const closureDays = (c: Closure): IsoDate[] => {
  const from = toDay(c.from);
  return Array.from({ length: Math.max(0, toDay(c.to) - from + 1) }, (_, i) => toIso(from + i));
};

export function workCalendar(cal: Calendar): WorkCalendar {
  if (cal.workdays.length === 0) throw new RangeError("a calendar needs at least one working weekday");
  const workdays = new Set<Weekday>(cal.workdays);
  const key = cal.region === null ? null : regionKey(cal.region);
  const source = cal.region === null ? null : sourceName(cal.region);
  const counting = [...cal.holidays].filter(([, y]) => key !== null && y.region === key);
  const loadedYears = new Set(counting.map(([year]) => year));

  const byDate = new Map<IsoDate, Entry[]>();
  const push = (e: Entry) => byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  cal.tuning.forEach((t, date) => {
    if (t.kind === "add") push({ kind: "added", date, name: t.name });
  });
  counting.flatMap(([, y]) => y.days).forEach((day) => push({ kind: "fetched", date: day.date, day }));
  [...cal.closures.values()]
    .sort((a, b) => (a.from === b.from ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.from < b.from ? -1 : 1))
    .forEach((closure) => closureDays(closure).forEach((date) => push({ kind: "closure", date, closure })));

  const offOf = (e: Entry): OffDay | null => {
    switch (e.kind) {
      case "added":
        return { date: e.date, name: e.name, origin: "added", source: null };
      case "fetched": {
        const origin = fetchedOrigin(e.day, cal.tuning.get(e.date));
        return origin === null ? null : { date: e.date, name: e.day.name, origin, source };
      }
      case "closure":
        return { date: e.date, name: e.closure.name, origin: "closure", source: null };
    }
  };

  const named = new Map<IsoDate, { entry: Entry; off: OffDay }>(
    [...byDate].flatMap(([date, entries]) => {
      if (!workdays.has(weekday(toDay(date)))) return [];
      return entries
        .flatMap((entry) => {
          const off = offOf(entry);
          return off === null ? [] : [{ entry, off }];
        })
        .slice(0, 1)
        .map((hit) => [date, hit] as const);
    }),
  );
  const offDays = new Map<Day, OffDay>([...named.values()].map(({ off }) => [toDay(off.date), off]));

  const off = (d: Day): OffDay | null => (workdays.has(weekday(d)) ? (offDays.get(d) ?? null) : null);
  const isWork = (d: Day): boolean => workdays.has(weekday(d)) && !offDays.has(d);

  const listedOf = (e: Entry): ListedDay => {
    const counted = named.get(e.date)?.entry === e;
    switch (e.kind) {
      case "added":
        return { date: e.date, name: e.name, kind: "added", counted, tuned: true };
      case "fetched":
        return { date: e.date, name: e.day.name, kind: e.day.kind, counted, tuned: tunes(cal.tuning.get(e.date)) };
      case "closure":
        return { date: e.date, name: e.closure.name, kind: "closure", counted, tuned: false };
    }
  };

  const listed = (from: Day, to: Day): readonly ListedDay[] => {
    const lo = toIso(from), hi = toIso(to);
    return [...byDate]
      .filter(([date]) => date >= lo && date <= hi)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([, entries]) => entries.map(listedOf));
  };

  const missingYears = (from: Day, to: Day): number[] => {
    if (key === null) return [];
    const first = yearOf(from), last = yearOf(to);
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i).filter((y) => !loadedYears.has(y));
  };

  const snapF = (d: Day): Day => { while (!isWork(d)) d += 1; return d; };
  const snapB = (d: Day): Day => { while (!isWork(d)) d -= 1; return d; };
  const after = (d: Day): Day => snapF(d + 1);
  function addWork(d: Day, n: number): Day {
    if (n < 0) return subWork(d, -n);
    d = snapF(d);
    for (; n > 0; n--) d = after(d);
    return d;
  }
  function subWork(d: Day, n: number): Day {
    d = snapB(d);
    for (; n > 0; n--) d = snapB(d - 1);
    return d;
  }
  const workBetween = (a: Day, b: Day): number => {
    let n = 0;
    for (let d = a; d <= b; d++) if (isWork(d)) n++;
    return n;
  };

  return { isWork, off, listed, missingYears, snapF, snapB, after, addWork, subWork, workBetween };
}
