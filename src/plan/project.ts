import type { Calendar, Closure, HolidayYear, Tuning } from "../domain/calendar";
import type { IsoDate } from "../domain/dates";
import type { Baseline, BaselineId, Item, ItemId, ItemKind, Link, LinkKey, PlanId, PlanState } from "../domain/model";
import type { LogState } from "../log/state";
import type { UnitKey, Write } from "../log/types";
import { decodeAs, decodeUnit, parseKey, validateWrite, type UnitKind } from "./units";

export class PlanIncomplete extends Error {}

interface Table {
  live: ReadonlyMap<UnitKey, unknown>;
  latest: ReadonlyMap<UnitKey, unknown>;
}

interface Parsed {
  u: UnitKey;
  v: unknown;
  kind: UnitKind;
  arg: string;
  to?: string;
}

interface Raw {
  item: Item;
  own: boolean;
}

const tables = new WeakMap<PlanState, Table>();

const ITEM_UNITS: readonly UnitKind[] = ["e", "n", "s", "p"];

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byOrder = (a: Item, b: Item): number => cmp(a.place.order, b.place.order) || cmp(a.id, b.id);

const REQUIRED: readonly [UnitKey, string][] = [
  ["pn", "name"],
  ["cr", "holiday region"],
  ["cw", "working week"],
];

const itemIds = (parsed: readonly Parsed[]): ItemId[] =>
  [...new Set(parsed.filter((p) => ITEM_UNITS.includes(p.kind)).map((p) => p.arg))].sort(cmp);

const latestWrite = (log: LogState, u: UnitKey): unknown => {
  const ws = log.writers(u);
  const last = ws[ws.length - 1];
  const write = log.get(last)?.w.find((x) => x.u === u);
  if (write === undefined) throw new Error(`Action ${last} holds no write to ${u}`);
  return write.v;
};

const rawItem = (id: ItemId, t: Table): Raw => {
  const pick = (k: UnitKind): { v: unknown; live: boolean } | null => {
    const u = `${k}:${id}`;
    if (t.live.has(u)) return { v: t.live.get(u), live: true };
    if (t.latest.has(u)) return { v: t.latest.get(u), live: false };
    return null;
  };
  const need = (k: UnitKind, what: string) => {
    const got = pick(k);
    if (got === null) throw new Error(`Item ${id} has no ${what}`);
    return got;
  };
  const e = need("e", "existence");
  const ex = decodeAs("existence", `e:${id}`, e.v);
  const kind: ItemKind = ex.k;
  const s = pick("s");
  const schedule = s === null ? null : decodeAs("sched", `s:${id}`, s.v);
  if (kind === "group" && schedule !== null) throw new Error(`Group ${id} has a schedule`);
  if (kind !== "group" && schedule === null) throw new Error(`Item ${id} has no schedule`);
  if (kind === "task" && schedule !== null && schedule.dur < 1) throw new Error(`Task ${id} has a duration under 1 working day`);
  const r = t.live.get(`r:${id}`);
  return {
    item: {
      id,
      kind,
      name: decodeAs("name", `n:${id}`, need("n", "name").v),
      trashed: false,
      schedule,
      place: decodeAs("place", `p:${id}`, need("p", "place").v),
      refs: r === undefined ? {} : decodeAs("refs", `r:${id}`, r),
    },
    own: e.live ? ex.t : true,
  };
};

const breakLoops = (parentOf: Map<ItemId, ItemId | null>): void => {
  const done = new Set<ItemId>();
  [...parentOf.keys()].forEach((start) => {
    const path: ItemId[] = [];
    const onPath = new Set<ItemId>();
    let at: ItemId | null = start;
    while (at !== null && !done.has(at) && !onPath.has(at)) {
      path.push(at);
      onPath.add(at);
      at = parentOf.get(at) ?? null;
    }
    if (at !== null && onPath.has(at)) {
      const loop = path.slice(path.indexOf(at));
      parentOf.set(loop.reduce((m, x) => (cmp(x, m) < 0 ? x : m)), null);
    }
    path.forEach((p) => done.add(p));
  });
};

const projectItems = (ids: readonly ItemId[], t: Table): Map<ItemId, Item> => {
  const raws = new Map(ids.map((id) => [id, rawItem(id, t)]));
  const parentOf = new Map(
    [...raws].map(([id, r]): [ItemId, ItemId | null] => {
      const p = r.item.place.parent;
      return [id, p !== null && raws.get(p)?.item.kind === "group" ? p : null];
    }),
  );
  breakLoops(parentOf);
  const trashed = new Map<ItemId, boolean>();
  const isTrashed = (id: ItemId): boolean => {
    const known = trashed.get(id);
    if (known !== undefined) return known;
    const parent = parentOf.get(id) ?? null;
    const value = (raws.get(id) as Raw).own || (parent !== null && isTrashed(parent));
    trashed.set(id, value);
    return value;
  };
  return new Map(
    [...raws].map(([id, r]): [ItemId, Item] => [
      id,
      { ...r.item, trashed: isTrashed(id), place: { parent: parentOf.get(id) ?? null, order: r.item.place.order } },
    ]),
  );
};

