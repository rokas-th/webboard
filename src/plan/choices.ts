import { fmtShort, LOG_STYLE } from "../domain/dates";
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
  by: readonly ActionId[];
}

interface Found {
  units: readonly UnitKey[];
  parts: readonly ActionId[];
  lists: readonly (readonly ActionId[])[];
  bound: readonly (readonly ActionId[])[];
  deletions: readonly Deletion[];
}

interface Side {
  actions: ActionId[];
}

type Start = { kind: "none" } | { kind: "start"; start: string | null };

const NO_START: Start = { kind: "none" };

const ITEM_UNITS: readonly UnitKind[] = ["e", "n", "s", "p", "r", "wi", "pa"];
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

const successor = (u: UnitKey): ItemId => {
  const k = parseKey(u);
  if (k.to === undefined) throw new Error(`Link ${u} has no successor`);
  return k.to;
};

const itemsOf = (units: readonly UnitKey[]): ItemId[] =>
  unique(
    units.flatMap((u) => {
      const k = parseKey(u);
      if (ITEM_UNITS.includes(k.kind)) return [k.arg];
      if (k.kind === "l") return [successor(u)];
      return [];
    }),
  );

const itemIn = (plan: PlanState, id: ItemId) => {
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`Item ${id} is not in the plan`);
  return it;
};

const parentIn = (plan: PlanState, parent: ItemId | null): ItemId | null => {
  if (parent === null) return null;
  const p = plan.items.get(parent);
  return p !== undefined && p.kind === "group" ? parent : null;
};

const insideFrom = (plan: PlanState, parent: ItemId | null, x: ItemId): boolean => {
  const chain = (at: ItemId | null): boolean => {
    if (at === null) return false;
    if (at === x) return true;
    return chain(itemIn(plan, at).place.parent);
  };
  return chain(parentIn(plan, parent));
};

const itemName = (plan: PlanState, id: ItemId): string => itemIn(plan, id).name;

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

  write(id: ActionId, u: UnitKey): Write {
    const wr = this.writeOf(id, u);
    if (wr === undefined) throw new Error(`Action ${id} holds no write to ${u}`);
    return wr;
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
        const at = (p: ActionId): number => {
          const got = d.get(p);
          if (got === undefined) throw new Error(`Action ${p} has no depth before ${x}`);
          return got;
        };
        d.set(x, par.length === 0 ? 0 : 1 + Math.max(...par.map(at)));
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
    s.clash === null ? [] : [{ units: [u], parts: [...s.clash], lists: [s.clash], bound: [], deletions: [] }],
  );

const trashers = (r: Reader, u: UnitKey, trashing: (v: unknown) => boolean): readonly ActionId[] => {
  const ts = r.frontier(u).filter((id) => trashing(r.write(id, u).v));
  if (ts.length === 0) throw new Error(`No live write to ${u} trashes its item`);
  return ts;
};

const trashedBy = (r: Reader, x: ItemId): readonly ActionId[] | null => {
  const u = key.e(x);
  const st = r.log.unit(u);
  if (st !== undefined) return decodeAs("existence", u, st.value).t ? trashers(r, u, (v) => decodeAs("existence", u, v).t) : null;
  const ws = r.log.writers(u);
  if (ws.length === 0) throw new Error(`Item ${x} is in the plan but has no e: writes`);
  const create = ws[0];
  const au = key.a(create);
  const act = r.log.unit(au);
  if (act === undefined || act.value !== false) throw new Error(`Item ${x} has no existence while its create ${create} is active`);
  return trashers(r, au, (v) => v === false);
};

