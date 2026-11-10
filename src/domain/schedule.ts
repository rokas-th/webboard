import type { WorkCalendar } from "./calendar";
import type { Day } from "./dates";
import { linkKey, type ItemId, type Link, type LinkKey } from "./model";
import { need } from "./need";

export type Lock = "done" | "doing" | "held";

export interface Sched {
  id: ItemId;
  kind: "task" | "milestone";
  start: Day;
  dur: number;
  lock: Lock | null;
}

export interface SchedView {
  items: ReadonlyMap<ItemId, Sched>;
  links: readonly Link[];
  cal: WorkCalendar;
}

export function startOf(s: Sched, cal: WorkCalendar): Day {
  return cal.snapF(s.start);
}

export function endOf(s: Sched, cal: WorkCalendar): Day {
  return s.kind === "milestone" ? startOf(s, cal) : cal.addWork(startOf(s, cal), Math.max(1, s.dur) - 1);
}

export function earliest(succ: Sched, link: Link, pred: Sched, cal: WorkCalendar): Day {
  const ps = startOf(pred, cal);
  const pe = endOf(pred, cal);
  const lag = link.lag;
  if (link.type === "FS") return cal.addWork(succ.kind === "milestone" ? pe : cal.after(pe), lag);
  if (link.type === "SS") return cal.addWork(ps, lag);
  const reqEnd = cal.addWork(link.type === "FF" ? pe : ps, lag);
  return succ.kind === "milestone" ? reqEnd : cal.subWork(reqEnd, Math.max(1, succ.dur) - 1);
}

export interface Stop {
  id: ItemId;
  reason: Lock;
}

export interface PushResult {
  moves: ReadonlyMap<ItemId, Day>;
  stopped: readonly Stop[];
}

const byId = (a: ItemId, b: ItemId): number => (a < b ? -1 : a > b ? 1 : 0);

const groupBy = <T>(xs: readonly T[], keyOf: (x: T) => ItemId): Map<ItemId, T[]> => {
  const out = new Map<ItemId, T[]>();
  xs.forEach((x) => {
    const k = keyOf(x);
    const list = out.get(k);
    if (list === undefined) out.set(k, [x]);
    else list.push(x);
  });
  return out;
};

const successorMap = (links: readonly Link[]): Map<ItemId, ItemId[]> =>
  new Map([...groupBy(links, (l) => l.from)].map(([k, ls]) => [k, ls.map((l) => l.to)]));

export function loopLinks(links: readonly Link[]): ReadonlySet<LinkKey> {
  const succ = successorMap(links);
  const nodes = [...new Set(links.flatMap((l) => [l.from, l.to]))].sort(byId);
  const index = new Map<ItemId, number>();
  const low = new Map<ItemId, number>();
  const onStack = new Set<ItemId>();
  const stack: ItemId[] = [];
  const component = new Map<ItemId, number>();
  const sizes: number[] = [];
  const visit = (v: ItemId): void => {
    index.set(v, index.size);
    low.set(v, need(index, v, "index"));
    stack.push(v);
    onStack.add(v);
    (succ.get(v) ?? []).forEach((w) => {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(need(low, v, "low link"), need(low, w, "low link")));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(need(low, v, "low link"), need(index, w, "index")));
      }
    });
    if (low.get(v) !== index.get(v)) return;
    const id = sizes.length;
    let size = 0;
    for (;;) {
      const w = stack.pop();
      if (w === undefined) throw new Error(`no stack entry for item ${v}`);
      onStack.delete(w);
      component.set(w, id);
      size += 1;
      if (w === v) break;
    }
    sizes.push(size);
  };
  nodes.forEach((v) => {
    if (!index.has(v)) visit(v);
  });
  return new Set(
    links
      .filter((l) => l.from === l.to || (component.get(l.from) === component.get(l.to) && sizes[need(component, l.from, "component")] >= 2))
      .map((l) => linkKey(l.from, l.to)),
  );
}

