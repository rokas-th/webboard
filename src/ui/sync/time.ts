import { fmtShort, localToday } from "../../domain/dates";

const two = (n: number): string => String(n).padStart(2, "0");

export const clockTime = (at: number): string => {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

export const dayTime = (at: number): string => `${fmtShort(localToday(new Date(at)))} ${clockTime(at)}`;
