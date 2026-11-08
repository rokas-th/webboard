import type { Calendar, HolidayDay, HolidayKind, HolidayYear } from "../../domain/calendar";
import type { IsoDate } from "../../domain/dates";

export const FETCHED_AT = "2026-11-08T08:00:00.000Z";

export const holidayDay = (date: IsoDate, name: string, kind: HolidayKind): HolidayDay => ({
  date,
  name,
  kind,
  sourceId: `oh-${date}`,
  scope: null,
});

export const holidayYear = (region: string, year: number, days: readonly HolidayDay[]): HolidayYear => ({
  region,
  year,
  days,
  fetchedAt: FETCHED_AT,
});

export const CH_ZH_2026 = holidayYear("oh:CH:CH-ZH", 2026, [
  holidayDay("2026-12-24", "Christmas Eve", "half"),
  holidayDay("2026-12-25", "Christmas Day", "public"),
  holidayDay("2026-12-26", "St Stephen's Day", "public"),
]);

export const CH_ZH_2027 = holidayYear("oh:CH:CH-ZH", 2027, [
  holidayDay("2027-01-01", "New Year's Day", "public"),
  holidayDay("2027-01-02", "Berchtold's Day", "optional"),
  holidayDay("2027-03-26", "Good Friday", "public"),
  holidayDay("2027-03-29", "Easter Monday", "public"),
]);

export const CH_ZH: Calendar = {
  region: { src: "openholidays", country: "CH", subdivision: "CH-ZH" },
  workdays: [1, 2, 3, 4, 5],
  closures: new Map(),
  tuning: new Map(),
  holidays: new Map([
    [2026, CH_ZH_2026],
    [2027, CH_ZH_2027],
  ]),
};

export const CH_ZH_OFF: ReadonlySet<IsoDate> = new Set([
  "2026-12-25",
  "2026-12-26",
  "2027-01-01",
  "2027-03-26",
  "2027-03-29",
]);
