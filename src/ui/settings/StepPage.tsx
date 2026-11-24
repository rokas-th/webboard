import { useLayoutEffect, useRef, useState } from "react";
import { items } from "../../actions/copy";
import type { StepColour, StepId } from "../../domain/model";
import { projectBoard, stepsOf, type Step } from "../../domain/steps";
import { usePlanView, type PlanSession } from "../../store/session";
import { useDeleteStep } from "../board/DeleteStep";
import { ColourPop, limitOfText } from "../board/StepPopovers";
import { colourTitle, COMPLETES_ROW, completesLabel, DELETE_STEP, LIMIT_NONE, overLimit, renameLabel, STEP_GONE, workflowLimitLabel } from "../board/text";
import type { Point } from "../common/ContextMenu";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { pointBelow } from "../common/pickMenu";
import { Switch } from "../common/Switch";
import { toast } from "../common/Toast";
import { TextField } from "../panel/TextField";
import { useRun } from "../run";
import { DetailRow } from "./SettingsPages";
import { stepStyle } from "./Workflow";

export const STEP_LABELS = { name: "Name", colour: "Colour", limit: "Limit", completes: COMPLETES_ROW, items: "Items" } as const;

function Fields(p: { session: PlanSession; readOnly: boolean; step: Step; count: number; select: boolean; onDelete(): void }) {
  const { run } = useRun(p.session);
  const box = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ at: Point; back: HTMLElement } | null>(null);
  const s = p.step;
  const ro = p.readOnly;
  const select = p.select;
  const over = s.limit !== null && p.count > s.limit;
  const limitText = s.limit === null ? "" : String(s.limit);

  useLayoutEffect(() => {
    if (!select) return;
    const root = box.current;
    if (root === null) throw new Error("StepPage: the fields are not rendered");
    const el = root.querySelector<HTMLInputElement>("input.workflow-name");
    if (el === null) throw new Error("StepPage: there is no name to select");
    el.focus();
    el.select();
  }, [select]);

  const live = (): Step | null => stepsOf(p.session.view().plan).find((x) => x.id === s.id) ?? null;

  const pickColour = (c: StepColour): void => {
    setPop(null);
    const now = live();
    if (now === null) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    if (c !== now.colour) run({ t: "step", op: "colour", step: s.id, colour: c });
  };

  const limit = (text: string): boolean => {
    const next = limitOfText(text);
    if (next === s.limit) return true;
    return run({ t: "step", op: "limit", step: s.id, limit: next }) !== null;
  };

  const toggleCompletes = (): void => {
    if (s.completes) run({ t: "step", op: "noneCompletes" });
    else run({ t: "step", op: "completes", step: s.id, completes: true });
  };

  return (
    <div ref={box} className="settings-detail" data-step={s.id} style={stepStyle(s.colour)}>
      <div className="settings-detail-card">
        <DetailRow label={STEP_LABELS.name}>
          {ro ? (
            <input type="text" className="workflow-name" aria-label={renameLabel(s.name)} value={s.name} disabled readOnly />
          ) : (
            <TextField className="workflow-name" label={renameLabel(s.name)} value={s.name} readOnly={false} onCommit={(next) => run({ t: "step", op: "rename", step: s.id, name: next }) !== null} />
          )}
        </DetailRow>
        <DetailRow label={STEP_LABELS.colour}>
          <button
            type="button"
            className="workflow-swatch"
            aria-label={colourTitle(s.name)}
            aria-haspopup="dialog"
            aria-expanded={pop !== null}
            disabled={ro}
            onClick={(e) => setPop({ at: pointBelow(e.currentTarget), back: e.currentTarget })}
          >
            <span className="swatch" />
          </button>
        </DetailRow>
        <DetailRow label={STEP_LABELS.limit}>
          {ro ? (
            <input type="text" className="workflow-limit" aria-label={workflowLimitLabel(s.name)} placeholder={LIMIT_NONE} value={limitText} disabled readOnly />
          ) : (
            <TextField className="workflow-limit" label={workflowLimitLabel(s.name)} placeholder={LIMIT_NONE} inputMode="numeric" value={limitText} readOnly={false} onCommit={limit} />
          )}
        </DetailRow>
        <DetailRow label={STEP_LABELS.completes}>
          <Switch label={completesLabel(s.name)} checked={s.completes} disabled={ro} onToggle={toggleCompletes} />
        </DetailRow>
        <DetailRow label={STEP_LABELS.items}>
          <span className={over ? "settings-detail-value over" : "settings-detail-value"} title={over && s.limit !== null ? overLimit(s.limit) : undefined}>
            {items(p.count)}
          </span>
        </DetailRow>
      </div>
      <button type="button" className="settings-detail-danger" disabled={ro} onClick={p.onDelete}>
        {DELETE_STEP}
      </button>
      {pop !== null && (
        <div
          className="workflow-pop"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            setPop(null);
          }}
        >
          <ColourPop name={s.name} colour={s.colour} at={pop.at} back={pop.back} onPick={pickColour} onClose={() => setPop(null)} />
        </div>
      )}
    </div>
  );
}

export function StepPage(p: { session: PlanSession; readOnly: boolean; step: StepId; select: boolean }) {
  const view = usePlanView(p.session);
  const deleting = useDeleteStep(p.session);
  const projection = projectBoard(view.plan, view.derived);
  const step = projection.steps.find((s) => s.id === p.step) ?? null;
  const column = step === null ? undefined : projection.columns.find((c) => c.step !== null && c.step.id === step.id);
  if (step !== null && column === undefined) throw new Error(`StepPage: step ${step.id} has no column`);
  return (
    <>
      {step === null || column === undefined ? (
        <p className="settings-line">{STEP_GONE}</p>
      ) : (
        <Fields session={p.session} readOnly={p.readOnly} step={step} count={column.items.length} select={p.select} onDelete={() => deleting.ask(step.id)} />
      )}
      {deleting.node}
    </>
  );
}
