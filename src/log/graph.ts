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

const isPlain = (v: unknown, inObject: boolean): boolean => {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (v === undefined) return inObject;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object") return false;
  if (Array.isArray(v)) return v.every((x) => isPlain(x, false));
  if (!isPlainObject(v)) return false;
  return Object.values(v).every((x) => isPlain(x, true));
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

export interface Refusal {
  id: ActionId;
  message: string;
}

export interface Admitted {
  released: readonly Action[];
  refused: readonly Refusal[];
}

export type ReadyCheck = (a: Action, saw: (ancestor: ActionId) => boolean) => string | null;

const NONE: Admitted = { released: [], refused: [] };

export class Graph {
  private readonly nodes: Map<ActionId, Node>;
  private readonly waiting: Map<ActionId, Waiting>;
  private readonly headSet: Set<ActionId>;
  private readonly blocked: Map<ActionId, ActionId[]>;
  private readonly tips: ActionId[];
  private readonly sorted: ActionId[];
  private readonly rejected: Map<ActionId, Action>;

  constructor(from?: Graph) {
    this.nodes = new Map(from?.nodes);
    this.waiting = new Map(
      [...(from?.waiting ?? [])].map(([id, w]): [ActionId, Waiting] => [id, { action: w.action, missing: new Set(w.missing) }]),
    );
    this.headSet = new Set(from?.headSet);
    this.blocked = new Map([...(from?.blocked ?? [])].map(([id, list]): [ActionId, ActionId[]] => [id, [...list]]));
    this.tips = [...(from?.tips ?? [])];
    this.sorted = [...(from?.sorted ?? [])];
    this.rejected = new Map(from?.rejected);
  }

  copy(): Graph {
    return new Graph(this);
  }

  get(id: ActionId): Action | undefined {
    return this.nodes.get(id)?.action;
  }

  known(id: ActionId): boolean {
    return this.has(id) || this.rejected.has(id);
  }

  reject(a: Action): void {
    if (this.known(a.id)) throw new Error(`Action ${a.id} is already known`);
    this.rejected.set(a.id, a);
  }

  refusal(a: Action): string | null {
    const known = this.nodes.get(a.id)?.action ?? this.waiting.get(a.id)?.action ?? this.rejected.get(a.id);
    if (known !== undefined) {
      const same = known === a || (isPlain(a, false) && equal(known, a));
      return same ? null : `Action ${a.id} arrived twice with different contents`;
    }
    if (!isPlain(a, false)) return `Action ${a.id} holds a value that is not plain JSON`;
    const missing = this.missingOf(a);
    if (missing.has(a.id)) return `Action ${a.id} lists itself as a parent`;
    if (missing.size > 0 && this.closesCycle(a.id, missing)) return `Action ${a.id} closes a parent cycle`;
    return null;
  }

  add(a: Action): readonly Action[] {
    return this.admit(a, () => null).released;
  }

  admit(a: Action, check: ReadyCheck): Admitted {
    const reason = this.refusal(a);
    if (reason !== null) throw new Error(reason);
    if (this.known(a.id)) return NONE;
    const missing = this.missingOf(a);
    if (missing.size > 0) {
      this.waiting.set(a.id, { action: a, missing });
      missing.forEach((p) => {
        const list = this.blocked.get(p);
        if (list === undefined) this.blocked.set(p, [a.id]);
        else list.push(a.id);
      });
      return NONE;
    }
    const released: Action[] = [];
    const refused: Refusal[] = [];
    const queue: Action[] = [a];
    for (const next of queue) {
      const message = check(next, (x) => this.nodes.has(x) && next.par.some((p) => this.seen(x, p)));
      if (message !== null) {
        this.rejected.set(next.id, next);
        refused.push({ id: next.id, message });
        continue;
      }
      this.place(next);
      released.push(next);
      queue.push(...this.unblock(next.id));
    }
    return { released: released.sort((x, y) => this.compare(x.id, y.id)), refused };
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

  private missingOf(a: Action): Set<ActionId> {
    return new Set(a.par.filter((p) => !this.nodes.has(p)));
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
