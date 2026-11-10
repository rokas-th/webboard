import type { PlanView } from "../../store/doc";
import { heldChoice } from "./describe";

export function HeldChip(p: { view: PlanView; onChoose(choice: string): void }) {
  const view = p.view;
  if (view.held.size === 0) return null;
  const open = (): void => {
    const c = heldChoice(view);
    if (c === null) throw new Error("No open choice holds the held items");
    p.onChoose(c.id);
  };
  return (
    <button type="button" className="chip chip-amber" onClick={open}>
      {view.held.size} held
    </button>
  );
}
