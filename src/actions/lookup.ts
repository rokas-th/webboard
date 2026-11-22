import type { Item, ItemId, PlanState } from "../domain/model";
import { liveLinks } from "../plan/project";
import { refusal } from "./copy";
import { Refused } from "./intents";

export const itemOf = (plan: PlanState, id: ItemId): Item => {
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`Item ${id} is not in this plan`);
  return it;
};

const trashRootAbove = (plan: PlanState, it: Item): Item | null => {
  const above = (at: ItemId | null, found: Item | null): Item | null => {
    if (at === null) return found;
    const p = itemOf(plan, at);
    return above(p.place.parent, p.trashed ? p : found);
  };
  return above(it.place.parent, null);
};

export const notInsideTrash = (plan: PlanState, it: Item): Item => {
  const root = trashRootAbove(plan, it);
  if (root !== null) throw new Refused(refusal.inside(it.name, root.name));
  return it;
};

export const live = (plan: PlanState, id: ItemId): Item => {
  const it = notInsideTrash(plan, itemOf(plan, id));
  if (it.trashed) throw new Refused(refusal.trashed(it.name));
  return it;
};

export const hasPredecessor = (plan: PlanState, id: ItemId): boolean => liveLinks(plan).some((l) => l.to === id);
