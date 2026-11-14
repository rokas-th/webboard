import { useMemo } from "react";
import { workCalendar } from "../../domain/calendar";
import { fmtNear, isCalendarDate, toDay, toIso } from "../../domain/dates";
import { MAX_TASK_DUR, type Item } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import { toast } from "../common/Toast";
import { DATE_UNREADABLE, endBeforeStart, endOnDayOff } from "../copy";
import type { Run } from "../run";
import { TextField } from "./TextField";

const WHOLE = /^[-+]?\d+$/;

export const dateUnreadable = (): void => toast(DATE_UNREADABLE, "bad");

export function WholeField(p: { label: string; value: number; min: number; max: number; notWhole: string; inputMode?: "numeric"; onCommit(n: number): boolean }) {
  const notWhole = (): void => toast(p.notWhole, "bad");
  const commit = (next: string): boolean => {
    if (next === "") return false;
    if (!WHOLE.test(next)) {
      notWhole();
      return false;
    }
    const n = Number(next);
    if (n === p.value) return false;
    return p.onCommit(n);
  };
  return <TextField type="number" inputMode={p.inputMode} className="num-input" label={p.label} min={String(p.min)} max={String(p.max)} value={String(p.value)} readOnly={false} onCommit={commit} onUnreadable={notWhole} />;
}

export function EndField(p: { view: PlanView; item: Item; label: string; run: Run }) {
  const it = p.item;
  const cal = useMemo(() => workCalendar(p.view.plan.calendar), [p.view.plan.calendar]);
  const start = p.view.derived.start.get(it.id);
  const end = p.view.derived.end.get(it.id);
  if (start === undefined || end === undefined) throw new Error(`EndField: scheduled item ${it.id} has no derived start or end`);
  const commit = (next: string): boolean => {
    if (!isCalendarDate(next)) return false;
    const day = toDay(next);
    if (day < start) {
      toast(endBeforeStart(fmtNear(toIso(start), p.view.today)), "bad");
      return false;
    }
    if (!cal.isWork(day)) {
      toast(endOnDayOff(fmtNear(next, p.view.today)), "bad");
      return false;
    }
    return p.run.run({ t: "resize", item: it.id, dur: cal.workBetween(start, day) }) !== null;
  };
  return (
    <TextField
      type="date"
      className="date-input"
      label={p.label}
      min={toIso(start)}
      max={toIso(cal.addWork(start, MAX_TASK_DUR - 1))}
      value={toIso(end)}
      readOnly={false}
      onCommit={commit}
      onUnreadable={dateUnreadable}
    />
  );
}
