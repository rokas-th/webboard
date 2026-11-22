import { childrenOf } from "../plan/project";
import { goneSet, type Derived } from "./derive";
import { MAX_STEP_LIMIT, MAX_STEP_NAME, scheduleOf, STEP_COLOURS, type Item, type ItemId, type PlanState, type StepColour, type StepId, type StepValue } from "./model";

export { MAX_STEP_LIMIT, MAX_STEP_NAME, STEP_COLOURS };

export const VIRTUAL_STEPS: ReadonlyMap<StepId, StepValue> = new Map<StepId, StepValue>([
  ["now", { n: "Now", c: "cyan", o: "a0" }],
  ["next", { n: "Next", c: "violet", o: "a1" }],
  ["later", { n: "Later", c: "slate", o: "a2" }],
  ["done", { n: "Done", c: "lime", o: "a3", d: true }],
]);

const DONE_STEP: StepId = "done";

export interface Step {
  id: StepId;
  name: string;
  colour: StepColour;
  order: string;
  completes: boolean;
  limit: number | null;
}

export type StepMode = "dates" | "steps";

export type StepProblem =
  | { kind: "sameName" | "completesTwice"; steps: readonly StepId[] }
  | { kind: "openInCompleting"; steps: readonly StepId[]; items: readonly ItemId[] };

export interface StepColumn {
  step: Step | null;
  items: readonly Item[];
}

export interface BoardProjection {
  mode: StepMode;
  steps: readonly Step[];
  completing: Step | null;
  columns: readonly StepColumn[];
  columnOf: ReadonlyMap<ItemId, StepId | null>;
  hiddenDone: number;
  problems: readonly StepProblem[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const stepNameKey = (name: string): string => name.toLowerCase();

export function stepModeOf(plan: PlanState): StepMode {
  return plan.workflow.steps.size + plan.workflow.items.size > 0 ? "steps" : "dates";
}

export function stepsOf(plan: PlanState): readonly Step[] {
  const ids = [...new Set([...VIRTUAL_STEPS.keys(), ...plan.workflow.steps.keys()])];
  return ids
    .flatMap((id): Step[] => {
      const stored = plan.workflow.steps.get(id);
      const value = stored === undefined ? VIRTUAL_STEPS.get(id) : stored;
      if (value === undefined) throw new Error(`Step ${id} has no value`);
      if (value === null) return [];
      return [{ id, name: value.n, colour: value.c, order: value.o, completes: value.d === true, limit: value.l ?? null }];
    })
    .sort((a, b) => cmp(a.order, b.order) || cmp(a.id, b.id));
}

export function storedStepOf(plan: PlanState, item: Item): StepId {
  const stored = plan.workflow.items.get(item.id);
  return stored === undefined || stored === null ? scheduleOf(item).horizon : stored;
}

const boardItems = (plan: PlanState): Item[] => {
  const gone = goneSet(plan);
  const walk = (parent: ItemId | null): Item[] => childrenOf(plan, parent).flatMap((i) => (gone.has(i.id) ? [] : i.kind === "group" ? walk(i.id) : [i]));
  return walk(null);
};

const problemsOf = (steps: readonly Step[]): StepProblem[] => {
  const completing = steps.filter((s) => s.completes).map((s) => s.id);
  const names = [...new Set(steps.map((s) => stepNameKey(s.name)))];
  const twice: StepProblem[] = completing.length > 1 ? [{ kind: "completesTwice", steps: completing }] : [];
  const same = names
    .map((n) => steps.filter((s) => stepNameKey(s.name) === n).map((s) => s.id))
    .filter((ids) => ids.length > 1)
    .map((ids): StepProblem => ({ kind: "sameName", steps: ids }));
  return [...twice, ...same];
};

const statusOf = (derived: Derived, id: ItemId) => {
  const s = derived.status.get(id);
  if (s === undefined) throw new Error(`Board: item ${id} has no status`);
  return s;
};

const datesColumn = (derived: Derived, id: ItemId): StepId => {
  const h = derived.horizon.get(id);
  if (h !== undefined) return h;
  if (statusOf(derived, id) !== "done") throw new Error(`Board: item ${id} has no horizon`);
  return DONE_STEP;
};

export function projectBoard(plan: PlanState, derived: Derived): BoardProjection {
  const mode = stepModeOf(plan);
  const steps = stepsOf(plan);
  const completing = steps.find((s) => s.completes) ?? null;
  const live = new Set(steps.map((s) => s.id));
  const items = boardItems(plan);
  const placed = items.map((i): { item: Item; at: StepId | null } | null => {
    if (mode === "dates") return { item: i, at: datesColumn(derived, i.id) };
    if (statusOf(derived, i.id) === "done") return completing === null ? null : { item: i, at: completing.id };
    const stored = storedStepOf(plan, i);
    return { item: i, at: live.has(stored) ? stored : null };
  });
  const shown = placed.filter((p): p is { item: Item; at: StepId | null } => p !== null);
  const inColumn = (at: StepId | null): Item[] => shown.filter((p) => p.at === at).map((p) => p.item);
  const noStep = inColumn(null);
  const open = completing === null ? [] : shown.filter((p) => p.at === completing.id && statusOf(derived, p.item.id) !== "done").map((p) => p.item.id);
  const stranded: StepProblem[] = completing === null || open.length === 0 ? [] : [{ kind: "openInCompleting", steps: [completing.id], items: open }];
  return {
    mode,
    steps,
    completing,
    columns: [...(noStep.length === 0 ? [] : [{ step: null, items: noStep }]), ...steps.map((s) => ({ step: s, items: inColumn(s.id) }))],
    columnOf: new Map(shown.map((p): [ItemId, StepId | null] => [p.item.id, p.at])),
    hiddenDone: placed.length - shown.length,
    problems: [...problemsOf(steps), ...stranded],
  };
}
