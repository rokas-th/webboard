import type { ItemId } from "../domain/model";
import type { PlanSession } from "../store/session";

export function trashRootOf(s: PlanSession, id: ItemId): ItemId {
  const plan = s.view().plan;
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`No item ${id}`);
  const parent = it.place.parent === null ? undefined : plan.items.get(it.place.parent);
  return parent !== undefined && parent.trashed ? trashRootOf(s, parent.id) : id;
}

export function remoteTrashText(s: PlanSession, id: ItemId, device: string): string | null {
  const root = trashRootOf(s, id);
  const a = s.authorOf("e:" + root);
  if (a === null || a.dev === device) return null;
  const rootItem = s.view().plan.items.get(root);
  if (rootItem === undefined) throw new Error(`No item ${root}`);
  return `“${rootItem.name}” was moved to the Trash on ${a.device}. Restore it from the Trash.`;
}
