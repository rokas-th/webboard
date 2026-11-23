import { useId, useMemo, useState } from "react";
import type { Built } from "../../actions/intents";
import type { ResolveOptions } from "../../actions/resolve";
import type { PlanState } from "../../domain/model";
import type { UnitKey } from "../../log/types";
import { sideText, type Choice } from "../../plan/choices";
import { usePlanView, type PlanSession } from "../../store/session";
import { Dialog } from "../common/Dialog";
import { useExec } from "../run";
import { unitSubject } from "./describe";
import { groupRows, outcomeLine } from "./outcome";
import { orderedSides } from "./order";
import { CHOICE_TITLE, DEFAULTS, pickOf, usePicks, useSettledClose, type Picks } from "./pick";
import { useDateStyle, useDevice } from "../DeviceProvider";
import { sideContent, type SideContent } from "./side";
import { UndoOffer } from "./UndoOffer";

const NO_PICKS: Picks = new Map();

function Column(p: { plan: PlanState; choice: Choice; side: string; label: string; content: SideContent; picked: boolean; readOnly: boolean; onKeep(): void }) {
  const plan = p.plan;
  const c = p.content;
  const style = useDateStyle();
  return (
    <section className={p.picked ? "choice-col picked" : "choice-col"}>
      <p className="choice-side">{sideText(p.choice, p.side, plan)}</p>
      {c.values.map((v, i) => (
        <p key={i} className="choice-value">
          {v}
        </p>
      ))}
      {c.impact !== null && <p className="recal">{c.impact}</p>}
      <p className="choice-summary">{c.summary}</p>
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
      <details className="choice-moves">
        <summary>Show what moves</summary>
        {groupRows(c.rows, plan).map((s) => (
          <div key={s.group ?? ""} className="moves-group">
            <p className="moves-title">{s.title}</p>
            {s.rows.map((r) => (
              <p key={r.item} className="moves-line">
                {outcomeLine(r, plan, style)}
              </p>
            ))}
          </div>
        ))}
      </details>
      <button type="button" className="button-primary" disabled={p.readOnly} onClick={p.onKeep}>
        Keep {p.label}
      </button>
    </section>
  );
}

function Body(p: { session: PlanSession; choice: Choice; side: string | undefined; local: string; onKeep(write: () => Built): void }) {
  const view = usePlanView(p.session);
  const plan = view.plan;
  const choice = p.choice;
  const sides = useMemo(() => orderedSides(choice, p.local), [choice, p.local]);
  const [opts, setOpts] = useState<ResolveOptions>(DEFAULTS);
  const [perItem, setPerItem] = useState(false);
  const [live, setPerUnit] = usePicks(choice, plan);
  const base = useId();
  const picks = perItem ? live : NO_PICKS;
  const style = useDateStyle();
  const week = useDevice().prefs.week;
  const contents = useMemo(
    () => sides.map((s) => sideContent(p.session, choice, pickOf(s.key, picks), opts, style, week)),
    [p.session, choice, sides, picks, opts, view, style, week],
  );
  const pickUnit = (u: UnitKey, side: string): void => {
    const next = new Map(live);
    if (side === "") next.delete(u);
    else next.set(u, side);
    setPerUnit(next);
  };
  const offerSide = p.side;
  return (
    <>
      {offerSide !== undefined && (
        <UndoOffer disabled={p.session.readOnly} onKeep={() => p.onKeep(() => p.session.resolve(choice.id, { side: offerSide }, opts))} />
      )}
      <div className="choice-options">
        <label>
          <input type="checkbox" checked={opts.pushFromPredecessors} onChange={(e) => setOpts({ ...opts, pushFromPredecessors: e.target.checked })} />
          Push from predecessors
        </label>
        <label>
          <input type="checkbox" checked={opts.returnPushed} onChange={(e) => setOpts({ ...opts, returnPushed: e.target.checked })} />
          Return the items the other side's push moved
        </label>
        <label>
          <input type="checkbox" checked={perItem} onChange={(e) => setPerItem(e.target.checked)} />
          Pick per item
        </label>
      </div>
      {perItem && (
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
      )}
      <div className="choice-cols">
        {sides.map((s, i) => (
          <Column
            key={s.key}
            plan={plan}
            readOnly={p.session.readOnly}
            choice={choice}
            side={s.key}
            label={s.label}
            content={contents[i]}
            picked={s.key === p.side}
            onKeep={() => p.onKeep(() => p.session.resolve(choice.id, pickOf(s.key, picks), opts))}
          />
        ))}
      </div>
    </>
  );
}

export function ChoiceDialog(p: { session: PlanSession; id: string; side?: string; local: string; onClose(): void }) {
  const view = usePlanView(p.session);
  const exec = useExec(p.session);
  const choice = view.choices.find((c) => c.id === p.id) ?? null;
  const onClose = p.onClose;
  const watched = useSettledClose(choice === null, onClose);
  if (choice === null) return null;
  const keep = (write: () => Built): void => {
    if (exec(watched(write)) !== null) onClose();
  };
  return (
    <Dialog label={CHOICE_TITLE} wide onClose={onClose}>
      <Body session={p.session} choice={choice} side={p.side} local={p.local} onKeep={keep} />
    </Dialog>
  );
}
