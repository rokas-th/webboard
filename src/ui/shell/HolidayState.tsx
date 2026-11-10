import { useCallback, useState, useSyncExternalStore } from "react";
import type { Intent } from "../../actions/intents";
import type { Calendar } from "../../domain/calendar";
import { noticeText, type HolidayNotice } from "../../services/holidays";
import type { Clock } from "../../services/clock";
import type { Registry } from "../../store/registry";
import { usePlanView, type PlanSession } from "../../store/session";
import { CalendarDialog, type CalendarReview } from "../calendar/CalendarDialog";
import { useUiValue } from "../state";

export const NOTICE_LABELS: Readonly<Record<"load" | "retry" | "review" | "calendar", string>> = {
  load: "Load",
  retry: "Try again",
  review: "Review",
  calendar: "Change calendar…",
};

const withBase = (i: Intent): i is { t: "calendar"; next: Calendar; base: Calendar } => i.t === "calendar" && i.base !== undefined;

export function reviewOf(n: HolidayNotice): CalendarReview {
  if (n.k !== "ready" && n.k !== "changed") throw new Error(`A ${n.k} notice for ${n.year} has nothing to review`);
  if (!withBase(n.intent)) throw new Error("A review notice needs a calendar intent with base");
  return { year: n.year, intent: n.intent };
}

export function HolidayState(p: { session: PlanSession; registry: Registry; clock: Clock }) {
  const view = usePlanView(p.session);
  const { setUi } = useUiValue();
  const holidays = p.registry.holidays;
  const planId = view.plan.id;
  const notices = useSyncExternalStore(
    useCallback((cb: () => void) => holidays.subscribe(cb), [holidays]),
    () => holidays.notices(planId),
  );
  const [review, setReview] = useState<CalendarReview | null>(null);
  const openCalendar = (): void => setUi({ dialog: { t: "calendar" } });

  const act = (n: HolidayNotice): void => {
    const a = noticeText(n).action;
    if (a === "load" || a === "retry") void holidays.load(planId, p.session, n.year);
    if (a === "review") setReview(reviewOf(n));
    if (a === "calendar") openCalendar();
  };

  return (
    <div className="holiday-state">
      {view.plan.calendar.region === null && (
        <p className="head-line warn">
          No holiday region — dates use weekdays and closures ·{" "}
          <button type="button" className="line-button" onClick={openCalendar}>
            Choose region
          </button>
        </p>
      )}
      {notices.map((n) => {
        const t = noticeText(n);
        return (
          <div key={`${n.k} ${n.year}`} className={n.k === "failed" || n.k === "refreshFailed" ? "head-line warn notice" : "head-line notice"}>
            <span className="notice-text">{t.text}</span>
            {t.action !== null && (
              <button type="button" className="line-button" onClick={() => act(n)}>
                {NOTICE_LABELS[t.action]}
              </button>
            )}
            {t.detail !== null && <span className="notice-detail">{t.detail}</span>}
          </div>
        );
      })}
      {review !== null && <CalendarDialog session={p.session} registry={p.registry} clock={p.clock} review={review} onClose={() => setReview(null)} />}
    </div>
  );
}
