import { cmp } from "../plan/project";
import type { ItemId, PersonId, PersonValue, PlanState, StepColour } from "./model";

export interface Person {
  id: PersonId;
  name: string;
  initials: string;
  colour: StepColour;
  order: string;
}

export type Assignee =
  | { kind: "live"; person: Person }
  | { kind: "former"; id: PersonId; name: string | null; initials: string | null; colour: StepColour | null };

export interface PeopleProblem {
  kind: "sameName";
  people: readonly PersonId[];
}

export interface PeopleProjection {
  people: readonly Person[];
  assignees: ReadonlyMap<ItemId, readonly Assignee[]>;
  problems: readonly PeopleProblem[];
}

export const personNameKey = (n: string): string => n.toLowerCase();

export function peopleOf(plan: PlanState): readonly Person[] {
  return [...plan.people.persons]
    .flatMap(([id, v]): Person[] => (v === null ? [] : [{ id, name: v.n, initials: v.i, colour: v.c, order: v.o }]))
    .sort((a, b) => cmp(a.order, b.order) || cmp(a.id, b.id));
}

export function storedAssigneesOf(plan: PlanState, item: ItemId): readonly PersonId[] {
  return plan.people.assignees.get(item) ?? [];
}

const initialOf = (word: string): string => {
  const [first] = [...word];
  if (first === undefined) throw new Error(`No initial for the word "${word}"`);
  const upper = first.toUpperCase();
  return [...upper].length === 1 ? upper : first;
};

export function initialsOf(name: string): string {
  const words = name.split(/\s+/u).filter((x) => x.length > 0);
  if (words.length === 0) throw new Error(`No initials for the name "${name}"`);
  const first = initialOf(words[0]);
  return words.length === 1 ? first : `${first}${initialOf(words[words.length - 1])}`;
}

const formerOf = (id: PersonId, value: PersonValue | undefined): Assignee =>
  value === undefined
    ? { kind: "former", id, name: null, initials: null, colour: null }
    : { kind: "former", id, name: value.n, initials: value.i, colour: value.c };

const problemsOf = (people: readonly Person[]): PeopleProblem[] => {
  const names = [...new Set(people.map((p) => personNameKey(p.name)))];
  return names
    .map((n) => people.filter((p) => personNameKey(p.name) === n).map((p) => p.id))
    .filter((ids) => ids.length > 1)
    .map((ids): PeopleProblem => ({ kind: "sameName", people: ids }));
};

export function projectPeople(plan: PlanState, former: ReadonlyMap<PersonId, PersonValue>): PeopleProjection {
  const people = peopleOf(plan);
  const live = new Map(people.map((p): [PersonId, Person] => [p.id, p]));
  const assigneesOf = (ids: readonly PersonId[]): Assignee[] => [
    ...people.filter((p) => ids.includes(p.id)).map((person): Assignee => ({ kind: "live", person })),
    ...ids
      .filter((id) => !live.has(id))
      .sort(cmp)
      .map((id) => formerOf(id, former.get(id))),
  ];
  return {
    people,
    assignees: new Map(
      [...plan.people.assignees].flatMap(([item, ids]): [ItemId, readonly Assignee[]][] => (ids === null || ids.length === 0 ? [] : [[item, assigneesOf(ids)]])),
    ),
    problems: problemsOf(people),
  };
}
