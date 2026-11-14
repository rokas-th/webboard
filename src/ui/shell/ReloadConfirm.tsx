import { useRef, useState, type ReactNode } from "react";
import { Refused } from "../../actions/intents";
import { CANCEL_LABEL, usesNativeAlert, type NativeAsk } from "../../services/alert";
import { AppError } from "../../services/ipc";
import type { Registry } from "../../store/registry";
import { Dialog } from "../common/Dialog";
import { NativeConfirm } from "../common/NativeConfirm";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";

export const RELOAD_LABEL = "Load again from the server";
export const RELOAD_TEXT = "Changes this device had not sent to the server are not loaded again; the damaged files stay on this device.";
export const RELOAD_CONFIRM = "Load again";

export const RELOAD_ASK: NativeAsk = { title: RELOAD_LABEL, message: RELOAD_TEXT, confirm: { label: RELOAD_CONFIRM, destructive: false }, cancel: CANCEL_LABEL };

async function reloadNow(registry: Registry, docId: string, close: () => void): Promise<void> {
  try {
    await registry.reloadFromServer(docId);
  } catch (e) {
    if (!(e instanceof AppError || e instanceof Refused)) throw e;
    toast(e.message, "bad");
    return;
  }
  close();
}

export function ReloadConfirmBody(p: { registry: Registry; docId: string; onClose(): void }) {
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
    void reloadNow(p.registry, p.docId, () => {
      settle();
      p.onClose();
    }).then(settle, (e: unknown) => {
      settle();
      throw e;
    });
  };
  return (
    <>
      <p>{RELOAD_TEXT}</p>
      <div className="modal-actions">
        <button type="button" onClick={p.onClose}>
          {CANCEL_LABEL}
        </button>
        <button type="button" className="button-primary" disabled={pending || p.registry.reloading(p.docId)} onClick={load}>
          {RELOAD_CONFIRM}
        </button>
      </div>
    </>
  );
}

export function NativeReload(p: { registry: Registry; docId: string; offered: boolean; onClose(): void }) {
  return <NativeConfirm ask={RELOAD_ASK} current={p.offered} run={() => reloadNow(p.registry, p.docId, p.onClose)} onClose={p.onClose} />;
}

export function ReloadConfirm(p: { registry: Registry; docId: string; offered: boolean; frame?: "dialog" | "sheet"; onClose(): void }) {
  if (usesNativeAlert()) return <NativeReload registry={p.registry} docId={p.docId} offered={p.offered} onClose={p.onClose} />;
  const body: ReactNode = <ReloadConfirmBody registry={p.registry} docId={p.docId} onClose={p.onClose} />;
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
