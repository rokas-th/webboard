import type { ItemId } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import { columnsOf } from "../board/Board";
import { listGroups } from "../list/groups";
import type { UiState } from "../state";
import { timelineRows } from "../timeline/rows";

export type PhoneTab = "list" | "timeline";

const listOrder = (view: PlanView): ItemId[] => listGroups(view).flatMap((s) => s.items);

const rowOrder = (view: PlanView, collapsed: ReadonlySet<ItemId>): ItemId[] => timelineRows(view, collapsed).map((r) => r.id);

export function tabOrder(view: PlanView, ui: Pick<UiState, "view" | "collapsed">): readonly ItemId[] {
  if (ui.view === "timeline") return rowOrder(view, ui.collapsed);
  if (ui.view === "list") return listOrder(view);
  return columnsOf(view).shown.flatMap((c) => c.items.map((i) => i.id));
}

export function phoneOrder(view: PlanView, tab: PhoneTab, collapsed: ReadonlySet<ItemId>): readonly ItemId[] {
  return tab === "list" ? listOrder(view) : rowOrder(view, collapsed);
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
