import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { newItemIntent } from "../../actions/newItem";
import { fmtShort, toIso, type Day } from "../../domain/dates";
import { STEP_COLOURS, type Item, type ItemId, type PersonId, type StepColour, type StepId } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { projectBoard, stepsOf, type Step } from "../../domain/steps";
import { readPlatform } from "../../platform";
import { haptic } from "../../services/haptics";
import type { PlanView } from "../../store/doc";
import { useNotes, usePlanView, type PlanSession } from "../../store/session";
import type { PickSection, Point } from "../common/ContextMenu";
import { CloseGlyph } from "../common/dismiss";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { pointBelow, usePickMenu } from "../common/pickMenu";
import { toast } from "../common/Toast";
import { groupPath, statusLabel, type StatusLabel } from "../list/groups";
import { createdItem } from "../palette/commands";
import { useRun } from "../run";
import { useUiValue } from "../state";
import { useDetail } from "../detail/DetailContext";
import { duplicateRow } from "../duplicate";
import { assigneeName, assignSection, cardPeople, heldOf, personOfRow } from "../people/assign";
import { Avatar } from "../people/Avatar";
import { assigneesLabel, moreText } from "../people/text";
import { planMatcher } from "../search/match";
import { isClick } from "../timeline/gesture";
import { useDeleteStep } from "./DeleteStep";
import { HoldGesture, type HoldEvent } from "./hold";
import { boardLayout, filterLayout, nearnessOf, statusOf, type BoardColumn, type BoardLayout } from "./layout";
import { MoveAll } from "./MoveAll";
import { useBoardPrefs, writeBoardPrefs, type BoardPrefs } from "./prefs";
import { ColourPop, LimitPop, limitOfText } from "./StepPopovers";
import {
  addLabel,
  BY_DATES,
  CARD_MENU,
  CLEAR_SEARCH,
  collapseLabel,
  COLOUR_ROW,
  COMPLETES_ROW,
  countText,
  DELETE,
  DELETE_ROW,
  doneStripLabel,
  DRAFT_PLACEHOLDER,
  draftLabel,
  DROP_TO_FINISH,
  DUPLICATE_ROW,
  filteredText,
  HIDE_ROW,
  hiddenDoneText,
  hiddenStripLabel,
  INSERT_LEFT,
  INSERT_RIGHT,
  LATE,
  LIMIT_ROW,
  moreLabel,
  MOVE_TO,
  newStepName,
  NO_STEP,
  NO_STEP_LINE,
  NOTHING_HERE,
  nothingMatchesText,
  OPEN_ROW,
  overLimit,
  RENAME,
  renameLabel,
  soonText,
  STEP_MENU,
} from "./text";

const NO_STEP_KEY = "no-step";

export const STEP_DRAG = "application/x-webboard-step";

const DOT: Readonly<Record<StatusLabel, string>> = {
  conflict: "dot conflict",
  held: "dot held",
  late: "dot late",
  "in progress": "dot doing",
  done: "dot",
  "not started": "dot",
};

type HeadRow = "rename" | "colour" | "limit" | "completes" | "insert-left" | "insert-right" | "hide" | "delete";

const HEAD_ROWS: readonly HeadRow[] = ["rename", "colour", "limit", "completes", "insert-left", "insert-right", "hide", "delete"];

const headRowOf = (id: string): HeadRow => {
  const found = HEAD_ROWS.find((r) => r === id);
  if (found === undefined) throw new Error(`Board: the step menu chose ${JSON.stringify(id)}, which is no row of it`);
  return found;
};

type Pop = { kind: "colour" | "limit"; step: StepId; at: Point; back: HTMLElement };

type HoldTarget = { k: "step"; step: StepId } | { k: "card"; item: ItemId; x: number; y: number };

type Holding = { target: HoldTarget; anchor: HTMLElement; pointer: number; held: boolean };

const STEP_ROW = "step:";

const stepStyle = (c: StepColour): CSSProperties => ({ "--step": `var(--s-${c})` });

const dayOf = (m: ReadonlyMap<ItemId, Day>, id: ItemId, what: string): string => {
  const d = m.get(id);
  if (d === undefined) throw new Error(`Board: scheduled item ${id} has no ${what}`);
  return fmtShort(toIso(d));
};

