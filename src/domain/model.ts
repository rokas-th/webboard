import type { Calendar } from "./calendar";
import type { IsoDate } from "./dates";

export type ItemId = string;
export type PlanId = string;
export type BaselineId = string;
export type LinkKey = string;
export type ItemKind = "task" | "milestone" | "group";
export type Status = "todo" | "doing" | "done";
export type Horizon = "now" | "next" | "later";
export type LinkType = "FS" | "SS" | "FF" | "SF";

export interface Schedule {
  start: IsoDate | null;
  dur: number;
  status: Status;
  progress: number;
  horizon: Horizon;
}

export interface Place {
  parent: ItemId | null;
  order: string;
}

export interface Item {
  id: ItemId;
  kind: ItemKind;
  name: string;
  trashed: boolean;
  schedule: Schedule | null;
  place: Place;
  refs: Readonly<Record<string, string>>;
}

export interface Link {
  from: ItemId;
  to: ItemId;
  type: LinkType;
  lag: number;
}

export interface Baseline {
  id: BaselineId;
  name: string;
  at: IsoDate;
  dates: Readonly<Record<ItemId, { start: IsoDate; dur: number }>>;
}

export type StepId = string;
export type StepColour = "cyan" | "violet" | "magenta" | "lime" | "amber" | "coral" | "sky" | "slate";

export interface StepValue {
  n: string;
  c: StepColour;
  o: string;
  d?: true;
  l?: number;
}

export interface Workflow {
  steps: ReadonlyMap<StepId, StepValue | null>;
  items: ReadonlyMap<ItemId, StepId | null>;
}

export const EMPTY_WORKFLOW: Workflow = { steps: new Map(), items: new Map() };

export const STEP_COLOURS: readonly StepColour[] = ["cyan", "violet", "magenta", "lime", "amber", "coral", "sky", "slate"];
export const MAX_STEP_NAME = 32;
export const MAX_STEP_LIMIT = 99;

export type PersonId = string;

export interface PersonValue {
  n: string;
  i: string;
  c: StepColour;
  o: string;
}

export interface People {
  persons: ReadonlyMap<PersonId, PersonValue | null>;
  assignees: ReadonlyMap<ItemId, readonly PersonId[] | null>;
}

export const EMPTY_PEOPLE: People = { persons: new Map(), assignees: new Map() };

export const MAX_PERSON_NAME = 64;
export const MAX_INITIALS = 3;
export const MAX_ASSIGNEES = 8;

export interface DefaultsValue {
  dur: number;
  dated: boolean;
  who: PersonId | null;
  group: ItemId | null;
  step: StepId | null;
}

export interface PlanState {
  id: PlanId;
  name: string;
  items: ReadonlyMap<ItemId, Item>;
  links: ReadonlyMap<LinkKey, Link>;
  calendar: Calendar;
  baselines: ReadonlyMap<BaselineId, Baseline>;
  workflow: Workflow;
  people: People;
  defaults: DefaultsValue | null;
}

export const scheduleOf = (it: Item): Schedule => {
  if (it.schedule === null) throw new Error(`no schedule for item ${it.id}`);
  return it.schedule;
};

export const linkKey = (from: ItemId, to: ItemId): LinkKey => `${from}>${to}`;

export const MAX_TASK_DUR = 3650;
export const MAX_LAG = 1000;
