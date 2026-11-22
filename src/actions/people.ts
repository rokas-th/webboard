import { MAX_ASSIGNEES, MAX_INITIALS, MAX_PERSON_NAME, STEP_COLOURS, type Item, type ItemId, type PersonId, type PersonValue, type PlanState, type StepColour } from "../domain/model";
import { peopleOf, personNameKey, storedAssigneesOf, type Person } from "../domain/people";
import { newId } from "../log/ids";
import type { Write } from "../log/types";
import { cmp } from "../plan/project";
import { planRules } from "../plan/rules";
import * as codec from "../plan/units";
import { key } from "../plan/units";
import { items, label, q, refusal } from "./copy";
import { Refused, type AssignIntent, type Ctx, type PersonIntent } from "./intents";
import { live } from "./lookup";
import { normalizeName } from "./names";
import { slotAfter, type Keyed } from "./slot";

export interface PersonDraft {
  own: readonly Write[];
  label: string;
  sentences: readonly string[];
}

const own = (u: string, v: unknown): Write => ({ u, v, c: "own" });

const valueOfPerson = (p: Person): PersonValue => ({ n: p.name, i: p.initials, c: p.colour, o: p.order });

const personWrite = (p: Person): Write => own(key.pp(p.id), codec.person.enc(valueOfPerson(p)));

const listValue = (ids: readonly PersonId[]): readonly PersonId[] | null => (ids.length === 0 ? null : [...ids].sort(cmp));

const listWrite = (item: ItemId, ids: readonly PersonId[]): Write => own(key.pa(item), codec.assignees.enc(listValue(ids)));

const missingPerson = (id: PersonId | null): Error => new Error(`Person ${id} is not in this plan`);

const livePerson = (plan: PlanState, id: PersonId): Person => {
  const p = peopleOf(plan).find((x) => x.id === id);
  if (p === undefined) throw missingPerson(id);
  return p;
};

const checkColour = (colour: StepColour): StepColour => {
  if (!STEP_COLOURS.includes(colour)) throw new Error(`Person colour ${colour} is not one of ${STEP_COLOURS.join(", ")}`);
  return colour;
};

const checkName = (plan: PlanState, raw: string, self: PersonId | null): string => {
  const name = normalizeName(raw);
  if ([...name].length > MAX_PERSON_NAME) throw new Refused(refusal.personNameLong);
  const taken = peopleOf(plan).find((p) => p.id !== self && personNameKey(p.name) === personNameKey(name));
  if (taken !== undefined) throw new Refused(refusal.personNameTaken(taken.name));
  return name;
};

const checkInitials = (raw: string): string => {
  const initials = raw.trim();
  const length = [...initials].length;
  if (length < 1 || length > MAX_INITIALS || /\s/u.test(initials)) throw new Refused(refusal.initials);
  return initials;
};

const changed = (before: Person, after: Person): Write => {
  const w = personWrite(after);
  if (planRules.same(w.u, w.v, codec.person.enc(valueOfPerson(before)))) throw new Refused(refusal.nothing);
  return w;
};

const keyed = (people: readonly Person[]): Keyed[] => people.map((p) => ({ id: p.id, order: p.order }));

const rekeyedWrites = (plan: PlanState, rekeyed: readonly Keyed[]): Write[] => rekeyed.map((r) => personWrite({ ...livePerson(plan, r.id), order: r.order }));

const plain = (writes: readonly Write[], text: string): PersonDraft => ({ own: writes, label: text, sentences: [] });

const distinct = <T extends string>(xs: readonly T[], what: string): readonly T[] => {
  const twice = xs.find((x, n) => xs.indexOf(x) !== n);
  if (twice !== undefined) throw new Error(`${what} ${twice} is repeated`);
  return xs;
};

const assignable = (plan: PlanState, id: ItemId): Item => {
  const it = live(plan, id);
  if (it.kind === "group") throw new Error(`Group ${it.id} has no assignees`);
  return it;
};

const sameList = (a: readonly PersonId[], b: readonly PersonId[]): boolean => a.length === b.length && a.every((x, n) => x === b[n]);

export const holders = (plan: PlanState, person: PersonId): readonly [ItemId, readonly PersonId[]][] =>
  [...plan.people.assignees].flatMap(([item, ids]): [ItemId, readonly PersonId[]][] => {
    if (ids === null || !ids.includes(person)) return [];
    const it = plan.items.get(item);
    if (it === undefined) throw new Error(`Item ${item} is not in this plan`);
    if (it.kind === "group") throw new Error(`Group ${item} has assignees`);
    return [[item, ids]];
  });

