import { useRef, useState, type ReactNode } from "react";
import { Refused } from "../../actions/intents";
import { AppError } from "../../services/ipc";
import type { Registry } from "../../store/registry";
import { Dialog } from "../common/Dialog";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";

export const RELOAD_LABEL = "Load again from the server";
export const RELOAD_TEXT = "Changes this device had not sent to the server are not loaded again; the damaged files stay on this device.";

export function ReloadConfirm(p: { registry: Registry; docId: string; frame?: "dialog" | "sheet"; onClose(): void }) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const settle = (): void => {
    pendingRef.current = false;
    setPending(false);
  };
  const load = (): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    p.registry.reloadFromServer(p.docId).then(
      () => {
        settle();
        p.onClose();
      },
      (e: unknown) => {
        settle();
        if (!(e instanceof AppError || e instanceof Refused)) throw e;
        toast(e.message, "bad");
      },
    );
  };
  const body: ReactNode = (
    <>
      <p>{RELOAD_TEXT}</p>
      <div className="modal-actions">
        <button type="button" onClick={p.onClose}>
          Cancel
        </button>
        <button type="button" className="button-primary" disabled={pending} onClick={load}>
          Load again
        </button>
      </div>
    </>
  );
  if (p.frame === "sheet") {
    return (
      <Sheet open title={RELOAD_LABEL} onClose={p.onClose}>
        <div className="reload-sheet">{body}</div>
      </Sheet>
    );
  }
  return (
    <Dialog label={RELOAD_LABEL} onClose={p.onClose}>
      {body}
    </Dialog>
  );
}
