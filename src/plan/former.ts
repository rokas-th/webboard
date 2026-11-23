import type { DefaultNames } from "../domain/defaults";
import type { PersonId, PersonValue, PlanState } from "../domain/model";
import { VIRTUAL_STEPS } from "../domain/steps";
import type { LogState } from "../log/state";
import type { UnitKey } from "../log/types";
import { cmp } from "./project";
import { decodeAs, key, type Codecs, type Value } from "./units";

export function lastNonNull<K extends keyof Codecs>(log: LogState, u: UnitKey, codec: K): NonNullable<Value<K>> | null {
  const written = [...log.writers(u)]
    .reverse()
    .map((a) => {
      const action = log.get(a);
      if (action === undefined) throw new Error(`Action ${a} is not ready`);
      const x = action.w.find((y) => y.u === u);
      if (x === undefined) throw new Error(`Action ${a} holds no write to ${u}`);
      return decodeAs(codec, u, x.v);
    })
    .find((v): v is NonNullable<Value<K>> => v !== null);
  return written ?? null;
}

export function lastPersonValue(log: LogState, id: PersonId): PersonValue | null {
  return lastNonNull(log, key.pp(id), "person");
}

export function formerPeople(log: LogState, plan: PlanState): ReadonlyMap<PersonId, PersonValue> {
  const stored = [...new Set([...plan.people.assignees.values()].flatMap((ids) => ids ?? []))].sort(cmp);
  const isLive = (id: PersonId): boolean => {
    const p = plan.people.persons.get(id);
    return p !== undefined && p !== null;
  };
  return new Map(
    stored
      .filter((id) => !isLive(id))
      .flatMap((id): [PersonId, PersonValue][] => {
        const value = lastPersonValue(log, id);
        return value === null ? [] : [[id, value]];
      }),
  );
}

export function defaultNames(log: LogState, plan: PlanState): DefaultNames {
  const stored = plan.defaults;
  if (stored === null) return { who: null, group: null, step: null };
  const { who, group, step } = stored;
  return {
    who: who === null ? null : (lastPersonValue(log, who)?.n ?? null),
    group: group === null ? null : (lastNonNull(log, key.n(group), "name")),
    step: step === null ? null : (lastNonNull(log, key.ws(step), "step")?.n ?? VIRTUAL_STEPS.get(step)?.n ?? null),
  };
}
