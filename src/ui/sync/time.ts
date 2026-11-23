import { fmtShort, localToday, type DateStyle } from "../../domain/dates";

const two = (n: number): string => String(n).padStart(2, "0");

export const clockTime = (at: number): string => {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

export const dayTime = (at: number, style: DateStyle): string => `${fmtShort(localToday(new Date(at)), style)} ${clockTime(at)}`;
