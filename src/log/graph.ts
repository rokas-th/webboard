import type { Action, ActionId } from "./types";

type VersionVector = ReadonlyMap<number, number>;

interface Node {
  action: Action;
  depth: number;
  chain: number;
  pos: number;
  base: VersionVector | null;
}

interface Waiting {
  action: Action;
  missing: Set<ActionId>;
}

const isPlainObject = (v: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const assertPlain = (id: ActionId, v: unknown, inObject: boolean): void => {
  const fail = () => {
    throw new Error(`Action ${id} holds a value that is not plain JSON`);
  };
  if (v === null || typeof v === "string" || typeof v === "boolean") return;
  if (v === undefined) return inObject ? undefined : fail();
  if (typeof v === "number") return Number.isFinite(v) ? undefined : fail();
  if (typeof v !== "object") return fail();
  if (Array.isArray(v)) return v.forEach((x) => assertPlain(id, x, false));
  if (!isPlainObject(v)) return fail();
  Object.values(v).forEach((x) => assertPlain(id, x, true));
};

const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const defined = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined);
  const ea = defined(a);
  const mb = new Map(defined(b));
  return ea.length === mb.size && ea.every(([k, v]) => mb.has(k) && equal(v, mb.get(k)));
};

const sameRecord = (known: Action, a: Action): boolean => {
  assertPlain(a.id, known, false);
  assertPlain(a.id, a, false);
  return equal(known, a);
};

export class Graph {
  private readonly nodes = new Map<ActionId, Node>();
  private readonly waiting = new Map<ActionId, Waiting>();
  private readonly headSet = new Set<ActionId>();
  private readonly blocked = new Map<ActionId, ActionId[]>();
  private readonly tips: ActionId[] = [];
  private readonly sorted: ActionId[] = [];

  add(a: Action): readonly Action[] {
    const known = this.nodes.get(a.id)?.action ?? this.waiting.get(a.id)?.action;
    if (known !== undefined) {
      if (!sameRecord(known, a)) throw new Error(`Action ${a.id} arrived twice with different contents`);
      return [];
    }
    const missing = new Set(a.par.filter((p) => !this.nodes.has(p)));
    if (missing.size > 0) {
      if (missing.has(a.id)) throw new Error(`Action ${a.id} lists itself as a parent`);
      if (this.closesCycle(a.id, missing)) throw new Error(`Action ${a.id} closes a parent cycle`);
      this.waiting.set(a.id, { action: a, missing });
      missing.forEach((p) => {
        const list = this.blocked.get(p);
        if (list === undefined) this.blocked.set(p, [a.id]);
        else list.push(a.id);
      });
      return [];
    }
    const released: Action[] = [a];
    for (const next of released) {
      this.place(next);
      released.push(...this.unblock(next.id));
    }
    return released.sort((x, y) => this.compare(x.id, y.id));
  }

  has(id: ActionId): boolean {
    return this.nodes.has(id) || this.waiting.has(id);
  }

  ready(id: ActionId): boolean {
    return this.nodes.has(id);
  }

  get heads(): readonly ActionId[] {
    return [...this.headSet].sort((a, b) => this.compare(a, b));
  }

  get pending(): readonly ActionId[] {
    return [...this.waiting.keys()].sort();
  }

  depth(id: ActionId): number {
    return this.node(id).depth;
  }

  seen(ancestor: ActionId, by: ActionId): boolean {
    const x = this.node(ancestor);
    const y = this.node(by);
    if (x.chain === y.chain) return x.pos <= y.pos;
    const known = y.base?.get(x.chain);
    return known !== undefined && known >= x.pos;
  }

  order(): readonly ActionId[] {
    return [...this.sorted];
  }

  before(a: ActionId, b: ActionId): boolean {
    return this.compare(a, b) < 0;
  }

  private closesCycle(id: ActionId, missing: ReadonlySet<ActionId>): boolean {
    const visited = new Set<ActionId>();
    const stack = [...missing];
    for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
      if (p === id) return true;
      if (visited.has(p)) continue;
      visited.add(p);
      stack.push(...(this.waiting.get(p)?.missing ?? []));
    }
    return false;
  }

  private node(id: ActionId): Node {
    const n = this.nodes.get(id);
    if (n === undefined) throw new Error(`Action ${id} is not ready`);
    return n;
  }

  private compare(a: ActionId, b: ActionId): number {
    const da = this.depth(a);
    const db = this.depth(b);
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private unblock(id: ActionId): Action[] {
    const ids = this.blocked.get(id) ?? [];
    this.blocked.delete(id);
    return ids.flatMap((child) => {
      const w = this.waiting.get(child);
      if (w === undefined || !w.missing.delete(id)) {
        throw new Error(`Action ${child} was not waiting for ${id}`);
      }
      if (w.missing.size > 0) return [];
      this.waiting.delete(child);
      return [w.action];
    });
  }

  private place(a: Action): void {
    const parents = [...new Set(a.par)].map((p) => this.node(p));
    const depth = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => p.depth));
    const tip = parents.find((p) => p.action.ses === a.ses && this.tips[p.chain] === p.action.id);
    const chain = tip === undefined ? this.tips.length : tip.chain;
    const pos = tip === undefined ? 0 : tip.pos + 1;
    const merge = parents.some((p) => p.chain !== chain);
    const base = merge ? this.mergeVector(parents, chain, pos) : tip === undefined ? null : tip.base;
    this.tips[chain] = a.id;
    this.nodes.set(a.id, { action: a, depth, chain, pos, base });
    parents.forEach((p) => this.headSet.delete(p.action.id));
    this.headSet.add(a.id);
    this.insert(a.id);
  }

  private mergeVector(parents: readonly Node[], chain: number, pos: number): VersionVector {
    const vv = new Map<number, number>([[chain, pos]]);
    const raise = (c: number, p: number) => vv.set(c, Math.max(vv.get(c) ?? -1, p));
    parents.forEach((p) => {
      p.base?.forEach((at, c) => raise(c, at));
      raise(p.chain, p.pos);
    });
    return vv;
  }

  private insert(id: ActionId): void {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.sorted[mid], id) < 0) lo = mid + 1;
      else hi = mid;
    }
    this.sorted.splice(lo, 0, id);
  }
}
