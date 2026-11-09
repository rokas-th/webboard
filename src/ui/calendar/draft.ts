import { Refused } from "../../actions/intents";
import type { Calendar, Closure, Tuning } from "../../domain/calendar";
import type { IsoDate, Weekday } from "../../domain/dates";
import { newId } from "../../log/ids";
import { planRules } from "../../plan/rules";
import { key } from "../../plan/units";

export const NO_WORKDAY = "A calendar needs at least one working day.";

export function setWorkday(cal: Calendar, d: Weekday, on: boolean): Calendar {
  const rest = cal.workdays.filter((x) => x !== d);
  if (!on && rest.length === 0) throw new Refused(NO_WORKDAY);
  const workdays = on ? [...rest, d] : rest;
  return { ...cal, workdays: [...new Set(workdays)].sort((a, b) => a - b) };
}

export function addClosure(cal: Calendar, c: Omit<Closure, "id">): Calendar {
  const id = newId();
  return { ...cal, closures: new Map([...cal.closures, [id, { id, from: c.from, to: c.to, name: c.name }]]) };
}

export function removeClosure(cal: Calendar, id: string): Calendar {
  if (!cal.closures.has(id)) throw new Error(`No closure ${id} in the draft`);
  return { ...cal, closures: new Map([...cal.closures].filter(([k]) => k !== id)) };
}

export function tune(cal: Calendar, date: IsoDate, t: Tuning | null): Calendar {
  const rest = [...cal.tuning].filter(([d]) => d !== date);
  return { ...cal, tuning: new Map(t === null ? rest : [...rest, [date, t]]) };
}

const sameMap = <V>(a: ReadonlyMap<string | number, V>, b: ReadonlyMap<string | number, V>, same: (k: string | number, x: V, y: V) => boolean): boolean =>
  a.size === b.size &&
  [...a].every(([k, x]) => {
    const y = b.get(k);
    return y !== undefined && same(k, x, y);
  });

export function sameCalendar(a: Calendar, b: Calendar): boolean {
  const wa = new Set(a.workdays);
  const wb = new Set(b.workdays);
  return (
    planRules.same(key.cr, a.region, b.region) &&
    wa.size === wb.size &&
    [...wa].every((d) => wb.has(d)) &&
    sameMap(a.closures, b.closures, (k, x, y) => planRules.same(key.cc(String(k)), x, y)) &&
    sameMap(a.tuning, b.tuning, (k, x, y) => planRules.same(key.ct(String(k)), x, y)) &&
    sameMap(a.holidays, b.holidays, (k, x, y) => planRules.same(key.ch(Number(k)), x, y))
  );
}
