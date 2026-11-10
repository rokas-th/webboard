import { memo } from "react";
import { toDay, toIso, weekday, yearOf, type Day } from "../../domain/dates";
import type { Zoom } from "../state";
import { WEEKDAYS } from "./dayText";
import type { Geometry } from "./geometry";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export const nodataTitle = (year: number): string => `No holiday data for ${year} — dates use weekdays and closures`;

const dateOf = (d: Day): number => Number(toIso(d).slice(8, 10));

const nextMonth = (y: number, m: number): Day => toDay(`${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, "0")}-01`);

export function isoWeek(d: Day): number {
  const thursday = d - (weekday(d) - 1) + 3;
  return Math.floor((thursday - toDay(`${yearOf(thursday)}-01-01`)) / 7) + 1;
}

interface Month {
  day: Day;
  next: Day;
  y: number;
  m: number;
}

export const Scale = memo(function Scale(p: { geo: Geometry; zoom: Zoom; today: Day; missing: readonly number[] }) {
  const { geo } = p;
  const last = geo.origin + geo.days;
  const days = Array.from({ length: geo.days }, (_, i) => geo.origin + i);
  const months = days
    .filter((d) => d === geo.origin || dateOf(d) === 1)
    .map((d): Month => {
      const iso = toIso(d);
      const y = Number(iso.slice(0, 4));
      const m = Number(iso.slice(5, 7));
      return { day: d, next: Math.min(nextMonth(y, m), last), y, m };
    });
  const tx = geo.x(p.today) + geo.ppd / 2;
  return (
    <div className="tl-head">
      <div className="tl-corner">
        <span>Task</span>
        <span>Days</span>
      </div>
      <div className="tl-scale" style={{ width: geo.width }}>
        {months.map((mo) => {
          const nodata = p.missing.includes(mo.y);
          return (
            <div
              key={mo.day}
              className={nodata ? "tl-month nodata" : "tl-month"}
              style={{ left: geo.x(mo.day), width: geo.x(mo.next) - geo.x(mo.day) }}
              title={nodata ? nodataTitle(mo.y) : undefined}
            >
              <span className="tl-month-text">
                {MONTHS[mo.m - 1]} {mo.y}
              </span>
            </div>
          );
        })}
        {p.zoom === "W"
          ? days.map((d) => {
              const off = geo.cal.off(d);
              const cls = off !== null ? "tl-tick hol" : geo.cal.isWork(d) ? "tl-tick" : "tl-tick off";
              return (
                <div key={d} className={cls} style={{ left: geo.x(d), width: geo.ppd }} title={off === null ? undefined : off.name}>
                  {WEEKDAYS[weekday(d) - 1].charAt(0)} {dateOf(d)}
                </div>
              );
            })
          : days
              .filter((d) => weekday(d) === 1)
              .map((d) => (
                <div key={d} className="tl-tick" style={{ left: geo.x(d), width: 7 * geo.ppd }}>
                  {p.zoom === "M" ? `W${isoWeek(d)} · ${dateOf(d)}` : isoWeek(d)}
                </div>
              ))}
        <div className="tl-today-label" style={{ left: tx }}>
          TODAY
        </div>
      </div>
    </div>
  );
});
