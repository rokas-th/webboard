import { workCalendar } from "./calendar";
import { toDay, type Day, type IsoDate } from "./dates";
import { linkKey, type BaselineId, type Horizon, type Item, type ItemId, type PlanState, type Status } from "./model";
import { conflicts, endOf, loopLinks, startOf, type Conflict, type Lock, type Sched, type SchedView } from "./schedule";

export interface Derived {
  start: ReadonlyMap<ItemId, Day>;
  end: ReadonlyMap<ItemId, Day>;
  status: ReadonlyMap<ItemId, Status>;
  horizon: ReadonlyMap<ItemId, Horizon>;
  late: ReadonlySet<ItemId>;
  conflicts: readonly Conflict[];
  missingYears: readonly number[];
  progress: ReadonlyMap<ItemId, number>;
  slip(baseline: BaselineId): ReadonlyMap<ItemId, number>;
}

interface Basis {
  gone: ReadonlySet<ItemId>;
  live: ReadonlyMap<ItemId, Item>;
  status: ReadonlyMap<ItemId, Status>;
  view: SchedView;
}

export const goneSet = (plan: PlanState): ReadonlySet<ItemId> => {
  const gone = new Map<ItemId, boolean>();
  plan.items.forEach((_, id) => {
    const path: ItemId[] = [];
    let at: ItemId | null = id;
    while (at !== null && !gone.has(at)) {
      const seen = path.indexOf(at);
      if (seen >= 0) throw new Error(`parent cycle: ${path.slice(seen).sort().join(", ")}`);
      path.push(at);
      const child: ItemId = at;
      at = (plan.items.get(child) as Item).place.parent;
      if (at === null) break;
      const parent = plan.items.get(at);
      if (parent === undefined) throw new Error(`unknown parent ${at} of ${child}`);
      if (parent.kind !== "group") throw new Error(`parent ${at} of ${child} is not a group`);
    }
    const above = at !== null && gone.get(at) === true;
    path.reduceRight((acc, p) => {
      const g = acc || (plan.items.get(p) as Item).trashed;
      gone.set(p, g);
      return g;
    }, above);
  });
  return new Set([...gone].filter(([, g]) => g).map(([id]) => id));
};

export const lockOf = (status: Status | undefined, held: boolean): Lock | null =>
  status === "done" ? "done" : status === "doing" ? "doing" : held ? "held" : null;

const basis = (plan: PlanState, held: ReadonlySet<ItemId>): Basis => {
  const gone = goneSet(plan);
  const live = new Map([...plan.items].filter(([id, i]) => !gone.has(id) && i.kind !== "group"));
  const links = [...plan.links.values()].filter((l) => live.has(l.from) && live.has(l.to));
  const loops = loopLinks(links);
  const preds = new Map<ItemId, ItemId[]>();
  links
    .filter((l) => !loops.has(linkKey(l.from, l.to)))
    .forEach((l) => preds.set(l.to, [...(preds.get(l.to) ?? []), l.from]));
  const status = new Map<ItemId, Status>();
  const statusOf = (id: ItemId): Status => {
    const known = status.get(id);
    if (known !== undefined) return known;
    const i = live.get(id) as Item;
    const from = preds.get(id) ?? [];
    const s: Status =
      i.kind === "milestone" && from.length > 0
        ? from.every((p) => statusOf(p) === "done")
          ? "done"
          : "todo"
        : (i.schedule as NonNullable<Item["schedule"]>).status;
    status.set(id, s);
    return s;
  };
  live.forEach((_, id) => statusOf(id));
  const items = new Map(
    [...live.values()].flatMap((i) => {
      const sc = i.schedule as NonNullable<Item["schedule"]>;
      if (sc.start === null) return [];
      const s: Sched = {
        id: i.id,
        kind: i.kind as Sched["kind"],
        start: toDay(sc.start),
        dur: i.kind === "milestone" ? 0 : sc.dur,
        lock: lockOf(status.get(i.id) as Status, held.has(i.id)),
      };
      return [[i.id, s] as const];
    }),
  );
  return { gone, live, status, view: { items, links, cal: workCalendar(plan.calendar) } };
};

export function schedView(plan: PlanState, held: ReadonlySet<ItemId>): SchedView {
  return basis(plan, held).view;
}

const horizonOf = (days: number): Horizon => (days <= 14 ? "now" : days <= 56 ? "next" : "later");

