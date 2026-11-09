import type { Calendar, RegionRef } from "../../domain/calendar";
import type { Weekday } from "../../domain/dates";

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

export function weekdaysText(w: readonly Weekday[]): string {
  const days = [...new Set(w)].sort((a, b) => a - b);
  const run = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (run && days.length > 2) return `${DAYS[days[0]]}–${DAYS[days[days.length - 1]]}`;
  return days.map((d) => DAYS[d]).join(", ");
}

export function calendarSummary(cal: Calendar): string {
  const n = cal.closures.size;
  const closures = n === 0 ? "no closures" : n === 1 ? "1 closure" : `${n} closures`;
  return `${cal.region ? regionText(cal.region) : "No holiday region"} · ${weekdaysText(cal.workdays)} · ${closures}`;
}
