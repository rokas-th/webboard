import type { ChipField, GroupBy, ScopeId, SortDir } from "./prefs";

export const LIST_PREFS_UNREADABLE = "Saved List settings for this plan could not be read; they were reset.";

export const SORT_LIMIT = "The List sorts by at most 3 columns. Shift-click a sorted column to drop it.";

export const CHIP_LIMIT = "The List filters by at most 32 values. Remove a filter first.";

export const SORT_TITLE = "Click to sort · Shift-click adds a key";

export const sortRankText = (rank: number, of: number, dir: SortDir): string => `${dir === "asc" ? "ascending" : "descending"}, sort key ${rank} of ${of}`;

export const sortDirText = (dir: SortDir): string => (dir === "asc" ? "ascending" : "descending");

export const scopeLabel = (scope: string, n: number): string => `${scope}, ${n === 1 ? "1 item" : `${n.toLocaleString("en-GB")} items`}`;

export const filterLabel = (n: number): string => (n === 0 ? "Filter" : `Filter, ${n} active`);

export const NO_STEP = "No step";

export const TASK = "Task";

export const MILESTONE = "Milestone";

export const SORT_UP = "▲";

export const SORT_DOWN = "▼";

export const SCOPE = "Scope";

export const SCOPE_LABELS: Readonly<Record<ScopeId, string>> = {
  open: "Open",
  soon: "Due soon",
  late: "Late",
  blocked: "Blocked",
  unscheduled: "Unscheduled",
  unassigned: "Unassigned",
  milestones: "Milestones",
  done: "Done",
  all: "All",
};

export const SCOPE_TITLES: Readonly<Record<ScopeId, string | null>> = {
  open: "Not done",
  soon: "Ends within 7 working days",
  late: "Past its end and not done",
  blocked: "Waits on an unfinished predecessor",
  unscheduled: "No start date",
  unassigned: "Nobody assigned",
  milestones: null,
  done: null,
  all: "Everything in this plan",
};

export const FIELD_LABELS: Readonly<Record<ChipField, string>> = {
  step: "Step",
  assignee: "Assignee",
  kind: "Kind",
  group: "Group",
};

export const GROUP_LABELS: Readonly<Record<GroupBy, string>> = {
  outline: "Plan outline",
  step: "Step",
  assignee: "Assignee",
  none: "None",
};

export const NOT_IN_A_GROUP = "Not in a group";

export const REMOVED_STEP = "a removed step";

export const REMOVED_GROUP = "a removed group";

export const FILTER = "Filter";

export const GROUP_BY = "Group by";

export const PLAN_ORDER = "Plan order";

export const CLEAR_ALL = "Clear all";

export const SORT_ASC = "↑";

export const SORT_DESC = "↓";

export const PULL_CARET = "▾";

export const chipText = (field: ChipField, value: string): string => `${FIELD_LABELS[field]} is ${value}`;

export const removeChipLabel = (chip: string): string => `Remove filter ${chip}`;

export const sortedText = (keys: readonly { title: string; dir: SortDir }[]): string =>
  `Sorted by ${keys.map((k) => `${k.title} ${k.dir === "asc" ? SORT_ASC : SORT_DESC}`).join(", then ")}`;

export const itemsText = (n: number): string => (n === 1 ? "1 item" : `${n.toLocaleString("en-GB")} items`);

export const GROUP_PREFIX = "Group: ";

export const nothingText = (scope: ScopeId, filtered: boolean, q: string): string => {
  const where = `Nothing in ${SCOPE_LABELS[scope]}`;
  if (q !== "") return `${where} matches “${q}”.`;
  return filtered ? `${where} with these filters.` : `${where}.`;
};

export const lateText = (days: number): string => `${days} d`;

export const progressText = (pct: number): string => `${pct}%`;

export const COLUMN_MENU = "Column";

export const SORT_ASCENDING = "Sort ascending";

export const SORT_DESCENDING = "Sort descending";

export const ADD_SECOND_KEY = "Add as second sort key";

export const ADD_THIRD_KEY = "Add as third sort key";

export const REMOVE_FROM_SORT = "Remove from sort";

export const HIDE_COLUMN = "Hide column";

export const SIZE_TO_FIT = "Size to fit";

export const COLUMNS_MORE = "Columns…";

export const RESET_COLUMNS = "Reset columns";

export const resizeLabel = (title: string): string => `Resize ${title}`;

export const COLUMNS_TITLE = "Columns";

export const moveLabel = (title: string): string => `Move ${title}`;

export const handleTitle = (command: boolean): string => `Drag to reorder · ${command ? "⌥↑ ⌥↓" : "Alt ↑ Alt ↓"}`;

export const PINNED = "pinned";

export const SORT_AND_GROUP = "Sort and group";

export const SORT_BY = "Sort by";

export const NO_DATES = "No dates";

export const META_SEP = " · ";

export const spanText = (start: string, end: string): string => `${start} – ${end}`;

export const recordText = (reason: string, raw: string, shown: number): string =>
  `${reason}. The record was: ${raw.length > shown ? `${raw.slice(0, shown)}… (${raw.length} characters)` : raw}`;
