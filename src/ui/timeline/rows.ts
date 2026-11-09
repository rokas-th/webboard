import type { ItemId, ItemKind } from "../../domain/model";
import { childrenOf } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { ROW } from "./geometry";

export interface Row {
  id: ItemId;
  depth: number;
  kind: ItemKind | "ghost";
}

export function timelineRows(view: PlanView, collapsed: ReadonlySet<ItemId>): Row[] {
  const ghosts = new Set(view.choices.filter((c) => c.kind === "delete").flatMap((c) => c.items));
  const walk = (parent: ItemId | null, depth: number): Row[] =>
    childrenOf(view.plan, parent).flatMap((item): Row[] => {
      const below = item.kind === "group" && !collapsed.has(item.id) ? walk(item.id, depth + 1) : [];
      if (item.trashed) return ghosts.has(item.id) ? [{ id: item.id, depth, kind: "ghost" }, ...below] : below;
      if (item.kind === "group") return [{ id: item.id, depth, kind: "group" }, ...below];
      return item.schedule !== null && item.schedule.start !== null ? [{ id: item.id, depth, kind: item.kind }] : [];
    });
  return walk(null, 0);
}

export function visibleRange(scrollTop: number, height: number, count: number, overscan = 8): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / ROW) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + height) / ROW) + overscan);
  return [Math.min(first, last), last];
}
