import { Graph, type ReadyCheck } from "./graph";
import { OWNER_CAUSES, type Action, type ActionId, type LogDelta, type Rules, type UnitKey, type UnitState, type Write } from "./types";

interface Unit {
  writers: ActionId[];
  writes: Map<ActionId, Write>;
  frontier: ActionId[];
  state: UnitState | undefined;
}

interface Basis {
  graph: Graph;
  table: Map<UnitKey, Unit>;
  inactive: Set<ActionId>;
}

let seed: Basis | null = null;

const ACTIVITY = "a:";

const target = (u: UnitKey): ActionId | null => (u.startsWith(ACTIVITY) ? u.slice(ACTIVITY.length) : null);

const arrivalRefusal = (a: Action): string | null => {
  const twice = a.w.find((w, i) => a.w.findIndex((o) => o.u === w.u) !== i);
  if (twice !== undefined) return `Action ${a.id} writes ${twice.u} twice`;
  const self = a.w.find((w) => target(w.u) === a.id);
  if (self !== undefined) return `Action ${a.id} writes ${self.u} without having seen it`;
  const loose = a.w.find((w) => target(w.u) !== null && typeof w.v !== "boolean");
  if (loose !== undefined) return `Action ${a.id} writes ${loose.u} with a value that is not true or false`;
  return null;
};

const unseenActivity: ReadyCheck = (a, saw) => {
  const unseen = a.w.find((w) => {
    const x = target(w.u);
    return x !== null && !saw(x);
  });
  return unseen === undefined ? null : `Action ${a.id} writes ${unseen.u} without having seen it`;
};

export class LogState {
  private readonly rules: Rules;
  private readonly graph: Graph;
  private readonly table: Map<UnitKey, Unit>;
  private readonly inactive: Set<ActionId>;
  private failure: string | null = null;

  constructor(rules: Rules) {
    const basis = seed;
    seed = null;
    this.rules = rules;
    this.graph = basis?.graph ?? new Graph();
    this.table = basis?.table ?? new Map();
    this.inactive = basis?.inactive ?? new Set();
  }

