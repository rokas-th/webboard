import { useContext } from "react";
import type { ItemId, PlanState } from "../../domain/model";
import type { Conflict } from "../../domain/schedule";
import type { PlanView } from "../../store/doc";
import { UiContext } from "../state";
import { heldChoice } from "./describe";

export type Broken = Exclude<Conflict, { kind: "dayoff" }>;

export const countedConflicts = (view: PlanView): Broken[] => view.derived.conflicts.filter((c): c is Broken => c.kind !== "dayoff");

export function conflictSuccessor(view: PlanView, c: Broken): ItemId {
  if (c.kind === "early") return c.succ;
  const link = view.plan.links.get(c.link);
  if (link === undefined) throw new Error(`Conflict link ${c.link} is not in the plan`);
  return link.to;
}

const ancestors = (plan: PlanState, id: ItemId): ItemId[] => {
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`No item ${id}`);
  return it.place.parent === null ? [] : [it.place.parent, ...ancestors(plan, it.place.parent)];
};

const hasStart = (plan: PlanState, id: ItemId): boolean => {
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`No item ${id}`);
  return it.schedule !== null && it.schedule.start !== null;
};

export function HeadCounts(p: { view: PlanView; onChoose(choice: string): void }) {
  const view = p.view;
  const uiValue = useContext(UiContext);
  const conflicts = countedConflicts(view);

  const goToFirst = (): void => {
    if (uiValue === null) throw new Error("Go to first conflict needs a UiContext provider");
    const first = conflicts[0];
    if (first === undefined) throw new Error("Go to first conflict: there is no conflict");
    const succ = conflictSuccessor(view, first);
    const up = new Set(ancestors(view.plan, succ));
    const collapsed = [...uiValue.ui.collapsed].some((id) => up.has(id)) ? new Set([...uiValue.ui.collapsed].filter((id) => !up.has(id))) : uiValue.ui.collapsed;
    uiValue.setUi({ view: "timeline", selected: succ, collapsed, reveal: hasStart(view.plan, succ) ? succ : null });
  };

  const openHeld = (): void => {
    const c = heldChoice(view);
    if (c === null) throw new Error("No open choice holds the held items");
    p.onChoose(c.id);
  };

  return (
    <>
      {view.held.size > 0 && (
        <button type="button" className="chip chip-amber" onClick={openHeld}>
          {view.held.size} held
        </button>
      )}
      {conflicts.length > 0 && (
        <span className="chip chip-magenta">
          {conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"} ·{" "}
          <button type="button" className="chip-button" onClick={goToFirst}>
            Go to first conflict
          </button>
        </span>
      )}
    </>
  );
}
