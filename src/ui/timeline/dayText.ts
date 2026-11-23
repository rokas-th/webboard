import { fmtNear, fmtShort, toIso, weekday, type DateStyle, type Day, type IsoDate } from "../../domain/dates";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const dayLabel = (d: Day, style: DateStyle): string => `${WEEKDAYS[weekday(d) - 1]} ${fmtShort(toIso(d), style)}`;

export const dayLabelNear = (d: Day, today: IsoDate, style: DateStyle): string => `${WEEKDAYS[weekday(d) - 1]} ${fmtNear(toIso(d), today, style)}`;
