import { describe, expect, it } from "vitest";
import { endOf, earliest, startOf, type Sched } from "./schedule";
import { toDay, toIso, type Day } from "./dates";
import type { LinkType } from "./model";
import { CH_ZH_OFF } from "../test/fixtures/calendars";
import { mockupRef, type RefTask } from "../test/fixtures/mockupRef";
import { ln, ms, task, view } from "../test/fixtures/sched";

const A = task("A", "2026-12-21", 4);
const S = task("S", "2026-12-01", 3);
const M = ms("M", "2026-12-01");
const P = ms("P", "2026-12-24");
const v = view([A, S, M, P], []);
const cal = v.cal;

const TABLE: readonly (readonly [LinkType, number, string, string])[] = [
  ["FS", 0, "12-28", "12-24"],
  ["FS", 2, "12-30", "12-29"],
  ["FS", -2, "12-23", "12-22"],
  ["SS", 0, "12-21", "12-21"],
  ["SS", 2, "12-23", "12-23"],
  ["SS", -2, "12-17", "12-17"],
  ["FF", 0, "12-22", "12-24"],
  ["FF", 2, "12-24", "12-29"],
  ["FF", -2, "12-18", "12-22"],
  ["SF", 0, "12-17", "12-21"],
  ["SF", 2, "12-21", "12-23"],
  ["SF", -2, "12-15", "12-17"],
];

const at = (id: string): Sched => {
  const s = v.items.get(id);
  if (!s) throw new Error(`no item ${id}`);
  return s;
};

const iso = (d: Day) => toIso(d);

describe("startOf and endOf", () => {
  it("ends the predecessor on Christmas Eve", () => {
    expect(iso(startOf(A, cal))).toBe("2026-12-21");
    expect(iso(endOf(A, cal))).toBe("2026-12-24");
  });

  it("snaps a start on a day off forward and counts the duration from there", () => {
    const T = task("T", "2026-12-25", 2);
    expect(iso(startOf(T, cal))).toBe("2026-12-28");
    expect(iso(endOf(T, cal))).toBe("2026-12-29");
  });

  it("puts a milestone on a day off on the next working day", () => {
    const N = ms("N", "2026-12-26");
    expect(iso(startOf(N, cal))).toBe("2026-12-28");
    expect(iso(endOf(N, cal))).toBe("2026-12-28");
  });
});

describe("earliest", () => {
  it.each(TABLE)("%s %i from A: task 2026-%s, milestone 2026-%s", (type, lag, s, m) => {
    expect(iso(earliest(at("S"), ln("A", "S", type, lag), at("A"), cal))).toBe(`2026-${s}`);
    expect(iso(earliest(at("M"), ln("A", "M", type, lag), at("A"), cal))).toBe(`2026-${m}`);
  });

  it("lets FS from a milestone into a milestone share its day", () => {
    expect(iso(earliest(M, ln("P", "M", "FS", 0), P, cal))).toBe("2026-12-24");
    expect(iso(earliest(M, ln("P", "M", "FS", 1), P, cal))).toBe("2026-12-28");
  });

  it("starts a task after a milestone by FS on the next working day", () => {
    expect(iso(earliest(S, ln("P", "S", "FS", 0), P, cal))).toBe("2026-12-28");
    expect(iso(earliest(S, ln("P", "S", "FS", 1), P, cal))).toBe("2026-12-29");
  });

  it("matches the mockup's earliest over every type, lag and shape", () => {
    const ref = mockupRef([1, 2, 3, 4, 5], CH_ZH_OFF);
    const first = toDay("2026-12-01");
    const last = toDay("2027-01-15");
    const starts = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    const predShapes: readonly (number | null)[] = [1, 2, 3, 4, 5, null];
    const succShapes: readonly (number | null)[] = [1, 2, 3, 4, null];
    const types: readonly LinkType[] = ["FS", "SS", "FF", "SF"];
    const lags = [-3, -2, -1, 0, 1, 2, 3];
    const asRef = (s: Sched): RefTask => ({ kind: s.kind, start: s.start, dur: s.dur });
    const shaped = (id: string, start: Day, dur: number | null): Sched =>
      dur === null ? ms(id, toIso(start)) : task(id, toIso(start), dur);
    const mismatches = starts.flatMap((ps) =>
      predShapes.flatMap((pd) =>
        succShapes.flatMap((sd) =>
          types.flatMap((type) =>
            lags.flatMap((lag) => {
              const pred = shaped("p", ps, pd);
              const succ = shaped("s", first, sd);
              const link = ln("p", "s", type, lag);
              const got = earliest(succ, link, pred, cal);
              const want = ref.earliest(asRef(succ), { type, lag }, asRef(pred));
              return got === want ? [] : [`${toIso(ps)} ${pd} ${sd} ${type} ${lag}: ${toIso(got)} != ${toIso(want)}`];
            }),
          ),
        ),
      ),
    );
    expect(starts.length * predShapes.length * succShapes.length * types.length * lags.length).toBe(38640);
    expect(mismatches).toEqual([]);
  });
});
