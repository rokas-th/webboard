import { useState, type ReactNode } from "react";
import { AppError, syncReset } from "../../services/ipc";
import { chipText, holdsPlan, type SyncState } from "../../sync/manager";
import { canReload, syncActions } from "../../sync/reload";
import { useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { Dialog } from "../common/Dialog";
import { toast } from "../common/Toast";
import { ReloadButton } from "../shell/PlanFailed";
import { exportFlow } from "../shell/fileFlows";
import { ReloadConfirm } from "../shell/ReloadConfirm";
import type { SyncPane } from "../state";
import { DevicesPane } from "./DevicesPane";
import { JoinPane } from "./JoinPane";
import { PairPane } from "./PairPane";
import { SetupPane } from "./SetupPane";

const PANE_LABELS: Record<SyncPane, string> = {
  setup: "Set up sync",
  join: "Join with a code",
  pair: "Add a device",
  devices: "Devices",
};

const PANE_ORDER: readonly SyncPane[] = ["setup", "join", "pair", "devices"];

export function resolvePane(state: SyncState, pane: SyncPane | null): SyncPane {
  if (pane !== null) return pane;
  if (state.kind === "off") return "setup";
  if (state.kind === "error" && (state.code === "unauthorized" || state.code === "revoked" || (state.code === "local-failed" && state.doc === null))) return "join";
  return "devices";
}

export const syncMessage = (state: SyncState, name: (doc: string) => string | null): string => (state.kind === "error" && state.message !== null ? state.message : chipText(state, name));

export function SyncActionButtons(p: { holds: boolean; onReset?(): void; children?: ReactNode }) {
  const { state, restart } = useSyncState();
  const registry = useSyncRegistry();
  const [resetError, setResetError] = useState<string | null>(null);
  const actions = syncActions(state, p.holds);
  const doc = state.kind === "error" ? state.doc : null;
  const exportPlan = (): void => {
    if (doc === null) throw new Error("Export needs a plan doc");
    registry
      .session(doc)
      .then(exportFlow)
      .catch((e: unknown) => {
        if (!(e instanceof AppError)) throw e;
        toast(e.message, "bad");
      });
  };
  const reset = (): void => {
    setResetError(null);
    syncReset().then(
      async () => {
        await restart();
        p.onReset?.();
      },
      (e: unknown) => {
        if (!(e instanceof AppError)) throw e;
        setResetError(e.message);
      },
    );
  };
  if (actions.length === 0 && p.children === undefined) return null;
  return (
    <>
      <div className="sync-buttons">
        {actions.map((a) => {
          if (a === "export")
            return (
              <button key={a} type="button" onClick={exportPlan}>
                Export…
              </button>
            );
          if (a === "reset")
            return (
              <button key={a} type="button" className="button-danger" onClick={reset}>
                Reset sync
              </button>
            );
          return (
            <button key={a} type="button" onClick={() => void restart()}>
              Try again
            </button>
          );
        })}
        {p.children}
      </div>
      {resetError !== null && <p className="sync-error bad">{resetError}</p>}
    </>
  );
}

function IndexActions(p: { cause: string | null }) {
  const registry = useSyncRegistry();
  const enabled = canReload(useSyncState().state);
  const [confirm, setConfirm] = useState<string | null>(null);
  const doc = registry.indexErrorDoc();
  const reloadable = p.cause === "store.corrupt" && doc !== null && !registry.spaceReadOnly();
  return (
    <>
      <div className="sync-buttons">
        <button type="button" onClick={() => void registry.retryIndex()}>
          Try again
        </button>
      </div>
      {reloadable && <ReloadButton enabled={enabled} onOpen={() => setConfirm(doc)} />}
      {confirm !== null && <ReloadConfirm registry={registry} docId={confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

export function SyncDialog(p: { pane: SyncPane | null; onPane(pane: SyncPane): void; onClose(): void }) {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const [opened] = useState(() => resolvePane(state, null));
  const pane = p.pane ?? opened;
  const error = state.kind === "error" ? state : null;
  const indexDoc = error !== null && error.code === "local-failed" && error.doc !== null && error.doc.startsWith("ix-");
  const holds = error !== null && error.doc !== null && !error.doc.startsWith("ix-") && holdsPlan(registry, error.doc);
  return (
    <Dialog label="Sync" wide onClose={p.onClose}>
      {error !== null && (
        <div className="sync-status">
          {error.message !== null && <p className="sync-message bad">{error.message}</p>}
          {indexDoc ? <IndexActions cause={error.cause} /> : <SyncActionButtons holds={holds} onReset={() => p.onPane("join")} />}
        </div>
      )}
      <div className="sync-tabs" role="tablist" aria-label="Sync">
        {PANE_ORDER.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={pane === k} className={pane === k ? "active" : undefined} onClick={() => p.onPane(k)}>
            {PANE_LABELS[k]}
          </button>
        ))}
      </div>
      <section className="sync-pane" role="tabpanel" aria-label={PANE_LABELS[pane]}>
        {pane === "setup" && <SetupPane />}
        {pane === "join" && <JoinPane />}
        {pane === "pair" && <PairPane />}
        {pane === "devices" && <DevicesPane />}
      </section>
    </Dialog>
  );
}