function When(p: { view: PlanView; item: Item }) {
  const sc = p.item.schedule;
  if (sc === null) throw new Error(`Board: item ${p.item.id} has no schedule`);
  if (sc.start === null) return <span className="unsched">unscheduled</span>;
  const start = dayOf(p.view.derived.start, p.item.id, "start");
  if (p.item.kind === "milestone") return <span className="when">◆ {start}</span>;
  return <span className="when">{`${start} – ${dayOf(p.view.derived.end, p.item.id, "end")}`}</span>;
}

function Near(p: { view: PlanView; layout: BoardLayout; item: Item }) {
  const near = nearnessOf(p.view, p.layout.mode, p.item);
  if (near === null) return null;
  if (near.kind === "late") return <span className="badge late">{LATE}</span>;
  return <span className="badge soon">{soonText(near.days)}</span>;
}

const groupName = (view: PlanView, item: Item): string | null => (item.place.parent === null ? null : groupPath(view, item.place.parent));

function CardPeople(p: { view: PlanView; item: Item }) {
  const list = p.view.people.assignees.get(p.item.id) ?? [];
  const shown = cardPeople(list);
  if (shown === null) return null;
  const label = assigneesLabel(list.map(assigneeName));
  return (
    <span className="card-people" role="img" aria-label={label} title={label}>
      <Avatar assignee={shown.first} />
      {shown.more > 0 && <span className="avatar-more">{moreText(shown.more)}</span>}
    </span>
  );
}

function BoardLine(p: { layout: BoardLayout; completing: boolean; query: string; onClear(): void }) {
  const l = p.layout;
  return (
    <p className="board-line" role="status">
      {p.query !== "" && (
        <span className="filter-chip" data-filter-chip="">
          <span className="chip-text">{filteredText(p.query)}</span>
          <button type="button" className="chip-x" aria-label={CLEAR_SEARCH} title={CLEAR_SEARCH} onClick={p.onClear}>
            <CloseGlyph />
          </button>
        </span>
      )}
      {l.mode === "dates" && (
        <span className="quiet-line" data-by-dates="">
          {BY_DATES}
        </span>
      )}
      {!p.completing && l.hiddenDone > 0 && (
        <span className="quiet-line" data-done-hidden="">
          {hiddenDoneText(l.hiddenDone)}
        </span>
      )}
      {l.problems.map((text) => (
        <span key={text} className="board-problem">
          {text}
        </span>
      ))}
    </p>
  );
}

function RenameInput(p: { step: Step; onCommit(name: string): void; onCancel(): void }) {
  const [text, setText] = useState(p.step.name);
  const input = useRef<HTMLInputElement>(null);
  const ended = useRef(false);
  useEffect(() => {
    const el = input.current;
    if (el === null) throw new Error("Board: the rename field rendered without its element");
    el.focus();
    el.select();
  }, []);
  return (
    <input
      ref={input}
      type="text"
      className="col-rename"
      aria-label={renameLabel(p.step.name)}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          p.onCommit(text);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          ended.current = true;
          p.onCancel();
        }
      }}
      onBlur={() => {
        if (!ended.current) p.onCommit(text);
      }}
    />
  );
}

function DraftCard(p: { step: Step; onCommit(name: string): boolean; onDiscard(): void }) {
  const [text, setText] = useState("");
  const ended = useRef(false);
  const end = (): void => {
    if (ended.current) return;
    if (text.trim() === "") {
      ended.current = true;
      p.onDiscard();
      return;
    }
    ended.current = p.onCommit(text.trim());
  };
  return (
    <div className="card card-draft">
      <input
        type="text"
        className="card-draft-name"
        aria-label={draftLabel(p.step.name)}
        placeholder={DRAFT_PLACEHOLDER}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            end();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            ended.current = true;
            p.onDiscard();
          }
        }}
        onBlur={end}
      />
    </div>
  );
}

const action = (id: string, title: string) => ({ id, title, checked: false, checkable: false });

const headSections = (step: Step, hidden: boolean, readOnly: boolean): readonly PickSection[] => {
  const hide = { id: "hide", title: HIDE_ROW, checked: hidden, checkable: true };
  if (readOnly) return [{ title: null, rows: [hide] }];
  return [
    {
      title: null,
      rows: [action("rename", RENAME), action("colour", COLOUR_ROW), action("limit", LIMIT_ROW), { id: "completes", title: COMPLETES_ROW, checked: step.completes, checkable: true }],
    },
    { title: null, rows: [action("insert-left", INSERT_LEFT), action("insert-right", INSERT_RIGHT), hide] },
    { title: null, rows: [action("delete", DELETE_ROW)] },
  ];
};