const editDraft = (ctx: Ctx, intent: PersonIntent): PersonDraft => {
  const plan = ctx.view.plan;
  switch (intent.op) {
    case "add": {
      const colour = checkColour(intent.colour);
      const name = checkName(plan, intent.name, null);
      const initials = checkInitials(intent.initials);
      const slot = slotAfter(keyed(peopleOf(plan)), intent.after, () => missingPerson(intent.after));
      const added: PersonValue = { n: name, i: initials, c: colour, o: slot.order };
      return plain([own(key.pp(newId()), codec.person.enc(added)), ...rekeyedWrites(plan, slot.rekeyed)], label.personAdded(name));
    }
    case "rename": {
      const p = livePerson(plan, intent.person);
      const name = checkName(plan, intent.name, p.id);
      return plain([changed(p, { ...p, name })], label.personRenamed(p.name, name));
    }
    case "initials": {
      const p = livePerson(plan, intent.person);
      const initials = checkInitials(intent.initials);
      return plain([changed(p, { ...p, initials })], label.personInitials(p.name, initials));
    }
    case "colour": {
      const p = livePerson(plan, intent.person);
      const colour = checkColour(intent.colour);
      return plain([changed(p, { ...p, colour })], label.personColoured(p.name, colour));
    }
    case "reorder": {
      const p = livePerson(plan, intent.person);
      const all = peopleOf(plan);
      const at = all.findIndex((x) => x.id === p.id);
      const prev = at === 0 ? null : all[at - 1].id;
      if (intent.after === p.id) throw new Error(`Person ${p.id} cannot follow itself`);
      if (prev === intent.after) throw new Refused(refusal.nothing);
      const slot = slotAfter(
        keyed(all.filter((x) => x.id !== p.id)),
        intent.after,
        () => missingPerson(intent.after),
      );
      return plain([personWrite({ ...p, order: slot.order }), ...rekeyedWrites(plan, slot.rekeyed)], label.personReordered(p.name));
    }
    case "remove": {
      if (intent.to === intent.person) throw new Error(`Person ${intent.person} cannot take its own items`);
      const p = livePerson(plan, intent.person);
      const to = intent.to === null ? null : livePerson(plan, intent.to);
      const next = holders(plan, p.id).map(([item, ids]): [ItemId, readonly PersonId[]] => [
        item,
        [...new Set([...ids.filter((x) => x !== p.id), ...(to === null ? [] : [to.id])])],
      ]);
      return plain([own(key.pp(p.id), codec.person.enc(null)), ...next.map(([item, ids]) => listWrite(item, ids))], label.personRemoved(p.name, next.length, to === null ? null : to.name));
    }
  }
};

const whatOf = (changedItems: readonly Item[]): string => (changedItems.length === 1 ? q(changedItems[0].name) : items(changedItems.length));

const assignDraft = (ctx: Ctx, intent: AssignIntent): PersonDraft => {
  const plan = ctx.view.plan;
  if (intent.t === "assignees") {
    const it = assignable(plan, intent.item);
    const stored = storedAssigneesOf(plan, it.id);
    const ids = distinct(intent.people, "Person").map((id) => (stored.includes(id) ? id : livePerson(plan, id).id));
    if (ids.length > MAX_ASSIGNEES) throw new Refused(refusal.assigneesMax);
    if (sameList(stored, [...ids].sort(cmp))) throw new Refused(refusal.nothing);
    return plain([listWrite(it.id, ids)], label.assigneesSet(it.name));
  }
  const p = livePerson(plan, intent.person);
  const adding = intent.t === "assign";
  const moved = distinct(intent.items, "Item").flatMap((id): { item: Item; write: Write }[] => {
    const it = assignable(plan, id);
    const stored = storedAssigneesOf(plan, it.id);
    if (stored.includes(p.id) === adding) return [];
    if (adding && stored.length >= MAX_ASSIGNEES) throw new Refused(refusal.assigneesFull(it.name));
    return [{ item: it, write: listWrite(it.id, adding ? [...stored, p.id] : stored.filter((x) => x !== p.id)) }];
  });
  if (moved.length === 0) throw new Refused(refusal.nothing);
  const what = whatOf(moved.map((m) => m.item));
  return plain(
    moved.map((m) => m.write),
    adding ? label.assigned(p.name, what) : label.unassigned(p.name, what),
  );
};

export function personDraft(ctx: Ctx, intent: PersonIntent | AssignIntent): PersonDraft {
  return intent.t === "person" ? editDraft(ctx, intent) : assignDraft(ctx, intent);
}

export function duplicatePeopleWrites(plan: PlanState, copies: readonly (readonly [from: ItemId, to: ItemId])[]): readonly Write[] {
  const isLive = new Set(peopleOf(plan).map((p) => p.id));
  return copies.flatMap(([from, to]) => {
    const kept = storedAssigneesOf(plan, from).filter((id) => isLive.has(id));
    return kept.length === 0 ? [] : [listWrite(to, kept)];
  });
}
