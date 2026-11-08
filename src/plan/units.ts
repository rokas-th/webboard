import type { HolidayDay, HolidayKind, HolidayYear, RegionRef, Tuning } from "../domain/calendar";
import { toDay, type IsoDate, type Weekday } from "../domain/dates";
import type { BaselineId, Horizon, ItemId, ItemKind, LinkType, Place, Schedule, Status } from "../domain/model";
import type { ActionId, Cause, UnitKey, Write } from "../log/types";

export type UnitKind = "pn" | "cr" | "cw" | "e" | "n" | "s" | "p" | "r" | "l" | "cc" | "ct" | "ch" | "b" | "a";

export interface Codec<T> {
  enc(x: T): unknown;
  dec(v: unknown): T;
}

export interface Existence {
  k: ItemKind;
  t: boolean;
}

export interface LinkValue {
  type: LinkType;
  lag: number;
}

export interface ClosureValue {
  from: IsoDate;
  to: IsoDate;
  name: string;
}

export interface BaselineValue {
  name: string;
  at: IsoDate;
  dates: Readonly<Record<ItemId, { start: IsoDate; dur: number }>>;
}

export interface Codecs {
  name: Codec<string>;
  existence: Codec<Existence>;
  sched: Codec<Schedule>;
  place: Codec<Place>;
  refs: Codec<Readonly<Record<string, string>>>;
  link: Codec<LinkValue | null>;
  region: Codec<RegionRef | null>;
  weekdays: Codec<readonly Weekday[]>;
  closure: Codec<ClosureValue | null>;
  tuning: Codec<Tuning | null>;
  holidayYear: Codec<HolidayYear | null>;
  baseline: Codec<BaselineValue | null>;
  activity: Codec<boolean>;
}

const ID = /^[A-Za-z0-9_-]+$/;
const ORDER = /^[0-9A-Za-z]+$/;
const YEAR = /^[0-9]{4}$/;
const ITEM_KINDS: readonly ItemKind[] = ["task", "milestone", "group"];
const STATUSES: readonly Status[] = ["todo", "doing", "done"];
const HORIZONS: readonly Horizon[] = ["now", "next", "later"];
const LINK_TYPES: readonly LinkType[] = ["FS", "SS", "FF", "SF"];
const HOLIDAY_KINDS: readonly HolidayKind[] = ["public", "optional", "half"];
const DIVISIONS = ["england-and-wales", "scotland", "northern-ireland"] as const;
const CAUSES: readonly Cause[] = ["own", "push", "recalendar", "undo", "revert", "resolution"];
const BARE: readonly UnitKind[] = ["pn", "cr", "cw"];
const BY_ID: readonly UnitKind[] = ["e", "n", "s", "p", "r", "cc", "b", "a"];

const fail = (unit: string, message: string): Error => new Error(`${unit}: ${message}`);

const show = (v: unknown): string => (v === undefined ? "nothing" : JSON.stringify(v));

const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const record = (unit: string, field: string, v: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!isRecord(v)) throw fail(unit, `${field} is not an object: ${show(v)}`);
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (extra.length > 0) throw fail(unit, `${field} has unknown fields ${extra.join(", ")}`);
  const missing = keys.filter((k) => !(k in v));
  if (missing.length > 0) throw fail(unit, `${field} lacks ${missing.join(", ")}`);
  return v;
};

const tuple = (unit: string, v: unknown, length: number): readonly unknown[] => {
  if (!Array.isArray(v) || v.length !== length) throw fail(unit, `value is not a list of ${length}: ${show(v)}`);
  return v;
};

const str = (unit: string, field: string, v: unknown): string => {
  if (typeof v !== "string") throw fail(unit, `${field} is not a string: ${show(v)}`);
  return v;
};

const bool = (unit: string, field: string, v: unknown): boolean => {
  if (typeof v !== "boolean") throw fail(unit, `${field} is not true or false: ${show(v)}`);
  return v;
};

