import { useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { q, refusal } from "../../actions/copy";
import type { GoneDefault } from "../../domain/defaults";
import { goneSet } from "../../domain/derive";
import { MAX_TASK_DUR, type Item, type ItemId, type PlanState } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { stepModeOf, stepsOf } from "../../domain/steps";
import { childrenOf } from "../../plan/project";
import { usePlanView, type PlanSession } from "../../store/session";
import { pointBelowEnd, usePickMenu } from "../common/pickMenu";
import { toast } from "../common/Toast";
import { planGroupPath } from "../list/groups";
import { TextField } from "../panel/TextField";
import { ADD_PEOPLE_IN_SETTINGS } from "../people/text";
import { useRun } from "../run";
import { checkRow, DefaultsPick, idOfRow, setDefault } from "./defaultsPick";
import { NewStepPick } from "./NewStepPick";
import { Row } from "./Row";
import { DEFAULTS_LABELS } from "./sections";

const SECTION = "defaults";
const ROW_CLASS = "defaults-row";

export const DUR_FIELD = "New task duration in working days";
export const DUR_UNIT = "working days";
export const DUR_HINT = "A new task lasts this long once it has dates.";
export const SHORTER = "Shorter";
export const LONGER = "Longer";
export const DATED_HINT = "Dated items start on the next working day.";
export const DATED = "Dated";
export const UNDATED = "Undated";
export const NOBODY = "Nobody";
export const PLAN_ROOT = "Plan root";

const NONE_ROW = "none";
const PERSON_ROW = "person:";
const PEOPLE_SETTINGS_ROW = "people-settings";
const ROOT_ROW = "root";
const GROUP_ROW = "group:";

const UNTIL = "until you choose another.";

const firstSentence = (g: GoneDefault): string => {
  switch (g.field) {
    case "who":
      return g.name === null ? "The default assignee was removed from people." : `The default assignee ${q(g.name)} was removed from people.`;
    case "group":
      if (g.why === "trashed") return g.name === null ? "The default group is in the Trash." : `The group ${q(g.name)} is in the Trash.`;
      if (g.why === "notGroup") return g.name === null ? "The default group names an item that is not a group." : `${q(g.name)} is not a group.`;
      return g.name === null ? "The default group was deleted." : `The group ${q(g.name)} was deleted.`;
    case "step":
      if (g.why === "completes") return g.name === null ? "The default step completes items." : `${q(g.name)} completes items.`;
      return g.name === null ? "The default step was deleted." : `The step ${q(g.name)} was deleted.`;
  }
};

const secondSentence = (g: GoneDefault, firstOpen: string | null): string => {
  switch (g.field) {
    case "who":
      return `New items are unassigned ${UNTIL}`;
    case "group":
      return `Board + adds to the plan root ${UNTIL}`;
    case "step":
      return firstOpen === null ? refusal.noOpenStep : `New undated items go to ${q(firstOpen)} ${UNTIL}`;
  }
};

export const goneText = (g: GoneDefault, firstOpen: string | null): string => `${firstSentence(g)} ${secondSentence(g, firstOpen)}`;

export function liveGroups(plan: PlanState): readonly Item[] {
  const gone = goneSet(plan);
  const walk = (parent: ItemId | null): Item[] => childrenOf(plan, parent).flatMap((i) => (i.kind === "group" && !gone.has(i.id) ? [i, ...walk(i.id)] : []));
  return walk(null);
}

export function Defaults(p: { session: PlanSession; readOnly: boolean; onPeople(): void }) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  const whoMenu = usePickMenu(DEFAULTS_LABELS.assignee);
  const groupMenu = usePickMenu(DEFAULTS_LABELS.group);
  const ids = useId();
  const shorter = useRef<HTMLButtonElement>(null);
  const longer = useRef<HTMLButtonElement>(null);
  const ro = p.readOnly;
  const d = view.defaults;
  const plan = view.plan;
  const people = view.people.people;
  const steps = stepsOf(plan);
  const firstOpen = stepModeOf(plan) === "steps" ? (steps.find((s) => !s.completes)?.name ?? null) : null;
  const durHint = `${ids}-dur-hint`;
  const datedHint = `${ids}-dated-hint`;

  const whoPerson = d.who === null ? null : (people.find((x) => x.id === d.who) ?? null);
  if (d.who !== null && whoPerson === null) throw new Error(`Defaults: the followed default assignee ${d.who} is not live`);
  const groupName = d.group === null ? PLAN_ROOT : planGroupPath(plan, d.group);

  const setDur = (value: number): boolean => run.run({ t: "defaults", field: "dur", value }) !== null;

  const stepDur = (by: -1 | 1): void => {
    const next = d.dur + by;
    const atBound = next === 1 || next === MAX_TASK_DUR;
    const own = by === -1 ? shorter.current : longer.current;
    const other = by === -1 ? longer.current : shorter.current;
    if (own === null || other === null) throw new Error("Defaults: the duration stepper is not rendered");
    const hadFocus = document.activeElement === own;
    if (!setDur(next)) return;
    if (atBound && hadFocus) other.focus();
  };

  const commitDur = (text: string): boolean => {
    if (!/^\d+$/.test(text)) {
      toast(refusal.defaultDur, "bad");
      return false;
    }
    const value = Number(text);
    if (value === p.session.view().defaults.dur) return false;
    return setDur(value);
  };

  const setDated = (dated: boolean): void => {
    if (p.session.view().defaults.dated === dated) return;
    run.run({ t: "defaults", field: "dated", value: dated });
  };

  const radioId = (dated: boolean): string => `${ids}-${dated ? "dated" : "undated"}`;

  const onRadioKey = (e: ReactKeyboardEvent<HTMLButtonElement>, dated: boolean): void => {
    const arrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key);
    if (!arrow || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const other = document.getElementById(radioId(!dated));
    if (other === null) throw new Error(`Defaults: the ${dated ? UNDATED : DATED} radio is not rendered`);
    other.focus();
    setDated(!dated);
  };

  const onWho = (row: string): void => {
    if (row === PEOPLE_SETTINGS_ROW) {
      p.onPeople();
      return;
    }
    if (row === NONE_ROW) {
      setDefault(p.session, run, { t: "defaults", field: "who", value: null }, true);
      return;
    }
    const id = idOfRow(PERSON_ROW, row, DEFAULTS_LABELS.assignee);
    setDefault(p.session, run, { t: "defaults", field: "who", value: id }, peopleOf(p.session.view().plan).some((x) => x.id === id));
  };

  const openWho = (anchor: HTMLElement): void => {
    const rows = [
      checkRow(NONE_ROW, NOBODY, d.who === null),
      ...(people.length === 0 ? [{ id: PEOPLE_SETTINGS_ROW, title: ADD_PEOPLE_IN_SETTINGS, checked: false, checkable: false }] : people.map((x) => checkRow(`${PERSON_ROW}${x.id}`, x.name, x.id === d.who))),
    ];
    whoMenu.open("who", anchor, pointBelowEnd(anchor), [{ title: null, rows }], onWho);
  };

  const onGroup = (row: string): void => {
    if (row === ROOT_ROW) {
      setDefault(p.session, run, { t: "defaults", field: "group", value: null }, true);
      return;
    }
    const id = idOfRow(GROUP_ROW, row, DEFAULTS_LABELS.group);
    setDefault(p.session, run, { t: "defaults", field: "group", value: id }, liveGroups(p.session.view().plan).some((g) => g.id === id));
  };

  const openGroup = (anchor: HTMLElement): void => {
    const rows = [checkRow(ROOT_ROW, PLAN_ROOT, d.group === null), ...liveGroups(plan).map((g) => checkRow(`${GROUP_ROW}${g.id}`, planGroupPath(plan, g.id), g.id === d.group))];
    groupMenu.open("group", anchor, pointBelowEnd(anchor), [{ title: null, rows }], onGroup);
  };

  const durText = String(d.dur);

  return (
    <>
      <p className="defaults-line" role="status">
        {d.gone.map((g) => (
          <span key={g.field} className="board-problem">
            {goneText(g, firstOpen)}
          </span>
        ))}
      </p>
      <Row section={SECTION} row="duration" label={DEFAULTS_LABELS.duration} rowClassName={ROW_CLASS} hint={{ id: durHint, text: DUR_HINT }}>
        <div className="stepper">
          <button ref={shorter} type="button" className="step-btn" aria-label={SHORTER} disabled={ro || d.dur <= 1} onClick={() => stepDur(-1)}>
            <span aria-hidden="true">−</span>
          </button>
          {ro ? (
            <input type="text" className="defaults-dur" aria-label={DUR_FIELD} aria-describedby={durHint} value={durText} disabled readOnly />
          ) : (
            <TextField className="defaults-dur" label={DUR_FIELD} describedBy={durHint} inputMode="numeric" value={durText} readOnly={false} onCommit={commitDur} />
          )}
          <button ref={longer} type="button" className="step-btn" aria-label={LONGER} disabled={ro || d.dur >= MAX_TASK_DUR} onClick={() => stepDur(1)}>
            <span aria-hidden="true">+</span>
          </button>
          <span className="defaults-unit">{DUR_UNIT}</span>
        </div>
      </Row>
      <Row section={SECTION} row="dated" label={DEFAULTS_LABELS.dated} rowClassName={ROW_CLASS} hint={{ id: datedHint, text: DATED_HINT }}>
        <div className="seg defaults-seg" role="radiogroup" aria-label={DEFAULTS_LABELS.dated} aria-describedby={datedHint}>
          {[true, false].map((dated) => {
            const on = d.dated === dated;
            return (
              <button
                key={String(dated)}
                type="button"
                role="radio"
                id={radioId(dated)}
                data-dated={dated ? "dated" : "undated"}
                className={on ? "active" : undefined}
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                disabled={ro}
                onKeyDown={(e) => onRadioKey(e, dated)}
                onClick={() => setDated(dated)}
              >
                {dated ? DATED : UNDATED}
              </button>
            );
          })}
        </div>
      </Row>
      <Row section={SECTION} row="assignee" label={DEFAULTS_LABELS.assignee} rowClassName={ROW_CLASS}>
        <DefaultsPick field="who" label={DEFAULTS_LABELS.assignee} value={whoPerson === null ? NOBODY : whoPerson.name} expanded={whoMenu.openFor === "who"} disabled={ro} onOpen={openWho} />
      </Row>
      <Row section={SECTION} row="group" label={DEFAULTS_LABELS.group} rowClassName={ROW_CLASS}>
        <DefaultsPick field="group" label={DEFAULTS_LABELS.group} value={groupName} expanded={groupMenu.openFor === "group"} disabled={ro} onOpen={openGroup} />
      </Row>
      <Row section={SECTION} row="step" label={DEFAULTS_LABELS.step} rowClassName={ROW_CLASS} className="defaults-step">
        <NewStepPick session={p.session} readOnly={ro} align="end" />
      </Row>
      {whoMenu.node}
      {groupMenu.node}
    </>
  );
}
