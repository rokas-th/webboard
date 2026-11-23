import type { PickRow, PickSection } from "../common/ContextMenu";
import { addSortKey, hideColumn, removeSortKey, resetColumns, setSort } from "./columnOps";
import type { ColumnId, ListPrefs } from "./prefs";
import { ADD_SECOND_KEY, ADD_THIRD_KEY, COLUMNS_MORE, HIDE_COLUMN, REMOVE_FROM_SORT, RESET_COLUMNS, SIZE_TO_FIT, SORT_ASCENDING, SORT_DESCENDING } from "./text";

export type HeadResult = { prefs: ListPrefs } | { columns: true } | { fit: true };

const row = (id: string, title: string, checked = false, checkable = false): PickRow => ({ id, title, checked, checkable });

export function headMenu(prefs: ListPrefs, id: ColumnId): PickSection[] {
  const primary = prefs.sort[0];
  const sorts = prefs.sort.some((s) => s.id === id);
  const keys = prefs.sort.length;
  const sort: PickRow[] = [
    row("asc", SORT_ASCENDING, primary !== undefined && primary.id === id && primary.dir === "asc", true),
    row("desc", SORT_DESCENDING, primary !== undefined && primary.id === id && primary.dir === "desc", true),
    ...(!sorts && keys === 1 ? [row("second", ADD_SECOND_KEY)] : []),
    ...(!sorts && keys === 2 ? [row("third", ADD_THIRD_KEY)] : []),
    ...(sorts ? [row("unsort", REMOVE_FROM_SORT)] : []),
  ];
  const column: PickRow[] = [...(id === "name" ? [] : [row("hide", HIDE_COLUMN)]), row("fit", SIZE_TO_FIT)];
  return [
    { title: null, rows: sort },
    { title: null, rows: column },
    { title: null, rows: [row("columns", COLUMNS_MORE), row("reset", RESET_COLUMNS)] },
  ];
}

export function runHeadRow(prefs: ListPrefs, id: ColumnId, chosen: string): HeadResult {
  if (chosen === "asc" || chosen === "desc") return { prefs: setSort(prefs, id, chosen) };
  if (chosen === "second" || chosen === "third") return { prefs: addSortKey(prefs, id) };
  if (chosen === "unsort") return { prefs: removeSortKey(prefs, id) };
  if (chosen === "hide") return { prefs: hideColumn(prefs, id) };
  if (chosen === "fit") return { fit: true };
  if (chosen === "columns") return { columns: true };
  if (chosen === "reset") return { prefs: resetColumns(prefs) };
  throw new Error(`List: the header menu has no row ${JSON.stringify(chosen)}`);
}
