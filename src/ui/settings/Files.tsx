import { useId } from "react";
import { q } from "../../actions/copy";
import type { Clock } from "../../services/clock";
import { usePlanView, type PlanSession } from "../../store/session";
import { meFor } from "../device";
import { useDevice } from "../DeviceProvider";
import { ImportButton } from "../phone/PlansSheet";
import { exportFlow, exportIcsFlow, exportListCsvFlow } from "../shell/fileFlows";
import type { PlanFiles } from "../shell/selection";
import { Row } from "./Row";
import { FILES_LABELS } from "./sections";

const SECTION = "files";

export const NO_PLAN_EXPORT = "Open a plan to export it.";
export const NO_PLAN_ICS = "Open a plan to export its milestones.";
export const CSV_LINE = "CSV holds the List's columns, sort, scope and filters on this device.";
export const BACKUP_HINT = "One .zip with every plan as a .webboard file. Unzip it and import a plan to restore it.";

export const icsHint = (plan: string): string => `Dated milestones of ${q(plan)} as all-day events.`;

function IcsRow(p: { session: PlanSession; clock: Clock }) {
  const view = usePlanView(p.session);
  const hint = useId();
  return (
    <Row section={SECTION} row="ics" label={FILES_LABELS.ics} rowClassName="files-row" hint={{ id: hint, text: icsHint(view.plan.name) }}>
      <button type="button" aria-describedby={hint} onClick={() => void exportIcsFlow(p.session, p.clock)}>
        Export milestones…
      </button>
    </Row>
  );
}

function BackupRow(p: { backup(): void }) {
  const hint = useId();
  return (
    <Row section={SECTION} row="backup" label={FILES_LABELS.backup} rowClassName="files-row" hint={{ id: hint, text: BACKUP_HINT }}>
      <button type="button" aria-describedby={hint} onClick={p.backup}>
        Back up…
      </button>
    </Row>
  );
}

export function Files(p: { session: PlanSession | null; files: PlanFiles; clock: Clock; backup(): void }) {
  const prefs = useDevice().prefs;
  const session = p.session;
  return (
    <>
      <Row section={SECTION} row="import" label={FILES_LABELS.import}>
        <ImportButton files={p.files} />
      </Row>
      <Row section={SECTION} row="export" label={FILES_LABELS.export} className={session === null ? undefined : "settings-export"}>
        {session === null ? (
          <span className="settings-value dim">{NO_PLAN_EXPORT}</span>
        ) : (
          <>
            <div className="actions">
              <button type="button" onClick={() => void exportFlow(session)}>
                Export plan…
              </button>
              <button type="button" onClick={() => void exportListCsvFlow(session, meFor(prefs, session.view().plan.id))}>
                Export List as CSV…
              </button>
            </div>
            <p className="settings-value dim">{CSV_LINE}</p>
          </>
        )}
      </Row>
      {session === null ? (
        <Row section={SECTION} row="ics" label={FILES_LABELS.ics} rowClassName="files-row">
          <span className="settings-value dim">{NO_PLAN_ICS}</span>
        </Row>
      ) : (
        <IcsRow session={session} clock={p.clock} />
      )}
      <BackupRow backup={p.backup} />
    </>
  );
}
