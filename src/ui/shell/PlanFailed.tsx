import { useState, type Ref } from "react";
import type { PlanId } from "../../domain/model";
import type { AppError } from "../../services/ipc";
import type { Registry } from "../../store/registry";
import { canReload } from "../../sync/reload";
import { useSyncState } from "../../sync/SyncProvider";
import { failureActions } from "./failure";
import { RELOAD_LABEL, ReloadConfirm } from "./ReloadConfirm";

export const FILES_STAY = "The plan’s files stay on this device.";
export const NEEDS_CONNECTION = "Needs a connection to the server.";

export function ReloadButton(p: { enabled: boolean; small?: boolean; buttonRef?: Ref<HTMLButtonElement>; onOpen(): void }) {
  return (
    <span className="reload-gate">
      <button ref={p.buttonRef} type="button" className={p.small === true ? "button-small" : undefined} disabled={!p.enabled} onClick={p.onOpen}>
        {RELOAD_LABEL}
      </button>
      {!p.enabled && <span className="dim">{NEEDS_CONNECTION}</span>}
    </span>
  );
}

export function FailedPlanView(p: {
  registry: Registry;
  id: PlanId;
  error: AppError;
  reloadEnabled: boolean;
  frame: "dialog" | "sheet";
  onRetry(): void;
  onTrash(id: PlanId): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const listing = p.registry.plans().find((l) => l.id === p.id);
  if (listing === undefined) throw new Error(`Plan ${p.id} is not listed`);
  const { action, filesStay } = failureActions(p.error, listing.space, p.registry.spaceReadOnly());
  return (
    <div className="plan-failed">
      <p className="failed-message bad">{p.error.message}</p>
      <div className="failed-actions">
        {action === "retry" && (
          <button type="button" onClick={p.onRetry}>
            Try again
          </button>
        )}
        {action === "trash" && (
          <button type="button" className="button-danger" onClick={() => p.onTrash(p.id)}>
            Move to Trash
          </button>
        )}
        {action === "reload" && <ReloadButton enabled={p.reloadEnabled} onOpen={() => setConfirm(true)} />}
      </div>
      {filesStay && <p className="failed-note">{FILES_STAY}</p>}
      {confirm && (
        <div
          className="reload-confirm"
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Tab") e.stopPropagation();
          }}
        >
          <ReloadConfirm registry={p.registry} docId={p.id} frame={p.frame} onClose={() => setConfirm(false)} />
        </div>
      )}
    </div>
  );
}

export function PlanFailed(p: { registry: Registry; id: PlanId; error: AppError; onTrash(id: PlanId): void }) {
  const reloadEnabled = canReload(useSyncState().state);
  return (
    <FailedPlanView
      registry={p.registry}
      id={p.id}
      error={p.error}
      reloadEnabled={reloadEnabled}
      frame="dialog"
      onRetry={() => void p.registry.retryPlan(p.id)}
      onTrash={p.onTrash}
    />
  );
}
