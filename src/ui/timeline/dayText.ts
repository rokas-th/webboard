import { fmtNear, fmtShort, toIso, weekday, type Day, type IsoDate } from "../../domain/dates";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const dayLabel = (d: Day): string => `${WEEKDAYS[weekday(d) - 1]} ${fmtShort(toIso(d))}`;

export const dayLabelNear = (d: Day, today: IsoDate): string => `${WEEKDAYS[weekday(d) - 1]} ${fmtNear(toIso(d), today)}`;
