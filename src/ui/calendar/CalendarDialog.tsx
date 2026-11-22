import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Refused, type Built, type Intent } from "../../actions/intents";
import { CLOSURE_TOO_LONG, closureTooLong, MAX_CLOSURE_DAYS, regionKey, type Calendar, type HolidayYear, type RegionRef, type Tuning } from "../../domain/calendar";
import type { PlanId } from "../../domain/model";
import { FIRST_PLAN_DATE, isCalendarDate, LAST_PLAN_DATE, toDay, toIso, yearOf, type Day, type IsoDate, type Weekday } from "../../domain/dates";
import { planRules } from "../../plan/rules";
import { key } from "../../plan/units";
import type { Clock } from "../../services/clock";
import type { HolidayNotice } from "../../services/holidays";
import { AppError } from "../../services/ipc";
import type { PlanView } from "../../store/doc";
import type { Registry } from "../../store/registry";
import { usePlanView, type PlanSession } from "../../store/session";
import { HOLIDAY_ATTRIBUTION } from "../common/About";
import { Dialog } from "../common/Dialog";
import { useCloseGuard, type DraftGuard } from "../common/dismiss";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { DATE_UNREADABLE } from "../copy";
import { historyTime } from "../panel/historyText";
import { useExec, useRun } from "../run";
import { DayList, type DraftYear } from "./DayList";
import { addClosure, removeClosure, sameCalendar, setWorkday, tune } from "./draft";
import { impactText } from "./impact";
import { messageOf } from "./message";
import { RegionPicker } from "./RegionPicker";

export interface CalendarReview {
  year: number;
  intent: { t: "calendar"; next: Calendar; base: Calendar };
}

interface CalendarBase {
  session: PlanSession;
  registry: Registry;
  clock: Clock;
}

export interface CalendarStash {
  plan: PlanId;
  base: Calendar;
  draft: Calendar;
  taken: Calendar;
  seen: Calendar["holidays"];
  dayName: string;
  dayFrom: string;
  dayTo: string;
}

export type FramedCalendarProps = CalendarBase & {
  frame?: "dialog" | "sheet";
  review?: CalendarReview;
  onClose(): void;
};

export type InlineCalendarProps = CalendarBase & {
  frame: "inline";
  reviewIn: "dialog" | "sheet";
  stash: RefObject<CalendarStash | null>;
  onApplied(region: RegionRef | null): void;
};

export type CalendarProps = FramedCalendarProps | InlineCalendarProps;

const NOTHING = "Nothing to change.";

export const CALENDAR_DRAFT: DraftGuard = { title: "Discard calendar changes?", message: "Your calendar changes are not applied yet." };

const REVIEW_TITLE = "Review changes";

const SECTION = "working-time";

const WEEK: readonly { d: Weekday; label: string }[] = [
  { d: 1, label: "Mon" },
  { d: 2, label: "Tue" },
  { d: 3, label: "Wed" },
  { d: 4, label: "Thu" },
  { d: 5, label: "Fri" },
  { d: 6, label: "Sat" },
  { d: 7, label: "Sun" },
];

function spanOf(view: PlanView): { from: Day; to: Day } {
  const today = toDay(view.today);
  const starts = [...view.derived.start.values()];
  if (starts.length === 0) return { from: today, to: today + 365 };
  return { from: Math.min(today, ...starts), to: Math.max(today, ...view.derived.end.values()) };
}

const lastDayMax = (from: string): IsoDate => {
  if (!isCalendarDate(from)) return LAST_PLAN_DATE;
  const longest = toIso(toDay(from) + MAX_CLOSURE_DAYS - 1);
  return longest < LAST_PLAN_DATE ? longest : LAST_PLAN_DATE;
};

function unreadable(el: HTMLInputElement | null): boolean {
  if (el === null) throw new Error("The day-off date field is not mounted");
  return el.validity.badInput;
}

const yearsOf = (from: Day, to: Day): number[] => Array.from({ length: yearOf(to) - yearOf(from) + 1 }, (_, i) => yearOf(from) + i);

