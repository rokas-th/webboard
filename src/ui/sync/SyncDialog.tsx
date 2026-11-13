import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AppError, syncReset } from "../../services/ipc";
import { SPACE_PREFIX } from "../../store/plan-id";
import { chipText, holdsPlan, type SyncState } from "../../sync/manager";
import { canReload, syncActions } from "../../sync/reload";
import { useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { Dialog, focusables } from "../common/Dialog";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { ReloadButton } from "../shell/PlanFailed";
import { exportFlow } from "../shell/fileFlows";
import { RELOAD_LABEL, ReloadConfirmBody } from "../shell/ReloadConfirm";
import type { SyncPane } from "../state";
import { DevicesPane } from "./DevicesPane";
import { JoinPane } from "./JoinPane";
import { PairPane } from "./PairPane";
import { SetupPane } from "./SetupPane";

export const PANE_LABELS: Record<SyncPane, string> = {
  setup: "Set up sync",
  join: "Join with a code",
  pair: "Add a device",
  devices: "Devices",
};

export const PANE_ORDER: readonly SyncPane[] = ["setup", "join", "pair", "devices"];

export function resolvePane(state: SyncState, pane: SyncPane | null): SyncPane {
  if (pane !== null) return pane;
  if (state.kind === "off") return "setup";
  if (state.kind === "error" && (state.code === "unauthorized" || state.code === "revoked" || (state.code === "local-failed" && state.doc === null))) return "join";
  return "devices";
}

export const syncMessage = (state: SyncState, name: (doc: string) => string | null): string => (state.kind === "error" && state.message !== null ? state.message : chipText(state, name));

export function SyncActionButtons(p: { holds: boolean; small?: boolean; onReset?(): void; children?: ReactNode }) {
  const { state, restart } = useSyncState();
  const registry = useSyncRegistry();
  const [resetError, setResetError] = useState<string | null>(null);
  const actions = syncActions(state, p.holds);
  const doc = state.kind === "error" ? state.doc : null;
  const exportPlan = (): void => {
    if (doc === null) throw new Error("Export needs a plan doc");
    registry
      .session(doc)
      .then((session) => exportFlow(session))
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
  const small = p.small === true ? "button-small" : undefined;
  if (actions.length === 0 && p.children === undefined) return null;
  return (
    <>
      <div className="sync-buttons">
        {actions.map((a) => {
          if (a === "export")
            return (
              <button key={a} type="button" className={small} onClick={exportPlan}>
                Export…
              </button>
            );
          if (a === "reset")
            return (
              <button key={a} type="button" className={small === undefined ? "button-danger" : "button-danger button-small"} onClick={reset}>
                Reset sync
              </button>
            );
          return (
            <button key={a} type="button" className={small} onClick={() => void restart()}>
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

function IndexActions(p: { cause: string | null; reloadRef: RefObject<HTMLButtonElement | null>; onReload(doc: string): void }) {
  const registry = useSyncRegistry();
  const enabled = canReload(useSyncState().state);
  const doc = registry.indexErrorDoc();
  const reloadable = p.cause === "store.corrupt" && doc !== null && !registry.spaceReadOnly();
  return (
    <>
      <div className="sync-buttons">
        <button type="button" onClick={() => void registry.retryIndex()}>
          Try again
        </button>
      </div>
      {reloadable && <ReloadButton enabled={enabled} buttonRef={p.reloadRef} onOpen={() => p.onReload(doc)} />}
    </>
  );
}

export function SyncDialog(p: { pane: SyncPane | null; frame?: "dialog" | "sheet"; onPane(pane: SyncPane): void; onClose(): void }) {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const [opened] = useState(() => resolvePane(state, null));
  const [confirm, setConfirm] = useState<string | null>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const confirming = useRef(false);
  useEffect(() => {
    if (confirm !== null) {
      confirming.current = true;
      const root = confirmRef.current;
      if (root === null) throw new Error("Reload confirmation rendered without its element");
      const [first] = focusables(root);
      if (first === undefined) throw new Error("Reload confirmation has nothing to focus");
      first.focus();
      return;
    }
    if (!confirming.current) return;
    confirming.current = false;
    const pane = paneRef.current;
    if (pane === null) throw new Error("Sync rendered without its pane");
    const reload = reloadRef.current;
    const target = reload !== null && !reload.disabled ? reload : focusables(pane)[0];
    if (target === undefined) throw new Error("Sync pane has nothing to focus");
    target.focus();
  }, [confirm]);
  const pane = p.pane ?? opened;
  const error = state.kind === "error" ? state : null;
  const indexDoc = error !== null && error.code === "local-failed" && error.doc !== null && error.doc.startsWith(SPACE_PREFIX);
  const holds = error !== null && error.doc !== null && !error.doc.startsWith(SPACE_PREFIX) && holdsPlan(registry, error.doc);
  const body = (
    <>
      {error !== null && (
        <div className="sync-status">
          {error.message !== null && <p className="sync-message bad">{error.message}</p>}
          {indexDoc ? <IndexActions cause={error.cause} reloadRef={reloadRef} onReload={setConfirm} /> : <SyncActionButtons holds={holds} onReset={() => p.onPane("join")} />}
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
    </>
  );
  const cancel = (): void => setConfirm(null);
  const label = confirm === null ? "Sync" : RELOAD_LABEL;
  const onClose = confirm === null ? p.onClose : cancel;
  if (p.frame === "sheet") {
    return (
      <Sheet open title={label} onClose={onClose}>
        {confirm !== null && (
          <div ref={confirmRef} className="reload-sheet">
            <ReloadConfirmBody registry={registry} docId={confirm} onClose={cancel} />
          </div>
        )}
        <div ref={paneRef} className="sync-sheet" hidden={confirm !== null}>
          {body}
        </div>
      </Sheet>
    );
  }
  return (
    <Dialog label={label} wide onClose={onClose}>
      {confirm !== null && (
        <div ref={confirmRef}>
          <ReloadConfirmBody registry={registry} docId={confirm} onClose={cancel} />
        </div>
      )}
      <div ref={paneRef} hidden={confirm !== null}>
        {body}
      </div>
    </Dialog>
  );
}
