import { goneSet } from "../../domain/derive";
import { usePlanView, type PlanSession } from "../../store/session";
import { useRun } from "../run";
import { derivedStatus } from "../status";
import { useUiValue } from "../state";
import { Baselines } from "./Baselines";
import { calendarSummary } from "./calendarText";
import { History } from "./History";
import { TextField } from "./TextField";
import { Trash } from "./Trash";

function Stat(p: { k: string; v: number; tone?: "amber" | "magenta" }) {
  return (
    <>
      <span className="k">{p.k}</span>
      <span className={p.tone !== undefined && p.v > 0 ? `v ${p.tone}` : "v"} data-stat={p.k}>
        {p.v}
      </span>
    </>
  );
}

export function PlanPanel(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  const { setUi } = useUiValue();
  const plan = view.plan;
  const gone = goneSet(plan);
  const items = [...plan.items.values()].filter((i) => i.kind !== "group" && !gone.has(i.id));
  const done = items.filter((i) => derivedStatus(view, i.id, "PlanPanel") === "done").length;
  const unscheduled = items.filter((i) => i.schedule !== null && i.schedule.start === null).length;
  const late = items.filter((i) => view.derived.late.has(i.id)).length;
  const conflicts = view.derived.conflicts.filter((c) => c.kind !== "dayoff").length;
  return (
    <div className="panel">
      <h2>Plan</h2>
      <TextField className="title-input" label="Plan name" value={plan.name} readOnly={p.readOnly} onCommit={(next) => run.run({ t: "planName", name: next }) !== null} />
      <div className="stat">
        <Stat k="Items" v={items.length} />
        <Stat k="Done" v={done} />
        <Stat k="Unscheduled" v={unscheduled} />
        <Stat k="Late" v={late} tone="amber" />
        <Stat k="Held" v={view.held.size} tone="amber" />
        <Stat k="Conflicts" v={conflicts} tone="magenta" />
      </div>
      <h2>Calendar</h2>
      <p className="val-line">{calendarSummary(plan.calendar)}</p>
      {!p.readOnly && (
        <div className="actions">
          <button type="button" className="button-small" onClick={() => setUi({ dialog: { t: "calendar" } })}>
            Change calendar…
          </button>
        </div>
      )}
      <Baselines view={view} readOnly={p.readOnly} run={run} />
      <Trash view={view} readOnly={p.readOnly} run={run} />
      <History session={p.session} readOnly={p.readOnly} />
    </div>
  );
}
