import type { PlanId } from "../domain/model";
import { newId } from "../log/ids";

export const SPACE_PREFIX = "ix-";

export function newPlanId(draw: () => string = newId): PlanId {
  const id = draw();
  return id.startsWith(SPACE_PREFIX) ? newPlanId(draw) : id;
}