const deletions = (r: Reader): Found[] => {
  const kids = new Map<ItemId, ItemId[]>();
  [...r.plan.items.values()].forEach((it) => {
    if (it.place.parent !== null) kids.set(it.place.parent, [...(kids.get(it.place.parent) ?? []), it.id]);
  });
  const under = (x: ItemId): ItemId[] => [x, ...(kids.get(x) ?? []).flatMap(under)];
  const ids = [...r.plan.items.keys()].sort(cmp);
  return ids.flatMap((x): Found[] => {
    const ts = trashedBy(r, x);
    if (ts === null) return [];
    const editors = (u: UnitKey): ActionId[] =>
      r.frontier(u).filter((e) => OWNER_CAUSES.has(r.write(e, u).c) && ts.every((t) => r.concurrent(e, t)));
    const inside = new Set(under(x));
    const named = [...inside].flatMap((y) => [key.n(y), key.s(y)]).map((u): [UnitKey, ActionId[]] => [u, editors(u)]);
    const placed = ids.map((y): [UnitKey, ActionId[]] => {
      const u = key.p(y);
      return [
        u,
        editors(u).filter((e) => {
          if (inside.has(y)) return true;
          const before = r.log.valueWithout(u, new Set([e]));
          return before !== undefined && insideFrom(r.plan, decodeAs("place", u, before.value).parent, x);
        }),
      ];
    });
    const hit = [...named, ...placed].filter(([, es]) => es.length > 0);
    if (hit.length === 0) return [];
    const es = unique(hit.flatMap(([, e]) => e));
    return [
      {
        units: [key.e(x), ...hit.map(([u]) => u)],
        parts: [...ts, ...es],
        lists: hit.flatMap(([, e]) => ts.map((t) => [t, ...e])),
        bound: [ts],
        deletions: [{ item: x, by: ts }],
      },
    ];
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

interface ParentLoop {
  items: readonly ItemId[];
  units: readonly UnitKey[];
  parts: readonly ActionId[];
}

const parentLoops = (r: Reader): ParentLoop[] => {
  const parentOf = new Map(
    [...r.plan.items.keys()].flatMap((id): [ItemId, ItemId | null][] => {
      const u = key.p(id);
      const st = r.log.unit(u);
      return st === undefined ? [] : [[id, parentIn(r.plan, decodeAs("place", u, st.value).parent)]];
    }),
  );
  return cycles(parentOf).map((loop): ParentLoop => {
    const froms = loop.map((y): [UnitKey, ActionId] => {
      const u = key.p(y);
      const st = r.log.unit(u);
      if (st === undefined) throw new Error(`Unit ${u} in a parent loop has no live value`);
      return [u, st.from];
    });
    return { items: loop, units: froms.map(([u]) => u), parts: unique(froms.map(([, f]) => f)) };
  });
};

const placeLoops = (r: Reader): Found[] =>
  parentLoops(r).flatMap(({ units, parts }): Found[] => {
    if (parts.length < 2) return [];
    const pairs = parts.flatMap((f, i) => parts.slice(i + 1).map((g) => [f, g]));
    const apart = pairs.filter(([f, g]) => r.concurrent(f, g));
    return [{ units, parts, lists: apart.length > 0 ? apart : pairs, bound: [], deletions: [] }];
  });

const grouped = (found: readonly Found[]): Found[] => {
  const root = found.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  const owner = new Map<string, number>();
  found.forEach((f, i) =>
    f.parts.forEach((k) => {
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
    bound: fs.flatMap((f) => f.bound),
    deletions: fs.flatMap((f) => f.deletions),
  }));
};

const sidesOf = (r: Reader, g: Found): Side[] => {
  const sides: Side[] = [];
  const sideOf = new Map<ActionId, Side>();
  const sideAt = (q: ActionId): Side => {
    const side = sideOf.get(q);
    if (side === undefined) throw new Error(`Action ${q} has no side`);
    return side;
  };
  const join = (side: Side, p: ActionId) => {
    side.actions.push(p);
    sideOf.set(p, side);
  };
  const shares = (a: ActionId, b: ActionId) => g.lists.some((l) => l.includes(a) && l.includes(b));
  g.parts.forEach((p) => {
    const mate = g.parts.find(
      (q) => sideOf.has(q) && g.bound.some((b) => b.includes(q) && b.includes(p)) && !sideAt(q).actions.some((a) => shares(a, p)),
    );
    if (mate !== undefined) {
      join(sideAt(mate), p);
      return;
    }
    const seen = g.parts.find((q) => sideOf.has(q) && r.log.seen(q, p));
    const side = seen === undefined ? undefined : sideAt(seen);
    if (side !== undefined && !side.actions.some((a) => shares(a, p))) {
      join(side, p);
      return;
    }
    const opened = { actions: [p] };
    sides.push(opened);
    sideOf.set(p, opened);
  });
  return sides;
};

const valueOn = (r: Reader, side: Side, others: ReadonlySet<ActionId>, u: UnitKey): { v: unknown } | null => {
  const own = [...side.actions]
    .reverse()
    .map((a) => r.writeOf(a, u))
    .find((x) => x !== undefined);
  if (own !== undefined) return { v: own.v };
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

const orphanExistence = (r: Reader, d: Deletion, side: Side, others: ReadonlySet<ActionId>, u: UnitKey): Existence => {
  const st = r.log.unit(u);
  if (st !== undefined && !others.has(st.from)) throw new Error(`Side ${side.actions[0]} has no value for ${u} while ${u} is live`);
  const ws = r.log.writers(u);
  if (ws.length === 0) throw new Error(`Delete choice on ${u} has no e: writes`);
  const last = ws[ws.length - 1];
  return { k: decodeAs("existence", u, r.write(last, u).v).k, t: side.actions.some((a) => d.by.includes(a)) };
};

const startOf = (u: UnitKey, v: { v: unknown } | null): Start => (v === null ? NO_START : { kind: "start", start: decodeAs("sched", u, v.v).start });

const startTag = (s: Start): string => (s.kind === "none" ? "none" : `start ${s.start}`);

const later = (a: Start, b: Start): boolean => a.kind === "start" && b.kind === "start" && a.start !== null && b.start !== null && a.start > b.start;

const resultLabels = (r: Reader, g: Found, sides: readonly Side[], values: readonly ReadonlyMap<UnitKey, unknown>[]): string[] => {
  const othersOf = (i: number) => new Set(sides.filter((_, j) => j !== i).flatMap((s) => s.actions));
  const startIn = (i: number, u: UnitKey): Start => startOf(u, values[i].has(u) ? { v: values[i].get(u) } : null);
  const named = g.units.find((u) => parseKey(u).kind === "s" && new Set(sides.map((_, i) => startTag(startIn(i, u)))).size > 1);
  if (named === undefined) return sides.map((s) => r.action(s.actions[0]).lbl);
  const item = parseKey(named).arg;
  const written = unique(g.parts.flatMap((p) => r.action(p).w.map((x) => x.u))).filter((u) => parseKey(u).kind === "s" && u !== named);
  const starts = written.map((u) => sides.map((s, i) => startOf(u, valueOn(r, s, othersOf(i), u))));
  return sides.map((_, i) => {
    const start = startIn(i, named);
    if (start.kind === "none") throw new Error(`Side ${sides[i].actions[0]} has no value for ${named}`);
    const head = start.start === null ? `“${itemName(r.plan, item)}” has no start` : `“${itemName(r.plan, item)}” starts ${fmtShort(start.start, LOG_STYLE)}`;
    const n = starts.filter((row) => row.some((other, j) => j !== i && later(row[i], other))).length;
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
        const best = deepest.get(d);
        if (best === undefined) throw new Error(`Device ${d} has no deepest side`);
        return best === -1 || best === i ? deviceName(devices, d) : `${deviceName(devices, d)} — earlier copy`;
      })
      .join(" + "),
  );
};

const touched = (r: Reader, id: ActionId): UnitKey[] =>
  r.action(id).w.flatMap((x) => {
    const k = parseKey(x.u);
    return k.kind === "a" ? touched(r, k.arg) : [x.u];
  });

const build = (r: Reader, found: Found, devices: ReadonlyMap<DeviceId, string>): Choice => {
  const parts = r.byOrder(found.parts);
  const g: Found = { ...found, parts };
  const sides = sidesOf(r, g);
  const kind = kindOf(r, g);
  const values = sides.map((s, i) => {
    const others = new Set(sides.filter((_, j) => j !== i).flatMap((o) => o.actions));
    return new Map(
      g.units.flatMap((u): [UnitKey, unknown][] => {
        const got = valueOn(r, s, others, u);
        if (got !== null) return [[u, got.v]];
        const d = g.deletions.find((x) => key.e(x.item) === u);
        return d === undefined ? [] : [[u, orphanExistence(r, d, s, others, u)]];
      }),
    );
  });
  const labels = kind === "resolutions" ? resultLabels(r, g, sides, values) : deviceLabels(r, sides, devices);
  const items =
    kind === "activity"
      ? itemsOf(g.units.flatMap((u) => touched(r, parseKey(u).arg)))
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

export function silentLoops(log: LogState, plan: PlanState): readonly (readonly ItemId[])[] {
  return parentLoops(new Reader(log, plan))
    .filter((l) => l.parts.length < 2)
    .map((l) => l.items);
}

export function heldItems(choices: readonly Choice[], plan: PlanState): ReadonlySet<ItemId> {
  return new Set(
    choices
      .filter((c) => c.kind !== "calendar")
      .flatMap((c) => [
        ...c.units.flatMap((u) => {
          const k = parseKey(u);
          if (k.kind === "s") return [k.arg];
          if (k.kind === "l") return [successor(u)];
          return [];
        }),
        ...(c.kind === "activity" ? c.items.filter((i) => plan.items.has(i)).filter((i) => itemIn(plan, i).schedule !== null) : []),
      ]),
  );
}

export function choiceHolding(choices: readonly Choice[], plan: PlanState, item: ItemId): string {
  const c = choices.find((x) => heldItems([x], plan).has(item));
  if (c === undefined) throw new Error(`Item ${item} is held by no open choice`);
  return c.id;
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
