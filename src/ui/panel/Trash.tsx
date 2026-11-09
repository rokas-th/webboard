import { trashRoots } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import type { Run } from "../run";

export function Trash(p: { view: PlanView; readOnly: boolean; run: Run }) {
  const plan = p.view.plan;
  const roots = trashRoots(plan).map((id) => {
    const it = plan.items.get(id);
    if (it === undefined) throw new Error(`Trash: no item ${id}`);
    return it;
  });
  if (roots.length === 0) return null;
  return (
    <>
      <h2>Trash</h2>
      <div className="links">
        {roots.map((it) => (
          <div key={it.id} className="link-row" data-trashed={it.id}>
            <span className="t">{it.name}</span>
            {!p.readOnly && (
              <button type="button" className="button-small" onClick={() => p.run.run({ t: "restore", items: [it.id] })}>
                Restore
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
