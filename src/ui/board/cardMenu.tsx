import type { ReactNode } from "react";
import type { ItemId, PersonId, StepId } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { projectBoard, stepsOf, type Step } from "../../domain/steps";
import { usePlanView, type PlanSession } from "../../store/session";
import type { PickSection, Point } from "../common/ContextMenu";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { usePickMenu } from "../common/pickMenu";
import { toast } from "../common/Toast";
import { duplicateRow } from "../duplicate";
import { assignSection, heldOf, personOfRow } from "../people/assign";
import { useRun } from "../run";
import { useUiValue } from "../state";
import { CARD_MENU, DELETE, DUPLICATE_ROW, MOVE_TO, OPEN_ROW } from "./text";

const STEP_ROW = "step:";

export interface CardMenu {
  open(item: ItemId, anchor: HTMLElement, at: Point): void;
  moveTo(item: ItemId, to: StepId): void;
  openFor: string | null;
  node: ReactNode;
}

export const actionRow = (id: string, title: string) => ({ id, title, checked: false, checkable: false });

export const liveStep = (session: PlanSession, id: StepId): Step | null => stepsOf(session.view().plan).find((s) => s.id === id) ?? null;

export function useCardMenu(session: PlanSession, readOnly: boolean, onOpen: (item: ItemId) => void): CardMenu {
  const view = usePlanView(session);
  const { ui, setUi } = useUiValue();
  const { run } = useRun(session);
  const menu = usePickMenu(CARD_MENU);

  const moveTo = (id: ItemId, to: StepId): void => {
    if (!view.plan.items.has(id)) throw new Error(`Board: dragged item ${id} is not in the plan`);
    const now = session.view();
    const current = projectBoard(now.plan, now.derived).columnOf.get(id);
    if (current === undefined) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    if (current === to) return;
    run({ t: "toStep", items: [id], step: to });
  };

  const cardSections = (item: ItemId): readonly PickSection[] => {
    const open = { title: null, rows: [actionRow("open", OPEN_ROW)] };
    if (readOnly) return [open];
    const projection = projectBoard(view.plan, view.derived);
    const current = projection.columnOf.get(item);
    const assign = assignSection(view.people.people, heldOf(view, item));
    return [
      open,
      { title: MOVE_TO, rows: projection.steps.map((s) => ({ id: `${STEP_ROW}${s.id}`, title: s.name, checked: s.id === current, checkable: true })) },
      ...(assign === null ? [] : [assign]),
      { title: null, rows: [actionRow("duplicate", DUPLICATE_ROW), actionRow("delete", DELETE)] },
    ];
  };

  const toggleAssignee = (item: ItemId, person: PersonId, held: boolean): void => {
    const now = session.view().plan;
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
      onOpen(item);
      return;
    }
    if (row === "duplicate") {
      duplicateRow(run, () => session.view(), ui, setUi, item);
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
    const step = liveStep(session, row.slice(STEP_ROW.length));
    if (step === null) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    moveTo(item, step.id);
  };

  const open = (item: ItemId, anchor: HTMLElement, at: Point): void => {
    const held = heldOf(view, item);
    menu.open(item, anchor, at, cardSections(item), (row) => onCardChosen(item, row, held));
  };

  return { open, moveTo, openFor: menu.openFor, node: menu.node };
}
