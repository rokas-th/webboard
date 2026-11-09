import { workCalendar, type Calendar, type ListedDay, type Tuning } from "../../domain/calendar";
import { fmtShort, toDay, toIso, yearOf, type Day, type IsoDate } from "../../domain/dates";
import { NOT_AVAILABLE, noticeText, type HolidayNotice } from "../../services/holidays";
import { originLabel } from "./origin";

export interface DraftFailure {
  message: string;
  tried: string;
}

const NOT_LOADED = "not loaded — dates use weekdays and closures";

const fmtDay = (d: IsoDate): string => `${fmtShort(d)} ${yearOf(toDay(d))}`;

function scopeOf(cal: Calendar, day: ListedDay): string | null {
  if (day.kind === "added" || day.kind === "closure") return null;
  const year = cal.holidays.get(yearOf(toDay(day.date)));
  const found = year?.days.find((d) => d.date === day.date && d.name === day.name && d.kind === day.kind);
  if (found === undefined) throw new Error(`No fetched day ${day.name} on ${day.date} in the draft`);
  return found.scope;
}

function action(day: ListedDay, t: Tuning | undefined): { label: string; next: Tuning | null } | null {
  switch (day.kind) {
    case "public":
      return t?.kind === "work" ? { label: "Count as a day off", next: null } : { label: "Work this day", next: { kind: "work" } };
    case "optional":
    case "half":
      return t?.kind === "off" ? { label: "Work this day", next: null } : { label: "Count as a day off", next: { kind: "off" } };
    case "added":
      return { label: "Remove", next: null };
    case "closure":
      return null;
  }
}

const retryable = (n: HolidayNotice): boolean => {
  const a = noticeText(n).action;
  return a === "retry" || (a === "calendar" && n.k === "failed" && !NOT_AVAILABLE.has(n.error.code));
};

export function DayList(p: {
  draft: Calendar;
  from: Day;
  to: Day;
  own: boolean;
  notices: readonly HolidayNotice[];
  failures: ReadonlyMap<number, DraftFailure>;
  onTune(date: IsoDate, t: Tuning | null): void;
  onRetryDraft(year: number): void;
  onLoad(year: number): void;
}) {
  const cal = workCalendar(p.draft);
  const days = cal.listed(p.from, p.to);
  const missing = cal.missingYears(p.from, p.to);
  return (
    <div className="day-list-wrap">
      <p className="dimp">
        Days off and holidays, {fmtDay(toIso(p.from))} – {fmtDay(toIso(p.to))}
      </p>
      <ul className="day-list" aria-label="Days off and holidays">
        {missing.map((y) => {
          const failure = p.failures.get(y);
          const notice = p.own && failure === undefined ? p.notices.find((n) => n.year === y && n.k === "failed") : undefined;
          return (
            <li key={`missing ${y}`} className="day-missing">
              <span className="day-year">{`${y} · ${NOT_LOADED}`}</span>
              {failure !== undefined && (
                <span className="day-detail">
                  <span>{failure.message}</span> <span>{`Tried ${failure.tried}`}</span>
                  <button type="button" className="button-small" onClick={() => p.onRetryDraft(y)}>
                    Try again
                  </button>
                </span>
              )}
              {notice !== undefined && (
                <span className="day-detail">
                  <span>{noticeText(notice).detail}</span>
                  {retryable(notice) && (
                    <button type="button" className="button-small" onClick={() => p.onLoad(y)}>
                      Try again
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
        {days.map((d, i) => {
          const act = action(d, p.draft.tuning.get(d.date));
          return (
            <li key={`${d.date} ${d.kind} ${d.name} ${i}`} className={d.counted ? "day-row counted" : "day-row"}>
              <span className="d">{fmtDay(d.date)}</span>
              <span className={d.kind === "closure" ? "day-name c" : "day-name"}>{d.name}</span>
              <span className="day-origin">{originLabel(d, p.draft.region, scopeOf(p.draft, d))}</span>
              {act !== null && (
                <button type="button" className="button-small" onClick={() => p.onTune(d.date, act.next)}>
                  {act.label}
                </button>
              )}
            </li>
          );
        })}
        {missing.length === 0 && days.length === 0 && <li className="day-row">Nothing listed in this span.</li>}
      </ul>
    </div>
  );
}
