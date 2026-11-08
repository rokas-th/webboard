import fc from "fast-check";
import { workCalendar, type Calendar, type Closure, type Tuning, type WorkCalendar } from "../../domain/calendar";
import { toDay, toIso, type Day, type IsoDate, type Weekday } from "../../domain/dates";
import { linkKey, type ItemId, type Link, type LinkType } from "../../domain/model";
import { loopLinks, type Lock, type Sched, type SchedView } from "../../domain/schedule";
import { CH_ZH } from "./calendars";

export interface ArbPlan {
  view: SchedView;
  roots: ItemId[];
}

const FIRST: Day = toDay("2026-11-01");
const LAST: Day = toDay("2027-03-31");
const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];
const LINK_TYPES: readonly LinkType[] = ["FS", "SS", "FF", "SF"];
const CH_ZH_DATES: readonly IsoDate[] = [...CH_ZH.holidays.values()].flatMap((y) => y.days.map((d) => d.date));

const arbDay = fc.integer({ min: FIRST, max: LAST });

export const itemOf = (view: SchedView, id: ItemId): Sched => {
  const s = view.items.get(id);
  if (s === undefined) throw new Error(`no item ${id}`);
  return s;
};

const calendarText = (c: Calendar): string =>
  [
    `workdays [${c.workdays.join(",")}]`,
    `tuning {${[...c.tuning].map(([d, t]) => `${d} ${t.kind === "add" ? `add:${t.name}` : t.kind}`).join(", ")}}`,
    `closures [${[...c.closures.values()].map((x) => `${x.id} ${x.from}..${x.to}`).join(", ")}]`,
  ].join("; ");

const printable = <T extends object>(value: T, text: () => string): T & fc.WithToStringMethod =>
  Object.assign(value, { [fc.toStringMethod]: text });

const arbTuning: fc.Arbitrary<Tuning> = fc.oneof(
  fc.constant<Tuning>({ kind: "off" }),
  fc.constant<Tuning>({ kind: "work" }),
  fc.constantFrom("Team day", "Moving day").map((name): Tuning => ({ kind: "add", name })),
);

const arbClosure = (id: string): fc.Arbitrary<Closure> =>
  fc.record({ from: arbDay, len: fc.integer({ min: 1, max: 10 }), name: fc.constantFrom("Office move", "Year-end") }).map(
    ({ from, len, name }) => ({ id, from: toIso(from), to: toIso(Math.min(LAST, from + len - 1)), name }),
  );

const arbTuned = (dates: fc.Arbitrary<IsoDate[]>): fc.Arbitrary<(readonly [IsoDate, Tuning])[]> =>
  dates.chain((ds) => fc.tuple(...ds.map((d) => arbTuning.map((t) => [d, t] as const))));

export const arbCalendar: fc.Arbitrary<Calendar> = fc
  .record({
    workdays: fc.subarray([...WEEKDAYS], { minLength: 1 }),
    holidays: arbTuned(fc.subarray([...CH_ZH_DATES])),
    ordinary: arbTuned(fc.uniqueArray(arbDay.map(toIso), { maxLength: 3 })),
    closures: fc.integer({ min: 0, max: 2 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbClosure(`c${i}`)))),
  })
  .map(({ workdays, holidays, ordinary, closures }) => {
    const cal: Calendar = {
      ...CH_ZH,
      workdays,
      tuning: new Map([...holidays, ...ordinary]),
      closures: new Map(closures.map((c) => [c.id, c] as const)),
    };
    return printable(cal, () => `Calendar(${calendarText(cal)})`);
  });

const arbLock: fc.Arbitrary<Lock | null> = fc.oneof(
  { arbitrary: fc.constant(null), weight: 12 },
  { arbitrary: fc.constantFrom<Lock>("done", "doing", "held"), weight: 3 },
);

const idOf = (i: number): ItemId => `i${String(i).padStart(2, "0")}`;

const arbSched = (id: ItemId): fc.Arbitrary<Sched> =>
  fc
    .record({
      task: fc.oneof({ arbitrary: fc.constant(true), weight: 4 }, { arbitrary: fc.constant(false), weight: 1 }),
      start: arbDay,
      dur: fc.integer({ min: 1, max: 15 }),
      lock: arbLock,
    })
    .map(({ task, start, dur, lock }) => ({ id, kind: task ? "task" : "milestone", start, dur: task ? dur : 0, lock }));

const arbPair = (order: readonly ItemId[]): fc.Arbitrary<readonly [ItemId, ItemId]> =>
  fc.oneof(
    { arbitrary: fc.tuple(fc.constantFrom(...order), fc.constantFrom(...order)), weight: 1 },
    {
      arbitrary: fc
        .tuple(fc.nat({ max: order.length - 1 }), fc.nat({ max: order.length - 1 }))
        .map(([a, b]) => [order[Math.min(a, b)], order[Math.max(a, b)]] as const),
      weight: 3,
    },
  );

const arbLink = (order: readonly ItemId[]): fc.Arbitrary<Link> =>
  fc
    .record({ pair: arbPair(order), type: fc.constantFrom(...LINK_TYPES), lag: fc.integer({ min: -5, max: 5 }) })
    .map(({ pair: [from, to], type, lag }) => ({ from, to, type, lag }));

