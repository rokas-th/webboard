import type { ItemId } from "./model";

export function need<V>(map: ReadonlyMap<ItemId, V>, id: ItemId, what: string): V {
  const v = map.get(id);
  if (v === undefined) throw new Error(`no ${what} for item ${id}`);
  return v;
}