const nonNull = <T>(entries: readonly [string, T | null][]): [string, T][] =>
  entries.filter((e): e is [string, T] => e[1] !== null).sort((a, b) => cmp(a[0], b[0]));

const build = (id: PlanId, t: Table): PlanState => {
  const missing = REQUIRED.filter(([u]) => !t.live.has(u)).map(([, what]) => what);
  if (missing.length > 0) throw new PlanIncomplete(`Plan ${id} is not complete yet: it has no ${missing.join(" and no ")}`);
  const parsed: Parsed[] = [...t.live].map(([u, v]) => ({ u, v, ...parseKey(u) }));
  const of = (k: UnitKind) => parsed.filter((p) => p.kind === k);
  const links = nonNull<Link>(
    of("l").map((p): [LinkKey, Link | null] => {
      const v = decodeAs("link", p.u, p.v);
      return [`${p.arg}>${p.to as string}`, v === null ? null : { from: p.arg, to: p.to as string, type: v.type, lag: v.lag }];
    }),
  );
  const calendar: Calendar = {
    region: decodeAs("region", "cr", t.live.get("cr")),
    workdays: decodeAs("weekdays", "cw", t.live.get("cw")),
    closures: new Map(
      nonNull<Closure>(
        of("cc").map((p): [string, Closure | null] => {
          const v = decodeAs("closure", p.u, p.v);
          return [p.arg, v === null ? null : { id: p.arg, ...v }];
        }),
      ),
    ),
    tuning: new Map(nonNull<Tuning>(of("ct").map((p): [IsoDate, Tuning | null] => [p.arg, decodeAs("tuning", p.u, p.v)]))),
    holidays: new Map(
      nonNull<HolidayYear>(of("ch").map((p): [string, HolidayYear | null] => [p.arg, decodeUnit(p.u, p.v) as HolidayYear | null])).map(
        ([y, v]): [number, HolidayYear] => [Number(y), v],
      ),
    ),
  };
  const baselines = nonNull<Baseline>(
    of("b").map((p): [BaselineId, Baseline | null] => {
      const v = decodeAs("baseline", p.u, p.v);
      return [p.arg, v === null ? null : { id: p.arg, ...v }];
    }),
  );
  const plan: PlanState = {
    id,
    name: decodeAs("name", "pn", t.live.get("pn")),
    items: projectItems(itemIds(parsed), t),
    links: new Map(links),
    calendar,
    baselines: new Map(baselines),
  };
  tables.set(plan, t);
  return plan;
};

export function projectPlan(id: PlanId, log: LogState): PlanState {
  const live = new Map(
    [...log.units()].filter(([u]) => parseKey(u).kind !== "a").map(([u, s]): [UnitKey, unknown] => [u, s.value]),
  );
  const candidates = itemIds([...live.keys()].map((u) => ({ u, v: null, ...parseKey(u) })));
  const latest = new Map(
    candidates
      .flatMap((item) => ITEM_UNITS.map((k) => `${k}:${item}`))
      .filter((u) => !live.has(u) && log.writers(u).length > 0)
      .map((u): [UnitKey, unknown] => [u, latestWrite(log, u)]),
  );
  return build(id, { live, latest });
}

export function applyWrites(plan: PlanState, w: readonly Write[]): PlanState {
  const t = tables.get(plan);
  if (t === undefined) throw new Error("applyWrites needs a plan made by projectPlan or applyWrites");
  const live = new Map(t.live);
  const seen = new Set<UnitKey>();
  w.forEach((x) => {
    if (parseKey(x.u).kind === "a") throw new Error(`applyWrites cannot apply ${x.u}`);
    if (seen.has(x.u)) throw new Error(`applyWrites: ${x.u} written twice`);
    seen.add(x.u);
    validateWrite(x);
    live.set(x.u, x.v);
  });
  return build(plan.id, { live, latest: t.latest });
}

export function childrenOf(plan: PlanState, parent: ItemId | null): readonly Item[] {
  return [...plan.items.values()].filter((i) => i.place.parent === parent).sort(byOrder);
}

export function trashRoots(plan: PlanState): readonly ItemId[] {
  const parentOf = (i: Item): Item | null => {
    if (i.place.parent === null) return null;
    const p = plan.items.get(i.place.parent);
    if (p === undefined) throw new Error(`Item ${i.id} has a parent ${i.place.parent} that is not in the plan`);
    return p;
  };
  return [...plan.items.values()]
    .filter((i) => {
      const p = parentOf(i);
      return i.trashed && (p === null || !p.trashed);
    })
    .map((i) => i.id)
    .sort(cmp);
}

export function liveLinks(plan: PlanState): readonly Link[] {
  const live = (id: ItemId): boolean => {
    const it = plan.items.get(id);
    return it !== undefined && !it.trashed && it.kind !== "group";
  };
  return [...plan.links.values()].filter((l) => live(l.from) && live(l.to));
}
