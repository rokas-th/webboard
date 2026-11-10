import type { PlanId } from "../domain/model";
import type { IndexDoc } from "../store/index-doc";

export function movePlan(plan: PlanId, local: IndexDoc, space: IndexDoc): void {
  if (!space.plans().some((p) => p.id === plan)) space.addPlan(plan);
  if (!local.plans().some((p) => p.id === plan && p.trashed)) local.trashPlan(plan);
}
