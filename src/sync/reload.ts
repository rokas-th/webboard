import type { PlanId } from "../domain/model";
import { SPACE_PREFIX } from "../store/plan-id";
import type { SyncState } from "./manager";

export type SyncAction = "export" | "reset" | "retry";

const isIndex = (doc: string): boolean => doc.startsWith(SPACE_PREFIX);

export function canReload(s: SyncState): boolean {
  switch (s.kind) {
    case "off":
    case "offline":
      return false;
    case "synced":
    case "syncing":
    case "receiving":
      return true;
    case "error":
      return s.code === "local-failed" || s.code === "store-failed" || s.code === "rejected" || s.code === "too-large";
  }
}

export function stopsArrival(s: SyncState, plan: PlanId): boolean {
  if (s.kind !== "error") return false;
  if (s.doc === plan && (s.code === "too-large" || s.code === "rejected" || s.code === "store-failed" || s.code === "failed")) return true;
  if (s.code === "local-failed") return s.doc === null;
  return s.code === "revoked" || s.code === "unauthorized" || s.code === "not-configured" || s.code === "keychain" || s.code === "failed";
}

export function syncActions(s: SyncState, holds: boolean): readonly SyncAction[] {
  if (s.kind !== "error") return [];
  if (s.code === "revoked" || s.code === "unauthorized") return [];
  if (s.code === "local-failed") return s.doc === null ? ["reset", "retry"] : [];
  if ((s.code === "rejected" || s.code === "too-large" || s.code === "store-failed") && s.doc !== null && !isIndex(s.doc) && holds) return ["export", "retry"];
  return ["retry"];
}
