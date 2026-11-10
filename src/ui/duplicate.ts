import type { Built, Intent } from "../actions/intents";
import type { ItemId } from "../domain/model";
import type { PlanView } from "../store/doc";
import type { SetUi, UiState } from "./state";
import { timelineRows } from "./timeline/rows";

export function duplicatedItem(built: Built): ItemId {
  const [id] = built.newNotes;
  if (id === undefined) throw new Error(`Duplicate: “${built.action.lbl}” made no copy`);
  return id;
}

export function duplicateRow(run: (i: Intent) => Built | null, view: () => PlanView, ui: UiState, setUi: SetUi, item: ItemId): void {
  const built = run({ t: "duplicate", item });
  if (built === null) return;
  const copy = duplicatedItem(built);
  const shown = ui.view === "timeline" && timelineRows(view(), ui.collapsed).some((r) => r.id === copy);
  setUi(shown ? { selected: copy, follow: copy } : { selected: copy });
}
