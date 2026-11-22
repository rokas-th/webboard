import { formerText } from "../../actions/copy";
import type { ItemId, PersonId } from "../../domain/model";
import type { Assignee, Person } from "../../domain/people";
import type { PlanView } from "../../store/doc";
import type { PickSection } from "../common/ContextMenu";
import { ASSIGN } from "./text";

export const heldOf = (view: PlanView, item: ItemId): readonly PersonId[] =>
  (view.people.assignees.get(item) ?? []).flatMap((a) => (a.kind === "live" ? [a.person.id] : []));

export const PERSON_ROW = "person:";

export const PEOPLE_SETTINGS_ROW = "people-settings";

export function assignSection(people: readonly Person[], held: readonly PersonId[]): PickSection | null {
  if (people.length === 0) return null;
  return {
    title: ASSIGN,
    rows: people.map((p) => ({ id: `${PERSON_ROW}${p.id}`, title: p.name, checked: held.includes(p.id), checkable: true })),
  };
}

export function personOfRow(row: string): PersonId | null {
  if (!row.startsWith(PERSON_ROW)) return null;
  const id = row.slice(PERSON_ROW.length);
  if (id === "") throw new Error(`The row ${JSON.stringify(row)} names no person`);
  return id;
}

export const assigneeName = (a: Assignee): string => (a.kind === "live" ? a.person.name : formerText(a.name));

export function cardPeople(list: readonly Assignee[]): { first: Assignee; more: number } | null {
  const [first, ...rest] = list;
  if (first === undefined) return null;
  return { first, more: rest.length };
}
