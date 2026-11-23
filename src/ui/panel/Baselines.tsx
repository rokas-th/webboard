import { fmtFull, fmtShort, LOG_STYLE, type IsoDate } from "../../domain/dates";
import type { PlanView } from "../../store/doc";
import type { Run } from "../run";
import { useDateStyle } from "../DeviceProvider";
import { useUiValue } from "../state";
import { TextField } from "./TextField";

export const baselineDefault = (today: IsoDate): string => `Baseline ${fmtFull(today, LOG_STYLE)}`;

export function Baselines(p: { view: PlanView; readOnly: boolean; run: Run; titled: boolean }) {
  const { ui, setUi } = useUiValue();
  const style = useDateStyle();
  const list = [...p.view.plan.baselines.values()].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  return (
    <>
      {p.titled && <h2>Baselines</h2>}
      {list.length > 0 && (
        <div className="baselines">
          {list.map((b) => {
            const shown = ui.baseline === b.id;
            return (
              <div key={b.id} className={shown ? "baseline-row shown" : "baseline-row"} data-baseline={b.id}>
                <TextField
                  className="baseline-name"
                  label="Baseline name"
                  value={b.name}
                  readOnly={p.readOnly}
                  onCommit={(next) => p.run.run({ t: "baseline", op: "rename", id: b.id, name: next }) !== null}
                />
                <span className="baseline-at">{fmtShort(b.at, style)}</span>
                <button type="button" className="button-small" aria-pressed={shown} onClick={() => setUi({ baseline: shown ? null : b.id })}>
                  {shown ? "Hide" : "Show"}
                </button>
                {!p.readOnly && (
                  <button type="button" className="button-small" onClick={() => p.run.run({ t: "baseline", op: "remove", id: b.id })}>
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!p.readOnly && (
        <div className="actions">
          <button type="button" className="button-small" onClick={() => p.run.run({ t: "baseline", op: "save", name: baselineDefault(p.view.today) })}>
            Save baseline
          </button>
        </div>
      )}
    </>
  );
}
