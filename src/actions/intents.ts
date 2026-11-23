import type { Calendar, HolidayYear } from "../domain/calendar";
import type { IsoDate } from "../domain/dates";
import type { BaselineId, DefaultsValue, ItemId, ItemKind, LinkKey, LinkType, PersonId, Schedule, StepColour, StepId } from "../domain/model";
import type { Conflict, Stop } from "../domain/schedule";
import type { LogState } from "../log/state";
import type { Action, DeviceId, SessionId } from "../log/types";
import type { PlanView } from "../store/doc";

export type Intent =
  | { t: "create"; kind: ItemKind; name: string; parent: ItemId | null; after: ItemId | null; start: IsoDate | null; dur?: number; step?: StepId; who?: PersonId }
  | { t: "rename"; item: ItemId; name: string }
  | { t: "schedule"; item: ItemId; set: Partial<Schedule> }
  | { t: "move"; items: readonly ItemId[]; days: number }
  | { t: "resize"; item: ItemId; dur: number }
  | { t: "place"; item: ItemId; parent: ItemId | null; after: ItemId | null }
  | { t: "trash"; items: readonly ItemId[] }
  | { t: "restore"; items: readonly ItemId[] }
  | { t: "link"; from: ItemId; to: ItemId; type: LinkType; lag: number }
  | { t: "unlink"; link: LinkKey }
  | { t: "calendar"; next: Calendar; base?: Calendar }
  | { t: "snap"; item: ItemId }
  | { t: "fix"; conflict: Conflict; how: "push" | "shorten" | "remove" }
  | { t: "baseline"; op: "save"; name: string }
  | { t: "baseline"; op: "rename"; id: BaselineId; name: string }
  | { t: "baseline"; op: "remove"; id: BaselineId }
  | { t: "planName"; name: string }
  | { t: "duplicate"; item: ItemId }
  | StepIntent
  | ToStepIntent
  | PersonIntent
  | AssignIntent
  | DefaultsIntent;

export type DefaultsIntent = { [F in keyof DefaultsValue]: { t: "defaults"; field: F; value: DefaultsValue[F] } }[keyof DefaultsValue];

export type PersonIntent =
  | { t: "person"; op: "add"; name: string; initials: string; colour: StepColour; after: PersonId | null }
  | { t: "person"; op: "rename"; person: PersonId; name: string }
  | { t: "person"; op: "initials"; person: PersonId; initials: string }
  | { t: "person"; op: "colour"; person: PersonId; colour: StepColour }
  | { t: "person"; op: "reorder"; person: PersonId; after: PersonId | null }
  | { t: "person"; op: "remove"; person: PersonId; to: PersonId | null };

export type AssignIntent =
  | { t: "assign" | "unassign"; items: readonly ItemId[]; person: PersonId }
  | { t: "assignees"; item: ItemId; people: readonly PersonId[] };

export type StepIntent =
  | { t: "step"; op: "add"; name: string; colour: StepColour; after: StepId | null }
  | { t: "step"; op: "rename"; step: StepId; name: string }
  | { t: "step"; op: "colour"; step: StepId; colour: StepColour }
  | { t: "step"; op: "reorder"; step: StepId; after: StepId | null }
  | { t: "step"; op: "limit"; step: StepId; limit: number | null }
  | { t: "step"; op: "completes"; step: StepId; completes: boolean }
  | { t: "step"; op: "noneCompletes" }
  | { t: "step"; op: "delete"; step: StepId; to: StepId | null };

export type ToStepIntent = { t: "toStep"; items: readonly ItemId[]; step: StepId };

export interface Preview {
  itemsChanged: number;
  endsChanged: number;
  movedLater: number;
  stopped: readonly Stop[];
  conflictsAfter: number;
  kept: readonly string[];
}

export type NoteCopy = readonly [from: ItemId, to: ItemId];

export interface Built {
  action: Action;
  newNotes: readonly ItemId[];
  noteCopies?: readonly NoteCopy[];
  toast: string;
  preview: Preview;
}

export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

export class HeldRefused extends Refused {
  readonly choice: string;

  constructor(message: string, choice: string) {
    super(message);
    this.name = "HeldRefused";
    this.choice = choice;
  }
}

export interface Ctx {
  view: PlanView;
  log: LogState;
  dev: DeviceId;
  ses: SessionId;
  now: number;
  devices: ReadonlyMap<DeviceId, string>;
  cachedHolidays(region: string, year: number): HolidayYear | null;
}
