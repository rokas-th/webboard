import { toIso, weekday, type Day, type IsoDate, type Weekday } from "../../domain/dates";
import type { LinkType } from "../../domain/model";

export interface RefTask {
  kind: "task" | "milestone";
  start: Day;
  dur: number;
}

export interface RefDep {
  type: LinkType;
  lag?: number;
}

export interface MockupRef {
  isWork(t: Day): boolean;
  snapF(t: Day): Day;
  snapB(t: Day): Day;
  after(t: Day): Day;
  addWork(t: Day, n: number): Day;
  subWork(t: Day, n: number): Day;
  workBetween(a: Day, b: Day): number;
  earliest(succ: RefTask, dep: RefDep, pred: RefTask): Day;
}

export function mockupRef(workdays: readonly Weekday[], off: ReadonlySet<IsoDate>): MockupRef {
  const DAY = 1;
  const isWeekday = (t: Day) => workdays.includes(weekday(t));
  const isWork = (t: Day) => isWeekday(t) && !off.has(toIso(t));
  const snapF = (t: Day) => { while (!isWork(t)) t += DAY; return t; };
  const snapB = (t: Day) => { while (!isWork(t)) t -= DAY; return t; };
  const after = (t: Day) => snapF(t + DAY);
  function addWork(t: Day, n: number): Day {
    if (n < 0) return subWork(t, -n);
    t = snapF(t);
    for (; n > 0; n--) t = after(t);
    return t;
  }
  function subWork(t: Day, n: number): Day {
    t = snapB(t);
    for (; n > 0; n--) t = snapB(t - DAY);
    return t;
  }
  const workBetween = (a: Day, b: Day) => { let n = 0; for (let t = a; t <= b; t += DAY) if (isWork(t)) n++; return n; };
  const tStart = (t: RefTask) => snapF(t.start);
  const tEnd = (t: RefTask) => (t.kind === "milestone" ? tStart(t) : addWork(tStart(t), Math.max(1, t.dur) - 1));
  function earliest(succ: RefTask, dep: RefDep, pred: RefTask): Day {
    const ps = tStart(pred), pe = tEnd(pred), lag = dep.lag || 0;
    if (dep.type === "FS") return addWork(succ.kind === "milestone" ? pe : after(pe), lag);
    if (dep.type === "SS") return addWork(ps, lag);
    const reqEnd = addWork(dep.type === "FF" ? pe : ps, lag);
    return succ.kind === "milestone" ? reqEnd : subWork(reqEnd, Math.max(1, succ.dur) - 1);
  }
  return { isWork, snapF, snapB, after, addWork, subWork, workBetween, earliest };
}