  add(actions: Iterable<Action>): LogDelta {
    this.usable();
    const batch = [...actions];
    try {
      return this.admit(batch);
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  get heads(): readonly ActionId[] {
    this.usable();
    return this.graph.heads;
  }

  get pending(): readonly ActionId[] {
    this.usable();
    return this.graph.pending;
  }

  get(id: ActionId): Action | undefined {
    this.usable();
    return this.graph.get(id);
  }

  unit(u: UnitKey): UnitState | undefined {
    this.usable();
    return this.table.get(u)?.state;
  }

  units(): ReadonlyMap<UnitKey, UnitState> {
    this.usable();
    return new Map(
      [...this.table].flatMap(([u, t]): [UnitKey, UnitState][] => (t.state === undefined ? [] : [[u, t.state]])),
    );
  }

  active(id: ActionId): boolean {
    this.usable();
    return this.isActive(id);
  }

  seen(ancestor: ActionId, by: ActionId): boolean {
    this.usable();
    if (!this.graph.ready(by)) throw new Error(`Action ${by} is not ready`);
    return this.graph.ready(ancestor) && this.graph.seen(ancestor, by);
  }

  valueWithout(u: UnitKey, without: ReadonlySet<ActionId>): UnitState | undefined {
    this.usable();
    const t = this.table.get(u);
    if (t === undefined) return undefined;
    const live = t.writers.filter((id) => this.isActive(id) && !without.has(id));
    return this.stateOf(u, t, this.frontierOf(live));
  }

  order(): readonly ActionId[] {
    this.usable();
    return this.graph.order();
  }

  before(a: ActionId, b: ActionId): boolean {
    this.usable();
    return this.graph.before(a, b);
  }

  writers(u: UnitKey): readonly ActionId[] {
    this.usable();
    return [...(this.table.get(u)?.writers ?? [])];
  }

  frontier(u: UnitKey): readonly ActionId[] {
    this.usable();
    return [...(this.table.get(u)?.frontier ?? [])];
  }

  fork(): LogState {
    this.usable();
    const table = new Map(
      [...this.table].map(([u, t]): [UnitKey, Unit] => [
        u,
        { writers: [...t.writers], writes: new Map(t.writes), frontier: [...t.frontier], state: t.state },
      ]),
    );
    return forked(this.rules, { graph: this.graph.copy(), table, inactive: new Set(this.inactive) });
  }

  private usable(): void {
    if (this.failure !== null) throw new Error(`LogState is unusable after an earlier error: ${this.failure}`);
  }

  private isActive(id: ActionId): boolean {
    return !this.inactive.has(id);
  }

  private admit(batch: readonly Action[]): LogDelta {
    const units = new Set<UnitKey>();
    const was = new Map<ActionId, boolean>();
    const added: ActionId[] = [];
    const refused = new Map<ActionId, string>();
    const refuse = (id: ActionId, message: string) => {
      if (!refused.has(id)) refused.set(id, message);
    };
    batch.forEach((a) => {
      if (this.graph.known(a.id)) {
        const repeat = this.graph.refusal(a);
        if (repeat !== null) refuse(a.id, repeat);
        return;
      }
      const reason = arrivalRefusal(a) ?? this.graph.refusal(a);
      if (reason !== null) {
        this.graph.reject(a);
        refuse(a.id, reason);
        return;
      }
      const admitted = this.graph.admit(a, unseenActivity);
      admitted.refused.forEach((r) => refuse(r.id, r.message));
      admitted.released.forEach((r) => {
        this.apply(r, units, was);
        added.push(r.id);
      });
    });
    const activity = new Set([...was].filter(([id, before]) => before !== this.isActive(id)).map(([id]) => id));
    return {
      units,
      activity,
      added: added.sort((x, y) => this.compare(x, y)),
      refused: [...refused].map(([id, message]) => ({ id, message })),
    };
  }

  private apply(a: Action, units: Set<UnitKey>, was: Map<ActionId, boolean>): void {
    const dirty = new Set<ActionId>();
    a.w.forEach((w) => {
      const t = this.table.get(w.u) ?? { writers: [], writes: new Map(), frontier: [], state: undefined };
      this.table.set(w.u, t);
      this.insert(t.writers, a.id);
      t.writes.set(a.id, w);
      t.frontier = t.frontier.filter((m) => !this.graph.seen(m, a.id));
      this.insert(t.frontier, a.id);
      t.state = this.stateOf(w.u, t, t.frontier);
      units.add(w.u);
      const x = target(w.u);
      if (x !== null) dirty.add(x);
    });
    this.cascade(dirty, units, was);
  }

  private cascade(dirty: Set<ActionId>, units: Set<UnitKey>, was: Map<ActionId, boolean>): void {
    const refresh = new Set<UnitKey>();
    while (dirty.size > 0) {
      const x = [...dirty].reduce((m, id) => (this.compare(id, m) > 0 ? id : m));
      dirty.delete(x);
      const u = ACTIVITY + x;
      const t = this.must(u);
      this.recompute(u, t);
      units.add(u);
      const now = t.state === undefined ? true : t.state.value === true;
      const before = this.isActive(x);
      if (now === before) continue;
      if (!was.has(x)) was.set(x, before);
      if (now) this.inactive.delete(x);
      else this.inactive.add(x);
      const flipped = this.graph.get(x);
      if (flipped === undefined) throw new Error(`Action ${x} is not ready`);
      flipped.w.forEach((w) => {
        const y = target(w.u);
        if (y === null) refresh.add(w.u);
        else dirty.add(y);
      });
    }
    refresh.forEach((u) => {
      this.recompute(u, this.must(u));
      units.add(u);
    });
  }

  private recompute(u: UnitKey, t: Unit): void {
    t.frontier = this.frontierOf(t.writers.filter((id) => this.isActive(id)));
    t.state = this.stateOf(u, t, t.frontier);
  }

  private frontierOf(live: readonly ActionId[]): ActionId[] {
    return live.reduceRight<ActionId[]>(
      (front, id) => (front.some((f) => this.graph.seen(id, f)) ? front : [id, ...front]),
      [],
    );
  }

  private stateOf(u: UnitKey, t: Unit, frontier: readonly ActionId[]): UnitState | undefined {
    const entries = frontier.map((id) => {
      const w = t.writes.get(id);
      if (w === undefined) throw new Error(`Action ${id} holds no write to ${u}`);
      return { id, w };
    });
    if (entries.length === 0) return undefined;
    const owners = entries.filter((e) => OWNER_CAUSES.has(e.w.c));
    if (owners.length > 0) {
      const latest = owners[owners.length - 1];
      const differ = owners.some((e, i) => owners.slice(i + 1).some((o) => !this.rules.same(u, e.w.v, o.w.v)));
      return { value: latest.w.v, from: latest.id, clash: differ ? owners.map((e) => e.id) : null };
    }
    const merged = entries.reduce((acc, next) => {
      const m = this.rules.mergeDerived(u, acc.w, next.w);
      if (m === acc.w) return acc;
      if (m === next.w) return next;
      throw new Error(`mergeDerived for ${u} returned a write that is neither of its two inputs`);
    });
    return { value: merged.w.v, from: merged.id, clash: null };
  }

  private must(u: UnitKey): Unit {
    const t = this.table.get(u);
    if (t === undefined) throw new Error(`Unit ${u} has no writers`);
    return t;
  }

  private compare(a: ActionId, b: ActionId): number {
    return a === b ? 0 : this.graph.before(a, b) ? -1 : 1;
  }

  private insert(list: ActionId[], id: ActionId): void {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.graph.before(list[mid], id)) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, id);
  }
}

function forked(rules: Rules, basis: Basis): LogState {
  seed = basis;
  return new LogState(rules);
}

export function replay(actions: Iterable<Action>, rules: Rules): LogState {
  const log = new LogState(rules);
  log.add(actions);
  return log;
}