export function derive(plan: PlanState, held: ReadonlySet<ItemId>, today: IsoDate): Derived {
  const { gone, live, status, view } = basis(plan, held);
  const { cal } = view;
  const now = toDay(today);
  const scheds = [...view.items.values()];
  const start = new Map(scheds.map((s) => [s.id, startOf(s, cal)] as const));
  const end = new Map(scheds.map((s) => [s.id, endOf(s, cal)] as const));

  const children = new Map<ItemId, Item[]>();
  [...plan.items.values()]
    .filter((i) => !gone.has(i.id) && i.place.parent !== null)
    .forEach((i) => children.set(i.place.parent as ItemId, [...(children.get(i.place.parent as ItemId) ?? []), i]));
  const groups = [...plan.items.values()].filter((i) => i.kind === "group" && !gone.has(i.id));

  const spans = new Map<ItemId, readonly [Day, Day] | null>();
  const spanOf = (g: ItemId): readonly [Day, Day] | null => {
    if (spans.has(g)) return spans.get(g) as readonly [Day, Day] | null;
    const parts = (children.get(g) ?? []).flatMap((c): (readonly [Day, Day])[] => {
      if (c.kind === "group") {
        const s = spanOf(c.id);
        return s === null ? [] : [s];
      }
      return start.has(c.id) ? [[start.get(c.id) as Day, end.get(c.id) as Day]] : [];
    });
    const span = parts.length === 0 ? null : ([Math.min(...parts.map((p) => p[0])), Math.max(...parts.map((p) => p[1]))] as const);
    spans.set(g, span);
    return span;
  };
  groups.forEach((g) => {
    const s = spanOf(g.id);
    if (s === null) return;
    start.set(g.id, s[0]);
    end.set(g.id, s[1]);
  });

  const weights = new Map<ItemId, readonly [number, number]>();
  const weightOf = (g: ItemId): readonly [number, number] => {
    const known = weights.get(g);
    if (known !== undefined) return known;
    const w = (children.get(g) ?? []).reduce<readonly [number, number]>((acc, c) => {
      if (c.kind === "group") {
        const [sum, dur] = weightOf(c.id);
        return [acc[0] + sum, acc[1] + dur];
      }
      if (c.kind !== "task") return acc;
      const sc = c.schedule as NonNullable<Item["schedule"]>;
      const p = status.get(c.id) === "done" ? 100 : sc.progress;
      return [acc[0] + sc.dur * p, acc[1] + sc.dur];
    }, [0, 0]);
    weights.set(g, w);
    return w;
  };
  const hasTask = (g: ItemId): boolean =>
    (children.get(g) ?? []).some((c) => c.kind === "task" || (c.kind === "group" && hasTask(c.id)));
  const progress = new Map(
    groups
      .filter((g) => hasTask(g.id))
      .map((g) => {
        const [sum, dur] = weightOf(g.id);
        if (dur === 0) throw new Error(`group ${g.id} has tasks but no duration`);
        return [g.id, Math.round(sum / dur)] as const;
      }),
  );

  const horizon = new Map(
    [...live.values()]
      .filter((i) => status.get(i.id) !== "done")
      .map((i) => {
        const s = view.items.get(i.id);
        if (s === undefined) return [i.id, (i.schedule as NonNullable<Item["schedule"]>).horizon] as const;
        return [i.id, status.get(i.id) === "doing" ? "now" : horizonOf((start.get(i.id) as Day) - now)] as const;
      }),
  );

  const late = new Set(scheds.filter((s) => status.get(s.id) !== "done" && (end.get(s.id) as Day) < now).map((s) => s.id));

  const stored = new Map(scheds.map((s) => [s.id, s.start] as const));
  const lo = Math.min(now, ...scheds.map((s) => start.get(s.id) as Day));
  const hi = Math.max(now, ...scheds.map((s) => end.get(s.id) as Day));

  const signedWork = (a: Day, b: Day): number =>
    a === b ? 0 : a < b ? cal.workBetween(cal.after(a), b) : -cal.workBetween(cal.after(b), a);

  const slip = (id: BaselineId): ReadonlyMap<ItemId, number> => {
    const b = plan.baselines.get(id);
    if (b === undefined) throw new Error(`no baseline ${id}`);
    return new Map(
      Object.entries(b.dates)
        .filter(([item]) => view.items.has(item))
        .map(([item, d]) => [item, signedWork(cal.snapF(toDay(d.start)), start.get(item) as Day)] as const),
    );
  };

  return {
    start,
    end,
    status,
    horizon,
    late,
    conflicts: conflicts(view, stored),
    missingYears: cal.missingYears(lo, hi),
    progress,
    slip,
  };
}
