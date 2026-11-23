import { refusal } from "../../actions/copy";
import type { StepId } from "../../domain/model";
import { stepModeOf, stepsOf, type Step } from "../../domain/steps";
import { usePlanView, type PlanSession } from "../../store/session";
import { newItemsByDates, newItemsDefault, newItemsText } from "../board/text";
import { pointBelow, pointBelowEnd, usePickMenu } from "../common/pickMenu";
import { useRun } from "../run";
import { checkRow, DefaultsPick, idOfRow, setDefault } from "./defaultsPick";
import { DEFAULTS_LABELS } from "./sections";

const STEP_PICK_LABEL = DEFAULTS_LABELS.step;

export const FIRST_OPEN_STEP = "First open step";

const LATER: StepId = "later";

const FIRST_ROW = "first";

const STEP_ROW = "step:";

const openSteps = (steps: readonly Step[]): readonly Step[] => steps.filter((s) => !s.completes);

export function NewStepPick(p: { session: PlanSession; readOnly: boolean; align: "start" | "end" }) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  const menu = usePickMenu(STEP_PICK_LABEL);
  const steps = stepsOf(view.plan);
  if (stepModeOf(view.plan) === "dates") {
    const later = steps.find((s) => s.id === LATER);
    if (later === undefined) throw new Error("NewStepPick: a by-dates plan has no Later step");
    return <p className="settings-line workflow-new">{newItemsByDates(later.name)}</p>;
  }
  const chosen = view.defaults.step;
  const chosenStep = chosen === null ? null : (steps.find((s) => s.id === chosen) ?? null);
  if (chosen !== null && chosenStep === null) throw new Error(`NewStepPick: the followed default step ${chosen} is not live`);
  const first = openSteps(steps)[0];

  const onChosen = (row: string): void => {
    const now = p.session.view().plan;
    if (row === FIRST_ROW) {
      setDefault(p.session, run, { t: "defaults", field: "step", value: null }, true);
      return;
    }
    const id = idOfRow(STEP_ROW, row, STEP_PICK_LABEL);
    const live = stepModeOf(now) === "steps" && openSteps(stepsOf(now)).some((s) => s.id === id);
    setDefault(p.session, run, { t: "defaults", field: "step", value: id }, live);
  };

  const open = (anchor: HTMLElement): void => {
    const rows = [checkRow(FIRST_ROW, FIRST_OPEN_STEP, chosen === null), ...openSteps(steps).map((s) => checkRow(`${STEP_ROW}${s.id}`, s.name, s.id === chosen))];
    menu.open("step", anchor, p.align === "end" ? pointBelowEnd(anchor) : pointBelow(anchor), [{ title: null, rows }], onChosen);
  };

  const line =
    chosenStep !== null ? (
      <p className="settings-line workflow-new">{newItemsDefault(chosenStep.name)}</p>
    ) : first === undefined ? (
      <p className="settings-line workflow-new board-problem">{refusal.noOpenStep}</p>
    ) : (
      <p className="settings-line workflow-new">{newItemsText(first.name)}</p>
    );

  return (
    <>
      <DefaultsPick field="step" label={STEP_PICK_LABEL} value={chosenStep === null ? FIRST_OPEN_STEP : chosenStep.name} expanded={menu.openFor === "step"} disabled={p.readOnly} onOpen={open} />
      {line}
      {menu.node}
    </>
  );
}