const returnFocusOf = (anchor: HTMLElement): HTMLElement => {
  if (anchor.matches(".col-more, .col-strip")) return anchor;
  const more = anchor.querySelector<HTMLElement>(".col-more");
  if (more === null) throw new Error("Board: a step menu opened from an element with no options button");
  return more;
};

export function Board(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const { ui, setUi } = useUiValue();
  const detail = useDetail();
  const { run } = useRun(p.session);
  const prefs = useBoardPrefs(view.plan.id);
  const menu = usePickMenu(STEP_MENU);
  const cardMenu = usePickMenu(CARD_MENU);
  const deleting = useDeleteStep(p.session);
  const down = useRef<{ id: ItemId; x: number; y: number } | null>(null);
  const dragged = useRef<ItemId | null>(null);
  const draggedStep = useRef<StepId | null>(null);
  const holding = useRef<Holding | null>(null);
  const gesture = useRef<HoldGesture | null>(null);
  const onHoldRef = useRef<(events: readonly HoldEvent[]) => void>(() => undefined);
  const suppressClick = useRef<StepId | null>(null);
  const stopScroll = useRef<(() => void) | null>(null);
  const lostRef = useRef<(e: PointerEvent) => void>(() => undefined);
  const [liftedStep, setLiftedStep] = useState<StepId | null>(null);
  const [liftedCard, setLiftedCard] = useState<ItemId | null>(null);
  const [over, setOver] = useState<StepId | null>(null);
  const [draft, setDraft] = useState<StepId | null>(null);
  const [renaming, setRenaming] = useState<StepId | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const projection = projectBoard(view.plan, view.derived);
  const query = ui.query.trim();
  const notesSeen = useNotes(p.session, query !== "");
  const session = p.session;
  const match = useMemo(() => planMatcher(view, (id) => session.note(id).toString(), query), [view, session, query, notesSeen]);
  const layout = filterLayout(boardLayout(view, projection, prefs), match);
  const steps = projection.steps;
  const live: ReadonlySet<StepId> = new Set(steps.map((s) => s.id));
  const os = readPlatform(window).os;
  const ios = os === "ios";

  useEffect(() => {
    const lost = (e: PointerEvent): void => lostRef.current(e);
    window.addEventListener("pointerup", lost);
    window.addEventListener("pointercancel", lost);
    return () => {
      window.removeEventListener("pointerup", lost);
      window.removeEventListener("pointercancel", lost);
      const g = gesture.current;
      if (g !== null) g.cancelAll();
      holding.current = null;
      const unblock = stopScroll.current;
      stopScroll.current = null;
      if (unblock !== null) unblock();
    };
  }, []);

  const setPrefs = (next: BoardPrefs): void => writeBoardPrefs(window.localStorage, view.plan.id, next, live);

  const liveStep = (id: StepId): Step | null => stepsOf(p.session.view().plan).find((s) => s.id === id) ?? null;

  const moveTo = (id: ItemId, to: StepId): void => {
    if (!view.plan.items.has(id)) throw new Error(`Board: dragged item ${id} is not in the plan`);
    const now = p.session.view();
    const current = projectBoard(now.plan, now.derived).columnOf.get(id);
    if (current === undefined) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    if (current === to) return;
    run({ t: "toStep", items: [id], step: to });
  };

  const reorderTo = (source: StepId, target: StepId): void => {
    const all = stepsOf(p.session.view().plan);
    const from = all.findIndex((s) => s.id === source);
    const to = all.findIndex((s) => s.id === target);
    if (from < 0 || to < 0) throw new Error(`Board: reorder from ${source} to ${target} names a step that is not live`);
    if (from === to) return;
    const after = to > from ? target : to === 0 ? null : all[to - 1].id;
    run({ t: "step", op: "reorder", step: source, after });
  };

  const reveal = (id: StepId): void => {
    const c = layout.columns.find((x) => x.kind !== "noStep" && x.step.id === id);
    if (c === undefined) throw new Error(`Board: step ${id} has no column`);
    if (c.kind === "hiddenStrip") setPrefs({ ...prefs, hidden: prefs.hidden.filter((h) => h !== id) });
    if (c.kind === "doneStrip") setPrefs({ ...prefs, doneOpen: true });
  };

  const insert = (id: StepId, side: "left" | "right"): void => {
    const all = stepsOf(p.session.view().plan);
    const at = all.findIndex((s) => s.id === id);
    if (at < 0) throw new Error(`Board: insert next to ${id}, which is not live`);
    const after = side === "right" ? id : at === 0 ? null : all[at - 1].id;
    const used = new Set(all.map((s) => s.colour));
    const colour = STEP_COLOURS.find((c) => !used.has(c)) ?? "slate";
    const name = newStepName(all.map((s) => s.name));
    const built = run({ t: "step", op: "add", name, colour, after });
    if (built === null) return;
    const made = stepsOf(p.session.view().plan).find((s) => s.name === name);
    if (made === undefined) throw new Error(`Board: the new step ${name} is not in the plan`);
    setRenaming(made.id);
  };

  const onHeadChosen = (id: StepId, row: HeadRow, below: Point, back: HTMLElement): void => {
    const step = liveStep(id);
    if (step === null) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    switch (row) {
      case "rename":
        reveal(step.id);
        setRenaming(step.id);
        return;
      case "colour":
        setPop({ kind: "colour", step: step.id, at: below, back });
        return;
      case "limit":
        setPop({ kind: "limit", step: step.id, at: below, back });
        return;
      case "completes":
        run({ t: "step", op: "completes", step: step.id, completes: !step.completes });
        return;
      case "insert-left":
        insert(step.id, "left");
        return;
      case "insert-right":
        insert(step.id, "right");
        return;
      case "hide":
        setPrefs({ ...prefs, hidden: prefs.hidden.includes(step.id) ? prefs.hidden.filter((h) => h !== step.id) : [...prefs.hidden, step.id] });
        return;
      case "delete":
        deleting.ask(step.id);
        return;
    }
  };

  const openHead = (step: Step, anchor: HTMLElement, at: Point): void => {
    const below = pointBelow(anchor);
    const back = returnFocusOf(anchor);
    menu.open(step.id, anchor, at, headSections(step, prefs.hidden.includes(step.id), p.readOnly), (row) => onHeadChosen(step.id, headRowOf(row), below, back));
  };

  const onHeadContext = (e: ReactMouseEvent<HTMLElement>, step: Step): void => {
    e.preventDefault();
    if (ios && holding.current !== null) return;
    openHead(step, e.currentTarget, { x: e.clientX, y: e.clientY });
  };

  const cardSections = (item: ItemId): readonly PickSection[] => {
    const open = { title: null, rows: [action("open", OPEN_ROW)] };
    if (p.readOnly) return [open];
    const current = projection.columnOf.get(item);
    const assign = assignSection(view.people.people, heldOf(view, item));
    return [
      open,
      { title: MOVE_TO, rows: steps.map((s) => ({ id: `${STEP_ROW}${s.id}`, title: s.name, checked: s.id === current, checkable: true })) },
      ...(assign === null ? [] : [assign]),
      { title: null, rows: [action("duplicate", DUPLICATE_ROW), action("delete", DELETE)] },
    ];
  };

  const toggleAssignee = (item: ItemId, person: PersonId, held: boolean): void => {
    const now = p.session.view().plan;
    const it = now.items.get(item);
    if (it === undefined) throw new Error(`Board: the card menu assigned item ${item}, which is not in the plan`);
    if (it.trashed || !peopleOf(now).some((x) => x.id === person)) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    run({ t: held ? "unassign" : "assign", items: [item], person });
  };

  const onCardChosen = (item: ItemId, row: string, held: readonly PersonId[]): void => {
    if (row === "open") {
      detail.promote(item);
      return;
    }
    if (row === "duplicate") {
      duplicateRow(run, () => p.session.view(), ui, setUi, item);
      return;
    }
    if (row === "delete") {
      run({ t: "trash", items: [item] });
      return;
    }
    const person = personOfRow(row);
    if (person !== null) {
      toggleAssignee(item, person, held.includes(person));
      return;
    }
    if (!row.startsWith(STEP_ROW)) throw new Error(`Board: the card menu chose ${JSON.stringify(row)}, which is no row of it`);
    const step = liveStep(row.slice(STEP_ROW.length));
    if (step === null) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    moveTo(item, step.id);
  };

  const openCard = (item: ItemId, anchor: HTMLElement, at: Point): void => {
    const held = heldOf(view, item);
    cardMenu.open(item, anchor, at, cardSections(item), (row) => onCardChosen(item, row, held));
  };

  const onCardContext = (e: ReactMouseEvent<HTMLElement>, item: ItemId): void => {
    e.preventDefault();
    if (ios && holding.current !== null) return;
    openCard(item, e.currentTarget, { x: e.clientX, y: e.clientY });
  };

  const dropTargetAt = (x: number, y: number): StepId | null => {
    const el = document.elementFromPoint(x, y);
    const target = el === null ? null : el.closest<HTMLElement>("[data-drop]");
    const id = target === null ? undefined : target.dataset.drop;
    return id !== undefined && live.has(id) ? id : null;
  };

  const blockScroll = (): void => {
    if (stopScroll.current !== null) return;
    const stop = (e: Event): void => e.preventDefault();
    document.addEventListener("touchmove", stop, { passive: false });
    stopScroll.current = () => document.removeEventListener("touchmove", stop);
  };

  const endLift = (): void => {
    const unblock = stopScroll.current;
    stopScroll.current = null;
    if (unblock !== null) unblock();
    setLiftedStep(null);
    setLiftedCard(null);
    setOver(null);
  };

  const onMenuHold = (target: HoldTarget, anchor: HTMLElement): void => {
    if (target.k === "card") {
      openCard(target.item, anchor, pointBelow(anchor));
      return;
    }
    const step = liveStep(target.step);
    if (step === null) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    openHead(step, anchor, pointBelow(anchor));
  };

  const onHold = (events: readonly HoldEvent[], h: Holding | null): void => {
    if (h === null) {
      if (events.length > 0) throw new Error(`Board: a hold emitted ${events.map((e) => e.k).join(", ")} without a held header or card`);
      return;
    }
    const target = h.target;
    events.forEach((ev) => {
      switch (ev.k) {
        case "held":
          h.held = true;
          blockScroll();
          if (target.k === "step") setLiftedStep(target.step);
          else setLiftedCard(target.item);
          haptic("medium");
          return;
        case "drag":
          setOver(dropTargetAt(ev.x, ev.y));
          return;
        case "drop": {
          const to = dropTargetAt(ev.x, ev.y);
          endLift();
          if (to === null) return;
          if (target.k === "step") reorderTo(target.step, to);
          else moveTo(target.item, to);
          return;
        }
        case "menu":
          endLift();
          onMenuHold(target, h.anchor);
          return;
        case "cancel":
          endLift();
          return;
        case "tap":
          if (target.k === "card") detail.press({ item: target.item, x: target.x, y: target.y, at: performance.now() });
          return;
      }
    });
  };

  const sample = (e: ReactPointerEvent<HTMLElement>) => ({ pointer: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp });

  const gestureOf = (): HoldGesture => {
    const known = gesture.current;
    if (known !== null) return known;
    const made = new HoldGesture({
      schedule: (ms, fn) => {
        const t = window.setTimeout(fn, ms);
        return () => window.clearTimeout(t);
      },
      emit: (events) => onHoldRef.current(events),
    });
    gesture.current = made;
    return made;
  };

  const released = (events: readonly HoldEvent[]): void => {
    const h = holding.current;
    holding.current = null;
    if (h !== null && h.held && h.target.k === "step") suppressClick.current = h.target.step;
    onHold(events, h);
  };

  useLayoutEffect(() => {
    onHoldRef.current = (events) => onHold(events, holding.current);
    lostRef.current = (e) => {
      const h = holding.current;
      if (h === null || h.pointer !== e.pointerId) return;
      released(gestureOf().cancel(e.pointerId));
    };
  });

  const holdDown = (e: ReactPointerEvent<HTMLElement>, target: HoldTarget): void => {
    if (holding.current === null) holding.current = { target, anchor: e.currentTarget, pointer: e.pointerId, held: false };
    onHold(gestureOf().down(sample(e)), holding.current);
  };

  const holdMove = (e: ReactPointerEvent<HTMLElement>): void => onHold(gestureOf().move(sample(e)), holding.current);

  const holdUp = (e: ReactPointerEvent<HTMLElement>): void => released(gestureOf().up(sample(e)));

  const holdCancel = (e: ReactPointerEvent<HTMLElement>): void => released(gestureOf().cancel(e.pointerId));

  const touchOnIos = (e: ReactPointerEvent<HTMLElement>): boolean => ios && e.pointerType !== "mouse";

  const headTouch = (step: Step) =>
    !ios
      ? {}
      : {
          onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
            if (!touchOnIos(e)) return;
            suppressClick.current = null;
            const inner = e.target instanceof Element ? e.target.closest("button, input") : null;
            if (inner !== null && inner !== e.currentTarget) return;
            holdDown(e, { k: "step", step: step.id });
          },
          onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
            if (touchOnIos(e)) holdMove(e);
          },
          onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
            if (touchOnIos(e)) holdUp(e);
          },
          onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
            if (touchOnIos(e)) holdCancel(e);
          },
        };

  const consumedHold = (step: Step): boolean => {
    if (suppressClick.current !== step.id) return false;
    suppressClick.current = null;
    return true;
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>, id: ItemId): void => {
    if (e.button !== 0 || (os === "macos" && e.ctrlKey)) {
      down.current = null;
      return;
    }
    down.current = { id, x: e.clientX, y: e.clientY };
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>, id: ItemId): void => {
    const d = down.current;
    down.current = null;
    if (d === null || d.id !== id || !isClick(d, { x: e.clientX, y: e.clientY })) return;
    detail.press({ item: id, x: e.clientX, y: e.clientY, at: performance.now() });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: ItemId): void => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (e.key === "Enter") detail.rename(id);
    else detail.promote(id);
  };

  const onDragStart = (e: ReactDragEvent<HTMLDivElement>, id: ItemId): void => {
    down.current = null;
    dragged.current = id;
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  };

  const onHeadDragStart = (e: ReactDragEvent<HTMLElement>, id: StepId): void => {
    draggedStep.current = id;
    e.dataTransfer.setData(STEP_DRAG, id);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragEnd = (): void => {
    dragged.current = null;
    draggedStep.current = null;
    setOver(null);
  };

  const onDragOver = (e: ReactDragEvent<HTMLElement>, to: StepId): void => {
    if (dragged.current === null && draggedStep.current === null) return;
    e.preventDefault();
    if (over !== to) setOver(to);
  };

  const onDragLeave = (e: ReactDragEvent<HTMLElement>): void => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setOver(null);
  };

  const onDrop = (e: ReactDragEvent<HTMLElement>, to: StepId): void => {
    e.preventDefault();
    const id = dragged.current;
    const step = draggedStep.current;
    dragged.current = null;
    draggedStep.current = null;
    setOver(null);
    if (step !== null) reorderTo(step, to);
    else if (id !== null) moveTo(id, to);
  };

  const dropProps = (to: StepId) =>
    p.readOnly
      ? {}
      : {
          "data-drop": to,
          onDragOver: (e: ReactDragEvent<HTMLElement>) => onDragOver(e, to),
          onDragLeave,
          onDrop: (e: ReactDragEvent<HTMLElement>) => onDrop(e, to),
        };

  const commitRename = (step: Step, name: string): void => {
    if (liveStep(step.id) === null) return;
    if (name.trim() === step.name) {
      setRenaming(null);
      return;
    }
    if (run({ t: "step", op: "rename", step: step.id, name }) !== null) setRenaming(null);
  };

  const commitDraft = (step: Step, name: string): boolean => {
    if (liveStep(step.id) === null) return true;
    const now = p.session.view();
    const built = run(newItemIntent(now, now.today, "task", name, { column: step.id }));
    if (built === null) return false;
    setDraft(null);
    setUi({ selected: createdItem(built) });
    return true;
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

  const applyLimit = (id: StepId, text: string): void => {
    const step = liveStep(id);
    if (step === null) {
      setPop(null);
      toast(STALE_CONFIRM, "bad");
      return;
    }
    const limit = limitOfText(text);
    if (limit === step.limit) {
      setPop(null);
      return;
    }
    if (run({ t: "step", op: "limit", step: id, limit }) !== null) setPop(null);
  };

  const card = (item: Item) => {
    const group = groupName(view, item);
    const drags = !p.readOnly && !ios;
    return (
      <div
        key={item.id}
        className={["card", ...(ui.selected === item.id ? ["selected"] : []), ...(liftedCard === item.id ? ["lifted"] : [])].join(" ")}
        data-card={item.id}
        tabIndex={0}
        draggable={drags}
        onPointerDown={(e) => {
          if (touchOnIos(e)) holdDown(e, { k: "card", item: item.id, x: e.clientX, y: e.clientY });
          else onDown(e, item.id);
        }}
        onPointerMove={(e) => {
          if (touchOnIos(e)) holdMove(e);
        }}
        onPointerUp={(e) => {
          if (touchOnIos(e)) holdUp(e);
          else onUp(e, item.id);
        }}
        onPointerCancel={(e) => {
          if (touchOnIos(e)) holdCancel(e);
          else down.current = null;
        }}
        onContextMenu={(e) => onCardContext(e, item.id)}
        onKeyDown={(e) => onKey(e, item.id)}
        onDragStart={drags ? (e) => onDragStart(e, item.id) : undefined}
        onDragEnd={drags ? onDragEnd : undefined}
      >
        <div className="card-top">
          <span className={DOT[statusLabel(view, item.id)]} />
          <span className="card-name">{item.name}</span>
        </div>
        <div className="card-meta">
          <When view={view} item={item} />
          {group !== null && <span className="card-group">{group}</span>}
          <Near view={view} layout={layout} item={item} />
          <CardPeople view={view} item={item} />
        </div>
      </div>
    );
  };

  const strip = (step: Step, count: number, hidden: boolean) => (
    <button
      key={step.id}
      type="button"
      className={["col-strip", hidden ? "strip-hidden" : "strip-done", ...(over === step.id ? ["over"] : []), ...(liftedStep === step.id ? ["lifted"] : [])].join(" ")}
      style={stepStyle(step.colour)}
      data-col={step.id}
      data-strip={hidden ? "hidden" : "done"}
      aria-label={hidden ? hiddenStripLabel(step.name, count) : doneStripLabel(step.name, count)}
      draggable={!p.readOnly && !ios}
      onDragStart={p.readOnly || ios ? undefined : (e) => onHeadDragStart(e, step.id)}
      onDragEnd={p.readOnly || ios ? undefined : onDragEnd}
      onClick={() => {
        if (consumedHold(step)) return;
        setPrefs(hidden ? { ...prefs, hidden: prefs.hidden.filter((id) => id !== step.id) } : { ...prefs, doneOpen: true });
      }}
      onContextMenu={(e) => onHeadContext(e, step)}
      {...headTouch(step)}
      {...dropProps(step.id)}
    >
      <span className="swatch" />
      <span className="strip-count">{count}</span>
      <span className="strip-name">{step.name}</span>
    </button>
  );

  const emptyNote = (items: readonly Item[], completing: boolean): string => (items.length > 0 ? nothingMatchesText(query) : completing ? DROP_TO_FINISH : NOTHING_HERE);

  const stepColumn = (step: Step, items: readonly Item[], shown: readonly Item[], completing: boolean) => {
    const past = step.limit !== null && items.length > step.limit;
    const naming = renaming === step.id;
    return (
      <section
        key={step.id}
        className={["col", ...(over === step.id ? ["over"] : []), ...(liftedStep === step.id ? ["lifted"] : [])].join(" ")}
        style={stepStyle(step.colour)}
        data-col={step.id}
        {...dropProps(step.id)}
      >
        <div
          className="col-head"
          draggable={!p.readOnly && !ios && !naming}
          onDragStart={p.readOnly || ios || naming ? undefined : (e) => onHeadDragStart(e, step.id)}
          onDragEnd={p.readOnly || ios || naming ? undefined : onDragEnd}
          onContextMenu={(e) => onHeadContext(e, step)}
          {...headTouch(step)}
        >
          <span className="swatch" />
          {naming ? <RenameInput step={step} onCommit={(name) => commitRename(step, name)} onCancel={() => setRenaming(null)} /> : <h2>{step.name.toLocaleUpperCase()}</h2>}
          <span className={past ? "col-count over" : "col-count"} title={past && step.limit !== null ? overLimit(step.limit) : undefined}>
            {countText(items.length, step.limit)}
          </span>
          {!p.readOnly && (
            <button type="button" className="col-btn col-add" aria-label={addLabel(step.name)} title={addLabel(step.name)} onClick={() => setDraft(step.id)}>
              <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="col-btn col-more"
            aria-label={moreLabel(step.name)}
            title={moreLabel(step.name)}
            aria-haspopup="menu"
            aria-expanded={menu.openFor === step.id}
            onClick={(e) => openHead(step, e.currentTarget, pointBelow(e.currentTarget))}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
              <circle cx="3.5" cy="8" r="1.3" />
              <circle cx="8" cy="8" r="1.3" />
              <circle cx="12.5" cy="8" r="1.3" />
            </svg>
          </button>
          {completing && prefs.doneOpen && items.every((i) => statusOf(view, i.id) === "done") && (
            <button type="button" className="col-btn col-collapse" aria-label={collapseLabel(step.name)} title={collapseLabel(step.name)} onClick={() => setPrefs({ ...prefs, doneOpen: false })}>
              <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M10 3 5 8l5 5" />
              </svg>
            </button>
          )}
        </div>
        <div className="col-body">
          {draft === step.id && !p.readOnly && <DraftCard key={`draft-${step.id}`} step={step} onCommit={(name) => commitDraft(step, name)} onDiscard={() => setDraft(null)} />}
          {shown.length === 0 ? draft === step.id ? null : <p className="note">{emptyNote(items, completing)}</p> : shown.map(card)}
        </div>
      </section>
    );
  };

  const noStepColumn = (items: readonly Item[], shown: readonly Item[]) => (
    <section key={NO_STEP_KEY} className="col col-nostep" data-col={NO_STEP_KEY}>
      <div className="col-head">
        <span className="swatch warn" />
        <h2>{NO_STEP}</h2>
        <span className="col-badge">{items.length}</span>
      </div>
      <div className="col-note">
        <span>{NO_STEP_LINE}</span>
        {!p.readOnly && shown.length > 0 && <MoveAll steps={steps} onPick={(step) => run({ t: "toStep", items: shown.map((i) => i.id), step })} />}
      </div>
      <div className="col-body">{shown.length === 0 ? <p className="note">{emptyNote(items, false)}</p> : shown.map(card)}</div>
    </section>
  );

  const column = (c: BoardColumn) => {
    if (c.kind === "noStep") return noStepColumn(c.items, c.shown);
    if (c.kind === "doneStrip") return strip(c.step, c.count, false);
    if (c.kind === "hiddenStrip") return strip(c.step, c.count, true);
    return stepColumn(c.step, c.items, c.shown, c.completing);
  };

  const popStep = pop === null ? undefined : steps.find((s) => s.id === pop.step);
  const popGone = pop !== null && popStep === undefined;

  useEffect(() => {
    if (!popGone) return;
    setPop(null);
    toast(STALE_CONFIRM, "bad");
  }, [popGone]);

  const draftGone = draft !== null && !live.has(draft);
  useEffect(() => {
    if (!draftGone) return;
    setDraft(null);
    toast(STALE_CONFIRM, "bad");
  }, [draftGone]);

  const renameGone = renaming !== null && !live.has(renaming);
  useEffect(() => {
    if (!renameGone) return;
    setRenaming(null);
    toast(STALE_CONFIRM, "bad");
  }, [renameGone]);

  return (
    <div className="board">
      <BoardLine layout={layout} completing={projection.completing !== null} query={query} onClear={() => setUi({ query: "" })} />
      <div className="nnl">
        {layout.empty !== null && (
          <p className="note" data-empty-board="">
            {layout.empty}
          </p>
        )}
        {layout.columns.map(column)}
      </div>
      {menu.node}
      {cardMenu.node}
      {pop !== null && popStep !== undefined && pop.kind === "colour" && <ColourPop name={popStep.name} colour={popStep.colour} at={pop.at} back={pop.back} onPick={(c) => pickColour(popStep.id, c)} onClose={() => setPop(null)} />}
      {pop !== null && popStep !== undefined && pop.kind === "limit" && (
        <LimitPop step={popStep} at={pop.at} back={pop.back} onApply={(text) => applyLimit(popStep.id, text)} onClear={() => applyLimit(popStep.id, "")} onClose={() => setPop(null)} />
      )}
      {deleting.node}
    </div>
  );
}
