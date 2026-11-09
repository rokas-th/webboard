import type { PlanId } from "../../domain/model";
import type { PlanListing, Registry } from "../../store/registry";

export function NewPlanButton(p: { creating: boolean; onNew(): void }) {
  return (
    <button type="button" className="button-primary new-plan" disabled={p.creating} onClick={p.onNew}>
      {p.creating ? <span className="dim">Creating…</span> : "New plan"}
    </button>
  );
}

interface SidebarProps {
  registry: Registry;
  plans: readonly PlanListing[];
  selected: PlanId | null;
  creating: boolean;
  onNew(): void;
  onSelect(id: PlanId): void;
  onTrash(id: PlanId): void;
  onRestore(id: PlanId): void;
}

export function Sidebar(p: SidebarProps) {
  const failures = p.registry.failures();
  const readOnly = p.registry.spaceReadOnly();
  const locked = (l: PlanListing): boolean => l.space !== null && readOnly;
  const live = p.plans.filter((l) => !l.trashed);
  const trashed = p.plans.filter((l) => l.trashed);
  return (
    <nav className="sidebar" aria-label="Plans">
      <div className="sidebar-new">
        <NewPlanButton creating={p.creating} onNew={p.onNew} />
      </div>
      <div className="group-title">Plans</div>
      <ul className="entries">
        {live.map((l) => {
          const failure = failures.get(l.id);
          const shown = failure !== undefined && !(l.id === p.selected && l.loaded);
          return (
            <li key={l.id} className={l.id === p.selected ? "entry active" : "entry"}>
              <button type="button" className="entry-open" aria-current={l.id === p.selected ? "page" : undefined} onClick={() => p.onSelect(l.id)}>
                <span className="entry-name">{l.name ?? "Loading…"}</span>
              </button>
              {shown && <p className="entry-bad">{failure.message}</p>}
              <div className="entry-actions">
                {shown && l.loaded && (
                  <button type="button" className="button-small" onClick={() => void p.registry.retryPlan(l.id)}>
                    Try again
                  </button>
                )}
                <button type="button" className="button-small" disabled={locked(l)} onClick={() => p.onTrash(l.id)}>
                  Move to Trash
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {trashed.length > 0 && (
        <section aria-label="Trash">
          <div className="group-title">Trash</div>
          <ul className="entries">
            {trashed.map((l) => (
              <li key={l.id} className="entry">
                <span className="entry-name">{l.name ?? "Loading…"}</span>
                <div className="entry-actions">
                  <button type="button" className="button-small" disabled={locked(l)} onClick={() => p.onRestore(l.id)}>
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
