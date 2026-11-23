import { useId, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { formerText, q } from "../../actions/copy";
import { Refused } from "../../actions/intents";
import { usesNativeMenu } from "../../services/nativeMenu";
import { fmtNear, type DateFormat, type WeekStart } from "../../domain/dates";
import { meOf, type MeState } from "../../domain/me";
import { peopleOf } from "../../domain/people";
import type { Clock } from "../../services/clock";
import { usePlanView, type PlanSession } from "../../store/session";
import type { Updates } from "../../store/updates";
import { AboutText } from "../common/About";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { pointBelowEnd, usePickMenu } from "../common/pickMenu";
import { toast } from "../common/Toast";
import { meFor } from "../device";
import { useDateStyle, useDevice } from "../DeviceProvider";
import { TextField } from "../panel/TextField";
import { ADD_PEOPLE_IN_SETTINGS, meGoneText } from "../people/text";
import { UpdateLine } from "../shell/UpdateLine";
import type { ViewKind } from "../state";
import { checkRow, idOfRow } from "./defaultsPick";
import { Row } from "./Row";
import { GENERAL_LABELS } from "./sections";

const SECTION = "general";

const ROW_CLASS = "general-row";

export const TAB_HINT = "Used when WebBoard has no last place to reopen.";
export const WEEK_HINT = "The Timeline, printed weeks and Working days start on this day. Date pickers follow the system.";
export const CSV_KEEPS_ISO = "CSV keeps ISO dates.";
export const NOBODY = "Nobody";
export const NO_PLAN_ME = "Open a plan to choose who you are in it.";
export const DEVICE_HINT = "Shown in History and on your other devices. The sync server keeps the name this device joined with.";

export const meHint = (plan: string): string => `For ${q(plan)} on this device only. Turns on Mine in the List.`;

const NONE_ROW = "none";
const PERSON_ROW = "person:";
const PEOPLE_SETTINGS_ROW = "people-settings";

const TAB_OPTIONS: readonly (readonly [ViewKind, string])[] = [
  ["timeline", "Timeline"],
  ["board", "Board"],
  ["list", "List"],
];

const WEEK_OPTIONS: readonly (readonly [WeekStart, string])[] = [
  [1, "Monday"],
  [7, "Sunday"],
];

const DATE_OPTIONS: readonly (readonly [DateFormat, string])[] = [
  ["system", "System"],
  ["iso", "ISO"],
  ["dmy", "D.M.YYYY"],
];

const STEPS: ReadonlyMap<string, -1 | 1> = new Map([
  ["ArrowLeft", -1],
  ["ArrowUp", -1],
  ["ArrowRight", 1],
  ["ArrowDown", 1],
]);

interface ChoiceProps<T extends string | number> {
  field: string;
  label: string;
  hint?: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange(v: T): void;
}

export function SegChoice<T extends string | number>(p: ChoiceProps<T>) {
  return usesNativeMenu() ? <PullChoice {...p} /> : <RadioChoice {...p} />;
}

function PullChoice<T extends string | number>(p: ChoiceProps<T>) {
  const menu = usePickMenu(p.label);
  const shown = p.options.find(([v]) => v === p.value);
  if (shown === undefined) throw new Error(`Settings: ${p.label} has no option ${String(p.value)}`);
  const onChosen = (row: string): void => {
    const chosen = p.options.find(([v]) => String(v) === row);
    if (chosen === undefined) throw new Error(`${p.label}: the menu chose ${JSON.stringify(row)}, which is no row of it`);
    p.onChange(chosen[0]);
  };
  const open = (anchor: HTMLElement): void => {
    const rows = p.options.map(([v, text]) => checkRow(String(v), text, v === p.value));
    menu.open(p.field, anchor, pointBelowEnd(anchor), [{ title: null, rows }], onChosen);
  };
  return (
    <>
      <button
        type="button"
        className="settings-pick"
        data-pick={p.field}
        data-general={p.field}
        aria-label={`${p.label}: ${shown[1]}`}
        aria-describedby={p.hint}
        aria-haspopup="menu"
        aria-expanded={menu.openFor === p.field}
        onClick={(e) => open(e.currentTarget)}
      >
        {shown[1]}
      </button>
      {menu.node}
    </>
  );
}

function RadioChoice<T extends string | number>(p: ChoiceProps<T>) {
  const ids = useId();
  const radioId = (i: number): string => `${ids}-${i}`;
  const at = p.options.findIndex(([v]) => v === p.value);
  if (at < 0) throw new Error(`Settings: ${p.label} has no option ${String(p.value)}`);
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number): void => {
    const step = STEPS.get(e.key);
    if (step === undefined || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const next = (i + step + p.options.length) % p.options.length;
    const el = document.getElementById(radioId(next));
    if (el === null) throw new Error(`Settings: the ${p.options[next][1]} radio of ${p.label} is not rendered`);
    el.focus();
    p.onChange(p.options[next][0]);
  };
  return (
    <div className="seg general-seg" role="radiogroup" aria-label={p.label} aria-describedby={p.hint} data-general={p.field}>
      {p.options.map(([v, text], i) => {
        const on = i === at;
        return (
          <button
            key={String(v)}
            type="button"
            role="radio"
            id={radioId(i)}
            data-value={String(v)}
            className={on ? "active" : undefined}
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => p.onChange(v)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function datesHint(today: ReactNode): ReactNode {
  return (
    <>
      Today reads <span className="mono">{today}</span>. {CSV_KEEPS_ISO}
    </>
  );
}

const meText = (me: MeState): string => {
  switch (me.kind) {
    case "none":
      return NOBODY;
    case "live":
      return me.person.name;
    case "removed":
      return formerText(me.name);
    case "missing":
      return formerText(null);
  }
};

const meStatus = (me: MeState): string => (me.kind === "removed" ? meGoneText(me.name) : me.kind === "missing" ? meGoneText(null) : "");

function MeRow(p: { session: PlanSession; onPeople(): void }) {
  const view = usePlanView(p.session);
  const { prefs, setMe } = useDevice();
  const menu = usePickMenu(GENERAL_LABELS.me);
  const hint = useId();
  const plan = view.plan.id;
  const me = meOf(view, meFor(prefs, plan));
  const people = view.people.people;
  const value = meText(me);

  const onChosen = (row: string): void => {
    if (row === PEOPLE_SETTINGS_ROW) {
      p.onPeople();
      return;
    }
    if (row === NONE_ROW) {
      setMe(plan, null);
      return;
    }
    const id = idOfRow(PERSON_ROW, row, GENERAL_LABELS.me);
    if (!peopleOf(p.session.view().plan).some((x) => x.id === id)) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    setMe(plan, id);
  };

  const open = (anchor: HTMLElement): void => {
    const rows = [
      checkRow(NONE_ROW, NOBODY, me.kind === "none"),
      ...(people.length === 0
        ? [{ id: PEOPLE_SETTINGS_ROW, title: ADD_PEOPLE_IN_SETTINGS, checked: false, checkable: false }]
        : people.map((x) => checkRow(`${PERSON_ROW}${x.id}`, x.name, me.kind === "live" && me.person.id === x.id))),
    ];
    menu.open("me", anchor, pointBelowEnd(anchor), [{ title: null, rows }], onChosen);
  };

  return (
    <Row section={SECTION} row="me" label={GENERAL_LABELS.me} rowClassName={ROW_CLASS} hint={{ id: hint, text: meHint(view.plan.name) }} status={meStatus(me)}>
      <button
        type="button"
        className="settings-pick"
        data-pick="me"
        aria-label={`${GENERAL_LABELS.me}: ${value}`}
        aria-describedby={hint}
        aria-haspopup="menu"
        aria-expanded={menu.openFor === "me"}
        onClick={(e) => open(e.currentTarget)}
      >
        {value}
      </button>
      {menu.node}
    </Row>
  );
}

function DeviceRow(p: { device: string; renameDevice(name: string): void }) {
  const hint = useId();
  const commit = (next: string): boolean => {
    try {
      p.renameDevice(next);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      toast(e.message, "bad");
      return false;
    }
    return true;
  };
  return (
    <Row section={SECTION} row="device" label={GENERAL_LABELS.device} rowClassName={ROW_CLASS} hint={{ id: hint, text: DEVICE_HINT }}>
      <TextField className="settings-device-name" label={GENERAL_LABELS.device} describedBy={hint} value={p.device} readOnly={false} onCommit={commit} />
    </Row>
  );
}

export function General(p: { session: PlanSession | null; device: string; renameDevice(name: string): void; clock: Clock; updates: Updates | null; onPeople(): void }) {
  const { prefs, set } = useDevice();
  const style = useDateStyle();
  const hints = useId();
  const tabHint = `${hints}-tab`;
  const weekHint = `${hints}-week`;
  const datesHintId = `${hints}-dates`;
  const today = p.clock.today();
  return (
    <>
      <Row section={SECTION} row="tab" label={GENERAL_LABELS.tab} rowClassName={ROW_CLASS} hint={{ id: tabHint, text: TAB_HINT }}>
        <SegChoice field="tab" label={GENERAL_LABELS.tab} hint={tabHint} options={TAB_OPTIONS} value={prefs.tab} onChange={(tab) => set({ tab })} />
      </Row>
      <Row section={SECTION} row="week" label={GENERAL_LABELS.week} rowClassName={ROW_CLASS} hint={{ id: weekHint, text: WEEK_HINT }}>
        <SegChoice field="week" label={GENERAL_LABELS.week} hint={weekHint} options={WEEK_OPTIONS} value={prefs.week} onChange={(week) => set({ week })} />
      </Row>
      <Row section={SECTION} row="dates" label={GENERAL_LABELS.dates} rowClassName={ROW_CLASS} hint={{ id: datesHintId, text: datesHint(fmtNear(today, today, style)) }}>
        <SegChoice field="dates" label={GENERAL_LABELS.dates} hint={datesHintId} options={DATE_OPTIONS} value={prefs.dates} onChange={(dates) => set({ dates })} />
      </Row>
      {p.session === null ? (
        <Row section={SECTION} row="me" label={GENERAL_LABELS.me} rowClassName={ROW_CLASS}>
          <span className="settings-value dim">{NO_PLAN_ME}</span>
        </Row>
      ) : (
        <MeRow session={p.session} onPeople={p.onPeople} />
      )}
      <DeviceRow device={p.device} renameDevice={p.renameDevice} />
      {p.updates !== null && (
        <Row section={SECTION} row="updates" label={GENERAL_LABELS.updates}>
          <UpdateLine updates={p.updates} />
        </Row>
      )}
      <Row section={SECTION} row="about" label={GENERAL_LABELS.about} className="settings-about">
        <AboutText />
      </Row>
    </>
  );
}
