import { useEffect, useState, type ReactNode } from "react";
import { sideText } from "../../plan/choices";
import { usePlanView, type PlanSession } from "../../store/session";
import { CalendarBanner } from "../choices/CalendarBanner";
import { HeadCounts } from "../choices/HeadCounts";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function PlanHead(p: { session: PlanSession; onChoose(choice: string): void; children?: ReactNode }) {
  const view = usePlanView(p.session);
  const [listOpen, setListOpen] = useState(false);
  const plan = view.plan;
  const none = view.choices.length === 0;
  useEffect(() => {
    if (none) setListOpen(false);
  }, [none]);
  const choose = (id: string): void => {
    setListOpen(false);
    p.onChoose(id);
  };
  return (
    <div className="plan-head">
      <div className="plan-head-main">
        <h1>{plan.name}</h1>
        {view.unreadable.map((u) => (
          <p key={u.id} className="head-line bad">
            {u.message}
          </p>
        ))}
        {p.children}
        <CalendarBanner view={view} onChoose={choose} />
        <div className="chips">
          {view.pending > 0 && (
            <span className="chip chip-cyan">Receiving… · {plural(view.pending, "change waiting", "changes waiting")}</span>
          )}
          {view.choices.length > 0 && (
            <span className="chip chip-amber">
              {plural(view.choices.length, "open choice", "open choices")} ·{" "}
              <button type="button" className="chip-button" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
                Choose…
              </button>
            </span>
          )}
          <HeadCounts view={view} onChoose={choose} />
        </div>
      </div>
      {listOpen && view.choices.length > 0 && (
        <ul className="choice-list" aria-label="Open choices">
          {view.choices.map((c) => (
            <li key={c.id}>
              <button type="button" className="choice-row" onClick={() => choose(c.id)}>
                {c.sides.map((s) => sideText(c, s.key, plan)).join(" or ")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
