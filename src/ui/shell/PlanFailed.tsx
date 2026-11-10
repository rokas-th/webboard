import { useState } from "react";
import type { PlanId } from "../../domain/model";
import type { AppError } from "../../services/ipc";
import type { Registry } from "../../store/registry";
import { canReload } from "../../sync/reload";
import { useSyncState } from "../../sync/SyncProvider";
import { RELOAD_LABEL, ReloadConfirm } from "./ReloadConfirm";

export const FILES_STAY = "The plan’s files stay on this device.";
export const NEEDS_CONNECTION = "Needs a connection to the server.";

export function ReloadButton(p: { small?: boolean; onOpen(): void }) {
  const { state } = useSyncState();
  const ok = canReload(state);
  return (
    <span className="reload-gate">
      <button type="button" className={p.small === true ? "button-small" : undefined} disabled={!ok} onClick={p.onOpen}>
        {RELOAD_LABEL}
      </button>
      {!ok && <span className="dim">{NEEDS_CONNECTION}</span>}
    </span>
  );
}

export function PlanFailed(p: { registry: Registry; id: PlanId; error: AppError; onTrash(id: PlanId): void }) {
  useSyncState();
  const [confirm, setConfirm] = useState(false);
  const listing = p.registry.plans().find((l) => l.id === p.id);
  if (listing === undefined) throw new Error(`Plan ${p.id} is not listed`);
  const space = listing.space;
  const corrupt = p.error.code === "store.corrupt";
  const readOnly = p.registry.spaceReadOnly();
  return (
    <div className="plan-failed">
      <p className="failed-message bad">{p.error.message}</p>
      <div className="failed-actions">
        {!corrupt && (
          <button type="button" onClick={() => void p.registry.retryPlan(p.id)}>
            Try again
          </button>
        )}
        {corrupt && space === null && (
          <button type="button" className="button-danger" onClick={() => p.onTrash(p.id)}>
            Move to Trash
          </button>
        )}
        {corrupt && space !== null && !readOnly && <ReloadButton onOpen={() => setConfirm(true)} />}
      </div>
      {corrupt && (space === null || readOnly) && <p className="failed-note">{FILES_STAY}</p>}
      {confirm && <ReloadConfirm registry={p.registry} docId={p.id} onClose={() => setConfirm(false)} />}
    </div>
  );
}
