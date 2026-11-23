import type { DefaultsValue, PlanState } from "./model";
import { stepModeOf, stepsOf } from "./steps";

export const BUILT_IN_DEFAULTS: DefaultsValue = { dur: 3, dated: true, who: null, group: null, step: null };

export type GoneDefault = { field: "who" | "group" | "step"; id: string; name: string | null; why: "removed" | "trashed" | "missing" | "notGroup" | "deleted" | "completes" };

export interface DefaultsProjection extends DefaultsValue {
  stored: DefaultsValue | null;
  gone: readonly GoneDefault[];
}

export interface DefaultNames {
  who: string | null;
  group: string | null;
  step: string | null;
}

export type Followed = { id: string | null; gone: GoneDefault | null };

export const NO_NAMES: DefaultNames = { who: null, group: null, step: null };

const FOLLOWED_NONE: Followed = { id: null, gone: null };

export function defaultsOf(plan: PlanState): DefaultsValue {
  return plan.defaults ?? BUILT_IN_DEFAULTS;
}

export const followWho = (plan: PlanState, id: string | null, names: DefaultNames): Followed => {
  if (id === null) return FOLLOWED_NONE;
  const person = plan.people.persons.get(id);
  if (person !== undefined && person !== null) return { id, gone: null };
  return { id: null, gone: { field: "who", id, name: names.who, why: "removed" } };
};

export const followGroup = (plan: PlanState, id: string | null, names: DefaultNames): Followed => {
  if (id === null) return FOLLOWED_NONE;
  const item = plan.items.get(id);
  if (item === undefined) return { id: null, gone: { field: "group", id, name: names.group, why: "missing" } };
  if (item.kind !== "group") return { id: null, gone: { field: "group", id, name: item.name, why: "notGroup" } };
  if (item.trashed) return { id: null, gone: { field: "group", id, name: item.name, why: "trashed" } };
  return { id, gone: null };
};

export const followStep = (plan: PlanState, id: string | null, names: DefaultNames): Followed => {
  if (id === null || stepModeOf(plan) === "dates") return FOLLOWED_NONE;
  const step = stepsOf(plan).find((s) => s.id === id);
  if (step === undefined) return { id: null, gone: { field: "step", id, name: names.step, why: "deleted" } };
  if (step.completes) return { id: null, gone: { field: "step", id, name: step.name, why: "completes" } };
  return { id, gone: null };
};

export function projectDefaults(plan: PlanState, names: DefaultNames): DefaultsProjection {
  const value = defaultsOf(plan);
  const who = followWho(plan, value.who, names);
  const group = followGroup(plan, value.group, names);
  const step = followStep(plan, value.step, names);
  return {
    dur: value.dur,
    dated: value.dated,
    who: who.id,
    group: group.id,
    step: step.id,
    stored: plan.defaults,
    gone: [who.gone, group.gone, step.gone].filter((g): g is GoneDefault => g !== null),
  };
}
