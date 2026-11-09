import type { ListedDay, RegionRef } from "../../domain/calendar";

const official = (region: RegionRef): string => {
  switch (region.src) {
    case "openholidays":
      return "Official · OpenHolidays";
    case "govuk":
      return "Official · GOV.UK";
    case "opm":
      return "Official · US OPM";
    case "ics":
      return `From ${region.name}`;
  }
};

const scoped = (label: string, scope: string | null): string => (scope === null ? label : `${label} · ${scope}`);

export function originLabel(day: ListedDay, region: RegionRef | null, scope: string | null): string {
  switch (day.kind) {
    case "added":
      return "Added by you";
    case "closure":
      return "Closure";
    case "public":
    case "optional":
    case "half": {
      if (region === null) throw new Error(`A fetched day on ${day.date} needs a holiday region`);
      if (day.kind === "public") return scoped(day.tuned ? `${official(region)} — you work this day` : official(region), scope);
      const base = day.kind === "optional" ? "Optional" : "Half day";
      return scoped(day.counted || day.tuned ? `${base}, turned on` : base, scope);
    }
  }
}
