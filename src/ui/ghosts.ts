import type { ItemId } from "../domain/model";
import type { PlanView } from "../store/doc";

export const ghostIds = (view: PlanView): ReadonlySet<ItemId> =>
  new Set(
    view.choices
      .filter((c) => c.kind === "delete")
      .flatMap((c) => c.items)
      .filter((id) => view.plan.items.get(id)?.trashed === true),
  );
