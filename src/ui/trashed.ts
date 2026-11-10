import type { ItemId } from "../domain/model";
import type { DeviceId } from "../log/types";
import type { PlanSession } from "../store/session";
import { toast } from "./common/Toast";

export function trashRootOf(s: PlanSession, id: ItemId): ItemId {
  const plan = s.view().plan;
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`No item ${id}`);
  const parent = it.place.parent === null ? undefined : plan.items.get(it.place.parent);
  return parent !== undefined && parent.trashed ? trashRootOf(s, parent.id) : id;
}

export function toastRemoteTrash(s: PlanSession, id: ItemId, device: DeviceId): void {
  const root = trashRootOf(s, id);
  const a = s.trashAuthorOf(root);
  if (a.dev === device) return;
  const rootItem = s.view().plan.items.get(root);
  if (rootItem === undefined) throw new Error(`No item ${root}`);
  toast(`“${rootItem.name}” was moved to the Trash on ${a.device}. Restore it from the Trash.`);
}