const int = (unit: string, field: string, v: unknown, min = -Infinity, max = Infinity): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    const range = min === -Infinity ? "" : max === Infinity ? ` of at least ${min}` : ` from ${min} to ${max}`;
    throw fail(unit, `${field} is not a whole number${range}: ${show(v)}`);
  }
  return v;
};

const oneOf = <T extends string>(unit: string, field: string, v: unknown, options: readonly T[]): T => {
  if (typeof v !== "string" || !(options as readonly string[]).includes(v)) throw fail(unit, `${field} is not one of ${options.join(", ")}: ${show(v)}`);
  return v as T;
};

const date = (unit: string, field: string, v: unknown): IsoDate => {
  const d = str(unit, field, v);
  if (!isDate(d)) throw fail(unit, `${field} is not a calendar date: ${show(v)}`);
  return d;
};

const isDate = (d: string): boolean => {
  try {
    toDay(d);
    return true;
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
};

const id = (unit: string, field: string, v: unknown): string => {
  const s = str(unit, field, v);
  if (!ID.test(s)) throw fail(unit, `${field} is not an id: ${show(v)}`);
  return s;
};

const nameRule = (unit: string, field: string, v: unknown): string => {
  const s = str(unit, field, v);
  if (s.length === 0) throw fail(unit, `${field} is empty`);
  if (/[\n\r]/.test(s)) throw fail(unit, `${field} holds a line break: ${show(v)}`);
  if (s.trim() !== s) throw fail(unit, `${field} has spaces at its start or end: ${show(v)}`);
  return s;
};

const nullable = <T>(read: (v: unknown) => T) => (v: unknown): T | null => (v === null ? null : read(v));

interface Spec<T> {
  enc(x: T): unknown;
  dec(v: unknown, unit: string): T;
}

const codec = <T>(spec: Spec<T>, unit: string): Codec<T> => ({
  enc: (x) => {
    const v = encodeChecked(spec, unit, x);
    spec.dec(v, unit);
    return v;
  },
  dec: (v) => spec.dec(v, unit),
});

const encodeChecked = <T>(spec: Spec<T>, unit: string, x: T): unknown => {
  try {
    return spec.enc(x);
  } catch (e) {
    if (e instanceof TypeError) throw fail(unit, `cannot encode ${show(x)}: ${e.message}`);
    throw e;
  }
};

const orNull = <T>(spec: Spec<T>): Spec<T | null> => ({
  enc: (x) => (x === null ? null : spec.enc(x)),
  dec: (v, unit) => nullable((x) => spec.dec(x, unit))(v),
});

const nameSpec: Spec<string> = {
  enc: (x) => x,
  dec: (v, unit) => nameRule(unit, "name", v),
};

const existenceSpec: Spec<Existence> = {
  enc: (x) => ({ k: x.k, t: x.t }),
  dec: (v, unit) => {
    const r = record(unit, "value", v, ["k", "t"]);
    return { k: oneOf(unit, "k", r.k, ITEM_KINDS), t: bool(unit, "t", r.t) };
  },
};

const schedSpec: Spec<Schedule> = {
  enc: (x) => [x.start, x.dur, x.status, x.progress, x.horizon],
  dec: (v, unit) => {
    const [start, dur, status, progress, horizon] = tuple(unit, v, 5);
    const s: Schedule = {
      start: start === null ? null : date(unit, "start", start),
      dur: int(unit, "dur", dur, 0),
      status: oneOf(unit, "status", status, STATUSES),
      progress: int(unit, "progress", progress, 0, 100),
      horizon: oneOf(unit, "horizon", horizon, HORIZONS),
    };
    if (s.status === "done" && s.progress !== 100) throw fail(unit, `progress must be 100 when status is done, not ${s.progress}`);
    return s;
  },
};

const placeSpec: Spec<Place> = {
  enc: (x) => [x.parent, x.order],
  dec: (v, unit) => {
    const [parent, order] = tuple(unit, v, 2);
    const o = str(unit, "order", order);
    if (!ORDER.test(o)) throw fail(unit, `order is not made of 0-9, A-Z and a-z: ${show(order)}`);
    return { parent: parent === null ? null : id(unit, "parent", parent), order: o };
  },
};

const refsSpec: Spec<Readonly<Record<string, string>>> = {
  enc: (x) => ({ ...x }),
  dec: (v, unit) => {
    if (!isRecord(v)) throw fail(unit, `refs is not an object: ${show(v)}`);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(unit, `refs.${k}`, x)]));
  },
};