const arbLinks = (ids: readonly ItemId[], maxLength: number): fc.Arbitrary<Link[]> =>
  fc
    .shuffledSubarray([...ids], { minLength: ids.length })
    .chain((order) => fc.uniqueArray(arbLink(order), { maxLength, size: "max", selector: (l) => linkKey(l.from, l.to) }));

type Edit = { kind: "move"; by: number } | { kind: "resize"; dur: number };

const arbEdit: fc.Arbitrary<Edit> = fc.oneof(
  fc.integer({ min: -5, max: 10 }).map((by): Edit => ({ kind: "move", by })),
  fc.integer({ min: 1, max: 15 }).map((dur): Edit => ({ kind: "resize", dur })),
);

const edited = (s: Sched, e: Edit, cal: WorkCalendar): Sched =>
  e.kind === "move" || s.kind === "milestone"
    ? { ...s, start: cal.addWork(s.start, e.kind === "move" ? e.by : 0) }
    : { ...s, dur: e.dur };

const arbItems: fc.Arbitrary<Sched[]> = fc
  .integer({ min: 1, max: 30 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbSched(idOf(i)))));

const planOf = (
  items: readonly Sched[],
  links: readonly Link[],
  calendar: Calendar,
  edits: readonly (readonly [number, Edit])[],
): ArbPlan => {
  const cal = workCalendar(calendar);
  const roots = edits.map(([i]) => items[i].id);
  const edit = new Map(edits.map(([i, e]) => [items[i].id, e] as const));
  const view: SchedView = {
    items: new Map(
      items.map((s) => {
        const e = edit.get(s.id);
        return [s.id, e === undefined ? s : edited(s, e, cal)] as const;
      }),
    ),
    links,
    cal,
  };
  return printable({ view, roots }, () =>
    [
      `ArbPlan(${calendarText(calendar)}`,
      `items [${[...view.items.values()].map((s) => `${s.id} ${s.kind} ${toIso(s.start)}+${s.dur} ${s.lock ?? "-"}`).join(", ")}]`,
      `links [${links.map((l) => `${l.from}>${l.to} ${l.type}${l.lag >= 0 ? "+" : ""}${l.lag}`).join(", ")}]`,
      `roots [${roots.join(",")}])`,
    ].join("; "),
  );
};

const arbEdits = (n: number): fc.Arbitrary<[number, Edit][]> =>
  fc.uniqueArray(fc.tuple(fc.integer({ min: 0, max: n - 1 }), arbEdit), {
    minLength: 1,
    maxLength: Math.min(3, n),
    selector: ([i]) => i,
  });

const ghostIds = ["g0", "g1"] as const;

export const arbPlan: fc.Arbitrary<ArbPlan> = arbItems.chain((items) => {
  const ids = items.map((s) => s.id);
  return fc
    .record({ links: arbLinks([...ids, ...ghostIds], 60), calendar: arbCalendar, edits: arbEdits(ids.length) })
    .map(({ links, calendar, edits }) => planOf(items, links, calendar, edits));
});

const arbCycle = (ids: readonly ItemId[]): fc.Arbitrary<Link[]> =>
  fc
    .shuffledSubarray([...ids], { minLength: 1, maxLength: Math.min(4, ids.length) })
    .chain((ring) =>
      fc.tuple(
        ...ring.map((from, i) =>
          fc.record({ type: fc.constantFrom(...LINK_TYPES), lag: fc.integer({ min: -5, max: 5 }) }).map(
            ({ type, lag }): Link => ({ from, to: ring[(i + 1) % ring.length], type, lag }),
          ),
        ),
      ),
    );

export const arbLoopPlan: fc.Arbitrary<ArbPlan> = arbItems.chain((items) => {
  const ids = items.map((s) => s.id);
  return fc
    .record({
      cycle: arbCycle(ids),
      links: arbLinks([...ids, ...ghostIds], 20),
      calendar: arbCalendar,
      edits: arbEdits(ids.length),
    })
    .map(({ cycle, links, calendar, edits }) => {
      const cycleKeys = new Set(cycle.map((l) => linkKey(l.from, l.to)));
      const all = [...cycle, ...links.filter((l) => !cycleKeys.has(linkKey(l.from, l.to)))];
      if (loopLinks(all).size === 0) {
        throw new Error(`arbLoopPlan: no loop in ring ${cycle.map((l) => `${l.from}>${l.to}`).join(",")} over ${ids.join(",")}`);
      }
      return planOf(items, all, calendar, edits);
    });
});

export function downstreamOf(view: SchedView, roots: readonly ItemId[]): ReadonlySet<ItemId> {
  const loops = loopLinks(view.links);
  const links = view.links.filter(
    (l) => !loops.has(linkKey(l.from, l.to)) && view.items.has(l.from) && view.items.has(l.to),
  );
  const rootSet = new Set(roots);
  const seen = new Set<ItemId>(roots);
  const queue: ItemId[] = [...roots];
  for (let i = 0; i < queue.length; i += 1) {
    const v = queue[i];
    if (!rootSet.has(v) && itemOf(view, v).lock !== null) continue;
    links
      .filter((l) => l.from === v && !seen.has(l.to))
      .forEach((l) => {
        seen.add(l.to);
        queue.push(l.to);
      });
  }
  return new Set([...seen].filter((id) => !rootSet.has(id)));
}
