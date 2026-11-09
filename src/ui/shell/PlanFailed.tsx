import { useState } from "react";
import type { PlanId } from "../../domain/model";
import type { AppError } from "../../services/ipc";
import type { Registry } from "../../store/registry";
import { RELOAD_LABEL, ReloadConfirm } from "./ReloadConfirm";

export const FILES_STAY = "The plan’s files stay on this device.";

export function PlanFailed(p: { registry: Registry; id: PlanId; error: AppError; onTrash(id: PlanId): void }) {
  const [confirm, setConfirm] = useState(false);
  const listing = p.registry.plans().find((l) => l.id === p.id);
  const space = listing?.space ?? null;
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
        {corrupt && space !== null && !readOnly && (
          <button type="button" onClick={() => setConfirm(true)}>
            {RELOAD_LABEL}
          </button>
        )}
      </div>
      {corrupt && (space === null || readOnly) && <p className="failed-note">{FILES_STAY}</p>}
      {confirm && <ReloadConfirm registry={p.registry} docId={p.id} onClose={() => setConfirm(false)} />}
    </div>
  );
}
