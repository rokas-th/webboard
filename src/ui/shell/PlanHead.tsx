import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { sideText } from "../../plan/choices";
import { usePlanView, type PlanSession } from "../../store/session";
import { CalendarBanner } from "../choices/CalendarBanner";
import { HeadCounts } from "../choices/HeadCounts";
import { orderedSides } from "../choices/order";
import { TextField } from "../panel/TextField";
import { useRun } from "../run";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

type Popover = "choices" | "menu" | null;

export function PlanHead(p: {
  session: PlanSession;
  local: string;
  readOnly: boolean;
  naming: boolean;
  onNamed(): void;
  onChoose(choice: string): void;
  menu?: (open: boolean, setOpen: (open: boolean) => void) => ReactNode;
  children?: ReactNode;
}) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  const root = useRef<HTMLDivElement>(null);
  const { naming, onNamed, readOnly } = p;
  useEffect(() => {
    if (!naming) return;
    onNamed();
    if (readOnly) return;
    const input = root.current?.querySelector(".plan-name-input");
    if (!(input instanceof HTMLInputElement)) throw new Error("PlanHead: no Plan name field to focus");
    input.focus();
    input.select();
  }, [naming, onNamed, readOnly]);
  const [popover, setPopover] = useState<Popover>(null);
  const plan = view.plan;
  const none = view.choices.length === 0;
  const listOpen = popover === "choices";
  useEffect(() => {
    if (none) setPopover((o) => (o === "choices" ? null : o));
  }, [none]);
  const setMenuOpen = useCallback((open: boolean) => setPopover((o) => (open ? "menu" : o === "menu" ? null : o)), []);
  const choose = (id: string): void => {
    setPopover(null);
    p.onChoose(id);
  };
  return (
    <div className="plan-head" ref={root}>
      <div className="plan-head-main">
        <h1>
          <TextField className="plan-name-input" label="Plan name" value={plan.name} readOnly={p.readOnly} onCommit={(next) => run.run({ t: "planName", name: next }) !== null} />
        </h1>
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
              <button type="button" className="chip-button" aria-expanded={listOpen} onClick={() => setPopover(listOpen ? null : "choices")}>
                Choose…
              </button>
            </span>
          )}
          <HeadCounts view={view} onChoose={choose} />
        </div>
      </div>
      {p.menu === undefined ? null : p.menu(popover === "menu", setMenuOpen)}
      {listOpen && view.choices.length > 0 && (
        <ul className="choice-list" aria-label="Open choices">
          {view.choices.map((c) => (
            <li key={c.id}>
              <button type="button" className="choice-row" onClick={() => choose(c.id)}>
                {orderedSides(c, p.local).map((s) => sideText(c, s.key, plan)).join(" or ")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