export function wouldLoop(links: readonly Link[], candidate: Link): ItemId[] | null {
  if (candidate.from === candidate.to) return [candidate.from];
  const key = linkKey(candidate.from, candidate.to);
  const succ = successorMap(links.filter((l) => linkKey(l.from, l.to) !== key));
  const parent = new Map<ItemId, ItemId | null>([[candidate.to, null]]);
  const queue: ItemId[] = [candidate.to];
  for (let i = 0; i < queue.length; i += 1) {
    const v = queue[i];
    if (v === candidate.from) {
      const path: ItemId[] = [];
      for (let p: ItemId | null = v; p !== null; p = need(parent, p, "path parent")) path.unshift(p);
      return [candidate.from, ...path.slice(0, -1)];
    }
    [...(succ.get(v) ?? [])].sort(byId).filter((w) => !parent.has(w)).forEach((w) => {
      parent.set(w, v);
      queue.push(w);
    });
  }
  return null;
}

export function push(view: SchedView, roots: readonly ItemId[]): PushResult {
  const loops = loopLinks(view.links);
  const links = view.links.filter(
    (l) => !loops.has(linkKey(l.from, l.to)) && view.items.has(l.from) && view.items.has(l.to),
  );
  const succ = successorMap(links);
  const preds = groupBy(links, (l) => l.to);
  const rootSet = new Set(roots);
  const down = new Set<ItemId>();
  const frontier = [...roots];
  for (let v = frontier.pop(); v !== undefined; v = frontier.pop()) {
    if (!rootSet.has(v) && need(view.items, v, "schedule").lock !== null) continue;
    (succ.get(v) ?? []).filter((w) => !rootSet.has(w) && !down.has(w)).forEach((w) => {
      down.add(w);
      frontier.push(w);
    });
  }
  const inner = links.filter((l) => down.has(l.from) && down.has(l.to));
  const indeg = new Map<ItemId, number>([...down].map((v) => [v, 0]));
  inner.forEach((l) => indeg.set(l.to, need(indeg, l.to, "in-degree") + 1));
  const innerSucc = successorMap(inner);
  const ready = [...down].filter((v) => indeg.get(v) === 0).sort(byId);
  const order: ItemId[] = [];
  for (let v = ready.shift(); v !== undefined; v = ready.shift()) {
    order.push(v);
    (innerSucc.get(v) ?? []).forEach((w) => {
      indeg.set(w, need(indeg, w, "in-degree") - 1);
      if (indeg.get(w) === 0) {
        ready.push(w);
        ready.sort(byId);
      }
    });
  }
  if (order.length !== down.size) throw new Error("push: dependency cycle among push links");
  const moves = new Map<ItemId, Day>();
  const stopped: Stop[] = [];
  const current = (id: ItemId): Sched => {
    const s = need(view.items, id, "schedule");
    const m = moves.get(id);
    return m === undefined ? s : { ...s, start: m };
  };
  order.forEach((id) => {
    const s = current(id);
    const es = Math.max(...need(preds, id, "predecessors").map((l) => earliest(s, l, current(l.from), view.cal)));
    if (startOf(s, view.cal) >= es) return;
    if (s.lock !== null) stopped.push({ id, reason: s.lock });
    else moves.set(id, es);
  });
  return { moves, stopped };
}

export type Conflict =
  | { kind: "early"; link: LinkKey; pred: ItemId; succ: ItemId; need: Day; succLock: Lock | null }
  | { kind: "loop"; link: LinkKey }
  | { kind: "dayoff"; item: ItemId; shownFrom: Day };

export function conflicts(view: SchedView, storedStarts: ReadonlyMap<ItemId, Day>): Conflict[] {
  const loops = loopLinks(view.links);
  const keyed = view.links
    .map((l) => ({ l, key: linkKey(l.from, l.to) }))
    .sort((x, y) => byId(x.key, y.key));
  const loop: Conflict[] = keyed.filter(({ key }) => loops.has(key)).map(({ key }) => ({ kind: "loop", link: key }));
  const early: Conflict[] = keyed
    .filter(({ l, key }) => !loops.has(key) && view.items.has(l.from) && view.items.has(l.to))
    .flatMap(({ l, key }) => {
      const pred = need(view.items, l.from, "schedule");
      const succ = need(view.items, l.to, "schedule");
      const required = earliest(succ, l, pred, view.cal);
      return startOf(succ, view.cal) < required
        ? [{ kind: "early" as const, link: key, pred: l.from, succ: l.to, need: required, succLock: succ.lock }]
        : [];
    });
  const dayoff: Conflict[] = [...view.items.keys()].sort(byId).flatMap((id) => {
    const stored = storedStarts.get(id);
    if (stored === undefined) throw new Error(`conflicts: no stored start for ${id}`);
    return view.cal.isWork(stored) ? [] : [{ kind: "dayoff" as const, item: id, shownFrom: view.cal.snapF(stored) }];
  });
  return [...loop, ...early, ...dayoff];
}

