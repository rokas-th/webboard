import { useCallback, useSyncExternalStore } from "react";
import type { PlanId, StepId } from "../../domain/model";
import { projectBoard, type Step } from "../../domain/steps";
import type { PlanView } from "../../store/doc";
import type { PlanSession } from "../../store/session";
import { useBoardPrefs, writeBoardPrefs, type BoardPrefs } from "../board/prefs";
import type { PickRow, PickSection } from "../common/ContextMenu";
import { resetColumns } from "../list/columnOps";
import { useListPrefs, writeListPrefs, type GroupBy, type ListPrefs } from "../list/prefs";
import { COLUMNS_MORE, GROUP_BY, GROUP_LABELS, RESET_COLUMNS } from "../list/text";
import { useUiValue, type ViewKind } from "../state";

export const DISPLAY_OPTIONS = "Display options";

const EXPAND_DONE = "Expand the Done column";

const STEPS_TITLE = "Steps";

export interface DisplayMenu {
  sections: readonly PickSection[];
  run(id: string): void;
}

const GROUPINGS: readonly GroupBy[] = ["outline", "step", "assignee", "none"];

const GROUP_ROW = "group:";

const STEP_ROW = "step:";

const row = (id: string, title: string, checked: boolean | null): PickRow => ({ id, title, checked: checked === true, checkable: checked !== null });

const unknown = (id: string, where: string): Error => new Error(`Display: no row ${JSON.stringify(id)} on the ${where}`);

function listDisplay(prefs: ListPrefs, write: (next: ListPrefs) => void, askColumns: () => void): DisplayMenu {
  return {
    sections: [
      { title: GROUP_BY, rows: GROUPINGS.map((g) => row(`${GROUP_ROW}${g}`, GROUP_LABELS[g], prefs.group === g)) },
      { title: null, rows: [row("columns", COLUMNS_MORE, null), row("reset-columns", RESET_COLUMNS, null)] },
    ],
    run: (id) => {
      const group = GROUPINGS.find((g) => `${GROUP_ROW}${g}` === id);
      if (group !== undefined) write({ ...prefs, group });
      else if (id === "columns") askColumns();
      else if (id === "reset-columns") write(resetColumns(prefs));
      else throw unknown(id, "List");
    },
  };
}

function boardDisplay(steps: readonly Step[], completing: boolean, prefs: BoardPrefs, write: (next: BoardPrefs) => void): DisplayMenu {
  const done: PickSection[] = completing ? [{ title: null, rows: [row("done-open", EXPAND_DONE, prefs.doneOpen)] }] : [];
  return {
    sections: [...done, { title: STEPS_TITLE, rows: steps.map((s) => row(`${STEP_ROW}${s.id}`, s.name, !prefs.hidden.includes(s.id))) }],
    run: (id) => {
      const step = steps.find((s) => `${STEP_ROW}${s.id}` === id);
      if (step !== undefined) write({ ...prefs, hidden: prefs.hidden.includes(step.id) ? prefs.hidden.filter((h) => h !== step.id) : [...prefs.hidden, step.id] });
      else if (id === "done-open" && completing) write({ ...prefs, doneOpen: !prefs.doneOpen });
      else throw unknown(id, "Board");
    },
  };
}

const quiet = (): (() => void) => () => undefined;

function usePlanViewOf(session: PlanSession | null): PlanView | null {
  const subscribe = useCallback((cb: () => void) => (session === null ? quiet() : session.subscribe(cb)), [session]);
  const snapshot = useCallback(() => (session === null ? null : session.view()), [session]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function useDisplayMenu(session: PlanSession | null, view: ViewKind): DisplayMenu | null {
  const { ui, setUi } = useUiValue();
  const planView = usePlanViewOf(session);
  const plan: PlanId | null = planView === null ? null : planView.plan.id;
  const listPrefs = useListPrefs(view === "list" ? plan : null);
  const boardPrefs = useBoardPrefs(view === "board" ? plan : null);
  if (planView === null || plan === null || view === "timeline") return null;
  if (view === "list") return listDisplay(listPrefs, (next) => writeListPrefs(window.localStorage, plan, next), () => setUi({ columnsAsk: ui.columnsAsk + 1 }));
  const projection = projectBoard(planView.plan, planView.derived);
  const live: ReadonlySet<StepId> = new Set(projection.steps.map((s) => s.id));
  return boardDisplay(projection.steps, projection.completing !== null, boardPrefs, (next) => writeBoardPrefs(window.localStorage, plan, next, live));
}
