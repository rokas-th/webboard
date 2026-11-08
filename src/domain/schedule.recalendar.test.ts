import { describe, expect, it } from "vitest";
import { endOf, push, recalendar, type Sched, type SchedView } from "./schedule";
import { workCalendar, type Closure } from "./calendar";
import { toDay, type Day } from "./dates";
import type { ItemId } from "./model";
import { CH_ZH } from "../test/fixtures/calendars";
import { applyMoves, ln, PUSH_PLAN, task, view } from "../test/fixtures/sched";

const closure = (id: string, from: string, to: string, name: string): Closure => ({ id, from, to, name });

const NEXT = workCalendar({
  ...CH_ZH,
  closures: new Map([
    ["c1", closure("c1", "2026-12-16", "2026-12-16", "Office move")],
    ["c2", closure("c2", "2026-12-28", "2026-12-31", "Year-end")],
  ]),
});

const YEAR_END_ITEMS: readonly Sched[] = [
  task("P", "2026-12-14", 5, "done"),
  task("Q", "2026-12-28", 3, "doing"),
  task("R", "2026-12-29", 2),
  task("S", "2027-01-05", 2),
  task("H2", "2026-12-30", 1, "held"),
];

const days = (entries: Record<ItemId, string>): Map<ItemId, Day> =>
  new Map(Object.entries(entries).map(([id, d]) => [id, toDay(d)] as const));

const expectYearEnd = (v: SchedView): void => {
  const r = recalendar(v, NEXT);
  expect(r.durs).toEqual(new Map([["P", 4]]));
  expect(endOf({ ...(v.items.get("P") as Sched), dur: 4 }, NEXT)).toBe(toDay("2026-12-18"));
  expect(r.starts).toEqual(days({ R: "2027-01-04" }));
  expect(r.pushed.moves).toEqual(days({ S: "2027-01-06" }));
  expect(r.pushed.stopped).toEqual([]);
  expect(r.endsChanged).toBe(4);
  expect(r.movedLater).toBe(1);
};

describe("recalendar", () => {
  it("year-end closure", () => {
    expectYearEnd(view(YEAR_END_ITEMS, [ln("R", "S")]));
  });

  it("an unchanged calendar changes nothing", () => {
    const after = applyMoves(PUSH_PLAN, push(PUSH_PLAN, ["A"]).moves);
    const r = recalendar(after, after.cal);
    expect(r.starts).toEqual(new Map());
    expect(r.durs).toEqual(new Map());
    expect(r.pushed.moves).toEqual(new Map());
    expect(r.pushed.stopped).toEqual([{ id: "H", reason: "held" }]);
    expect(r.endsChanged).toBe(0);
    expect(r.movedLater).toBe(0);
  });

  it("loops are tolerated", () => {
    expectYearEnd(
      view(
        [...YEAR_END_ITEMS, task("X", "2026-12-14", 1), task("Y", "2026-12-15", 1)],
        [ln("R", "S"), ln("X", "Y"), ln("Y", "X")],
      ),
    );
  });

  it("roots ignore loop links", () => {
    const r = recalendar(
      view(
        [task("X", "2026-12-14", 1), task("Y", "2026-12-16", 1), task("Z", "2026-12-17", 1)],
        [ln("X", "Y"), ln("Y", "X"), ln("Y", "Z")],
      ),
      NEXT,
    );
    expect(r.starts).toEqual(days({ Y: "2026-12-17" }));
    expect(r.pushed.moves).toEqual(days({ Z: "2026-12-18" }));
    expect(r.movedLater).toBe(1);
  });

  it("roots ignore unscheduled predecessors", () => {
    const r = recalendar(
      view([task("G", "2026-12-14", 3), task("T", "2026-12-17", 1)], [ln("ghost", "G"), ln("G", "T")]),
      NEXT,
    );
    expect(r.starts).toEqual(new Map());
    expect(r.pushed.moves).toEqual(days({ T: "2026-12-18" }));
    expect(r.movedLater).toBe(1);
  });

  it("a locked item whose end moves pushes its successors", () => {
    const r = recalendar(
      view(
        [task("Z", "2026-12-21", 2, "done"), task("Q", "2026-12-28", 3, "doing"), task("T", "2026-12-31", 1)],
        [ln("Z", "Q"), ln("Q", "T")],
      ),
      NEXT,
    );
    expect(endOf(task("Q", "2026-12-28", 3, "doing"), NEXT)).toBe(toDay("2027-01-06"));
    expect(r.pushed.moves).toEqual(days({ T: "2027-01-07" }));
    expect(r.pushed.stopped).toEqual([]);
    expect(r.movedLater).toBe(1);
  });
});
