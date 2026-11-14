import { useId, useMemo, useState } from "react";
import type { Built } from "../../actions/intents";
import type { ResolveOptions } from "../../actions/resolve";
import type { PlanState } from "../../domain/model";
import type { UnitKey } from "../../log/types";
import { sideText, type Choice } from "../../plan/choices";
import { haptic } from "../../services/haptics";
import { usePlanView, type PlanSession } from "../../store/session";
import { unitSubject } from "../choices/describe";
import { orderedSides } from "../choices/order";
import { groupRows, outcomeLine } from "../choices/outcome";
import { CHOICE_TITLE, DEFAULTS, pickOf, usePicks, useSettledClose, type Picks } from "../choices/pick";
import { sideContent, type SideContent } from "../choices/side";
import { Sheet } from "../common/Sheet";
import { useExec } from "../run";
import { useReadOnly } from "./readOnly";

const othersThan = (side: string, picks: Picks): Picks => {
  const rest = [...picks].filter(([, key]) => key !== side);
  return rest.length === picks.size ? picks : new Map(rest);
};

function Card(p: { plan: PlanState; choice: Choice; side: string; content: SideContent; picked: boolean; onPick(): void }) {
  const [open, setOpen] = useState(false);
  const c = p.content;
  const plan = p.plan;
  return (
    <section className={p.picked ? "choice-col picked" : "choice-col"}>
      <button type="button" role="radio" aria-checked={p.picked} className="choice-side" onClick={p.onPick}>
        {sideText(p.choice, p.side, plan)}
      </button>
      {c.values.map((v, i) => (
        <p key={i} className="choice-value">
          {v}
        </p>
      ))}
      {c.rows.length === 0 ? (
        <p className="choice-summary">{c.summary}</p>
      ) : (
        <button type="button" className="choice-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
          {c.summary}
          {!open && <span className="dim"> · show what moves</span>}
        </button>
      )}
      {c.stopped.map((s, i) => (
        <p key={i} className="choice-stopped">
          {s}
        </p>
      ))}
      {c.kept.map((k, i) => (
        <p key={i} className="choice-kept">
          {k}
        </p>
      ))}
      {c.impact !== null && <p className="recal">{c.impact}</p>}
      {open &&
        groupRows(c.rows, plan).map((s) => (
          <div key={s.group ?? ""} className="moves-group">
            <p className="moves-title">{s.title}</p>
            {s.rows.map((r) => (
              <p key={r.item} className="moves-line">
                {outcomeLine(r, plan)}
              </p>
            ))}
          </div>
        ))}
    </section>
  );
}

function Body(p: {
  session: PlanSession;
  choice: Choice;
  side: string | undefined;
  local: string;
  watched(write: () => Built): () => Built;
  onClose(): void;
}) {
  const view = usePlanView(p.session);
  const exec = useExec(p.session);
  const readOnly = useReadOnly(p.session);
  const plan = view.plan;
  const choice = p.choice;
  const sides = useMemo(() => orderedSides(choice, p.local), [choice, p.local]);
  const first = sides[0];
  if (first === undefined) throw new Error(`Choice ${choice.id} has no sides`);
  const [kept, setKept] = useState(p.side ?? first.key);
  if (!sides.some((s) => s.key === kept)) throw new Error(`Choice ${choice.id} has no side ${kept}`);
  const [opts, setOpts] = useState<ResolveOptions>(DEFAULTS);
  const [live, setPicks] = usePicks(choice, plan);
  const base = useId();
  const contents = useMemo(
    () => sides.map((s) => sideContent(p.session, choice, pickOf(s.key, othersThan(s.key, live)), opts)),
    [p.session, choice, sides, live, opts, view],
  );
  const pickUnit = (u: UnitKey, side: string): void => {
    const next = new Map(live);
    if (side === "") next.delete(u);
    else next.set(u, side);
    setPicks(next);
  };
  const apply = (): void => {
    if (exec(p.watched(() => p.session.resolve(choice.id, pickOf(kept, othersThan(kept, live)), opts))) !== null) p.onClose();
  };
  return (
    <div className="panel csheet">
      <div className="choice-cols" role="radiogroup" aria-label="Keep">
        {sides.map((s, i) => (
          <Card key={s.key} plan={plan} choice={choice} side={s.key} content={contents[i]} picked={s.key === kept} onPick={() => setKept(s.key)} />
        ))}
      </div>
      <div className="choice-options">
        <label>
          <input
            type="checkbox"
            role="switch"
            checked={opts.pushFromPredecessors}
            onChange={(e) => {
              haptic("light");
              setOpts({ ...opts, pushFromPredecessors: e.target.checked });
            }}
          />
          Push from predecessors
        </label>
        <label>
          <input
            type="checkbox"
            role="switch"
            checked={opts.returnPushed}
            onChange={(e) => {
              haptic("light");
              setOpts({ ...opts, returnPushed: e.target.checked });
            }}
          />
          Return the items the other side's push moved
        </label>
      </div>
      <h2>Pick per item</h2>
      <ul className="pick-rows">
        {choice.units.map((u, i) => {
          const subjectId = `${base}-pick-${i}`;
          return (
            <li key={u} className="pick-row">
              <span id={subjectId} className="pick-subject">
                {unitSubject(u, plan)}
              </span>
              <select aria-labelledby={subjectId} value={live.get(u) ?? ""} onChange={(e) => pickUnit(u, e.target.value)}>
                <option value="">As the kept side</option>
                {sides
                  .filter((s) => s.values.has(u))
                  .map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
              </select>
            </li>
          );
        })}
      </ul>
      <button type="button" className="button-primary" disabled={readOnly} onClick={apply}>
        Apply
      </button>
    </div>
  );
}

export function ChoiceSheet(p: { session: PlanSession; id: string; side?: string; local: string; onClose(): void }) {
  const view = usePlanView(p.session);
  const choice = view.choices.find((c) => c.id === p.id) ?? null;
  const watched = useSettledClose(choice === null, p.onClose);
  if (choice === null) return null;
  return (
    <Sheet open title={CHOICE_TITLE} onClose={p.onClose}>
      <Body session={p.session} choice={choice} side={p.side} local={p.local} watched={watched} onClose={p.onClose} />
    </Sheet>
  );
}
