import type { PlanView } from "../../store/doc";

export const CALENDAR_BANNER = "The calendar was changed on two devices. Nothing moves until you choose.";

export function CalendarBanner(p: { view: PlanView; onChoose(choice: string): void }) {
  const c = p.view.choices.find((x) => x.kind === "calendar");
  if (c === undefined) return null;
  return (
    <div className="choice-banner calendar-banner">
      <span className="banner-text">{CALENDAR_BANNER}</span>
      <button type="button" className="button-small" onClick={() => p.onChoose(c.id)}>
        Choose…
      </button>
    </div>
  );
}
