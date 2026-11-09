import type { ItemId, Status } from "../domain/model";
import type { PlanView } from "../store/doc";

export function derivedStatus(view: PlanView, id: ItemId, caller: string): Status {
  const status = view.derived.status.get(id);
  if (status === undefined) throw new Error(`${caller}: item ${id} has no derived status`);
  return status;
}
