import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import type { IsoDate } from "../../domain/dates";
import type { ItemId, ItemKind } from "../../domain/model";
import { usePlanView, type PlanSession } from "../../store/session";
import { HeldChip } from "../choices/HeldChip";
import { createdItem, createIntent, NEW_NAME } from "../palette/commands";
import { useRun } from "../run";
import { useReadOnly } from "./readOnly";

const KINDS: readonly ItemKind[] = ["task", "milestone", "group"];

function NewItemMenu(p: { disabled: boolean; onPick(kind: ItemKind): void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const shown = open && !p.disabled;
  useEffect(() => {
    if (!shown) return;
    if (first.current === null) throw new Error("NewItemMenu: open without its first item");
    first.current.focus();
  }, [shown]);
  const close = (): void => {
    setOpen(false);
    toggle.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Escape" || !shown) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onLeave = (e: FocusEvent<HTMLDivElement>): void => {
    const next = e.relatedTarget;
    if (next instanceof Node && box.current?.contains(next)) return;
    setOpen(false);
  };
  return (
    <div className="plan-menu" ref={box} onKeyDown={onKey} onBlur={onLeave}>
      <button
        ref={toggle}
        type="button"
        className="button-primary phone-add"
        aria-haspopup="menu"
        aria-expanded={shown}
        disabled={p.disabled}
        onClick={() => setOpen(!open)}
      >
        +
      </button>
      {shown && (
        <div className="plan-menu-list" role="menu" aria-label="New item">
          {KINDS.map((kind, i) => (
            <button
              key={kind}
              ref={i === 0 ? first : undefined}
              type="button"
              role="menuitem"
              className="choice-row"
              onClick={() => {
                setOpen(false);
                p.onPick(kind);
              }}
            >
              {NEW_NAME[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanTools(p: { session: PlanSession; today(): IsoDate; onChoose(choice: string): void; onCreated(id: ItemId): void }) {
  const view = usePlanView(p.session);
  const readOnly = useReadOnly(p.session);
  const run = useRun(p.session);
  const create = (kind: ItemKind): void => {
    const built = run.run(createIntent(p.session, p.today(), kind, { parent: null, after: null }));
    if (built !== null) p.onCreated(createdItem(built));
  };
  return (
    <>
      <span className="phone-plan-name">{view.plan.name}</span>
      <HeldChip view={view} onChoose={p.onChoose} />
      <NewItemMenu disabled={readOnly} onPick={create} />
      <button type="button" className="button-small" disabled={readOnly || !p.session.canUndo()} onClick={() => run.undo()}>
        Undo
      </button>
      <button type="button" className="button-small" disabled={readOnly || !p.session.canRedo()} onClick={() => run.redo()}>
        Redo
      </button>
    </>
  );
}

export function PhoneTopBar(p: {
  name: string | null;
  session: PlanSession | null;
  today(): IsoDate;
  onPlans(): void;
  onChoose(choice: string): void;
  onCreated(id: ItemId): void;
}) {
  return (
    <header className="phone-head">
      <button type="button" className="button-small" onClick={p.onPlans}>
        Plans
      </button>
      {p.session !== null ? (
        <PlanTools session={p.session} today={p.today} onChoose={p.onChoose} onCreated={p.onCreated} />
      ) : (
        p.name !== null && <span className="phone-plan-name">{p.name}</span>
      )}
    </header>
  );
}
