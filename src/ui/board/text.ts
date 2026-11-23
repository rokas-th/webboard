import { items, q } from "../../actions/copy";

export const BY_DATES = "Columns follow dates. Edit a step or drag a card to use your own steps.";
export const BY_DATES_PHONE = "Pages follow dates. Move a card or add one to use your own steps.";
export const STEPS_BAR = "Steps";
export const NO_STEP_TAB = "No step";
export const EXPAND = "Expand";
export const SHOW = "Show";

export const foldedText = (n: number): string => `Collapsed on this device: ${items(n)}.`;

export const hiddenPageText = (n: number): string => `Hidden on this device: ${items(n)}.`;

export const stepTabLabel = (name: string, n: number, kind: "noStep" | "step" | "folded" | "hidden", limit: number | null): string => {
  if (kind === "hidden") return `${name}, hidden on this device, ${items(n)}`;
  if (kind === "folded") return `${name}, ${items(n)}, collapsed`;
  return limit !== null && n > limit ? `${name}, ${items(n)}, over the limit of ${limit}` : `${name}, ${items(n)}`;
};
export const NOTHING_HERE = "Nothing here.";
export const CLEAR_SEARCH = "Clear search";

export const nothingMatchesText = (query: string): string => `Nothing here matches ${q(query)}.`;

export const filteredText = (query: string): string => `Filtered: ${query}`;
export const DROP_TO_FINISH = "Drop here to mark done.";
export const NO_OPEN_STEP = "Every step in this plan completes items, so no open card has a column.";
export const NO_STEP = "NO STEP";
export const NO_STEP_LINE = "These items point at a step another device deleted.";
export const MOVE_ALL = "Move all to…";
export const HIDE_LIMIT = "The Board hides at most 64 steps on this device. Show one before hiding another.";
export const PREFS_UNREADABLE = "Saved Board settings for this plan could not be read; they were reset.";
export const LATE = "late";

export const hiddenDoneText = (n: number): string => (n === 1 ? "1 done item is hidden." : `${n} done items are hidden.`);

export const soonText = (days: number): string => `starts in ${days} d`;

export const countText = (n: number, limit: number | null): string => (limit === null ? `${n}` : `${n}/${limit}`);

export const overLimit = (limit: number): string => `Over the limit of ${limit}`;

export const doneStripLabel = (name: string, n: number): string => `${name}, ${items(n)}. Expand`;

export const hiddenStripLabel = (name: string, n: number): string => `${name}, hidden on this device, ${items(n)}. Show`;

export const addLabel = (name: string): string => `Add a task to ${name}`;

export const moreLabel = (name: string): string => `${name} options`;

export const collapseLabel = (name: string): string => `Collapse ${name}`;

export const STEP_MENU = "Step options";
export const RENAME = "Rename";
export const COLOUR_ROW = "Colour…";
export const LIMIT_ROW = "Limit…";
export const COMPLETES_ROW = "Completes items";
export const INSERT_LEFT = "Insert left";
export const INSERT_RIGHT = "Insert right";
export const HIDE_ROW = "Hide on this device";
export const DELETE_ROW = "Delete…";

export const renameLabel = (name: string): string => `Name of ${name}`;

export const colourTitle = (name: string): string => `Colour · ${name}`;

export const limitTitle = (name: string): string => `Limit · ${name}`;

export const LIMIT_NOTE = "Shown as count/limit in amber when passed. A limit never blocks a drop.";
export const LIMIT_INPUT = "Limit";
export const LIMIT_NONE = "None";
export const CLEAR = "Clear";
export const APPLY = "Apply";

export const colourName = (c: string): string => `${c.slice(0, 1).toUpperCase()}${c.slice(1)}`;

export const NEW_STEP = "New step";

export const newStepName = (taken: readonly string[]): string => {
  const keys = new Set(taken.map((n) => n.toLowerCase()));
  const free = (n: string): boolean => !keys.has(n.toLowerCase());
  if (free(NEW_STEP)) return NEW_STEP;
  const n = Array.from({ length: taken.length + 1 }, (_, i) => i + 2).find((i) => free(`${NEW_STEP} ${i}`));
  if (n === undefined) throw new Error("Board: no free name for a new step");
  return `${NEW_STEP} ${n}`;
};

export const CARD_MENU = "Card options";
export const OPEN_ROW = "Open";
export const MOVE_TO = "Move to";
export const DUPLICATE_ROW = "Duplicate";
export const SELECTION_GONE = "The selected item is no longer in this plan.";
export const GROUP_NO_STEP = "Groups have no step. Select a task or milestone.";

export const noStepNumber = (n: number): string => `This plan has no step ${n}.`;

export const draftLabel = (name: string): string => `Name of the new task in ${name}`;
export const DRAFT_PLACEHOLDER = "New task";

export const DELETE_STEP = "Delete step";
export const DELETE = "Delete";
export const DELETE_AND_MOVE = "Delete and move";
export const MOVE_TO_GROUP = "Move items to";
export const MARKS_DONE = "marks them done";

export const deleteEmptyText = (name: string): string => `Delete the step ${q(name)}? It holds no items.`;

export const moveItemsTitle = (n: number, name: string): string => `Move ${n === 1 ? "1 item" : `${n} items`} from ${name} to…`;

export const hiddenOfThem = (n: number): string => `${n} of them ${n === 1 ? "is" : "are"} done or in the Trash.`;

export const completesTwiceText = (names: readonly string[]): string => {
  const [first] = names;
  if (first === undefined) throw new Error("Board: a completesTwice problem names no step");
  return `Several steps complete items: ${names.map(q).join(", ")}. Only ${q(first)} does; clear Completes items on the others.`;
};

export const sameNameText = (name: string): string => `More than one step is named ${q(name)}. Rename one.`;

export const openInCompletingText = (name: string, n: number): string =>
  n === 1 ? `${q(name)} completes items but holds 1 item that is not done.` : `${q(name)} completes items but holds ${n} items that are not done.`;

export const WORKFLOW_NO_COMPLETING = "No step completes items";
export const COMPLETES_COLUMN = "Completes";
export const COMPLETES_GROUP = "Step that completes items";
export const WORKFLOW_HEAD: readonly string[] = ["", "", "Name", "Items", "Limit", COMPLETES_COLUMN, ""];
export const ADD_STEP = "+ Add step";

export const reorderLabel = (name: string): string => `Reorder ${name}`;

export const workflowLimitLabel = (name: string): string => `Limit of ${name}`;

export const completesLabel = (name: string): string => `${name} completes items`;

export const newItemsText = (name: string): string => `New undated items go to ${q(name)}, the first step that does not complete items.`;

export const newItemsByDates = (name: string): string => `New undated items go to ${q(name)} until this plan uses steps.`;

export const newItemsDefault = (name: string): string => `New undated items go to ${q(name)}.`;
