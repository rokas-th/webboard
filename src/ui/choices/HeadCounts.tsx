import { useContext } from "react";
import type { ItemId, PlanState } from "../../domain/model";
import type { Conflict } from "../../domain/schedule";
import type { PlanView } from "../../store/doc";
import { UiContext, type UiState } from "../state";
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

const hasRow = (plan: PlanState, id: ItemId): boolean => {
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`No item ${id}`);
  return it.kind === "group" || (it.schedule !== null && it.schedule.start !== null);
};

export function revealPatch(view: PlanView, collapsed: ReadonlySet<ItemId>, id: ItemId): Pick<UiState, "view" | "collapsed" | "reveal"> {
  const up = new Set(ancestors(view.plan, id));
  const open = [...collapsed].some((c) => up.has(c)) ? new Set([...collapsed].filter((c) => !up.has(c))) : collapsed;
  return { view: "timeline", collapsed: open, reveal: hasRow(view.plan, id) ? id : null };
}

export function goToFirstPatch(view: PlanView, collapsed: ReadonlySet<ItemId>): Pick<UiState, "selected" | "view" | "collapsed" | "reveal"> {
  const first = countedConflicts(view)[0];
  if (first === undefined) throw new Error("Go to first conflict: there is no conflict");
  const succ = conflictSuccessor(view, first);
  return { selected: succ, ...revealPatch(view, collapsed, succ) };
}

export function HeadCounts(p: { view: PlanView; onChoose(choice: string): void }) {
  const view = p.view;
  const uiValue = useContext(UiContext);
  const conflicts = countedConflicts(view);

  const goToFirst = (): void => {
    if (uiValue === null) throw new Error("Go to first conflict needs a UiContext provider");
    uiValue.setUi(goToFirstPatch(view, uiValue.ui.collapsed));
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
