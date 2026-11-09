import type { PlanSession } from "../../store/session";
import { usePlanView } from "../../store/session";

export function Tray(p: { session: PlanSession }) {
  const view = usePlanView(p.session);
  const unscheduled = [...view.plan.items.values()].filter((i) => !i.trashed && i.schedule !== null && i.schedule.start === null);
  return (
    <div className="tray">
      <span className="tray-title">Unscheduled · {unscheduled.length}</span>
      <span className="tray-spacer" />
      <span className="legend">
        <span>
          <i className="lb" />
          task
        </span>
        <span>
          <i className="lm" />
          milestone
        </span>
        <span>
          <i className="ll" />
          late
        </span>
        <span>
          <i className="lc" />
          conflict
        </span>
        <span>
          <i className="lh" />
          held
        </span>
      </span>
    </div>
  );
}
