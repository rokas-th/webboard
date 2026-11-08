import { describe, expect, it } from "vitest";
import { conflicts, lagThatHolds, push, type Conflict } from "./schedule";
import { workCalendar } from "./calendar";
import { toDay } from "./dates";
import { CH_ZH } from "../test/fixtures/calendars";
import { applyMoves, ln, PUSH_PLAN, storedStarts, task, view } from "../test/fixtures/sched";

describe("conflicts", () => {
  it("early names the need and the successor's lock", () => {
    expect(conflicts(PUSH_PLAN, storedStarts(PUSH_PLAN))).toEqual<Conflict[]>([
      { kind: "early", link: "A>B", pred: "A", succ: "B", need: toDay("2026-11-16"), succLock: null },
      { kind: "early", link: "D>H", pred: "D", succ: "H", need: toDay("2026-11-16"), succLock: "held" },
      { kind: "early", link: "H>K", pred: "H", succ: "K", need: toDay("2026-11-17"), succLock: null },
    ]);
    const after = applyMoves(PUSH_PLAN, push(PUSH_PLAN, ["A"]).moves);
    expect(conflicts(after, storedStarts(after))).toEqual<Conflict[]>([
      { kind: "early", link: "D>H", pred: "D", succ: "H", need: toDay("2026-11-23"), succLock: "held" },
      { kind: "early", link: "H>K", pred: "H", succ: "K", need: toDay("2026-11-17"), succLock: null },
    ]);
  });

  it("loop links are loop conflicts, not early ones", () => {
    const v = view([task("a", "2026-11-02", 5), task("b", "2026-11-02", 5)], [ln("a", "b"), ln("b", "a")]);
    expect(conflicts(v, storedStarts(v))).toEqual<Conflict[]>([
      { kind: "loop", link: "a>b" },
      { kind: "loop", link: "b>a" },
    ]);
  });

  it("a start on a day off", () => {
    const v = view([task("X", "2026-12-25", 1)], []);
    expect(conflicts(v, storedStarts(v))).toEqual<Conflict[]>([
      { kind: "dayoff", item: "X", shownFrom: toDay("2026-12-28") },
    ]);
  });

  it("order", () => {
    const v = view(
      [
        task("Z", "2026-12-25", 1),
        task("P", "2026-11-02", 10),
        task("Q", "2026-11-03", 1),
        task("a", "2026-11-02", 5),
        task("b", "2026-11-02", 5),
      ],
      [ln("P", "Q"), ln("b", "a"), ln("a", "b")],
    );
    expect(conflicts(v, storedStarts(v))).toEqual<Conflict[]>([
      { kind: "loop", link: "a>b" },
      { kind: "loop", link: "b>a" },
      { kind: "early", link: "P>Q", pred: "P", succ: "Q", need: toDay("2026-11-16"), succLock: null },
      { kind: "dayoff", item: "Z", shownFrom: toDay("2026-12-28") },
    ]);
  });
});

describe("lagThatHolds", () => {
  it("lagThatHolds", () => {
    const cal = workCalendar(CH_ZH);
    const a = task("A", "2026-11-02", 10);
    expect(lagThatHolds(task("S", "2026-11-12", 2, "done"), ln("A", "S"), a, cal)).toBe(-2);
    expect(lagThatHolds(task("S", "2026-11-16", 2), ln("A", "S"), a, cal)).toBe(0);
    expect(lagThatHolds(task("S", "2026-11-03", 2), ln("A", "S", "SS", 3), a, cal)).toBe(1);
  });
});
