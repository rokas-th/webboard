import type { PlanId } from "../../domain/model";
import type { AppError } from "../../services/ipc";
import type { PlanListing } from "../../store/registry";
import type { UpdateState } from "../../store/updates";
import { installOffered } from "./UpdateLine";

export const failureShown = (l: PlanListing, failures: ReadonlyMap<PlanId, AppError>, selected: PlanId | null): boolean =>
  !l.trashed && failures.has(l.id) && !(l.id === selected && l.loaded);

export interface ListContent {
  open: boolean;
  plans: readonly PlanListing[];
  failures: ReadonlyMap<PlanId, AppError>;
  selected: PlanId | null;
  update: UpdateState | null;
}

export const listAttention = (c: ListContent): boolean =>
  !c.open && (c.plans.some((l) => failureShown(l, c.failures, c.selected)) || (c.update !== null && installOffered(c.update)));
