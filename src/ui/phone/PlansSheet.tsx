import { useState } from "react";
import type { PlanId } from "../../domain/model";
import type { PlanListing, Registry } from "../../store/registry";
import type { SyncState } from "../../sync/manager";
import { canReload } from "../../sync/reload";
import { useSyncState } from "../../sync/SyncProvider";
import { Sheet } from "../common/Sheet";
import { FailedPlanView } from "../shell/PlanFailed";
import { restorePlan, type PlanFiles } from "../shell/selection";
import { EntryTag, LocalLine } from "../shell/LocalLine";
import { canMoveToSpace } from "../shell/moving";
import { NewPlanButton } from "../shell/Sidebar";
import { useUiValue, type SyncPane } from "../state";

export const NEW_PLAN = "New plan";

export function ImportButton(p: { files: PlanFiles }) {
  return (
    <button type="button" disabled={p.files.importing} onClick={p.files.importPlan}>
      {p.files.importing ? <span className="dim">Importing…</span> : "Import plan…"}
    </button>
  );
}

export function SettingsRow(p: { onClose(): void }) {
  const { setUi } = useUiValue();
  return (
    <button
      type="button"
      className="choice-row settings-row"
      onClick={() => {
        setUi({ settings: "theme" });
        p.onClose();
      }}
    >
      Settings…
    </button>
  );
}

export function CreateError(p: { error: string | null }) {
  return p.error === null ? null : <p className="entry-bad bad">{p.error}</p>;
}

function PlanRow(p: {
  registry: Registry;
  listing: PlanListing;
  current: boolean;
  locked: boolean;
  tagged: boolean;
  reloadEnabled: boolean;
  onOpen(id: PlanId): void;
  onTrash(id: PlanId): void;
}) {
  const l = p.listing;
  const failure = p.registry.failures().get(l.id);
  return (
    <li className={p.current ? "entry active" : "entry"}>
      <button type="button" className="entry-open" aria-current={p.current ? "page" : undefined} onClick={() => p.onOpen(l.id)}>
        <span className="entry-name">{l.name ?? "Loading…"}</span>
        <EntryTag listing={l} shown={p.tagged} />
      </button>
      {failure === undefined ? (
        <div className="entry-actions">
          <button type="button" className="button-small" disabled={p.locked} onClick={() => p.onTrash(l.id)}>
            Move to Trash
          </button>
        </div>
      ) : (
        <FailedPlanView
          registry={p.registry}
          id={l.id}
          error={failure}
          reloadEnabled={p.reloadEnabled}
          frame="sheet"
          onRetry={() => void p.registry.retryPlan(l.id)}
          onTrash={p.onTrash}
        />
      )}
    </li>
  );
}

function SyncRows(p: { state: SyncState; onSync(pane: SyncPane): void }) {
  const s = p.state;
  const out = s.kind === "off" || (s.kind === "error" && s.code === "revoked");
  const join = out || (s.kind === "error" && s.code === "unauthorized");
  if (!join) return null;
  return (
    <div className="plans-sync">
      {out && (
        <button type="button" className="choice-row" onClick={() => p.onSync("setup")}>
          Set up sync
        </button>
      )}
      <button type="button" className="choice-row" onClick={() => p.onSync("join")}>
        Join with a code
      </button>
    </div>
  );
}

export function PlansSheet(p: {
  registry: Registry;
  selected: PlanId | null;
  files: PlanFiles;
  error: string | null;
  onNew(name: string): void;
  onOpen(id: PlanId): void;
  onTrash(id: PlanId): void;
  onPurge(id: PlanId): void;
  onMoveAll(ids: readonly PlanId[]): void;
  onSync(pane: SyncPane): void;
  onClose(): void;
}) {
  const { state } = useSyncState();
  const [name, setName] = useState(NEW_PLAN);
  const registry = p.registry;
  const plans = registry.plans();
  const readOnly = registry.spaceReadOnly();
  const locked = (l: PlanListing): boolean => l.space !== null && readOnly;
  const canMove = canMoveToSpace(registry, state);
  const live = plans.filter((l) => !l.trashed);
  const trashed = plans.filter((l) => l.trashed);
  return (
    <Sheet open title="Plans" onClose={p.onClose}>
      <nav className="sidebar plans-sheet" aria-label="Plans">
        <div className="sidebar-new plans-new">
          <input type="text" aria-label="Plan name" value={name} onChange={(e) => setName(e.target.value)} />
          <NewPlanButton creating={p.files.creating} onNew={() => p.onNew(name)} />
          <CreateError error={p.error} />
          <ImportButton files={p.files} />
        </div>
        <SyncRows state={state} onSync={p.onSync} />
        <div className="group-title">Plans</div>
        <ul className="entries">
          {live.map((l) => (
            <PlanRow
              key={l.id}
              registry={registry}
              listing={l}
              current={l.id === p.selected}
              locked={locked(l)}
              tagged={canMove}
              reloadEnabled={canReload(state)}
              onOpen={p.onOpen}
              onTrash={p.onTrash}
            />
          ))}
        </ul>
        <LocalLine plans={plans} shown={canMove} onMoveAll={p.onMoveAll} />
        {trashed.length > 0 && (
          <section aria-label="Trash">
            <div className="group-title">Trash</div>
            <ul className="entries">
              {trashed.map((l) => (
                <li key={l.id} className="entry">
                  <span className="entry-name">{l.name ?? "Loading…"}</span>
                  <div className="entry-actions">
                    <button type="button" className="button-small" disabled={locked(l)} onClick={() => restorePlan(registry, l.id)}>
                      Restore
                    </button>
                    <button type="button" className="button-small button-danger" disabled={locked(l)} onClick={() => p.onPurge(l.id)}>
                      Delete forever
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        <SettingsRow onClose={p.onClose} />
      </nav>
    </Sheet>
  );
}
