import { Refused } from "../../actions/intents";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import type { PlanListing, Registry } from "../../store/registry";
import type { SyncState } from "../../sync/manager";
import { toast } from "../common/Toast";

export const LOCAL_TAG = "this device only";
export const EXAMPLE_TAG = "example";

export function canMoveToSpace(registry: Registry, state: SyncState): boolean {
  return registry.attachedSpace() !== null && !registry.spaceReadOnly() && state.kind !== "off" && !(state.kind === "error" && state.code === "local-failed");
}

export const onThisDeviceOnly = (l: PlanListing): boolean => !l.trashed && l.space === null && l.loaded && !l.example;

export function localLineText(n: number): string {
  return n === 1
    ? "1 plan is on this device only. Move it to the space to see it on other devices."
    : `${n} plans are on this device only. Move them to the space to see them on other devices.`;
}

export function moveAllLabel(n: number): string {
  if (n === 1) return "Move it";
  if (n === 2) return "Move both";
  return `Move all ${n}`;
}

export function moveAllToSpace(registry: Registry, ids: readonly PlanId[]): void {
  try {
    registry.movePlansToSpace(ids);
  } catch (e) {
    if (!(e instanceof Refused) && !(e instanceof AppError && e.code === "move.partial")) throw e;
    toast(e.message, "bad");
    return;
  }
  toast(ids.length === 1 ? "Moved to the space" : `Moved ${ids.length} plans to the space`);
}
