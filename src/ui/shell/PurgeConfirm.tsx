import { useRef, useState, type ReactNode } from "react";
import { Refused } from "../../actions/intents";
import type { PlanId } from "../../domain/model";
import { CANCEL_LABEL, usesNativeAlert, type NativeAsk } from "../../services/alert";
import { AppError } from "../../services/ipc";
import type { PlanListing, Registry } from "../../store/registry";
import type { SyncManager } from "../../sync/manager";
import { useSyncState } from "../../sync/SyncProvider";
import { Dialog } from "../common/Dialog";
import { NativeConfirm } from "../common/NativeConfirm";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { capital, quoted } from "./selection";

export const purgeLabel = (l: PlanListing): string => `Delete ${quoted(l)} forever?`;

export const PURGE_CONFIRM = "Delete forever";

export function purgeText(l: PlanListing): string {
  const name = capital(quoted(l));
  return l.space === null
    ? `${name} is erased from this device. This cannot be undone.`
    : `${name} and its whole history are erased from the server and from every device in the space. This cannot be undone.`;
}

export function purgeAsk(l: PlanListing, refusal: string | null): NativeAsk {
  if (refusal !== null) return { title: purgeLabel(l), message: refusal, confirm: null, cancel: "OK" };
  return { title: purgeLabel(l), message: purgeText(l), confirm: { label: PURGE_CONFIRM, destructive: true }, cancel: CANCEL_LABEL };
}

async function purgeNow(registry: Registry, listing: PlanListing, manager: SyncManager, close: () => void): Promise<void> {
  try {
    await registry.purgePlan(listing.id, manager.capRefused(listing.id));
  } catch (e) {
    if (!(e instanceof AppError || e instanceof Refused)) throw e;
    if (e instanceof AppError && e.code === "sync.revoked") void manager.markRevoked();
    const left = !registry.plans().some((l) => l.id === listing.id);
    if (left || (e instanceof AppError && e.code === "sync.purge_pending")) close();
    toast(e.message, "bad");
    return;
  }
  close();
  toast(`Deleted ${quoted(listing)} forever.`);
  if (listing.space !== null) manager.retryCapped();
}

function PurgeConfirmBody(p: { registry: Registry; listing: PlanListing; refusal: string | null; onClose(): void }) {
  const { manager } = useSyncState();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const settle = (): void => {
    pendingRef.current = false;
    setPending(false);
  };
  const purge = (): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    void purgeNow(p.registry, p.listing, manager, () => {
      settle();
      p.onClose();
    }).then(settle, (e: unknown) => {
      settle();
      throw e;
    });
  };
  return (
    <>
      <p>{p.refusal ?? purgeText(p.listing)}</p>
      <div className="modal-actions">
        <button type="button" onClick={p.onClose}>
          {CANCEL_LABEL}
        </button>
        {p.refusal === null && (
          <button type="button" className="button-danger" disabled={pending} onClick={purge}>
            {PURGE_CONFIRM}
          </button>
        )}
      </div>
    </>
  );
}

function NativePurge(p: { registry: Registry; listing: PlanListing; refusal: string | null; onClose(): void }) {
  const { manager } = useSyncState();
  return <NativeConfirm ask={purgeAsk(p.listing, p.refusal)} run={() => purgeNow(p.registry, p.listing, manager, p.onClose)} onClose={p.onClose} />;
}

export function PurgeConfirm(p: { registry: Registry; id: PlanId; frame?: "dialog" | "sheet"; onClose(): void }) {
  const listing = p.registry.plans().find((l) => l.id === p.id);
  if (listing === undefined) return null;
  const refusal = p.registry.purgeRefusal(p.id);
  if (usesNativeAlert()) return <NativePurge registry={p.registry} listing={listing} refusal={refusal} onClose={p.onClose} />;
  const body: ReactNode = <PurgeConfirmBody registry={p.registry} listing={listing} refusal={refusal} onClose={p.onClose} />;
  if (p.frame === "sheet") {
    return (
      <Sheet open title={purgeLabel(listing)} onClose={p.onClose}>
        <div className="reload-sheet">{body}</div>
      </Sheet>
    );
  }
  return (
    <Dialog label={purgeLabel(listing)} onClose={p.onClose}>
      {body}
    </Dialog>
  );
}
