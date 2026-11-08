import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { workCalendar } from "./calendar";
import { linkKey } from "./model";
import { conflicts, endOf, loopLinks, push, recalendar, startOf, type Sched, type SchedView } from "./schedule";
import { arbCalendar, arbLoopPlan, arbPlan, downstreamOf } from "../test/fixtures/arbitraries";
import { applyMoves, storedStarts } from "../test/fixtures/sched";

const NUM_RUNS = 1000;
const PARAMS: fc.Parameters<unknown> = { numRuns: NUM_RUNS, seed: 20261108 };
const MIN_HITS = NUM_RUNS / 20;

const item = (v: SchedView, id: string): Sched => v.items.get(id) as Sched;

const incomingInView = (v: SchedView, id: string) =>
  v.links.filter((l) => l.to === id && v.items.has(l.from) && v.items.has(l.to));

const onlyLoopFed = (v: SchedView): string[] => {
  const loops = loopLinks(v.links);
  return [...v.items.keys()].filter((id) => {
    const inc = incomingInView(v, id);
    return inc.length > 0 && inc.every((l) => loops.has(linkKey(l.from, l.to)));
  });
};

describe("push properties", () => {
  it("no early conflict remains downstream of the roots except at locks", () => {
    let hits = 0;
    fc.assert(
      fc.property(arbPlan, ({ view, roots }) => {
        const down = downstreamOf(view, roots);
        if (conflicts(view, storedStarts(view)).some((c) => c.kind === "early" && down.has(c.succ))) hits += 1;
        const r = push(view, roots);
        const after = applyMoves(view, r.moves);
        const stopped = new Set(r.stopped.map((s) => s.id));
        conflicts(after, storedStarts(after))
          .flatMap((c) => (c.kind === "early" && down.has(c.succ) ? [c] : []))
          .forEach((c) => {
            expect(c.succLock).not.toBeNull();
            expect(stopped.has(c.succ)).toBe(true);
          });
      }),
      PARAMS,
    );
    expect(hits).toBeGreaterThanOrEqual(MIN_HITS);
  });

  it("nothing upstream moves", () => {
    let hits = 0;
    fc.assert(
      fc.property(arbPlan, ({ view, roots }) => {
        const r = push(view, roots);
        if (r.moves.size > 0) hits += 1;
        const down = downstreamOf(view, roots);
        expect([...r.moves.keys()].filter((id) => !down.has(id))).toEqual([]);
      }),
      PARAMS,
    );
    expect(hits).toBeGreaterThanOrEqual(MIN_HITS);
  });

  it("no start moves earlier", () => {
    let hits = 0;
    fc.assert(
      fc.property(arbPlan, ({ view, roots }) => {
        const r = push(view, roots);
        if (r.moves.size > 0) hits += 1;
        r.moves.forEach((d, id) => expect(d).toBeGreaterThan(startOf(item(view, id), view.cal)));
      }),
      PARAMS,
    );
    expect(hits).toBeGreaterThanOrEqual(MIN_HITS);
  });

  it("no locked item moves", () => {
    let hits = 0;
    fc.assert(
      fc.property(arbPlan, ({ view, roots }) => {
        const r = push(view, roots);
        if (r.stopped.length > 0) hits += 1;
        expect([...r.moves.keys()].filter((id) => item(view, id).lock !== null)).toEqual([]);
      }),
      PARAMS,
    );
    expect(hits).toBeGreaterThanOrEqual(MIN_HITS);
  });

  it("push is complete in one pass", () => {
    let hits = 0;
    fc.assert(
      fc.property(arbPlan, ({ view, roots }) => {
        const r = push(view, roots);
        if (r.moves.size > 0) hits += 1;
        expect([...push(applyMoves(view, r.moves), roots).moves.keys()]).toEqual([]);
      }),
      PARAMS,
    );
    expect(hits).toBeGreaterThanOrEqual(MIN_HITS);
  });

  it("push terminates with loops present; an item fed only by loop links never moves", () => {
    let hits = 0;
    fc.assert(
      fc.property(arbLoopPlan, ({ view, roots }) => {
        const fed = onlyLoopFed(view);
        if (fed.length > 0) hits += 1;
        const r = push(view, roots);
        expect(fed.filter((id) => r.moves.has(id))).toEqual([]);
      }),
      PARAMS,
    );
    expect(hits).toBeGreaterThanOrEqual(MIN_HITS);
  });
});

describe("recalendar properties", () => {
  it("recalendar never moves what happened", () => {
    let hits = 0;
    fc.assert(
      fc.property(arbPlan, arbCalendar, ({ view }, nextCal) => {
        const next = workCalendar(nextCal);
        const locked = [...view.items.values()].filter((s) => s.lock !== null);
        if (locked.some((s) => next.snapF(s.start) !== s.start)) hits += 1;
        const r = recalendar(view, next);
        expect(locked.filter((s) => r.starts.has(s.id) || r.pushed.moves.has(s.id)).map((s) => s.id)).toEqual([]);
        locked
          .filter((s) => s.kind === "task" && s.lock === "done")
          .forEach((s) => {
            const oldEnd = endOf(s, view.cal);
            if (next.snapF(s.start) > oldEnd) return;
            const end = endOf({ ...s, dur: r.durs.get(s.id) ?? s.dur }, next);
            expect(end).toBeLessThanOrEqual(oldEnd);
            if (next.isWork(oldEnd)) expect(end).toBe(oldEnd);
          });
      }),
      PARAMS,
    );
    expect(hits).toBeGreaterThanOrEqual(MIN_HITS);
  });
});