const linkSpec: Spec<LinkValue> = {
  enc: (x) => [x.type, x.lag],
  dec: (v, unit) => {
    const [type, lag] = tuple(unit, v, 2);
    return { type: oneOf(unit, "type", type, LINK_TYPES), lag: int(unit, "lag", lag) };
  },
};

const regionSpec: Spec<RegionRef> = {
  enc: (x) => ({ ...x }),
  dec: (v, unit) => {
    if (!isRecord(v)) throw fail(unit, `region is not an object: ${show(v)}`);
    const src = oneOf(unit, "src", v.src, ["openholidays", "govuk", "opm", "ics"] as const);
    if (src === "openholidays") {
      const r = record(unit, "region", v, ["src", "country", "subdivision"]);
      return { src, country: str(unit, "country", r.country), subdivision: r.subdivision === null ? null : str(unit, "subdivision", r.subdivision) };
    }
    if (src === "govuk") {
      const r = record(unit, "region", v, ["src", "division"]);
      return { src, division: oneOf(unit, "division", r.division, DIVISIONS) };
    }
    if (src === "opm") {
      record(unit, "region", v, ["src"]);
      return { src };
    }
    const r = record(unit, "region", v, ["src", "url", "name"]);
    return { src, url: str(unit, "url", r.url), name: str(unit, "name", r.name) };
  },
};

const weekdaysSpec: Spec<readonly Weekday[]> = {
  enc: (x) => [...x],
  dec: (v, unit) => {
    if (!Array.isArray(v) || v.length === 0) throw fail(unit, `weekdays is not a non-empty list: ${show(v)}`);
    const days = v.map((d) => int(unit, "weekdays", d, 1, 7) as Weekday);
    if (new Set(days).size !== days.length) throw fail(unit, `weekdays repeats a day: ${show(v)}`);
    return days;
  },
};

const closureSpec: Spec<ClosureValue> = {
  enc: (x) => [x.from, x.to, x.name],
  dec: (v, unit) => {
    const [from, to, name] = tuple(unit, v, 3);
    const c: ClosureValue = { from: date(unit, "from", from), to: date(unit, "to", to), name: nameRule(unit, "name", name) };
    if (toDay(c.from) > toDay(c.to)) throw fail(unit, "closure ends before it starts");
    return c;
  },
};

const tuningSpec: Spec<Tuning> = {
  enc: (x) => ({ ...x }),
  dec: (v, unit) => {
    if (!isRecord(v)) throw fail(unit, `tuning is not an object: ${show(v)}`);
    const kind = oneOf(unit, "kind", v.kind, ["off", "work", "add"] as const);
    if (kind === "add") {
      const r = record(unit, "tuning", v, ["kind", "name"]);
      return { kind, name: nameRule(unit, "name", r.name) };
    }
    record(unit, "tuning", v, ["kind"]);
    return { kind };
  },
};

const holidayDay = (unit: string, v: unknown, i: number): HolidayDay => {
  const field = `days[${i}]`;
  const r = record(unit, field, v, ["date", "name", "kind", "sourceId", "scope"]);
  return {
    date: date(unit, `${field}.date`, r.date),
    name: str(unit, `${field}.name`, r.name),
    kind: oneOf(unit, `${field}.kind`, r.kind, HOLIDAY_KINDS),
    sourceId: str(unit, `${field}.sourceId`, r.sourceId),
    scope: r.scope === null ? null : str(unit, `${field}.scope`, r.scope),
  };
};

