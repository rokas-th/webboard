import type { Item, ItemId } from "../../domain/model";
import { childrenOf } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { rowContext, stepOf, type NoteText, type RowContext } from "../list/columns";
import { planGroupPath } from "../list/groups";
import { fold, searchQuery } from "./fold";

export type Matcher = (id: ItemId) => boolean;

function itemOf(ctx: RowContext, id: ItemId): Item {
  const item = ctx.view.plan.items.get(id);
  if (item === undefined) throw new Error(`Search: no item ${id}`);
  return item;
}

function ownText(ctx: RowContext, item: Item): string[] {
  if (ctx.ghosts.has(item.id)) return [item.name];
  const parent = item.place.parent;
  const people = (ctx.view.people.assignees.get(item.id) ?? []).map((a) => (a.kind === "live" ? a.person.name : (a.name ?? "")));
  return [item.name, ctx.notes(item.id), stepOf(ctx, item.id)?.name ?? "", ...people, parent === null ? "" : planGroupPath(ctx.view.plan, parent)];
}

export function searchMatcher(ctx: RowContext, query: string): Matcher | null {
  const q = searchQuery(query);
  if (q === "") return null;
  const has = (s: string): boolean => fold(s).includes(q);
  const memo = new Map<ItemId, boolean>();
  const match = (id: ItemId): boolean => {
    const seen = memo.get(id);
    if (seen !== undefined) return seen;
    const item = itemOf(ctx, id);
    const hit =
      item.kind === "group"
        ? has(item.name) ||
          childrenOf(ctx.view.plan, id)
            .filter((c) => !c.trashed)
            .some((c) => match(c.id))
        : ownText(ctx, item).some(has);
    memo.set(id, hit);
    return hit;
  };
  return match;
}

export const planMatcher = (view: PlanView, notes: NoteText, query: string): Matcher | null =>
  searchQuery(query) === "" ? null : searchMatcher(rowContext(view, notes, null, null), query);
