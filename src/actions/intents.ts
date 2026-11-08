import type { Calendar, HolidayYear } from "../domain/calendar";
import type { IsoDate } from "../domain/dates";
import type { BaselineId, ItemId, ItemKind, LinkKey, LinkType, Schedule } from "../domain/model";
import type { Conflict, Stop } from "../domain/schedule";
import type { LogState } from "../log/state";
import type { Action, DeviceId, SessionId } from "../log/types";
import type { PlanView } from "../store/doc";

export type Intent =
  | { t: "create"; kind: ItemKind; name: string; parent: ItemId | null; after: ItemId | null; start: IsoDate | null; dur?: number }
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
  | { t: "planName"; name: string };

export interface Preview {
  itemsChanged: number;
  endsChanged: number;
  movedLater: number;
  stopped: readonly Stop[];
  conflictsAfter: number;
  kept: readonly string[];
}

export interface Built {
  action: Action;
  newNotes: readonly ItemId[];
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