const holidayYearSpec: Spec<HolidayYear> = {
  enc: (x) => ({ region: x.region, year: x.year, days: x.days.map((d) => ({ ...d })), fetchedAt: x.fetchedAt }),
  dec: (v, unit) => {
    const r = record(unit, "value", v, ["region", "year", "days", "fetchedAt"]);
    if (!Array.isArray(r.days)) throw fail(unit, `days is not a list: ${show(r.days)}`);
    return {
      region: str(unit, "region", r.region),
      year: int(unit, "year", r.year),
      days: r.days.map((d, i) => holidayDay(unit, d, i)),
      fetchedAt: str(unit, "fetchedAt", r.fetchedAt),
    };
  },
};

const baselineSpec: Spec<BaselineValue> = {
  enc: (x) => ({ name: x.name, at: x.at, dates: Object.fromEntries(Object.entries(x.dates).map(([k, d]) => [k, { start: d.start, dur: d.dur }])) }),
  dec: (v, unit) => {
    const r = record(unit, "value", v, ["name", "at", "dates"]);
    if (!isRecord(r.dates)) throw fail(unit, `dates is not an object: ${show(r.dates)}`);
    const dates = Object.fromEntries(
      Object.entries(r.dates).map(([item, d]) => {
        const field = `dates.${item}`;
        id(unit, `${field} key`, item);
        const e = record(unit, field, d, ["start", "dur"]);
        return [item, { start: date(unit, `${field}.start`, e.start), dur: int(unit, `${field}.dur`, e.dur, 0) }];
      }),
    );
    return { name: nameRule(unit, "name", r.name), at: date(unit, "at", r.at), dates };
  },
};

const activitySpec: Spec<boolean> = {
  enc: (x) => x,
  dec: (v, unit) => bool(unit, "value", v),
};

type Value<K extends keyof Codecs> = Codecs[K] extends Codec<infer T> ? T : never;

const SPECS: { [K in keyof Codecs]: Spec<Value<K>> } = {
  name: nameSpec,
  existence: existenceSpec,
  sched: schedSpec,
  place: placeSpec,
  refs: refsSpec,
  link: orNull(linkSpec),
  region: orNull(regionSpec),
  weekdays: weekdaysSpec,
  closure: orNull(closureSpec),
  tuning: orNull(tuningSpec),
  holidayYear: orNull(holidayYearSpec),
  baseline: orNull(baselineSpec),
  activity: activitySpec,
};

export function decodeAs<K extends keyof Codecs>(codec: K, unit: UnitKey, v: unknown): Value<K> {
  return SPECS[codec].dec(v, unit);
}

const CODEC_OF: Readonly<Record<UnitKind, keyof Codecs>> = {
  pn: "name",
  n: "name",
  e: "existence",
  s: "sched",
  p: "place",
  r: "refs",
  l: "link",
  cr: "region",
  cw: "weekdays",
  cc: "closure",
  ct: "tuning",
  ch: "holidayYear",
  b: "baseline",
  a: "activity",
};

export const name: Codec<string> = codec(SPECS.name, "name");
export const existence: Codec<Existence> = codec(SPECS.existence, "e");
export const sched: Codec<Schedule> = codec(SPECS.sched, "s");
export const place: Codec<Place> = codec(SPECS.place, "p");
export const refs: Codec<Readonly<Record<string, string>>> = codec(SPECS.refs, "r");
export const link: Codec<LinkValue | null> = codec(SPECS.link, "l");
export const region: Codec<RegionRef | null> = codec(SPECS.region, "cr");
export const weekdays: Codec<readonly Weekday[]> = codec(SPECS.weekdays, "cw");
export const closure: Codec<ClosureValue | null> = codec(SPECS.closure, "cc");
export const tuning: Codec<Tuning | null> = codec(SPECS.tuning, "ct");
export const holidayYear: Codec<HolidayYear | null> = codec(SPECS.holidayYear, "ch");
export const baseline: Codec<BaselineValue | null> = codec(SPECS.baseline, "b");
export const activity: Codec<boolean> = codec(SPECS.activity, "a");

