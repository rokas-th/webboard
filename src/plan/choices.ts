import { fmtShort } from "../domain/dates";
import type { ItemId, PlanState } from "../domain/model";
import type { LogState } from "../log/state";
import { OWNER_CAUSES, type ActionId, type DeviceId, type UnitKey, type Write } from "../log/types";
import { decodeAs, key, parseKey, type Existence, type UnitKind } from "./units";

export interface ChoiceSide {
  key: string;
  label: string;
  actions: readonly ActionId[];
  values: ReadonlyMap<UnitKey, unknown>;
}

export interface Choice {
  id: string;
  kind: "items" | "calendar" | "delete" | "activity" | "resolutions";
  units: readonly UnitKey[];
  items: readonly ItemId[];
  sides: readonly ChoiceSide[];
}

interface Deletion {
  item: ItemId;
  by: ActionId;
}

interface Found {
  units: readonly UnitKey[];
  parts: readonly ActionId[];
  lists: readonly (readonly ActionId[])[];
  deletions: readonly Deletion[];
}

interface Side {
  actions: ActionId[];
}

const ITEM_UNITS: readonly UnitKind[] = ["e", "n", "s", "p", "r"];
const CALENDAR_UNITS: readonly UnitKind[] = ["cr", "cw", "cc", "ct", "ch"];
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

export function fnv1a64(s: string): string {
  const h = new TextEncoder().encode(s).reduce((acc, b) => ((acc ^ BigInt(b)) * FNV_PRIME) & MASK_64, FNV_OFFSET);
  const bytes = Array.from({ length: 8 }, (_, i) => Number((h >> BigInt(56 - 8 * i)) & 0xffn));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const deviceName = (devices: ReadonlyMap<DeviceId, string>, dev: DeviceId): string => devices.get(dev) ?? `Device ${dev.slice(0, 4)}`;

const itemsOf = (units: readonly UnitKey[]): ItemId[] =>
  unique(
    units.flatMap((u) => {
      const k = parseKey(u);
      if (ITEM_UNITS.includes(k.kind)) return [k.arg];
      if (k.kind === "l") return [k.to as string];
      return [];
    }),
  );

const parentIn = (plan: PlanState, parent: ItemId | null): ItemId | null => {
  if (parent === null) return null;
  const p = plan.items.get(parent);
  return p !== undefined && p.kind === "group" ? parent : null;
};

const insideFrom = (plan: PlanState, parent: ItemId | null, x: ItemId): boolean => {
  const chain = (at: ItemId | null): boolean => {
    if (at === null) return false;
    if (at === x) return true;
    const it = plan.items.get(at);
    if (it === undefined) throw new Error(`Item ${at} is not in the plan`);
    return chain(it.place.parent);
  };
  return chain(parentIn(plan, parent));
};

const itemName = (plan: PlanState, id: ItemId): string => {
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`Item ${id} is not in the plan`);
  return it.name;
};

class Reader {
  private readonly pos: ReadonlyMap<ActionId, number>;
  private readonly fronts = new Map<UnitKey, readonly ActionId[]>();
  private depths: Map<ActionId, number> | null = null;

  constructor(
    readonly log: LogState,
    readonly plan: PlanState,
  ) {
    this.pos = new Map(log.order().map((id, i) => [id, i]));
  }

  at(id: ActionId): number {
    const p = this.pos.get(id);
    if (p === undefined) throw new Error(`Action ${id} is not ready`);
    return p;
  }

  byOrder(ids: Iterable<ActionId>): ActionId[] {
    return unique([...ids]).sort((a, b) => this.at(a) - this.at(b));
  }

  action(id: ActionId) {
    const a = this.log.get(id);
    if (a === undefined) throw new Error(`Action ${id} is not ready`);
    return a;
  }

  writeOf(id: ActionId, u: UnitKey): Write | undefined {
    return this.action(id).w.find((x) => x.u === u);
  }

  frontier(u: UnitKey): readonly ActionId[] {
    const known = this.fronts.get(u);
    if (known !== undefined) return known;
    const live = this.log.writers(u).filter((id) => this.log.active(id));
    const front = live.reduceRight<ActionId[]>((acc, id) => (acc.some((f) => this.log.seen(id, f)) ? acc : [id, ...acc]), []);
    this.fronts.set(u, front);
    return front;
  }

  concurrent(a: ActionId, b: ActionId): boolean {
    return a !== b && !this.log.seen(a, b) && !this.log.seen(b, a);
  }

