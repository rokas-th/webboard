import { useSyncExternalStore } from "react";
import { countsText, type GanttReport } from "../../import/gantt";
import { Dialog } from "../common/Dialog";
import { Sheet } from "../common/Sheet";

export const CONVERTED_TITLE = "Converted from a .gantt file";
export const OPEN_PLAN = "Open plan";

interface Shown {
  report: GanttReport;
  settle: () => void;
}

const listeners = new Set<() => void>();
let shown: Shown | null = null;

const publish = (next: Shown | null): void => {
  shown = next;
  [...listeners].forEach((cb) => cb());
};

export function showConverted(report: GanttReport): Promise<void> {
  if (shown !== null) throw new Error("A conversion report is already open");
  const settlers: (() => void)[] = [];
  const done = new Promise<void>((resolve) => settlers.push(resolve));
  publish({ report, settle: () => settlers.forEach((s) => s()) });
  return done;
}

export function closeConverted(): void {
  const open = shown;
  if (open === null) throw new Error("No conversion report is open");
  publish(null);
  open.settle();
}

export const shownConverted = (): GanttReport | null => (shown === null ? null : shown.report);

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const snapshot = (): Shown | null => shown;

function ReportText(p: { report: GanttReport }) {
  return (
    <>
      <p>{`Plan “${p.report.name}” from ${p.report.fileName}`}</p>
      <p>{countsText(p.report.counts)}</p>
      <p>Not carried over:</p>
      <ul className="converted-dropped">
        {p.report.dropped.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
    </>
  );
}

export function ConvertedReport(p: { frame?: "dialog" | "sheet" }) {
  const current = useSyncExternalStore(subscribe, snapshot);
  if (current === null) return null;
  const openPlan = (
    <div className="modal-actions">
      <button type="button" className="button-primary" onClick={closeConverted}>
        {OPEN_PLAN}
      </button>
    </div>
  );
  if (p.frame === "sheet") {
    return (
      <Sheet open title={CONVERTED_TITLE} onClose={closeConverted}>
        <div className="converted-sheet">
          <ReportText report={current.report} />
          {openPlan}
        </div>
      </Sheet>
    );
  }
  return (
    <Dialog label={CONVERTED_TITLE} onClose={closeConverted}>
      <ReportText report={current.report} />
      {openPlan}
    </Dialog>
  );
}
