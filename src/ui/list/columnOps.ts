import { columnById } from "./columns";
import { DEFAULT_LIST_PREFS, MAX_WIDTH, type ColumnId, type ColumnPref, type ListPrefs, type SortDir } from "./prefs";

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export const TOUCH_HEAD_MIN = 96;

export const minWidthOn = (id: ColumnId, touch: boolean): number => (touch ? Math.max(columnById(id).minWidth, TOUCH_HEAD_MIN) : columnById(id).minWidth);

const indexOf = (p: ListPrefs, id: ColumnId): number => {
  const at = p.cols.findIndex((c) => c.id === id);
  if (at < 0) throw new Error(`List: ${id} is not a shown column`);
  return at;
};

export function moveColumn(p: ListPrefs, id: ColumnId, to: number): ListPrefs {
  if (id === "name") throw new Error("List: Name stays the first column");
  const from = indexOf(p, id);
  if (!Number.isSafeInteger(to) || to < 1 || to > p.cols.length) throw new Error(`List: ${to} is not an insertion index from 1 to ${p.cols.length}`);
  const moving = p.cols[from];
  const rest = p.cols.filter((c) => c.id !== id);
  const at = to > from ? to - 1 : to;
  return { ...p, cols: [...rest.slice(0, at), moving, ...rest.slice(at)] };
}

export function resizeColumn(p: ListPrefs, id: ColumnId, w: number): ListPrefs {
  indexOf(p, id);
  const next = clamp(Math.round(w), columnById(id).minWidth, MAX_WIDTH);
  return { ...p, cols: p.cols.map((c) => (c.id === id ? { id, w: next } : c)) };
}

export function hideColumn(p: ListPrefs, id: ColumnId): ListPrefs {
  if (id === "name") throw new Error("List: Name cannot be hidden");
  indexOf(p, id);
  return { ...p, cols: p.cols.filter((c) => c.id !== id), sort: p.sort.filter((s) => s.id !== id) };
}

export function showColumn(p: ListPrefs, id: ColumnId): ListPrefs {
  if (p.cols.some((c) => c.id === id)) throw new Error(`List: ${id} is already shown`);
  const added: ColumnPref = { id, w: columnById(id).defaultWidth };
  return { ...p, cols: [...p.cols, added] };
}

export function resetColumns(p: ListPrefs): ListPrefs {
  const cols = DEFAULT_LIST_PREFS.cols;
  return { ...p, cols, sort: p.sort.filter((s) => cols.some((c) => c.id === s.id)) };
}

export function fitWidth(min: number, widths: readonly number[]): number {
  if (widths.length === 0) throw new Error("List: nothing to fit");
  return clamp(Math.ceil(Math.max(...widths)), min, MAX_WIDTH);
}

export function dropIndex(mids: readonly number[], at: number): number {
  return 1 + mids.filter((m) => m < at).length;
}

export function setSort(p: ListPrefs, id: ColumnId, dir: SortDir): ListPrefs {
  indexOf(p, id);
  return { ...p, sort: [{ id, dir }] };
}

export function addSortKey(p: ListPrefs, id: ColumnId): ListPrefs {
  indexOf(p, id);
  if (p.sort.some((s) => s.id === id)) throw new Error(`List: ${id} already sorts`);
  return { ...p, sort: [...p.sort, { id, dir: "asc" }] };
}

export function removeSortKey(p: ListPrefs, id: ColumnId): ListPrefs {
  if (!p.sort.some((s) => s.id === id)) throw new Error(`List: ${id} does not sort`);
  return { ...p, sort: p.sort.filter((s) => s.id !== id) };
}