const NAMED: Readonly<Record<keyof Codecs, Codec<unknown>>> = {
  name: name as Codec<unknown>,
  existence: existence as Codec<unknown>,
  sched: sched as Codec<unknown>,
  place: place as Codec<unknown>,
  refs: refs as Codec<unknown>,
  link: link as Codec<unknown>,
  region: region as Codec<unknown>,
  weekdays: weekdays as Codec<unknown>,
  closure: closure as Codec<unknown>,
  tuning: tuning as Codec<unknown>,
  holidayYear: holidayYear as Codec<unknown>,
  baseline: baseline as Codec<unknown>,
  activity: activity as Codec<unknown>,
};

export function codecOf(kind: UnitKind): Codec<unknown> {
  return NAMED[CODEC_OF[kind]];
}

const malformed = (u: UnitKey): Error => new Error(`Malformed unit key “${u}”`);

export function parseKey(u: UnitKey): { kind: UnitKind; arg: string; to?: string } {
  const colon = u.indexOf(":");
  const prefix = colon < 0 ? u : u.slice(0, colon);
  const arg = colon < 0 ? "" : u.slice(colon + 1);
  const kind = prefix as UnitKind;
  if ((BARE as readonly string[]).includes(prefix)) {
    if (colon >= 0) throw malformed(u);
    return { kind, arg };
  }
  if (colon < 0) throw new Error(`Unknown unit key “${u}”`);
  if ((BY_ID as readonly string[]).includes(prefix)) {
    if (!ID.test(arg)) throw malformed(u);
    return { kind, arg };
  }
  if (prefix === "l") {
    const ends = arg.split(">");
    if (ends.length !== 2 || !ends.every((e) => ID.test(e))) throw malformed(u);
    return { kind, arg: ends[0], to: ends[1] };
  }
  if (prefix === "ct") {
    if (!isDate(arg)) throw malformed(u);
    return { kind, arg };
  }
  if (prefix === "ch") {
    if (!YEAR.test(arg)) throw malformed(u);
    return { kind, arg };
  }
  throw new Error(`Unknown unit key “${u}”`);
}

const checked = (u: UnitKey): UnitKey => {
  parseKey(u);
  return u;
};

export const key: {
  pn: UnitKey;
  cr: UnitKey;
  cw: UnitKey;
  e(i: ItemId): UnitKey;
  n(i: ItemId): UnitKey;
  s(i: ItemId): UnitKey;
  p(i: ItemId): UnitKey;
  r(i: ItemId): UnitKey;
  l(f: ItemId, t: ItemId): UnitKey;
  cc(id: string): UnitKey;
  ct(d: IsoDate): UnitKey;
  ch(y: number): UnitKey;
  b(id: BaselineId): UnitKey;
  a(id: ActionId): UnitKey;
} = {
  pn: "pn",
  cr: "cr",
  cw: "cw",
  e: (i) => checked(`e:${i}`),
  n: (i) => checked(`n:${i}`),
  s: (i) => checked(`s:${i}`),
  p: (i) => checked(`p:${i}`),
  r: (i) => checked(`r:${i}`),
  l: (f, t) => checked(`l:${f}>${t}`),
  cc: (i) => checked(`cc:${i}`),
  ct: (d) => checked(`ct:${d}`),
  ch: (y) => checked(`ch:${y}`),
  b: (i) => checked(`b:${i}`),
  a: (i) => checked(`a:${i}`),
};

export function decodeUnit(u: UnitKey, v: unknown): unknown {
  const { kind, arg } = parseKey(u);
  const value = SPECS[CODEC_OF[kind]].dec(v, u);
  if (kind === "ch" && value !== null && (value as HolidayYear).year !== Number(arg)) {
    throw fail(u, `year ${(value as HolidayYear).year} does not match the key`);
  }
  return value;
}

export function validateWrite(w: Write): void {
  if (!(CAUSES as readonly string[]).includes(w.c)) throw fail(w.u, `cause is not one of ${CAUSES.join(", ")}: ${show(w.c)}`);
  const value = decodeUnit(w.u, w.v);
  if ((w.c === "push" || w.c === "recalendar") && (parseKey(w.u).kind !== "s" || (value as Schedule).start === null)) {
    throw fail(w.u, `${w.c} cannot write this unit`);
  }
}
