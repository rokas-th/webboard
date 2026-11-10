import { useContext, useEffect, useMemo, useState } from "react";
import type { Preview } from "../../actions/intents";
import { OfferRefused } from "../../actions/undo";
import type { ActionId } from "../../log/types";
import { usePlanView, type HistoryEntry, type PlanSession } from "../../store/session";
import { Dialog } from "../common/Dialog";
import { Sheet } from "../common/Sheet";
import { OpenChoice, useExec } from "../run";
import { useUiValue } from "../state";
import { historyTime, revertText } from "./historyText";

export const REVERT = "Revert this action";
export const BRING_BACK = "Bring this action back";
export const REVERT_SHORT = "Revert";
export const BRING_BACK_SHORT = "Bring back";
export const HISTORY_PAGE = 50;

const entryOf = (session: PlanSession, id: ActionId): HistoryEntry => {
  const found = session.history().find((e) => e.id === id);
  if (found === undefined) throw new Error(`History: no action ${id}`);
  return found;
};

export function History(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const exec = useExec(p.session);
  const { setUi } = useUiValue();
  const [shown, setShown] = useState(HISTORY_PAGE);
  const entries = useMemo(() => p.session.history(), [p.session, view]);
  const offer = (id: ActionId): void => {
    exec(() => {
      p.session.previewRevert(id);
      setUi({ dialog: { t: "revert", id } });
      return null;
    });
  };
  return (
    <>
      <h2>History</h2>
      <ul className="history">
        {entries.slice(0, shown).map((e) => (
          <li key={e.id} className={e.active ? undefined : "inactive"} data-action={e.id}>
            <span className="hist-text">
              <span className="when">{historyTime(e.at, view.today)}</span>
              {` · ${e.device} · ${e.label}`}
            </span>
            {!p.readOnly && !e.root && (
              <button type="button" className="button-small" aria-label={e.active ? REVERT : BRING_BACK} onClick={() => offer(e.id)}>
                {e.active ? REVERT_SHORT : BRING_BACK_SHORT}
              </button>
            )}
          </li>
        ))}
      </ul>
      {entries.length > shown && (
        <div className="actions">
          <button type="button" className="button-small" onClick={() => setShown(shown + HISTORY_PAGE)}>
            Show older changes
          </button>
        </div>
      )}
    </>
  );
}

type Outlook = { k: "preview"; preview: Preview } | { k: "offer"; choice: string; side: string };

export function RevertDialog(p: { session: PlanSession; id: ActionId; frame?: "dialog" | "sheet"; onClose(): void }) {
  const view = usePlanView(p.session);
  const exec = useExec(p.session);
  const open = useContext(OpenChoice);
  if (open === null) throw new Error("RevertDialog needs an OpenChoice provider");
  const entry = useMemo(() => entryOf(p.session, p.id), [p.session, p.id, view]);
  const outlook = useMemo((): Outlook => {
    try {
      return { k: "preview", preview: p.session.previewRevert(p.id) };
    } catch (e) {
      if (e instanceof OfferRefused) return { k: "offer", choice: e.offer.choice, side: e.offer.side };
      throw e;
    }
  }, [p.session, p.id, view]);
  useEffect(() => {
    if (outlook.k === "offer") open(outlook.choice, outlook.side);
  }, [outlook, open]);
  if (outlook.k === "offer") return null;
  const apply = (): void => {
    if (exec(() => p.session.revert(p.id)) !== null) p.onClose();
  };
  const title = entry.active ? REVERT : BRING_BACK;
  const sheet = p.frame === "sheet";
  const body = (
    <>
      <div className="revert-text">
        {revertText(entry.label, outlook.preview).map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
      <div className="modal-actions">
        {!sheet && (
          <button type="button" onClick={p.onClose}>
            Cancel
          </button>
        )}
        <button type="button" className="button-primary" disabled={p.session.readOnly} onClick={apply}>
          Apply
        </button>
      </div>
    </>
  );
  if (sheet) {
    return (
      <Sheet open title={title} onClose={p.onClose}>
        <div className="revert-sheet">{body}</div>
      </Sheet>
    );
  }
  return (
    <Dialog label={title} onClose={p.onClose}>
      {body}
    </Dialog>
  );
}
