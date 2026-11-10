import { useRef, useState, type ReactNode } from "react";
import { Refused } from "../../actions/intents";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import type { PlanListing, Registry } from "../../store/registry";
import { useSyncState } from "../../sync/SyncProvider";
import { Dialog } from "../common/Dialog";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { capital, quoted } from "./selection";

export const purgeLabel = (l: PlanListing): string => `Delete ${quoted(l)} forever?`;

export function purgeText(l: PlanListing): string {
  const name = capital(quoted(l));
  return l.space === null
    ? `${name} is erased from this device. This cannot be undone.`
    : `${name} and its whole history are erased from the server and from every device in the space. This cannot be undone.`;
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
    p.registry.purgePlan(p.listing.id, manager.capRefused(p.listing.id)).then(
      () => {
        settle();
        p.onClose();
        toast(`Deleted ${quoted(p.listing)} forever.`);
        if (p.listing.space !== null) manager.retryCapped();
      },
      (e: unknown) => {
        settle();
        if (!(e instanceof AppError || e instanceof Refused)) throw e;
        if (e instanceof AppError && e.code === "sync.revoked") void manager.markRevoked();
        const left = !p.registry.plans().some((l) => l.id === p.listing.id);
        if (left || (e instanceof AppError && e.code === "sync.purge_pending")) p.onClose();
        toast(e.message, "bad");
      },
    );
  };
  return (
    <>
      <p>{p.refusal ?? purgeText(p.listing)}</p>
      <div className="modal-actions">
        <button type="button" onClick={p.onClose}>
          Cancel
        </button>
        {p.refusal === null && (
          <button type="button" className="button-danger" disabled={pending} onClick={purge}>
            Delete forever
          </button>
        )}
      </div>
    </>
  );
}

export function PurgeConfirm(p: { registry: Registry; id: PlanId; frame?: "dialog" | "sheet"; onClose(): void }) {
  const listing = p.registry.plans().find((l) => l.id === p.id);
  if (listing === undefined) return null;
  const body: ReactNode = <PurgeConfirmBody registry={p.registry} listing={listing} refusal={p.registry.purgeRefusal(p.id)} onClose={p.onClose} />;
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
