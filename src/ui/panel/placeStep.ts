import type { Intent } from "../../actions/intents";
import type { Item, PlanState } from "../../domain/model";
import { childrenOf } from "../../plan/project";

export function placeStep(plan: PlanState, it: Item, by: 1 | -1): Intent | null {
  const siblings = childrenOf(plan, it.place.parent).filter((s) => !s.trashed || s.id === it.id);
  const at = siblings.findIndex((s) => s.id === it.id);
  if (at < 0) throw new Error(`placeStep: item ${it.id} is not among its parent's children`);
  if (by < 0) return at === 0 ? null : { t: "place", item: it.id, parent: it.place.parent, after: at >= 2 ? siblings[at - 2].id : null };
  return at === siblings.length - 1 ? null : { t: "place", item: it.id, parent: it.place.parent, after: siblings[at + 1].id };
}
