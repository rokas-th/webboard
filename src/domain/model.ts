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

export interface PlanState {
  id: PlanId;
  name: string;
  items: ReadonlyMap<ItemId, Item>;
  links: ReadonlyMap<LinkKey, Link>;
  calendar: Calendar;
  baselines: ReadonlyMap<BaselineId, Baseline>;
}

export const linkKey = (from: ItemId, to: ItemId): LinkKey => `${from}>${to}`;
