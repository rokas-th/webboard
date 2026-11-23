import { defaultsOf } from "../domain/defaults";
import { MAX_TASK_DUR, type DefaultsValue, type ItemId, type PersonId, type PlanState, type StepId } from "../domain/model";
import { peopleOf } from "../domain/people";
import { stepModeOf, stepsOf } from "../domain/steps";
import type { Write } from "../log/types";
import * as codec from "../plan/units";
import { key } from "../plan/units";
import { label, refusal } from "./copy";
import { Refused, type Ctx, type DefaultsIntent } from "./intents";
import { itemOf } from "./lookup";

export interface DefaultsDraft {
  own: readonly Write[];
  label: string;
  sentences: readonly string[];
}

interface Field {
  next: DefaultsValue;
  label: string;
}

const personName = (plan: PlanState, id: PersonId): string => {
  const p = peopleOf(plan).find((x) => x.id === id);
  if (p === undefined) throw new Error(`Person ${id} is not in this plan`);
  return p.name;
};

const groupName = (plan: PlanState, id: ItemId): string => {
  const it = itemOf(plan, id);
  if (it.kind !== "group") throw new Error(`Item ${id} is not a group`);
  if (it.trashed) throw new Error(`Group ${id} is in the Trash`);
  return it.name;
};

const stepName = (plan: PlanState, id: StepId): string => {
  const s = stepsOf(plan).find((x) => x.id === id);
  if (s === undefined) throw new Error(`Step ${id} is not in this plan`);
  if (s.completes) throw new Error(`Step ${id} completes items`);
  return s.name;
};

const fieldOf = (plan: PlanState, now: DefaultsValue, intent: DefaultsIntent): Field => {
  switch (intent.field) {
    case "dur": {
      if (!Number.isInteger(intent.value) || intent.value < 1 || intent.value > MAX_TASK_DUR) throw new Refused(refusal.defaultDur);
      if (intent.value === now.dur) throw new Refused(refusal.nothing);
      return { next: { ...now, dur: intent.value }, label: label.defaultDur(intent.value) };
    }
    case "dated":
      if (intent.value === now.dated) throw new Refused(refusal.nothing);
      return { next: { ...now, dated: intent.value }, label: label.defaultDated(intent.value) };
    case "who": {
      const name = intent.value === null ? null : personName(plan, intent.value);
      if (intent.value === now.who) throw new Refused(refusal.nothing);
      return { next: { ...now, who: intent.value }, label: label.defaultWho(name) };
    }
    case "group": {
      const name = intent.value === null ? null : groupName(plan, intent.value);
      if (intent.value === now.group) throw new Refused(refusal.nothing);
      return { next: { ...now, group: intent.value }, label: label.defaultGroup(name) };
    }
    case "step": {
      if (stepModeOf(plan) === "dates") throw new Refused(refusal.defaultStepByDates);
      const name = intent.value === null ? null : stepName(plan, intent.value);
      if (intent.value === now.step) throw new Refused(refusal.nothing);
      return { next: { ...now, step: intent.value }, label: label.defaultStep(name) };
    }
  }
};

export function defaultsDraft(ctx: Ctx, intent: DefaultsIntent): DefaultsDraft {
  const plan = ctx.view.plan;
  const f = fieldOf(plan, defaultsOf(plan), intent);
  return { own: [{ u: key.pd, v: codec.defaults.enc(f.next), c: "own" }], label: f.label, sentences: [] };
}
