import { goneSet } from "../../domain/derive";
import type { ItemId, PlanState } from "../../domain/model";
import { childrenOf } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { ghostIds } from "../ghosts";

interface ListSection {
  group: ItemId | null;
  name: string;
  items: ItemId[];
}

export type StatusLabel = "conflict" | "held" | "late" | "in progress" | "done" | "not started";

const NOT_IN_A_GROUP = "Not in a group";

const pathOf = (plan: PlanState, id: ItemId): string[] => {
  const g = plan.items.get(id);
  if (g === undefined) throw new Error(`groupPath: no item ${id}`);
  return g.place.parent === null ? [g.name] : [...pathOf(plan, g.place.parent), g.name];
};

export const planGroupPath = (plan: PlanState, id: ItemId): string => pathOf(plan, id).join(" › ");

export const groupPath = (view: PlanView, id: ItemId): string => planGroupPath(view.plan, id);

interface Placed {
  id: ItemId;
  group: boolean;
  owner: ItemId | null;
}

export function listGroups(view: PlanView): ListSection[] {
  const ghosts = ghostIds(view);
  const gone = goneSet(view.plan);
  const listed = (id: ItemId): boolean => !gone.has(id) || ghosts.has(id);
  const walk = (parent: ItemId | null, owner: ItemId | null): Placed[] =>
    childrenOf(view.plan, parent).flatMap((i): Placed[] => {
      const here = listed(i.id) ? [{ id: i.id, group: i.kind === "group", owner }] : [];
      return i.kind === "group" ? [...here, ...walk(i.id, listed(i.id) ? i.id : owner)] : here;
    });
  const placed = walk(null, null);
  const ids = new Set(placed.map((e) => e.id));
  const unplaced = [...ghosts].filter((id) => !ids.has(id));
  if (unplaced.length > 0) throw new Error(`listGroups: ghost ${unplaced.join(", ")} has no section`);
  const byOwner = new Map<ItemId | null, ItemId[]>();
  placed
    .filter((e) => !e.group)
    .forEach((e) => {
      const list = byOwner.get(e.owner);
      if (list === undefined) byOwner.set(e.owner, [e.id]);
      else list.push(e.id);
    });
  const sections = placed.filter((e) => e.group).map((e) => ({ group: e.id, name: groupPath(view, e.id), items: byOwner.get(e.id) ?? [] }));
  const top = byOwner.get(null) ?? [];
  return [...sections, ...(top.length === 0 ? [] : [{ group: null, name: NOT_IN_A_GROUP, items: top }])];
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
  if (ghostIds(view).has(id)) return "held";
  const status = view.derived.status.get(id);
  if (status === undefined) throw new Error(`statusLabel: item ${id} has no derived status`);
  if (conflicted(view, id)) return "conflict";
  if (view.held.has(id)) return "held";
  if (view.derived.late.has(id)) return "late";
  if (status === "doing") return "in progress";
  if (status === "done") return "done";
  return "not started";
}