const sameRegion = (a: RegionRef | null, b: RegionRef | null): boolean => planRules.same(key.cr, a, b);

function refusedText(e: unknown): string {
  if (e instanceof Refused) return e.message;
  throw e;
}

function yearsFor(base: Calendar["holidays"], draft: Calendar["holidays"], region: RegionRef | null): Calendar["holidays"] {
  if (region === null) return new Map();
  const rk = regionKey(region);
  const of = (m: Calendar["holidays"]): [number, HolidayYear][] => [...m].filter(([, y]) => y.region === rk);
  return new Map([...of(base), ...of(draft)]);
}

function arrivedYears(seen: Calendar["holidays"], cal: Calendar): [number, HolidayYear][] {
  if (cal.region === null) return [];
  const rk = regionKey(cal.region);
  return [...cal.holidays].filter(([y, h]) => h.region === rk && seen.get(y)?.region !== rk);
}

function withArrived(cal: Calendar, arrived: readonly [number, HolidayYear][]): Calendar {
  const added = arrived.filter(([y]) => !cal.holidays.has(y));
  return added.length === 0 ? cal : { ...cal, holidays: new Map([...cal.holidays, ...added]) };
}

function readyYears(notices: readonly HolidayNotice[]): [number, HolidayYear][] {
  return notices.flatMap((n): [number, HolidayYear][] => {
    if (n.k !== "ready") return [];
    if (n.intent.t !== "calendar") throw new Error(`The ready notice for ${n.year} carries no calendar intent`);
    const y = n.intent.next.holidays.get(n.year);
    if (y === undefined) throw new Error(`The ready notice for ${n.year} carries no holidays for that year`);
    return [[n.year, y]];
  });
}

function withReady(d: Calendar, ready: readonly [number, HolidayYear][]): Calendar {
  if (d.region === null) return d;
  const rk = regionKey(d.region);
  return withArrived(d, ready.filter(([, y]) => y.region === rk));
}

function previewText(session: PlanSession, view: PlanView, intent: Extract<Intent, { t: "calendar" }>): string {
  if (session.view() !== view) throw new Error("The calendar preview ran on another plan view than the dialog shows");
  try {
    return impactText(session.preview(intent));
  } catch (e) {
    return refusedText(e);
  }
}