export function lagThatHolds(succ: Sched, link: Link, pred: Sched, cal: WorkCalendar): number {
  const start = startOf(succ, cal);
  const holds = (lag: number): boolean => earliest(succ, { ...link, lag }, pred, cal) <= start;
  if (holds(link.lag)) return link.lag;
  let fails = link.lag;
  let step = 1;
  while (!holds(link.lag - step)) {
    fails = link.lag - step;
    step *= 2;
  }
  let ok = link.lag - step;
  while (fails - ok > 1) {
    const mid = Math.floor((ok + fails) / 2);
    if (holds(mid)) ok = mid;
    else fails = mid;
  }
  return ok;
}

export interface RecalResult {
  starts: ReadonlyMap<ItemId, Day>;
  durs: ReadonlyMap<ItemId, number>;
  pushed: PushResult;
  endsChanged: number;
  movedLater: number;
}

export function recalendar(view: SchedView, next: WorkCalendar): RecalResult {
  const items = [...view.items.values()];
  const durs = new Map(
    items
      .filter((s) => s.kind === "task" && s.lock === "done")
      .map((s) => [s.id, Math.max(1, next.workBetween(next.snapF(s.start), endOf(s, view.cal)))] as const)
      .filter(([id, dur]) => dur !== need(view.items, id, "schedule").dur),
  );
  const starts = new Map(
    items
      .filter((s) => s.lock === null)
      .map((s) => [s.id, next.snapF(s.start)] as const)
      .filter(([id, start]) => start !== need(view.items, id, "schedule").start),
  );
  const recal: SchedView = {
    items: new Map(
      items.map((s) => [s.id, { ...s, start: starts.get(s.id) ?? s.start, dur: durs.get(s.id) ?? s.dur }] as const),
    ),
    links: view.links,
    cal: next,
  };
  const loops = loopLinks(view.links);
  const live = view.links.filter((l) => !loops.has(linkKey(l.from, l.to)) && view.items.has(l.from) && view.items.has(l.to));
  const led = new Set(live.map((l) => l.to));
  const preds = groupBy(live, (l) => l.to);
  const endMoved = (s: Sched, moves: ReadonlyMap<ItemId, Day>): boolean => {
    const r = need(recal.items, s.id, "schedule");
    const m = moves.get(s.id);
    return endOf(m === undefined ? r : { ...r, start: m }, next) !== endOf(s, view.cal);
  };
  const roots = items
    .filter((s) => !led.has(s.id) || s.lock !== null)
    .map((s) => s.id)
    .sort(byId);
  const pushedFromRoots = push(recal, roots);
  const at = (id: ItemId): Sched => {
    const r = need(recal.items, id, "schedule");
    const m = pushedFromRoots.moves.get(id);
    return m === undefined ? r : { ...r, start: m };
  };
  const lockStops = items
    .filter((s) => led.has(s.id))
    .sort((a, b) => byId(a.id, b.id))
    .flatMap((s): Stop[] => {
      if (s.lock === null) return [];
      const now = at(s.id);
      const early = need(preds, s.id, "predecessors").some((l) => startOf(now, next) < earliest(now, l, at(l.from), next));
      return early ? [{ id: s.id, reason: s.lock }] : [];
    });
  const pushed: PushResult = { moves: pushedFromRoots.moves, stopped: [...pushedFromRoots.stopped, ...lockStops] };
  const endsChanged = items.filter((s) => endMoved(s, pushed.moves)).length;
  return { starts, durs, pushed, endsChanged, movedLater: pushed.moves.size };
}
