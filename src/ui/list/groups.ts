import { goneSet } from "../../domain/derive";
import type { ItemId } from "../../domain/model";
import { childrenOf } from "../../plan/project";
import type { PlanView } from "../../store/doc";

export interface ListSection {
  group: ItemId | null;
  name: string;
  items: ItemId[];
}

export type StatusLabel = "conflict" | "held" | "late" | "in progress" | "done" | "not started";

export const NOT_IN_A_GROUP = "Not in a group";

export const ghostSet = (view: PlanView): ReadonlySet<ItemId> =>
  new Set(view.choices.filter((c) => c.kind === "delete").flatMap((c) => c.items));

export function listGroups(view: PlanView): ListSection[] {
  const ghosts = ghostSet(view);
  const gone = goneSet(view.plan);
  const listed = (id: ItemId): boolean => !gone.has(id) || ghosts.has(id);
  const direct = (parent: ItemId | null): ItemId[] =>
    childrenOf(view.plan, parent)
      .filter((i) => i.kind !== "group" && listed(i.id))
      .map((i) => i.id);
  const sections = (parent: ItemId | null, path: readonly string[]): ListSection[] =>
    childrenOf(view.plan, parent)
      .filter((i) => i.kind === "group" && listed(i.id))
      .flatMap((g) => {
        const names = [...path, g.name];
        return [{ group: g.id, name: names.join(" › "), items: direct(g.id) }, ...sections(g.id, names)];
      });
  const top = direct(null);
  return [...sections(null, []), ...(top.length === 0 ? [] : [{ group: null, name: NOT_IN_A_GROUP, items: top }])];
}

const conflicted = (view: PlanView, id: ItemId): boolean =>
  view.derived.conflicts.some((c) => {
    if (c.kind === "early") return c.succ === id;
    if (c.kind === "dayoff") return false;
    const link = view.plan.links.get(c.link);
    if (link === undefined) throw new Error(`Conflict link ${c.link} is not in the plan`);
    return link.to === id;
  });

export function statusLabel(view: PlanView, id: ItemId): StatusLabel {
  if (conflicted(view, id)) return "conflict";
  if (view.held.has(id)) return "held";
  if (view.derived.late.has(id)) return "late";
  const status = view.derived.status.get(id);
  if (status === "doing") return "in progress";
  if (status === "done") return "done";
  return "not started";
}
