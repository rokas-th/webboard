import { PANES_KEY, seedPanes, type PaneKey, type PaneSet, type PanesRecord } from "../ui/shell/panes";
import { PLACE_KEY } from "../ui/state";

const closing = (set: PaneSet, keys: readonly PaneKey[]): PaneSet => ({
  list: keys.includes("list") ? { ...set.list, open: false } : set.list,
  outline: keys.includes("outline") ? { ...set.outline, open: false } : set.outline,
  inspector: keys.includes("inspector") ? { ...set.inspector, open: false } : set.inspector,
});

export function seedPanesClosed(keys: readonly PaneKey[]): PanesRecord {
  const seeded = seedPanes(window.localStorage.getItem(PLACE_KEY));
  const record: PanesRecord = { v: 1, desk: closing(seeded.desk, keys), padLandscape: closing(seeded.padLandscape, keys), padPortrait: closing(seeded.padPortrait, keys) };
  window.localStorage.setItem(PANES_KEY, JSON.stringify(record));
  return record;
}
