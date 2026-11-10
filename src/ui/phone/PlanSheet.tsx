import { useEffect, useReducer } from "react";
import { normalizeName } from "../../actions/build";
import { Refused } from "../../actions/intents";
import type { Clock } from "../../services/clock";
import type { Registry } from "../../store/registry";
import { usePlanView, type PlanSession } from "../../store/session";
import { chipText } from "../../sync/manager";
import { docName, useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { CalendarBody, type CalendarReview } from "../calendar/CalendarDialog";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { Baselines } from "../panel/Baselines";
import { calendarSummary } from "../panel/calendarText";
import { History } from "../panel/History";
import { TextField } from "../panel/TextField";
import { Trash } from "../panel/Trash";
import { useRun } from "../run";
import { exportFlow } from "../shell/fileFlows";
import type { PlanFiles } from "../shell/selection";
import { useUiValue } from "../state";
import { AboutRow, ImportButton } from "./PlansSheet";
import { useReadOnly } from "./readOnly";

export function CalendarSheet(p: { session: PlanSession; registry: Registry; clock: Clock; review?: CalendarReview; onClose(): void }) {
  return (
    <Sheet open title="Calendar" onClose={p.onClose}>
      <div className="calendar-sheet">
        <CalendarBody session={p.session} registry={p.registry} clock={p.clock} review={p.review} frame="sheet" onClose={p.onClose} />
      </div>
    </Sheet>
  );
}

function SyncSection(p: { session: PlanSession }) {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const { setUi } = useUiValue();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => registry.subscribe(bump), [registry]);
  const id = p.session.view().plan.id;
  const listing = registry.plans().find((l) => l.id === id);
  const movable =
    listing !== undefined &&
    listing.space === null &&
    registry.attachedSpace() !== null &&
    !registry.spaceReadOnly() &&
    state.kind !== "off" &&
    !(state.kind === "error" && state.code === "local-failed");
  const move = (): void => {
    try {
      registry.movePlanToSpace(id);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      toast(e.message, "bad");
      return;
    }
    toast("Moved to the space");
  };
  return (
    <>
      <h2>Sync</h2>
      <button type="button" className="choice-row sync-row" onClick={() => setUi({ dialog: { t: "sync", pane: null } })}>
        <span className="sync-row-label">Sync</span> <span className="sync-row-state">{chipText(state, docName(registry))}</span>
      </button>
      {movable && (
        <div className="actions">
          <button type="button" className="button-small" onClick={move}>
            Move to space
          </button>
        </div>
      )}
    </>
  );
}

export function PlanSheet(p: { session: PlanSession; files: PlanFiles; onClose(): void }) {
  const view = usePlanView(p.session);
  const readOnly = useReadOnly(p.session);
  const run = useRun(p.session);
  const registry = useSyncRegistry();
  const { setUi } = useUiValue();
  const plan = view.plan;
  const rename = (next: string): boolean => {
    let name: string;
    try {
      name = normalizeName(next);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      toast(e.message, "bad");
      return false;
    }
    if (name === plan.name) return false;
    return run.run({ t: "planName", name }) !== null;
  };
  return (
    <Sheet open title="Plan" onClose={p.onClose}>
      <div className="panel plan-sheet">
        <TextField className="title-input" label="Plan name" value={plan.name} readOnly={readOnly} onCommit={rename} />
        <History session={p.session} readOnly={readOnly} />
        <Trash view={view} readOnly={readOnly} run={run} />
        <Baselines view={view} readOnly={readOnly} run={run} />
        <h2>Calendar</h2>
        <p className="val-line">{calendarSummary(plan.calendar)}</p>
        <div className="actions">
          <button type="button" className="button-small" onClick={() => setUi({ dialog: { t: "calendar" } })}>
            Change calendar…
          </button>
        </div>
        <SyncSection session={p.session} />
        <h2>File</h2>
        <div className="actions">
          <button type="button" className="button-small" onClick={() => void exportFlow(p.session, registry.device.platform)}>
            Export plan…
          </button>
          <ImportButton files={p.files} />
        </div>
        <AboutRow onAbout={() => setUi({ dialog: { t: "about" } })} />
      </div>
    </Sheet>
  );
}
