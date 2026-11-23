import type { ItemId, PersonId } from "../../domain/model";
import { projectBoard } from "../../domain/steps";
import type { PlanView } from "../../store/doc";
import { rowContext, type NoteText } from "../list/columns";
import { listModel } from "../list/model";
import type { ListPrefs } from "../list/prefs";
import type { UiState } from "../state";
import { timelineRows } from "../timeline/rows";
import type { Matcher } from "./match";

export interface SearchCount {
  shown: number;
  total: number;
}

const counted = (ids: readonly ItemId[], match: Matcher): SearchCount => ({ shown: ids.filter(match).length, total: ids.length });

export function searchCount(view: PlanView, ui: Pick<UiState, "view" | "collapsed">, listPrefs: ListPrefs, notes: NoteText, me: PersonId | null, match: Matcher | null): SearchCount | null {
  if (match === null) return null;
  if (ui.view === "list") {
    const model = listModel(rowContext(view, notes, me, null), listPrefs, match);
    return { shown: model.shown, total: model.scoped };
  }
  if (ui.view === "board") return counted([...projectBoard(view.plan, view.derived).columnOf.keys()], match);
  return counted(
    timelineRows(view, ui.collapsed)
      .filter((r) => r.kind === "task" || r.kind === "milestone")
      .map((r) => r.id),
    match,
  );
}