  depth(id: ActionId): number {
    if (this.depths === null) {
      const d = new Map<ActionId, number>();
      this.log.order().forEach((x) => {
        const par = this.action(x).par;
        d.set(x, par.length === 0 ? 0 : 1 + Math.max(...par.map((p) => d.get(p) as number)));
      });
      this.depths = d;
    }
    const got = this.depths.get(id);
    if (got === undefined) throw new Error(`Action ${id} is not ready`);
    return got;
  }
}

const unitClashes = (r: Reader): Found[] =>
  [...r.log.units()].flatMap(([u, s]): Found[] =>
    s.clash === null ? [] : [{ units: [u], parts: [...s.clash], lists: [s.clash], deletions: [] }],
  );

const trashedBy = (r: Reader, x: ItemId): ActionId | null => {
  const u = key.e(x);
  const st = r.log.unit(u);
  if (st !== undefined) return decodeAs("existence", u, st.value).t ? st.from : null;
  const ws = r.log.writers(u);
  if (ws.length === 0) return null;
  const create = ws[0];
  const act = r.log.unit(key.a(create));
  if (act === undefined || act.value !== false) throw new Error(`Item ${x} has no existence while its create ${create} is active`);
  return act.from;
};

const deletions = (r: Reader): Found[] => {
  const kids = new Map<ItemId, ItemId[]>();
  [...r.plan.items.values()].forEach((it) => {
    if (it.place.parent !== null) kids.set(it.place.parent, [...(kids.get(it.place.parent) ?? []), it.id]);
  });
  const under = (x: ItemId): ItemId[] => [x, ...(kids.get(x) ?? []).flatMap(under)];
  const ids = [...r.plan.items.keys()].sort(cmp);
  return ids.flatMap((x): Found[] => {
    const t = trashedBy(r, x);
    if (t === null) return [];
    const editors = (u: UnitKey): ActionId[] =>
      r.frontier(u).filter((e) => {
        const wr = r.writeOf(e, u);
        return wr !== undefined && OWNER_CAUSES.has(wr.c) && r.concurrent(e, t);
      });
    const inside = new Set(under(x));
    const named = [...inside].flatMap((y) => [key.n(y), key.s(y)]).map((u): [UnitKey, ActionId[]] => [u, editors(u)]);
    const placed = ids.map((y): [UnitKey, ActionId[]] => {
      const u = key.p(y);
      return [
        u,
        editors(u).filter((e) => {
          if (y === x) return true;
          const before = r.log.valueWithout(u, new Set([e]));
          return before !== undefined && insideFrom(r.plan, decodeAs("place", u, before.value).parent, x);
        }),
      ];
    });
    const hit = [...named, ...placed].filter(([, es]) => es.length > 0);
    if (hit.length === 0) return [];
    const es = unique(hit.flatMap(([, e]) => e));
    return [{ units: [key.e(x), ...hit.map(([u]) => u)], parts: [t, ...es], lists: [[t, ...es]], deletions: [{ item: x, by: t }] }];
  });
};

const cycles = (parentOf: ReadonlyMap<ItemId, ItemId | null>): ItemId[][] => {
  const done = new Set<ItemId>();
  return [...parentOf.keys()].sort(cmp).flatMap((start): ItemId[][] => {
    const path: ItemId[] = [];
    let at: ItemId | null = start;
    while (at !== null && !done.has(at) && !path.includes(at)) {
      path.push(at);
      at = parentOf.get(at) ?? null;
    }
    path.forEach((p) => done.add(p));
    return at !== null && path.includes(at) ? [path.slice(path.indexOf(at))] : [];
  });
};

const placeLoops = (r: Reader): Found[] => {
  const parentOf = new Map(
    [...r.plan.items.keys()].flatMap((id): [ItemId, ItemId | null][] => {
      const u = key.p(id);
      const st = r.log.unit(u);
      return st === undefined ? [] : [[id, parentIn(r.plan, decodeAs("place", u, st.value).parent)]];
    }),
  );
  return cycles(parentOf).flatMap((loop): Found[] => {
    const froms = loop.map((y): [UnitKey, ActionId] => {
      const u = key.p(y);
      return [u, (r.log.unit(u) as { from: ActionId }).from];
    });
    const kept = froms.filter(([, f]) => froms.some(([, g]) => r.concurrent(f, g)));
    if (kept.length < 2) return [];
    const parts = unique(kept.map(([, f]) => f));
    return [{ units: kept.map(([u]) => u), parts, lists: [parts], deletions: [] }];
  });
};

