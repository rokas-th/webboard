import { OWNER_CAUSES, type Action, type ActionId, type Rules, type UnitKey, type UnitState, type Write } from "../log/types";

export interface OracleResult {
  order: ActionId[];
  heads: ActionId[];
  pending: ActionId[];
  active: Map<ActionId, boolean>;
  units: Map<UnitKey, UnitState>;
}

const lookup = <K, V>(m: ReadonlyMap<K, V>, k: K): V => {
  const v = m.get(k);
  if (v === undefined) throw new Error(`oracle: no entry for ${String(k)}`);
  return v;
};

export function oracle(delivered: Iterable<Action>, rules: Rules): OracleResult {
  const byId = new Map<ActionId, Action>();
  [...delivered].forEach((a) => byId.set(a.id, a));
  const ready = new Set<ActionId>();
  let grew = true;
  while (grew) {
    const fresh = [...byId.values()].filter((a) => !ready.has(a.id) && a.par.every((p) => ready.has(p)));
    fresh.forEach((a) => ready.add(a.id));
    grew = fresh.length > 0;
  }
  const depth = new Map<ActionId, number>();
  const ancestors = new Map<ActionId, Set<ActionId>>();
  const depthOf = (id: ActionId): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const d = Math.max(-1, ...lookup(byId, id).par.map(depthOf)) + 1;
    depth.set(id, d);
    return d;
  };
  const ancestorsOf = (id: ActionId): Set<ActionId> => {
    const known = ancestors.get(id);
    if (known !== undefined) return known;
    const set = new Set<ActionId>([id]);
    lookup(byId, id).par.forEach((p) => ancestorsOf(p).forEach((x) => set.add(x)));
    ancestors.set(id, set);
    return set;
  };
  const order = [...ready].sort((x, y) => depthOf(x) - depthOf(y) || (x < y ? -1 : x > y ? 1 : 0));
  const named = new Set(order.flatMap((id) => lookup(byId, id).par));
  const heads = order.filter((id) => !named.has(id));
  const pending = [...byId.keys()].filter((id) => !ready.has(id)).sort();

  const writeOf = (id: ActionId, u: UnitKey): Write | undefined => lookup(byId, id).w.find((w) => w.u === u);

  const stateOf = (u: UnitKey, live: readonly ActionId[]): UnitState | undefined => {
    const top = live.filter((w) => !live.some((o) => o !== w && ancestorsOf(o).has(w)));
    if (top.length === 0) return undefined;
    const pairs = top.map((id) => {
      const w = writeOf(id, u);
      if (w === undefined) throw new Error(`oracle: ${id} does not write ${u}`);
      return [id, w] as const;
    });
    const owners = pairs.filter(([, w]) => OWNER_CAUSES.has(w.c));
    if (owners.length > 0) {
      const [lastId, lastW] = owners[owners.length - 1];
      const allSame = owners.every(([, a]) => owners.every(([, b]) => rules.same(u, a.v, b.v)));
      return { value: lastW.v, from: lastId, clash: owners.length >= 2 && !allSame ? owners.map(([id]) => id) : null };
    }
    let [fromId, acc] = pairs[0];
    pairs.slice(1).forEach(([id, w]) => {
      const m = rules.mergeDerived(u, acc, w);
      if (m === w) [fromId, acc] = [id, w];
      else if (m !== acc) throw new Error(`oracle: mergeDerived for ${u} returned a new write`);
    });
    return { value: acc.v, from: fromId, clash: null };
  };

  const writersOf = (u: UnitKey) => order.filter((id) => writeOf(id, u) !== undefined);
  const active = new Map<ActionId, boolean>();
  [...order].reverse().forEach((x) => {
    const s = stateOf(
      "a:" + x,
      writersOf("a:" + x).filter((id) => lookup(active, id)),
    );
    active.set(x, s === undefined ? true : s.value === true);
  });

  const keys = [...new Set(order.flatMap((id) => lookup(byId, id).w.map((w) => w.u)))];
  const units = new Map<UnitKey, UnitState>();
  keys.forEach((u) => {
    const s = stateOf(
      u,
      writersOf(u).filter((id) => lookup(active, id)),
    );
    if (s !== undefined) units.set(u, s);
  });
  return { order, heads, pending, active, units };
}
