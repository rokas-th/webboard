import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { items, refusal } from "../../actions/copy";
import { STEP_COLOURS, type StepColour, type StepId } from "../../domain/model";
import { projectBoard, stepsOf, type Step } from "../../domain/steps";
import { usePlanView, type PlanSession } from "../../store/session";
import { useDeleteStep } from "../board/DeleteStep";
import { boardLayout } from "../board/layout";
import { EMPTY_BOARD_PREFS } from "../board/prefs";
import { ColourPop, limitOfText } from "../board/StepPopovers";
import {
  ADD_STEP,
  BY_DATES,
  colourTitle,
  COMPLETES_COLUMN,
  COMPLETES_GROUP,
  completesLabel,
  DELETE_ROW,
  LIMIT_NONE,
  newItemsByDates,
  newItemsText,
  newStepName,
  overLimit,
  renameLabel,
  reorderLabel,
  WORKFLOW_HEAD,
  WORKFLOW_NO_COMPLETING,
  workflowLimitLabel,
} from "../board/text";
import type { Point } from "../common/ContextMenu";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { pointBelow } from "../common/pickMenu";
import { toast } from "../common/Toast";
import { TextField } from "../panel/TextField";
import { useRun } from "../run";
import { Row, rowKey } from "./Row";

const SECTION = "workflow";

const LATER: StepId = "later";

const stepStyle = (c: StepColour): CSSProperties => ({ "--step": `var(--s-${c})` });

type Focus = { step: StepId; what: "name" | "grip" };

type Drag = { step: StepId; over: StepId | null };

const rowOf = (el: Element | null): StepId | null => {
  const found = el === null ? null : el.closest<HTMLElement>("li.workflow-row[data-step]");
  const id = found === null ? undefined : found.dataset.step;
  return id === undefined ? null : id;
};

function NewItemsLine(p: { mode: "dates" | "steps"; steps: readonly Step[] }) {
  if (p.mode === "dates") {
    const later = p.steps.find((s) => s.id === LATER);
    if (later === undefined) throw new Error("Workflow: a by-dates plan has no Later step");
    return <p className="settings-line workflow-new">{newItemsByDates(later.name)}</p>;
  }
  const first = p.steps.find((s) => !s.completes);
  if (first === undefined) return <p className="settings-line workflow-new board-problem">{refusal.noOpenStep}</p>;
  return <p className="settings-line workflow-new">{newItemsText(first.name)}</p>;
}

