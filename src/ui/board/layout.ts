import { toDay } from "../../domain/dates";
import type { Item, ItemId, StepId } from "../../domain/model";
import type { BoardProjection, Step, StepColumn, StepMode, StepProblem } from "../../domain/steps";
import type { PlanView } from "../../store/doc";
import type { BoardPrefs } from "./prefs";
import { completesTwiceText, hiddenDoneText, NO_OPEN_STEP, openInCompletingText, sameNameText } from "./text";

export type BoardColumn =
  | { kind: "noStep"; items: readonly Item[] }
  | { kind: "step"; step: Step; items: readonly Item[]; completing: boolean }
  | { kind: "doneStrip"; step: Step; count: number }
  | { kind: "hiddenStrip"; step: Step; count: number };

export interface BoardLayout {
  mode: StepMode;
  columns: readonly BoardColumn[];
  hiddenDone: number;
  problems: readonly string[];
  empty: string | null;
}

export type Nearness = { kind: "late" } | { kind: "soon"; days: number };

const SOON_DAYS = 7;

export const statusOf = (view: PlanView, id: ItemId) => {
  const s = view.derived.status.get(id);
  if (s === undefined) throw new Error(`Board: item ${id} has no status`);
  return s;
};

const nameOf = (steps: readonly Step[], id: StepId): string => {
  const found = steps.find((s) => s.id === id);
  if (found === undefined) throw new Error(`Board: a problem names step ${id}, which is not live`);
  return found.name;
};

const problemText = (steps: readonly Step[], p: StepProblem): string => {
  if (p.kind === "completesTwice") return completesTwiceText(p.steps.map((id) => nameOf(steps, id)));
  const [first] = p.steps;
  if (first === undefined) throw new Error(`Board: a ${p.kind} problem names no step`);
  if (p.kind === "openInCompleting") return openInCompletingText(nameOf(steps, first), p.items.length);
  return sameNameText(nameOf(steps, first));
};

export function boardLayout(view: PlanView, projection: BoardProjection, prefs: BoardPrefs): BoardLayout {
  const hidden = new Set(prefs.hidden);
  const completingId = projection.completing === null ? null : projection.completing.id;
  const isOpen = (i: Item): boolean => statusOf(view, i.id) !== "done";
  const columnOf = (c: StepColumn): BoardColumn => {
    const step = c.step;
    if (step === null) return { kind: "noStep", items: c.items };
    if (hidden.has(step.id)) return { kind: "hiddenStrip", step, count: c.items.length };
    if (step.id !== completingId) return { kind: "step", step, items: c.items, completing: false };
    const open = c.items.filter(isOpen);
    if (open.length === 0 && !prefs.doneOpen) return { kind: "doneStrip", step, count: c.items.length };
    return { kind: "step", step, items: [...open, ...c.items.filter((i) => !isOpen(i))], completing: true };
  };
  const columns = projection.columns.map(columnOf);
  const finished = columns.reduce((n, c) => n + (c.kind === "doneStrip" || (c.kind === "hiddenStrip" && c.step.id === completingId) ? c.count : 0), 0);
  const noOpenColumn = columns.every((c) => c.kind === "doneStrip" || c.kind === "hiddenStrip") && projection.steps.every((s) => s.completes);
  const doneCount = finished + projection.hiddenDone;
  return {
    mode: projection.mode,
    columns,
    hiddenDone: projection.hiddenDone,
    problems: projection.problems.map((p) => problemText(projection.steps, p)),
    empty: noOpenColumn ? (doneCount === 0 ? NO_OPEN_STEP : `${NO_OPEN_STEP} ${hiddenDoneText(doneCount)}`) : null,
  };
}

export function cardOrder(layout: BoardLayout): readonly ItemId[] {
  return layout.columns.flatMap((c) => (c.kind === "noStep" || c.kind === "step" ? c.items.map((i) => i.id) : []));
}

export function nearnessOf(view: PlanView, mode: StepMode, item: Item): Nearness | null {
  if (mode !== "steps") return null;
  const status = statusOf(view, item.id);
  if (status === "done") return null;
  if (view.derived.late.has(item.id)) return { kind: "late" };
  if (status === "doing") return null;
  const start = view.derived.start.get(item.id);
  if (start === undefined) return null;
  const days = start - toDay(view.today);
  return days >= 1 && days <= SOON_DAYS ? { kind: "soon", days } : null;
}
