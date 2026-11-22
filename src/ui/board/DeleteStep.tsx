import { useCallback, useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { refusal } from "../../actions/copy";
import { stepHolding } from "../../actions/steps";
import type { StepColour, StepId } from "../../domain/model";
import { stepsOf, type Step } from "../../domain/steps";
import { CANCEL_LABEL, usesNativeAlert } from "../../services/alert";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { Dialog } from "../common/Dialog";
import { NativeConfirm, STALE_CONFIRM } from "../common/NativeConfirm";
import { toast } from "../common/Toast";
import { useRun } from "../run";
import { DELETE, DELETE_AND_MOVE, DELETE_STEP, deleteEmptyText, hiddenOfThem, MARKS_DONE, MOVE_TO_GROUP, moveItemsTitle } from "./text";

const swatchStyle = (c: StepColour): CSSProperties => ({ "--step": `var(--s-${c})` });

export interface DeleteStepAsk {
  ask(step: StepId): void;
  node: ReactNode;
}

export function deleteRefusal(steps: readonly Step[], step: StepId): string | null {
  if (!steps.some((s) => s.id === step)) throw new Error(`DeleteStep: step ${step} is not in this plan`);
  const rest = steps.filter((s) => s.id !== step);
  if (rest.length === 0) return refusal.lastStep;
  if (rest.every((s) => s.completes)) return refusal.lastOpenStep;
  return null;
}

type Asking = { step: Step; native: boolean };

const emptyNow = (view: PlanView, step: StepId): boolean => {
  const steps = stepsOf(view.plan);
  return steps.some((s) => s.id === step) && deleteRefusal(steps, step) === null && stepHolding(view, step).held === 0;
};

function NativeDelete(p: { session: PlanSession; step: Step; current: boolean; onClose(): void }) {
  const { run } = useRun(p.session);
  return (
    <NativeConfirm
      ask={{ title: DELETE_STEP, message: deleteEmptyText(p.step.name), confirm: { label: DELETE, destructive: true }, cancel: CANCEL_LABEL }}
      current={p.current}
      run={() => {
        run({ t: "step", op: "delete", step: p.step.id, to: null });
      }}
      onClose={p.onClose}
    />
  );
}

function EmptyDelete(p: { session: PlanSession; step: Step; onClose(): void }) {
  const { run } = useRun(p.session);
  const remove = (): void => {
    run({ t: "step", op: "delete", step: p.step.id, to: null });
    p.onClose();
  };
  return (
    <Dialog label={DELETE_STEP} onClose={p.onClose}>
      <p className="delete-step-text">{deleteEmptyText(p.step.name)}</p>
      <div className="modal-actions">
        <button type="button" onClick={p.onClose}>
          {CANCEL_LABEL}
        </button>
        <button type="button" className="button-danger" onClick={remove}>
          {DELETE}
        </button>
      </div>
    </Dialog>
  );
}

function MoveDelete(p: { session: PlanSession; step: Step; others: readonly Step[]; held: number; hidden: number; onClose(): void }) {
  const { run } = useRun(p.session);
  const group = useId();
  const preset = p.others.find((s) => !s.completes);
  if (preset === undefined) throw new Error(`DeleteStep: no step but ${p.step.name} takes open items`);
  const [picked, setPicked] = useState<StepId>(preset.id);
  const to = p.others.find((s) => s.id === picked) ?? null;
  const presetId = preset.id;
  const pickGone = to === null;
  useEffect(() => {
    if (!pickGone) return;
    setPicked(presetId);
    toast(STALE_CONFIRM, "bad");
  }, [pickGone, presetId]);
  const remove = (): void => {
    if (to === null) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    const built = run({ t: "step", op: "delete", step: p.step.id, to: to.id });
    if (built !== null) p.onClose();
  };
  return (
    <Dialog label={moveItemsTitle(p.held, p.step.name)} onClose={p.onClose}>
      {p.hidden > 0 && <p className="delete-step-hidden">{hiddenOfThem(p.hidden)}</p>}
      <div className="step-pick" role="radiogroup" aria-label={MOVE_TO_GROUP}>
        {p.others.map((s) => (
          <label key={s.id} className={s.id === picked ? "step-pick-row on" : "step-pick-row"} style={swatchStyle(s.colour)} data-pick={s.id}>
            <input type="radio" name={group} value={s.id} checked={s.id === picked} onChange={() => setPicked(s.id)} />
            <span className="swatch" />
            <span className="step-pick-name">{s.name}</span>
            {s.completes && <span className="pick-note">{MARKS_DONE}</span>}
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={p.onClose}>
          {CANCEL_LABEL}
        </button>
        <button type="button" className="button-danger" onClick={remove}>
          {DELETE_AND_MOVE}
        </button>
      </div>
    </Dialog>
  );
}

function Gone(p: { why: string; onClose(): void }) {
  const { why, onClose } = p;
  useEffect(() => {
    toast(why, "bad");
    onClose();
  }, [why, onClose]);
  return null;
}

function DeleteStep(p: { session: PlanSession; asking: Asking; onClose(): void }) {
  const view = usePlanView(p.session);
  if (p.asking.native) return <NativeDelete session={p.session} step={p.asking.step} current={emptyNow(view, p.asking.step.id)} onClose={p.onClose} />;
  const steps = stepsOf(view.plan);
  const step = steps.find((s) => s.id === p.asking.step.id);
  if (step === undefined) return <Gone why={STALE_CONFIRM} onClose={p.onClose} />;
  const refused = deleteRefusal(steps, step.id);
  if (refused !== null) return <Gone why={refused} onClose={p.onClose} />;
  const { held, hidden } = stepHolding(view, step.id);
  if (held === 0) return <EmptyDelete session={p.session} step={step} onClose={p.onClose} />;
  return <MoveDelete session={p.session} step={step} others={steps.filter((s) => s.id !== step.id)} held={held} hidden={hidden} onClose={p.onClose} />;
}

export function useDeleteStep(session: PlanSession): DeleteStepAsk {
  const [asking, setAsking] = useState<Asking | null>(null);
  const close = useCallback(() => setAsking(null), []);
  const ask = useCallback(
    (id: StepId): void => {
      const view = session.view();
      const steps = stepsOf(view.plan);
      const why = deleteRefusal(steps, id);
      if (why !== null) {
        toast(why, "bad");
        return;
      }
      const step = steps.find((s) => s.id === id);
      if (step === undefined) throw new Error(`DeleteStep: step ${id} passed the refusal check but is not in this plan`);
      setAsking({ step, native: usesNativeAlert() && stepHolding(view, id).held === 0 });
    },
    [session],
  );
  return { ask, node: asking === null ? null : <DeleteStep session={session} asking={asking} onClose={close} /> };
}