export function Workflow(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const { run } = useRun(p.session);
  const deleting = useDeleteStep(p.session);
  const list = useRef<HTMLUListElement>(null);
  const [pop, setPop] = useState<{ step: StepId; at: Point; back: HTMLElement } | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const projection = projectBoard(view.plan, view.derived);
  const layout = boardLayout(view, projection, EMPTY_BOARD_PREFS);
  const steps = projection.steps;
  const ro = p.readOnly;

  const liveStep = (id: StepId): Step | null => stepsOf(p.session.view().plan).find((s) => s.id === id) ?? null;

  const radios = useId();

  const countOf = (id: StepId): number => {
    const c = projection.columns.find((x) => x.step !== null && x.step.id === id);
    if (c === undefined) throw new Error(`Workflow: step ${id} has no column`);
    return c.items.length;
  };

  const reorderTo = (source: StepId, target: StepId): boolean => {
    const all = stepsOf(p.session.view().plan);
    const from = all.findIndex((s) => s.id === source);
    const to = all.findIndex((s) => s.id === target);
    if (from < 0 || to < 0) throw new Error(`Workflow: reorder from ${source} to ${target} names a step that is not live`);
    if (from === to) return false;
    const after = to > from ? target : to === 0 ? null : all[to - 1].id;
    return run({ t: "step", op: "reorder", step: source, after }) !== null;
  };

  const reorderRef = useRef(reorderTo);
  useLayoutEffect(() => {
    reorderRef.current = reorderTo;
  });

  const dragging = drag === null ? null : drag.step;
  useEffect(() => {
    if (dragging === null) return;
    const over: { current: StepId | null } = { current: null };
    const onMove = (e: PointerEvent): void => {
      const at = rowOf(document.elementFromPoint(e.clientX, e.clientY));
      over.current = at;
      setDrag({ step: dragging, over: at });
    };
    const onUp = (): void => {
      setDrag(null);
      const target = over.current;
      if (target !== null) reorderRef.current(dragging, target);
    };
    const onCancel = (): void => setDrag(null);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };
  }, [dragging]);

  useLayoutEffect(() => {
    if (focus === null) return;
    const root = list.current;
    if (root === null) throw new Error("Workflow: the step list is not rendered");
    const el = root.querySelector<HTMLElement>(`li.workflow-row[data-step="${focus.step}"] ${focus.what === "name" ? "input.workflow-name" : "button.workflow-grip"}`);
    if (el === null) throw new Error(`Workflow: step ${focus.step} has no ${focus.what} to focus`);
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, [focus]);

  const add = (): void => {
    const all = stepsOf(p.session.view().plan);
    const used = new Set(all.map((s) => s.colour));
    const colour = STEP_COLOURS.find((c) => !used.has(c)) ?? "slate";
    const name = newStepName(all.map((s) => s.name));
    const after = all.length === 0 ? null : all[all.length - 1].id;
    if (run({ t: "step", op: "add", name, colour, after }) === null) return;
    const made = stepsOf(p.session.view().plan).find((s) => s.name === name);
    if (made === undefined) throw new Error(`Workflow: the new step ${name} is not in the plan`);
    setFocus({ step: made.id, what: "name" });
  };

  const completes = (step: Step): void => {
    if (step.completes) return;
    run({ t: "step", op: "completes", step: step.id, completes: true });
  };

  const noneCompletes = (): void => {
    run({ t: "step", op: "noneCompletes" });
  };

  const rename = (step: Step, name: string): boolean => run({ t: "step", op: "rename", step: step.id, name }) !== null;

  const limit = (step: Step, text: string): boolean => {
    const next = limitOfText(text);
    if (next === step.limit) return true;
    return run({ t: "step", op: "limit", step: step.id, limit: next }) !== null;
  };

  const pickColour = (id: StepId, c: StepColour): void => {
    const step = liveStep(id);
    setPop(null);
    if (step === null) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    if (c !== step.colour) run({ t: "step", op: "colour", step: id, colour: c });
  };

  const onGripKey = (e: ReactKeyboardEvent<HTMLButtonElement>, step: Step): void => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const at = steps.findIndex((s) => s.id === step.id);
    if (at < 0) throw new Error(`Workflow: step ${step.id} is not live`);
    const target = steps[e.key === "ArrowUp" ? at - 1 : at + 1];
    if (target === undefined) return;
    if (reorderTo(step.id, target.id)) setFocus({ step: step.id, what: "grip" });
  };

  const onGripDown = (e: ReactPointerEvent<HTMLButtonElement>, step: Step): void => {
    if (ro || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    setDrag({ step: step.id, over: null });
  };

  const popStep = pop === null ? null : (steps.find((s) => s.id === pop.step) ?? null);
  const popGone = pop !== null && popStep === null;
  useEffect(() => {
    if (!popGone) return;
    setPop(null);
    toast(STALE_CONFIRM, "bad");
  }, [popGone]);
  const completing = steps.some((s) => s.completes);
  const radioIds = [...steps.map((s) => `${radios}-${s.id}`), `${radios}-none`];
  const radioOn = steps.findIndex((s) => s.completes);
  const radioTab = radioOn < 0 ? steps.length : radioOn;

  const onRadioKey = (e: ReactKeyboardEvent<HTMLButtonElement>, at: number): void => {
    const by = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (by === 0 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const id = radioIds[(at + by + radioIds.length) % radioIds.length];
    const el = document.getElementById(id);
    if (el === null) throw new Error(`Workflow: the radio ${id} is not rendered`);
    el.focus();
  };
  const showLine = layout.mode === "dates" || layout.problems.length > 0;

  const rowClass = (id: StepId): string => {
    const lifted = drag !== null && drag.step === id ? ["dragging"] : [];
    const target = drag !== null && drag.over === id && drag.step !== id ? ["drop-over"] : [];
    return ["workflow-row", ...lifted, ...target].join(" ");
  };

  return (
    <>
      <div className="settings-row settings-row-stack" data-settings-row={rowKey(SECTION, "steps")}>
        <span className="settings-label">Steps</span>
        <div className="workflow-control">
          {showLine && (
            <p className="workflow-line" role="status">
              {layout.mode === "dates" && (
                <span className="quiet-line" data-by-dates="">
                  {BY_DATES}
                </span>
              )}
              {layout.problems.map((text) => (
                <span key={text} className="board-problem">
                  {text}
                </span>
              ))}
            </p>
          )}
          <div className="workflow-head" aria-hidden="true">
            {WORKFLOW_HEAD.map((h, i) => (
              <span key={i}>{h}</span>
            ))}
          </div>
          <ul ref={list} className="workflow-list">
            {steps.map((s, i) => {
              const n = countOf(s.id);
              const over = s.limit !== null && n > s.limit;
              const limitText = s.limit === null ? "" : String(s.limit);
              return (
                <li key={s.id} className={rowClass(s.id)} data-step={s.id} style={stepStyle(s.colour)}>
                  <button type="button" className="workflow-grip" aria-label={reorderLabel(s.name)} disabled={ro} onKeyDown={(e) => onGripKey(e, s)} onPointerDown={(e) => onGripDown(e, s)}>
                    <span className="workflow-grip-dots" aria-hidden="true" />
                  </button>
                  <button type="button" className="workflow-swatch" aria-label={colourTitle(s.name)} disabled={ro} onClick={(e) => setPop({ step: s.id, at: pointBelow(e.currentTarget), back: e.currentTarget })}>
                    <span className="swatch" />
                  </button>
                  {ro ? (
                    <input type="text" className="workflow-name" aria-label={renameLabel(s.name)} value={s.name} disabled readOnly />
                  ) : (
                    <TextField className="workflow-name" label={renameLabel(s.name)} value={s.name} readOnly={false} onCommit={(next) => rename(s, next)} />
                  )}
                  <span className={over ? "workflow-count over" : "workflow-count"} title={over && s.limit !== null ? overLimit(s.limit) : undefined}>
                    {items(n)}
                  </span>
                  {ro ? (
                    <input type="text" className="workflow-limit" aria-label={workflowLimitLabel(s.name)} placeholder={LIMIT_NONE} value={limitText} disabled readOnly />
                  ) : (
                    <TextField
                      className="workflow-limit"
                      label={workflowLimitLabel(s.name)}
                      placeholder={LIMIT_NONE}
                      inputMode="numeric"
                      value={limitText}
                      readOnly={false}
                      onCommit={(next) => limit(s, next)}
                    />
                  )}
                  <button
                    type="button"
                    role="radio"
                    id={radioIds[i]}
                    className="workflow-completes"
                    aria-checked={s.completes}
                    aria-label={completesLabel(s.name)}
                    tabIndex={i === radioTab ? 0 : -1}
                    disabled={ro}
                    onKeyDown={(e) => onRadioKey(e, i)}
                    onClick={() => completes(s)}
                  >
                    <span className="workflow-radio" aria-hidden="true" />
                    <span className="workflow-completes-text" aria-hidden="true">
                      {COMPLETES_COLUMN}
                    </span>
                  </button>
                  <button type="button" className="workflow-delete" disabled={ro} onClick={() => deleting.ask(s.id)}>
                    {DELETE_ROW}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="workflow-radios" role="radiogroup" aria-label={COMPLETES_GROUP} aria-owns={radioIds.join(" ")}>
            <button
              type="button"
              role="radio"
              id={radioIds[steps.length]}
              className="workflow-none"
              aria-checked={!completing}
              tabIndex={radioTab === steps.length ? 0 : -1}
              disabled={ro}
              onKeyDown={(e) => onRadioKey(e, steps.length)}
              onClick={() => (completing ? noneCompletes() : undefined)}
            >
              <span className="workflow-radio" aria-hidden="true" />
              {WORKFLOW_NO_COMPLETING}
            </button>
          </div>
        </div>
      </div>
      <div className="workflow-add-row" data-settings-row={rowKey(SECTION, "add")}>
        <button type="button" className="workflow-add" disabled={ro} onClick={add}>
          {ADD_STEP}
        </button>
      </div>
      <Row section={SECTION} row="new-items" label="New items" stack>
        <NewItemsLine mode={layout.mode} steps={steps} />
      </Row>
      {pop !== null && popStep !== null && (
        <div
          className="workflow-pop"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            setPop(null);
          }}
        >
          <ColourPop name={popStep.name} colour={popStep.colour} at={pop.at} back={pop.back} onPick={(c) => pickColour(popStep.id, c)} onClose={() => setPop(null)} />
        </div>
      )}
      {deleting.node}
    </>
  );
}
