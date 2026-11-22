import type { PlanState, StepId } from "../domain/model";
import { stepsOf, VIRTUAL_STEPS } from "../domain/steps";
import type { LogState } from "../log/state";
import type { UnitKey } from "../log/types";
import { decodeAs } from "../plan/units";
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
  const written = [...log.writers(u)]
    .reverse()
    .map((a) => {
      const action = log.get(a);
      if (action === undefined) throw new Error(`Action ${a} is not ready`);
      const x = action.w.find((y) => y.u === u);
      if (x === undefined) throw new Error(`Action ${a} holds no write to ${u}`);
      return decodeAs("baseline", u, x.v);
    })
    .find((v) => v !== null);
  if (written === undefined) throw new Error(`No baseline ${id}`);
  return written.name;
};

export interface StepName {
  name: string;
  removed: boolean;
}

const lastStepName = (log: LogState, u: UnitKey, id: StepId): string | null => {
  const written = [...log.writers(u)]
    .reverse()
    .map((a) => {
      const action = log.get(a);
      if (action === undefined) throw new Error(`Action ${a} is not ready`);
      const x = action.w.find((y) => y.u === u);
      if (x === undefined) throw new Error(`Action ${a} holds no write to ${u}`);
      return decodeAs("step", u, x.v);
    })
    .find((v) => v !== null);
  if (written !== undefined) return written.n;
  const virtual = VIRTUAL_STEPS.get(id);
  return virtual === undefined ? null : virtual.n;
};

export const stepNameIn = (log: LogState, plans: readonly PlanState[], u: UnitKey, id: StepId): StepName | null => {
  const found = plans.flatMap((p) => stepsOf(p).filter((s) => s.id === id));
  if (found.length > 0) return { name: found[0].name, removed: false };
  const old = lastStepName(log, u, id);
  return old === null ? null : { name: old, removed: true };
};
