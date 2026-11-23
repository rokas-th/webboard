import type { PlanView } from "../store/doc";
import type { PersonId } from "./model";
import type { Person } from "./people";

export type MeState = { kind: "none" } | { kind: "live"; person: Person } | { kind: "removed"; id: PersonId; name: string | null } | { kind: "missing"; id: PersonId };

export function meOf(view: PlanView, id: PersonId | null): MeState {
  if (id === null) return { kind: "none" };
  const person = view.people.people.find((p) => p.id === id);
  if (person !== undefined) return { kind: "live", person };
  if (!view.plan.people.persons.has(id)) return { kind: "missing", id };
  return { kind: "removed", id, name: view.former.get(id)?.n ?? null };
}

export const meId = (me: MeState): PersonId | null => (me.kind === "live" ? me.person.id : null);
