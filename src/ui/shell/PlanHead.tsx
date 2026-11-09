import { useEffect, useState } from "react";
import { sideText } from "../../plan/choices";
import { usePlanView, type PlanSession } from "../../store/session";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function PlanHead(p: { session: PlanSession; onChoose(choice: string): void }) {
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
  const openHeld = (): void => {
    const c = view.choices.find((x) => x.items.some((i) => view.held.has(i)));
    if (c === undefined) throw new Error("No open choice holds the held items");
    p.onChoose(c.id);
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
          {view.held.size > 0 && (
            <button type="button" className="chip chip-amber" onClick={openHeld}>
              {view.held.size} held
            </button>
          )}
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
