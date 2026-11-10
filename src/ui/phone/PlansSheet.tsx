import { useRef, useState } from "react";
import { normalizeName } from "../../actions/build";
import type { PlanId } from "../../domain/model";
import type { PlanListing, Registry } from "../../store/registry";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { importFlow } from "../shell/fileFlows";
import { failureActions } from "../shell/failure";
import { FILES_STAY } from "../shell/PlanFailed";
import { RELOAD_LABEL, ReloadConfirm } from "../shell/ReloadConfirm";
import { quoted, surfaced } from "../shell/selection";
import { NewPlanButton } from "../shell/Sidebar";

export const NEW_PLAN = "New plan";

export interface PhoneFiles {
  creating: boolean;
  error: string | null;
  importing: boolean;
  newPlan(raw: string): void;
  importPlan(): void;
}

export function usePhoneFiles(registry: Registry, open: (id: PlanId) => void): PhoneFiles {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const creatingRef = useRef(false);
  const newPlan = (raw: string): void => {
    if (creatingRef.current) return;
    let name: string;
    try {
      name = normalizeName(raw);
    } catch (e) {
      setError(surfaced(e));
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    registry
      .createPlan(name)
      .then(
        (id) => open(id),
        (e: unknown) => setError(surfaced(e)),
      )
      .finally(() => {
        creatingRef.current = false;
        setCreating(false);
      });
  };
  const importPlan = (): void => {
    setImporting(true);
    void importFlow(registry, open).finally(() => setImporting(false));
  };
  return { creating, error, importing, newPlan, importPlan };
}

export function ImportButton(p: { files: PhoneFiles }) {
  return (
    <button type="button" disabled={p.files.importing} onClick={p.files.importPlan}>
      {p.files.importing ? <span className="dim">Importing…</span> : "Import plan…"}
    </button>
  );
}

export function CreateError(p: { files: PhoneFiles }) {
  return p.files.error === null ? null : <p className="entry-bad bad">{p.files.error}</p>;
}

function PlanRow(p: {
  registry: Registry;
  listing: PlanListing;
  current: boolean;
  locked: boolean;
  onOpen(id: PlanId): void;
  onTrash(id: PlanId): void;
  onReload(id: PlanId): void;
}) {
  const l = p.listing;
  const failure = p.registry.failures().get(l.id);
  const fa = failure === undefined ? null : failureActions(failure, l.space, p.registry.spaceReadOnly());
  return (
    <li className={p.current ? "entry active" : "entry"}>
      <button type="button" className="entry-open" aria-current={p.current ? "page" : undefined} onClick={() => p.onOpen(l.id)}>
        <span className="entry-name">{l.name ?? "Loading…"}</span>
      </button>
      {failure !== undefined && <p className="entry-bad bad">{failure.message}</p>}
      {fa !== null && fa.filesStay && <p className="failed-note">{FILES_STAY}</p>}
      <div className="entry-actions">
        {fa === null && (
          <button type="button" className="button-small" disabled={p.locked} onClick={() => p.onTrash(l.id)}>
            Move to Trash
          </button>
        )}
        {fa !== null && fa.action === "retry" && (
          <button type="button" className="button-small" onClick={() => void p.registry.retryPlan(l.id)}>
            Try again
          </button>
        )}
        {fa !== null && fa.action === "trash" && (
          <button type="button" className="button-small button-danger" onClick={() => p.onTrash(l.id)}>
            Move to Trash
          </button>
        )}
        {fa !== null && fa.action === "reload" && (
          <button type="button" className="button-small" onClick={() => p.onReload(l.id)}>
            {RELOAD_LABEL}
          </button>
        )}
      </div>
    </li>
  );
}

export function PlansSheet(p: {
  registry: Registry;
  selected: PlanId | null;
  files: PhoneFiles;
  onOpen(id: PlanId): void;
  onTrash(id: PlanId): void;
  onClose(): void;
}) {
  const [name, setName] = useState(NEW_PLAN);
  const [reload, setReload] = useState<PlanId | null>(null);
  const registry = p.registry;
  const plans = registry.plans();
  const readOnly = registry.spaceReadOnly();
  const locked = (l: PlanListing): boolean => l.space !== null && readOnly;
  const live = plans.filter((l) => !l.trashed);
  const trashed = plans.filter((l) => l.trashed);
  const restore = (l: PlanListing): void => {
    try {
      registry.restorePlan(l.id);
    } catch (e) {
      toast(surfaced(e), "bad");
      return;
    }
    toast(`Restored ${quoted(l)} from the Trash.`);
  };
  return (
    <>
      <Sheet open title="Plans" onClose={p.onClose}>
        <nav className="sidebar plans-sheet" aria-label="Plans">
          <div className="sidebar-new plans-new">
            <input type="text" aria-label="Plan name" value={name} onChange={(e) => setName(e.target.value)} />
            <NewPlanButton creating={p.files.creating} onNew={() => p.files.newPlan(name)} />
            <CreateError files={p.files} />
            <ImportButton files={p.files} />
          </div>
          <div className="group-title">Plans</div>
          <ul className="entries">
            {live.map((l) => (
              <PlanRow
                key={l.id}
                registry={registry}
                listing={l}
                current={l.id === p.selected}
                locked={locked(l)}
                onOpen={p.onOpen}
                onTrash={p.onTrash}
                onReload={setReload}
              />
            ))}
          </ul>
          {trashed.length > 0 && (
            <section aria-label="Trash">
              <div className="group-title">Trash</div>
              <ul className="entries">
                {trashed.map((l) => (
                  <li key={l.id} className="entry">
                    <span className="entry-name">{l.name ?? "Loading…"}</span>
                    <div className="entry-actions">
                      <button type="button" className="button-small" disabled={locked(l)} onClick={() => restore(l)}>
                        Restore
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </nav>
      </Sheet>
      {reload !== null && <ReloadConfirm registry={registry} docId={reload} frame="sheet" onClose={() => setReload(null)} />}
    </>
  );
}
