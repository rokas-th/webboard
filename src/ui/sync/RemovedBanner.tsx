import { AppError } from "../../services/ipc";
import type { PlanSession } from "../../store/session";
import { useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { toast } from "../common/Toast";
import { exportFlow } from "../shell/fileFlows";
import { useUiValue } from "../state";

export const REMOVED_TEXT = "This device was removed from the space. Its plans are read-only. Export saves changes the server never received.";

export function RemovedBanner(p: { session: PlanSession | null }) {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const { setUi } = useUiValue();
  if (state.kind !== "error" || state.code !== "revoked") return null;
  const session = p.session;
  const id = session === null ? null : session.view().plan.id;
  const space = id === null ? null : (registry.plans().find((l) => l.id === id)?.space ?? null);
  const exportOpen = (): void => {
    if (session === null) throw new Error("Export needs an open plan");
    exportFlow(session).catch((e: unknown) => {
      if (!(e instanceof AppError)) throw e;
      toast(e.message, "bad");
    });
  };
  return (
    <div className="banner bad removed-banner">
      <span className="banner-text">{REMOVED_TEXT}</span>
      {space !== null && (
        <button type="button" className="button-small" onClick={exportOpen}>
          Export…
        </button>
      )}
      <button type="button" className="button-small" onClick={() => setUi({ dialog: { t: "sync", pane: "join" } })}>
        Join with a code
      </button>
      <button type="button" className="button-small" onClick={() => setUi({ dialog: { t: "sync", pane: "setup" } })}>
        Set up sync
      </button>
    </div>
  );
}
