import { useState } from "react";
import type { IsoDate } from "../../domain/dates";
import type { ItemId, ItemKind } from "../../domain/model";
import { usePlanView, type PlanSession } from "../../store/session";
import { HeldChip } from "../choices/HeldChip";
import { NewItemMenu } from "../common/NewItemMenu";
import { createdItem, createIntent } from "../palette/commands";
import { useRun } from "../run";
import type { PlanFiles } from "../shell/selection";
import { SyncChip } from "../shell/SyncChip";
import { useUiValue } from "../state";
import { PlanSheet } from "./PlanSheet";
import { useReadOnly } from "./readOnly";

function PlanTools(p: { session: PlanSession; files: PlanFiles; today(): IsoDate; onChoose(choice: string): void; onCreated(id: ItemId): void }) {
  const view = usePlanView(p.session);
  const readOnly = useReadOnly(p.session);
  const run = useRun(p.session);
  const { ui } = useUiValue();
  const [sheet, setSheet] = useState(false);
  const create = (kind: ItemKind): void => {
    const built = run.run(createIntent(p.session, p.today(), kind, { parent: null, after: null }));
    if (built !== null) p.onCreated(createdItem(built));
  };
  return (
    <>
      <span className="phone-plan-name">{view.plan.name}</span>
      <HeldChip view={view} onChoose={p.onChoose} />
      <NewItemMenu label="+" className="button-primary phone-add" disabled={readOnly} onPick={create} />
      <button
        type="button"
        className="button-small phone-glyph"
        aria-label="Undo"
        title="Undo"
        disabled={readOnly || !p.session.canUndo()}
        onClick={() => run.undo()}
      >
        ↶
      </button>
      <button
        type="button"
        className="button-small phone-glyph"
        aria-label="Redo"
        title="Redo"
        disabled={readOnly || !p.session.canRedo()}
        onClick={() => run.redo()}
      >
        ↷
      </button>
      <SyncChip compact />
      <button type="button" className="button-small phone-more" aria-label="Plan" aria-haspopup="dialog" onClick={() => setSheet(true)}>
        ⋯
      </button>
      {sheet && ui.dialog === null && <PlanSheet session={p.session} files={p.files} onClose={() => setSheet(false)} />}
    </>
  );
}

export function PhoneTopBar(p: {
  name: string | null;
  session: PlanSession | null;
  files: PlanFiles;
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
        <PlanTools key={p.session.view().plan.id} session={p.session} files={p.files} today={p.today} onChoose={p.onChoose} onCreated={p.onCreated} />
      ) : (
        <>
          {p.name !== null && <span className="phone-plan-name">{p.name}</span>}
          <SyncChip compact />
        </>
      )}
    </header>
  );
}