export function CalendarBody(p: CalendarProps) {
  const session = p.session;
  const holidays = p.registry.holidays;
  const sheet = p.frame === "sheet";
  const inline = p.frame === "inline";
  const review = p.frame === "inline" ? undefined : p.review;
  const stash = p.frame === "inline" ? p.stash : null;
  const [restored] = useState<CalendarStash | null>(() => {
    const kept = stash === null ? null : stash.current;
    return kept !== null && kept.plan === session.view().plan.id ? kept : null;
  });
  const view = usePlanView(session);
  const run = useRun(session);
  const exec = useExec(session);
  const readOnly = useSyncExternalStore(
    useCallback((cb: () => void) => session.subscribe(cb), [session]),
    () => session.readOnly,
  );
  const notices = useSyncExternalStore(
    useCallback((cb: () => void) => holidays.subscribe(cb), [holidays]),
    () => holidays.notices(view.plan.id),
  );
  const [base, setBase] = useState<Calendar>(() => restored?.base ?? review?.intent.base ?? session.view().plan.calendar);
  const [draft, setDraft] = useState<Calendar>(() => restored?.draft ?? review?.intent.next ?? base);
  const [taken, setTaken] = useState<Calendar>(() => restored?.taken ?? base);
  const [seen, setSeen] = useState<Calendar["holidays"]>(() => restored?.seen ?? view.plan.calendar.holidays);
  const [seenNotices, setSeenNotices] = useState<readonly HolidayNotice[] | null>(null);
  const [drafted, setDrafted] = useState<ReadonlyMap<string, ReadonlyMap<number, DraftYear>>>(new Map());
  const [regionError, setRegionError] = useState<{ region: RegionRef; message: string } | null>(null);
  const [applied, setApplied] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [dayName, setDayName] = useState(restored?.dayName ?? "");
  const [dayFrom, setDayFrom] = useState(restored?.dayFrom ?? "");
  const [dayTo, setDayTo] = useState(restored?.dayTo ?? "");
  const firstDayRef = useRef<HTMLInputElement>(null);
  const lastDayRef = useRef<HTMLInputElement>(null);
  const clock = p.clock;
  const planCal = view.plan.calendar;
  if (seen !== planCal.holidays) {
    const arrived = arrivedYears(seen, planCal);
    setSeen(planCal.holidays);
    if (arrived.length > 0) {
      const ownKey = planCal.region === null ? null : regionKey(planCal.region);
      setBase((c) => withArrived(c, arrived));
      setDraft((d) => (d.region !== null && regionKey(d.region) === ownKey ? withArrived(d, arrived) : d));
      setTaken((c) => (c.region !== null && regionKey(c.region) === ownKey ? withArrived(c, arrived) : c));
    }
  }
  if (review === undefined && seenNotices !== notices) {
    const ready = readyYears(notices);
    setSeenNotices(notices);
    if (ready.length > 0) {
      setDraft((d) => withReady(d, ready));
      setTaken((c) => withReady(c, ready));
    }
  }
  const span = spanOf(view);
  const spanYears = useMemo(() => yearsOf(span.from, span.to), [span.from, span.to]);

  const fetchYears = useCallback(
    (region: RegionRef, years: readonly number[]): void => {
      const rk = regionKey(region);
      const mark = (state: (y: number) => DraftYear | null): void =>
        setDrafted((all) => {
          const kept = [...(all.get(rk) ?? new Map<number, DraftYear>())].filter(([y]) => !years.includes(y));
          const marked = years.flatMap((y): [number, DraftYear][] => {
            const s = state(y);
            return s === null ? [] : [[y, s]];
          });
          return new Map([...all, [rk, new Map([...kept, ...marked])]]);
        });
      mark(() => ({ k: "loading" }));
      void holidays.draftYears(region, years).then(
        (answers) => {
          const tried = historyTime(clock.now(), clock.today());
          const got = [...answers].flatMap(([y, a]): [number, HolidayYear][] => (a instanceof AppError ? [] : [[y, a]]));
          setDraft((d) => (d.region === null || regionKey(d.region) !== rk ? d : { ...d, holidays: new Map([...d.holidays, ...got]) }));
          mark((y) => {
            const a = answers.get(y);
            return a instanceof AppError ? { k: "failed", message: a.message, tried } : null;
          });
        },
        (e: unknown) => {
          const tried = historyTime(clock.now(), clock.today());
          mark(() => ({ k: "failed", message: messageOf(e), tried }));
          if (!(e instanceof AppError)) throw e;
        },
      );
    },
    [holidays, clock],
  );

  const pick = useCallback(
    (region: RegionRef | null): void => {
      setDraft((d) => ({ ...d, region, holidays: yearsFor(base.holidays, d.holidays, region) }));
      if (region !== null) fetchYears(region, spanYears);
    },
    [fetchYears, spanYears, base],
  );

  const change = (f: (c: Calendar) => Calendar): void => {
    try {
      f(draft);
    } catch (e) {
      toast(refusedText(e), "bad");
      return;
    }
    setDraft((d) => f(d));
  };

  const onTune = (date: IsoDate, t: Tuning | null): void => change((c) => tune(c, date, t));

  const addDay = (): void => {
    if (unreadable(firstDayRef.current) || unreadable(lastDayRef.current)) {
      toast(DATE_UNREADABLE, "bad");
      return;
    }
    const name = dayName.trim();
    if (name === "" || !isCalendarDate(dayFrom)) {
      toast("A day off needs a name and a first day.", "bad");
      return;
    }
    const to = dayTo === "" ? dayFrom : dayTo;
    if (!isCalendarDate(to)) {
      toast("The last day is not a date.", "bad");
      return;
    }
    if (toDay(to) < toDay(dayFrom)) {
      toast("The last day is before the first day.", "bad");
      return;
    }
    if (closureTooLong(dayFrom, to)) {
      toast(CLOSURE_TOO_LONG, "bad");
      return;
    }
    change((c) => (to === dayFrom ? tune(c, dayFrom, { kind: "add", name }) : addClosure(c, { from: dayFrom, to, name })));
    setDayName("");
    setDayFrom("");
    setDayTo("");
  };

  const unchanged = sameCalendar(draft, base);
  const asks = !applied && (!sameCalendar(draft, taken) || dayName !== "" || dayFrom !== "" || dayTo !== "");
  useCloseGuard(asks ? CALENDAR_DRAFT : null);
  const impact = useMemo(
    () => (unchanged ? impactText({ endsChanged: 0, movedLater: 0 }) : previewText(session, view, { t: "calendar", next: draft, base })),
    [unchanged, session, draft, base, view],
  );

  const planId = view.plan.id;
  useLayoutEffect(() => {
    if (stash === null) return;
    stash.current = applied ? null : { plan: planId, base, draft, taken, seen, dayName, dayFrom, dayTo };
  });

  const close = (): void => {
    if (p.frame === "inline") throw new Error("CalendarBody: the inline frame has no close; an apply ends it");
    p.onClose();
  };

  const saveRegion = (region: RegionRef): void => {
    setRegionError(null);
    p.registry.setLastRegion(region).then(
      () => close(),
      (e: unknown) => {
        setRegionError({ region, message: messageOf(e) });
        if (!(e instanceof AppError)) throw e;
      },
    );
  };

  const apply = (): void => {
    let built: Built | null;
    if (review === undefined) {
      built = run.run({ t: "calendar", next: draft, base });
    } else {
      built = exec(() => {
        const edited: Intent = { t: "calendar", next: draft, base: review.intent.base };
        const intent: Intent = draft === review.intent.next ? review.intent : edited;
        try {
          return session.apply(intent);
        } catch (e) {
          if (!(e instanceof Refused) || e.message !== NOTHING) throw e;
          holidays.dismiss(planId, review.year);
          close();
          return null;
        }
      });
    }
    if (built === null) return;
    setApplied(true);
    if (review !== undefined) holidays.dismiss(planId, review.year);
    const region = draft.region !== null && !sameRegion(draft.region, base.region) ? draft.region : null;
    if (p.frame === "inline") {
      p.onApplied(region);
      return;
    }
    if (region !== null) {
      saveRegion(region);
      return;
    }
    close();
  };

  const discard = (): void => {
    setDraft(taken);
    setDrafted(new Map());
    setRegionError(null);
    setDayName("");
    setDayFrom("");
    setDayTo("");
  };

  const anchored = (row: string, node: ReactNode): ReactNode =>
    inline ? (
      <div className="cal-anchor" data-settings-row={`${SECTION}.${row}`}>
        {node}
      </div>
    ) : (
      node
    );

  const draftRegion = draft.region;
  const own = draftRegion !== null && view.plan.calendar.region !== null && regionKey(draftRegion) === regionKey(view.plan.calendar.region);
  const regionYears = draftRegion === null ? new Map<number, DraftYear>() : (drafted.get(regionKey(draftRegion)) ?? new Map<number, DraftYear>());
  const closures = [...draft.closures.values()].sort((a, b) => (a.from === b.from ? (a.id < b.id ? -1 : 1) : a.from < b.from ? -1 : 1));

  return (
    <div className="cal-body">
      <div className="cal-grid">
        <label>Region</label>
        {anchored("region", <RegionPicker region={draft.region} tuning={draft.tuning} onPick={pick} onTune={onTune} />)}
        <label>Working days</label>
        {anchored(
          "days",
          <div className="seg seg-days" role="group" aria-label="Working days">
            {WEEK.map((w) => {
              const on = draft.workdays.includes(w.d);
              return (
                <button key={w.d} type="button" className={on ? "active" : ""} aria-pressed={on} onClick={() => change((c) => setWorkday(c, w.d, !on))}>
                  {w.label}
                </button>
              );
            })}
          </div>,
        )}
        <label>Closures</label>
        <div data-settings-row={inline ? `${SECTION}.closures` : undefined}>
          <div className="closure-list">
            {closures.map((c) => (
              <div key={c.id} className="closure-row">
                <span>{c.name}</span>
                <span className="when">{c.from === c.to ? c.from : `${c.from} – ${c.to}`}</span>
                <button type="button" className="x" aria-label={`Remove ${c.name}`} onClick={() => change((x) => removeClosure(x, c.id))}>
                  ×
                </button>
              </div>
            ))}
            {closures.length === 0 && <span className="note">None. Add company closures, holidays you take as a team, or a release freeze.</span>}
          </div>
          <div className="closure-add">
            <input type="text" aria-label="Day off name" placeholder="Name, e.g. Team offsite" value={dayName} onChange={(e) => setDayName(e.target.value)} />
            <input ref={firstDayRef} type="date" aria-label="First day" value={dayFrom} min={FIRST_PLAN_DATE} max={LAST_PLAN_DATE} onChange={(e) => setDayFrom(e.target.value)} />
            <input ref={lastDayRef} type="date" aria-label="Last day" value={dayTo} min={FIRST_PLAN_DATE} max={lastDayMax(dayFrom)} onChange={(e) => setDayTo(e.target.value)} />
            <button type="button" className="button-small" onClick={addDay}>
              Add a day off
            </button>
          </div>
        </div>
      </div>
      {anchored(
        "days-off",
        <DayList
          draft={draft}
          from={span.from}
          to={span.to}
          own={own}
          notices={notices}
          draftYears={regionYears}
          onTune={onTune}
          onRetryDraft={(y) => {
            if (draftRegion !== null) fetchYears(draftRegion, [y]);
          }}
          onLoad={(y) => void holidays.load(planId, session, y)}
        />,
      )}
      <p className="impact">{impact}</p>
      {draftRegion !== null && draftRegion.src === "openholidays" && <p className="dimp">{HOLIDAY_ATTRIBUTION}</p>}
      {regionError !== null && (
        <div className="cal-failed">
          <span className="note bad">{regionError.message}</span>
          <button type="button" className="button-small" onClick={() => saveRegion(regionError.region)}>
            Try again
          </button>
        </div>
      )}
      {inline ? (
        <div className="modal-actions cal-inline-actions">
          <button type="button" disabled={!asks} onClick={discard}>
            Discard changes
          </button>
          <button type="button" className="button-primary" disabled={readOnly || applied || unchanged} onClick={() => setReviewing(true)}>
            Review changes…
          </button>
        </div>
      ) : sheet ? (
        !readOnly && (
          <div className="modal-actions">
            <button type="button" className="button-primary" disabled={applied || unchanged} onClick={apply}>
              Apply
            </button>
          </div>
        )
      ) : (
        <div className="modal-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="button" className="button-primary" disabled={readOnly || applied || unchanged} onClick={apply}>
            Apply
          </button>
        </div>
      )}
      {p.frame === "inline" && reviewing && !applied && (
        <ReviewChanges frame={p.reviewIn} impact={impact} disabled={readOnly || unchanged} onApply={apply} onClose={() => setReviewing(false)} />
      )}
    </div>
  );
}

function ReviewChanges(p: { frame: "dialog" | "sheet"; impact: string; disabled: boolean; onApply(): void; onClose(): void }) {
  const body = (
    <>
      <p className="review-impact">{p.impact}</p>
      <div className="modal-actions">
        <button type="button" onClick={p.onClose}>
          Cancel
        </button>
        <button type="button" className="button-primary" disabled={p.disabled} onClick={p.onApply}>
          Apply
        </button>
      </div>
    </>
  );
  return createPortal(
    p.frame === "sheet" ? (
      <Sheet open title={REVIEW_TITLE} onClose={p.onClose}>
        <div className="review-sheet">{body}</div>
      </Sheet>
    ) : (
      <Dialog label={REVIEW_TITLE} onClose={p.onClose}>
        {body}
      </Dialog>
    ),
    document.body,
  );
}

export function CalendarDialog(p: FramedCalendarProps) {
  const view = usePlanView(p.session);
  return (
    <Dialog label={"Calendar · " + view.plan.name} wide onClose={p.onClose}>
      <CalendarBody {...p} />
    </Dialog>
  );
}
