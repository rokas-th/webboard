import type { WorkCalendar } from "./calendar";
import type { Day } from "./dates";
import type { ItemId, Link } from "./model";

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
