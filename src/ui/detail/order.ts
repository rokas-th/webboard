import type { ItemId, PersonId } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import { boardLayout, cardOrder, filterLayout } from "../board/layout";
import type { BoardPrefs } from "../board/prefs";
import { projectBoard } from "../../domain/steps";
import { rowContext, type NoteText } from "../list/columns";
import { listModel } from "../list/model";
import type { ListPrefs } from "../list/prefs";
import { searchCount, type SearchCount } from "../search/count";
import { planMatcher, searchMatcher, type Matcher } from "../search/match";
import type { UiState } from "../state";
import { timelineRows } from "../timeline/rows";

const rowOrder = (view: PlanView, collapsed: ReadonlySet<ItemId>): ItemId[] => timelineRows(view, collapsed).map((r) => r.id);

export function tabOrder(view: PlanView, ui: Pick<UiState, "view" | "collapsed">, boardPrefs: BoardPrefs, listPrefs: ListPrefs, notes: NoteText, me: PersonId | null, match: Matcher | null): readonly ItemId[] {
  if (ui.view === "timeline") return rowOrder(view, ui.collapsed);
  if (ui.view === "list") return listModel(rowContext(view, notes, me, null), listPrefs, match).order;
  return cardOrder(filterLayout(boardLayout(view, projectBoard(view.plan, view.derived), boardPrefs), match));
}

export interface TabSearch {
  order: readonly ItemId[];
  match: Matcher | null;
  count: SearchCount | null;
}

export function tabSearch(view: PlanView, ui: Pick<UiState, "view" | "collapsed" | "query">, boardPrefs: BoardPrefs, listPrefs: ListPrefs, notes: NoteText, me: PersonId | null): TabSearch {
  if (ui.view === "list") {
    const ctx = rowContext(view, notes, me, null);
    const match = searchMatcher(ctx, ui.query);
    const model = listModel(ctx, listPrefs, match);
    return { order: model.order, match, count: match === null ? null : { shown: model.shown, total: model.scoped } };
  }
  const match = planMatcher(view, notes, ui.query);
  return { order: tabOrder(view, ui, boardPrefs, listPrefs, notes, me, match), match, count: searchCount(view, ui, listPrefs, notes, me, match) };
}

export function firstMatch(found: TabSearch): ItemId | null {
  const { match } = found;
  return (match === null ? found.order[0] : found.order.find(match)) ?? null;
}

export function stepFrom(order: readonly ItemId[], selected: ItemId | null, by: 1 | -1): ItemId | null {
  if (order.length === 0) return null;
  const at = selected === null ? -1 : order.indexOf(selected);
  const next = at < 0 ? (by > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + by));
  return order[next];
}

export function stepPatch(order: readonly ItemId[], selected: ItemId | null, by: 1 | -1, follows: boolean): Partial<UiState> | null {
  const target = stepFrom(order, selected, by);
  if (target === null) return null;
  return follows ? { selected: target, follow: target } : { selected: target };
}