const grouped = (found: readonly Found[]): Found[] => {
  const root = found.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  const owner = new Map<string, number>();
  found.forEach((f, i) =>
    [...f.parts.map((p) => "a " + p), ...f.units.map((u) => "u " + u)].forEach((k) => {
      const j = owner.get(k);
      if (j === undefined) owner.set(k, i);
      else root[find(i)] = find(j);
    }),
  );
  const groups = new Map<number, Found[]>();
  found.forEach((f, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), f]));
  return [...groups.values()].map((fs) => ({
    units: unique(fs.flatMap((f) => f.units)).sort(cmp),
    parts: unique(fs.flatMap((f) => f.parts)),
    lists: fs.flatMap((f) => f.lists),
    deletions: fs.flatMap((f) => f.deletions),
  }));
};

const sidesOf = (r: Reader, parts: readonly ActionId[], lists: readonly (readonly ActionId[])[]): Side[] => {
  const sides: Side[] = [];
  const sideOf = new Map<ActionId, Side>();
  const shares = (a: ActionId, b: ActionId) => lists.some((l) => l.includes(a) && l.includes(b));
  parts.forEach((p) => {
    const seen = parts.find((q) => sideOf.has(q) && r.log.seen(q, p));
    const side = seen === undefined ? undefined : (sideOf.get(seen) as Side);
    if (side !== undefined && !side.actions.some((a) => shares(a, p))) {
      side.actions.push(p);
      sideOf.set(p, side);
      return;
    }
    const opened = { actions: [p] };
    sides.push(opened);
    sideOf.set(p, opened);
  });
  return sides;
};

const valueOn = (r: Reader, side: Side, others: ReadonlySet<ActionId>, u: UnitKey): { v: unknown } | null => {
  const own = [...side.actions].reverse().find((a) => r.writeOf(a, u) !== undefined);
  if (own !== undefined) return { v: (r.writeOf(own, u) as Write).v };
  const st = r.log.valueWithout(u, others);
  return st === undefined ? null : { v: st.value };
};

const kindOf = (r: Reader, g: Found): Choice["kind"] => {
  const kinds = g.units.map((u) => parseKey(u).kind);
  if (kinds.every((k) => k === "a")) return "activity";
  if (g.parts.every((p) => r.action(p).meta?.resolves !== undefined)) return "resolutions";
  if (g.deletions.length > 0) return "delete";
  if (kinds.every((k) => CALENDAR_UNITS.includes(k))) return "calendar";
  return "items";
};

const existenceFallback = (r: Reader, g: Found, side: Side, u: UnitKey): Existence | null => {
  const d = g.deletions.find((x) => key.e(x.item) === u);
  if (d === undefined) return null;
  const ws = r.log.writers(u);
  const last = ws[ws.length - 1];
  const wr = r.writeOf(last, u);
  if (wr === undefined) throw new Error(`Action ${last} holds no write to ${u}`);
  return { k: decodeAs("existence", u, wr.v).k, t: side.actions.includes(d.by) };
};

const startOf = (u: UnitKey, v: { v: unknown } | null): string | null => (v === null ? null : decodeAs("sched", u, v.v).start);

const resultLabels = (r: Reader, g: Found, sides: readonly Side[], values: readonly ReadonlyMap<UnitKey, unknown>[]): string[] => {
  const othersOf = (i: number) => new Set(sides.filter((_, j) => j !== i).flatMap((s) => s.actions));
  const startIn = (i: number, u: UnitKey): string | null => (values[i].has(u) ? startOf(u, { v: values[i].get(u) }) : null);
  const named = g.units.find((u) => parseKey(u).kind === "s" && new Set(sides.map((_, i) => startIn(i, u))).size > 1);
  if (named === undefined) return sides.map((s) => r.action(s.actions[0]).lbl);
  const item = parseKey(named).arg;
  const written = unique(g.parts.flatMap((p) => r.action(p).w.map((x) => x.u))).filter((u) => parseKey(u).kind === "s" && u !== named);
  const starts = written.map((u) => sides.map((s, i) => startOf(u, valueOn(r, s, othersOf(i), u))));
  return sides.map((_, i) => {
    const start = startIn(i, named);
    const head = start === null ? `“${itemName(r.plan, item)}” has no start` : `“${itemName(r.plan, item)}” starts ${fmtShort(start)}`;
    const n = starts.filter((row) => {
      const mine = row[i];
      return mine !== null && row.some((other, j) => j !== i && other !== null && mine > other);
    }).length;
    return n === 0 ? head : n === 1 ? `${head}, 1 item moves` : `${head}, ${n} items move`;
  });
};

