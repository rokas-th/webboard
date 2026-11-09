import { fmtShort, toIso, weekday, type Day } from "../../domain/dates";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const dayLabel = (d: Day): string => `${WEEKDAYS[weekday(d) - 1]} ${fmtShort(toIso(d))}`;
