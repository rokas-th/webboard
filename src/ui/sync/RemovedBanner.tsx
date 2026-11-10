import type { PlanId } from "../../domain/model";
import type { PlanListing, Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { exportFlow } from "../shell/fileFlows";
import { useUiValue } from "../state";

export const REMOVED_TEXT = "This device was removed from the space. Its plans are read-only. Export saves changes the server never received.";

function listingOf(registry: Registry, id: PlanId): PlanListing {
  const listing = registry.plans().find((l) => l.id === id);
  if (listing === undefined) throw new Error(`Plan ${id} is not listed`);
  return listing;
}

export function RemovedBanner(p: { session: PlanSession | null }) {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const { setUi } = useUiValue();
  if (state.kind !== "error" || state.code !== "revoked") return null;
  const session = p.session;
  const space = session === null ? null : listingOf(registry, session.view().plan.id).space;
  const exportOpen = (): void => {
    if (session === null) throw new Error("Export needs an open plan");
    void exportFlow(session, registry.device.platform);
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
