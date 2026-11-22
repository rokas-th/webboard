import type { PersonId, PlanState, StepId } from "../domain/model";
import { peopleOf } from "../domain/people";
import { stepsOf, VIRTUAL_STEPS } from "../domain/steps";
import type { LogState } from "../log/state";
import type { UnitKey } from "../log/types";
import { lastNonNull, lastPersonValue } from "../plan/former";
import { refusal } from "./copy";
import { Refused } from "./intents";

export function normalizeName(raw: string): string {
  const name = raw.replace(/\s+/g, (run) => (/[\n\r\t]/.test(run) ? " " : run)).trim();
  if (name.length === 0) throw new Refused(refusal.emptyName);
  return name;
}

export const baselineName = (log: LogState, plans: readonly PlanState[], u: UnitKey, id: string): string => {
  const live = plans.map((p) => p.baselines.get(id)).find((x) => x !== undefined);
  if (live !== undefined) return live.name;
  const written = lastNonNull(log, u, "baseline");
  if (written === null) throw new Error(`No baseline ${id}`);
  return written.name;
};

export interface KnownName {
  name: string;
  removed: boolean;
}

const lastStepName = (log: LogState, u: UnitKey, id: StepId): string | null => {
  const written = lastNonNull(log, u, "step");
  if (written !== null) return written.n;
  const virtual = VIRTUAL_STEPS.get(id);
  return virtual === undefined ? null : virtual.n;
};

export const stepNameIn = (log: LogState, plans: readonly PlanState[], u: UnitKey, id: StepId): KnownName | null => {
  const found = plans.flatMap((p) => stepsOf(p).filter((s) => s.id === id));
  if (found.length > 0) return { name: found[0].name, removed: false };
  const old = lastStepName(log, u, id);
  return old === null ? null : { name: old, removed: true };
};

export const personNameIn = (log: LogState, plans: readonly PlanState[], id: PersonId): KnownName | null => {
  const found = plans.flatMap((p) => peopleOf(p).filter((x) => x.id === id));
  if (found.length > 0) return { name: found[0].name, removed: false };
  const old = lastPersonValue(log, id);
  return old === null ? null : { name: old.n, removed: true };
};
