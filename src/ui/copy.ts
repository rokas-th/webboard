export const EMPTY_PLAN = "No items yet. Add one with + New.";

export const DUR_NOT_WHOLE = "A duration is a whole number of working days.";

export const LAG_NOT_WHOLE = "Lag must be a whole number of working days.";

export const endBeforeStart = (start: string): string => `The end cannot come before the start, ${start}.`;

export const endOnDayOff = (day: string): string => `${day} is not a working day. Pick a working day for the end.`;
