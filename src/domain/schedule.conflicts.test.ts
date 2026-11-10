import { describe, expect, it } from "vitest";
import { conflicts, earliest, lagThatHolds, push, startOf, type Conflict, type Sched } from "./schedule";
import { workCalendar, type WorkCalendar } from "./calendar";
import { toDay } from "./dates";
import { CH_ZH } from "../test/fixtures/calendars";
import { applyMoves, ln, ms, PUSH_PLAN, storedStarts, task, view } from "../test/fixtures/sched";
import type { Link, LinkType } from "./model";

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

  it("answers what a lag-by-lag walk answers", () => {
    const cal = workCalendar(CH_ZH);
    const walked = (succ: Sched, link: Link, pred: Sched, c: WorkCalendar): number => {
      const start = startOf(succ, c);
      let lag = link.lag;
      while (start < earliest(succ, { ...link, lag }, pred, c)) lag -= 1;
      return lag;
    };
    const types: readonly LinkType[] = ["FS", "SS", "FF", "SF"];
    const preds = [task("A", "2026-11-02", 10), task("A", "2027-03-10", 1), ms("A", "2026-12-24"), task("A", "2026-11-14", 4)];
    const succs = [task("S", "2026-11-12", 2, "done"), task("S", "2026-11-03", 5, "doing"), ms("S", "2026-11-20", "done"), task("S", "2027-04-01", 1)];
    const lags = [-7, -1, 0, 1, 3, 12];
    const cases = types.flatMap((type) => preds.flatMap((pred) => succs.flatMap((succ) => lags.map((lag) => ({ succ, pred, link: ln("A", "S", type, lag) })))));
    expect(cases).toHaveLength(384);
    cases.forEach(({ succ, pred, link }) => {
      expect(lagThatHolds(succ, link, pred, cal), JSON.stringify({ succ, pred, link })).toBe(walked(succ, link, pred, cal));
    });
  });

  it("finds a lag ten years back in under 5 ms", () => {
    const cal = workCalendar(CH_ZH);
    const succ = task("S", "2026-11-16", 2, "doing");
    const pred = task("A", "2036-11-17", 3);
    lagThatHolds(succ, ln("A", "S", "FS", 1), pred, cal);
    const t0 = performance.now();
    const lag = lagThatHolds(succ, ln("A", "S"), pred, cal);
    const took = performance.now() - t0;
    expect(lag).toBe(-2609);
    expect(took).toBeLessThan(5);
  });
});