const deviceLabels = (r: Reader, sides: readonly Side[], devices: ReadonlyMap<DeviceId, string>): string[] => {
  const devs = sides.map((s) => unique(s.actions.map((a) => r.action(a).dev)));
  const deepest = new Map(
    unique(devs.flat()).map((d): [DeviceId, number] => {
      const holding = sides.map((_, i) => i).filter((i) => devs[i].includes(d));
      const best = holding.reduce((m, i) => {
        const di = r.depth(sides[i].actions[0]);
        const dm = r.depth(sides[m].actions[0]);
        return di > dm || (di === dm && r.at(sides[i].actions[0]) > r.at(sides[m].actions[0])) ? i : m;
      });
      return [d, holding.length > 1 ? best : -1];
    }),
  );
  return devs.map((ds, i) =>
    ds
      .map((d) => {
        const best = deepest.get(d) as number;
        return best === -1 || best === i ? deviceName(devices, d) : `${deviceName(devices, d)} — earlier copy`;
      })
      .join(" + "),
  );
};

const build = (r: Reader, found: Found, devices: ReadonlyMap<DeviceId, string>): Choice => {
  const parts = r.byOrder(found.parts);
  const g: Found = { ...found, parts };
  const sides = sidesOf(r, parts, g.lists);
  const kind = kindOf(r, g);
  const values = sides.map((s, i) => {
    const others = new Set(sides.filter((_, j) => j !== i).flatMap((o) => o.actions));
    return new Map(
      g.units.flatMap((u): [UnitKey, unknown][] => {
        const got = valueOn(r, s, others, u);
        if (got !== null) return [[u, got.v]];
        const fallback = existenceFallback(r, g, s, u);
        return fallback === null ? [] : [[u, fallback]];
      }),
    );
  });
  const labels = kind === "resolutions" ? resultLabels(r, g, sides, values) : deviceLabels(r, sides, devices);
  const items =
    kind === "activity"
      ? itemsOf(g.units.flatMap((u) => r.action(parseKey(u).arg).w.map((x) => x.u)))
      : itemsOf(g.units);
  return {
    id: fnv1a64([...parts].sort().join(",")),
    kind,
    units: g.units,
    items,
    sides: sides.map((s, i) => ({ key: s.actions[0], label: labels[i], actions: s.actions, values: values[i] })),
  };
};

export function choices(log: LogState, plan: PlanState, devices: ReadonlyMap<DeviceId, string>): Choice[] {
  const r = new Reader(log, plan);
  const found = grouped([...unitClashes(r), ...deletions(r), ...placeLoops(r)]);
  return found
    .map((f) => build(r, f, devices))
    .sort((a, b) => r.at(a.sides[0].actions[0]) - r.at(b.sides[0].actions[0]));
}

export function heldItems(choices: readonly Choice[], plan: PlanState): ReadonlySet<ItemId> {
  return new Set(
    choices
      .filter((c) => c.kind !== "calendar")
      .flatMap((c) => [
        ...c.units.flatMap((u) => {
          const k = parseKey(u);
          if (k.kind === "s") return [k.arg];
          if (k.kind === "l") return [k.to as string];
          return [];
        }),
        ...(c.kind === "activity" ? c.items.filter((i) => (plan.items.get(i)?.schedule ?? null) !== null) : []),
      ]),
  );
}

export function sideText(choice: Choice, side: string, plan: PlanState): string {
  const s = choice.sides.find((x) => x.key === side);
  if (s === undefined) throw new Error(`Choice ${choice.id} has no side ${side}`);
  if (choice.kind !== "delete") return s.label;
  const eu = choice.units.find((u) => parseKey(u).kind === "e");
  if (eu === undefined) throw new Error(`Delete choice ${choice.id} has no existence unit`);
  const x = parseKey(eu).arg;
  if (!s.values.has(eu)) throw new Error(`Side ${side} of choice ${choice.id} has no value for ${eu}`);
  if (decodeAs("existence", eu, s.values.get(eu)).t) return `“${itemName(plan, x)}” stays in the Trash`;
  const out = choice.units.find((u) => {
    const k = parseKey(u);
    return k.kind === "p" && k.arg !== x && s.values.has(u) && !insideFrom(plan, decodeAs("place", u, s.values.get(u)).parent, x);
  });
  if (out !== undefined) return `“${itemName(plan, parseKey(out).arg)}” is moved out of it`;
  return `“${itemName(plan, x)}” is restored with the ${s.label}'s edit`;
}

export function choiceOf(choices: readonly Choice[], u: UnitKey): Choice | null {
  return choices.find((c) => c.units.includes(u)) ?? null;
}
