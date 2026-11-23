import type { Calendar, RegionRef } from "../../domain/calendar";
import { weekdaysFrom, type WeekStart, type Weekday } from "../../domain/dates";

const DIVISIONS: Readonly<Record<"england-and-wales" | "scotland" | "northern-ireland", string>> = {
  "england-and-wales": "England and Wales",
  scotland: "Scotland",
  "northern-ireland": "Northern Ireland",
};

const DAYS: Readonly<Record<Weekday, string>> = { 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun" };

export function regionText(r: RegionRef): string {
  switch (r.src) {
    case "openholidays":
      return r.subdivision ?? r.country;
    case "govuk":
      return DIVISIONS[r.division];
    case "opm":
      return "US federal (OPM)";
    case "ics":
      return `“${r.name}”`;
  }
}

export function weekdaysText(w: readonly Weekday[], week: WeekStart): string {
  const order = weekdaysFrom(week);
  const days = order.filter((d) => w.includes(d));
  const run = days.every((d, i) => i === 0 || order.indexOf(d) === order.indexOf(days[i - 1]) + 1);
  if (run && days.length > 2) return `${DAYS[days[0]]}–${DAYS[days[days.length - 1]]}`;
  return days.map((d) => DAYS[d]).join(", ");
}

export function calendarSummary(cal: Calendar, week: WeekStart): string {
  const n = cal.closures.size;
  const closures = n === 0 ? "no closures" : n === 1 ? "1 closure" : `${n} closures`;
  return `${cal.region ? regionText(cal.region) : "No holiday region"} · ${weekdaysText(cal.workdays, week)} · ${closures}`;
}
