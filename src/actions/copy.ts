import { CLOSURE_TOO_LONG } from "../domain/calendar";
import type { Horizon, ItemKind, LinkType, Status } from "../domain/model";
import type { Lock } from "../domain/schedule";
import type { DeviceId } from "../log/types";

export { fmtShort } from "../domain/dates";

export interface NamedStop {
  reason: Lock;
  name: string;
}

const MINUS = "−";

const count = (n: number, one: string, many: string): string =>
  `${n < 0 ? MINUS : ""}${Math.abs(n)} ${Math.abs(n) === 1 ? one : many}`;

export const q = (name: string): string => `“${name}”`;

export const items = (n: number): string => count(n, "item", "items");

export const workingDays = (n: number): string => count(n, "working day", "working days");

export const deviceName = (devices: ReadonlyMap<DeviceId, string>, id: DeviceId): string =>
  devices.get(id) ?? "Device " + id.slice(0, 4);

const STOP_REASON: Readonly<Record<Lock, string>> = { held: "held", done: "done", doing: "in progress" };

export function stopText(stops: readonly NamedStop[]): string {
  if (stops.length === 0) throw new Error("stopText needs at least one stop");
  const first = `stopped at ${STOP_REASON[stops[0].reason]} ${q(stops[0].name)}`;
  return stops.length === 1 ? first : `${first}, and ${stops.length - 1} more`;
}

export function pushSuffix(moved: number, stops: readonly NamedStop[]): string {
  if (stops.length > 0) return `; ${moved} moved, ${stopText(stops)}`;
  return moved === 0 ? "" : `; ${count(moved, "dependent item", "dependent items")} moved`;
}

export function calendarSuffix(endsChanged: number, movedLater: number): string {
  const parts = [
    ...(endsChanged === 0 ? [] : [count(endsChanged, "end date", "end dates") + " changed"]),
    ...(movedLater === 0 ? [] : [items(movedLater) + " moved later"]),
  ];
  return parts.length === 0 ? "" : "; " + parts.join(", ");
}

export const toastOf = (label: string, sentences: readonly string[]): string =>
  label + "." + sentences.map((s) => " " + s).join("");

const STATUS: Readonly<Record<Status, string>> = { done: "done", doing: "in progress", todo: "to do" };

const HORIZON: Readonly<Record<Horizon, string>> = { now: "Now", next: "Next", later: "Later" };

export const linkText = (from: string, to: string): string => `${q(from)} → ${q(to)}`;

export const label = {
  moved: (what: string, days: number): string =>
    `Moved ${what} ${days < 0 ? "earlier" : "later"} by ${workingDays(Math.abs(days))}`,
  resized: (name: string, dur: number): string => `Resized ${q(name)} to ${workingDays(dur)}`,
  added: (kind: ItemKind, name: string): string => `Added ${kind} ${q(name)}`,
  renamed: (from: string, to: string): string => `Renamed ${q(from)} to ${q(to)}`,
  scheduled: (name: string, shown: string): string => `Scheduled ${q(name)} from ${shown}`,
  unscheduled: (name: string): string => `Unscheduled ${q(name)}`,
  marked: (name: string, status: Status): string => `Marked ${q(name)} ${STATUS[status]}`,
  progress: (name: string, progress: number): string => `Set ${q(name)} to ${progress} %`,
  horizon: (name: string, horizon: Horizon): string => `Moved ${q(name)} to ${HORIZON[horizon]}`,
  changed: (name: string): string => `Changed ${q(name)}`,
  into: (name: string, group: string): string => `Moved ${q(name)} into ${q(group)}`,
  top: (name: string): string => `Moved ${q(name)} to the top level`,
  reordered: (name: string): string => `Reordered ${q(name)}`,
  trashed: (what: string): string => `Moved ${what} to the Trash`,
  restored: (what: string): string => `Restored ${what} from the Trash`,
  linked: (from: string, to: string, type: LinkType): string => `Linked ${linkText(from, to)} (${type})`,
  linkChanged: (from: string, to: string): string => `Changed the link ${linkText(from, to)}`,
  unlinked: (from: string, to: string): string => `Removed the link ${linkText(from, to)}`,
  calendar: (endsChanged: number, movedLater: number): string => `Changed the calendar${calendarSuffix(endsChanged, movedLater)}`,
  snapped: (name: string, shown: string): string => `Moved ${q(name)} to its first working day, ${shown}`,
  earliest: (name: string, shown: string): string => `Moved ${q(name)} to its earliest allowed date, ${shown}`,
  shortened: (from: string, to: string, lag: number): string => `Shortened the lag of ${linkText(from, to)} to ${workingDays(lag)}`,
  baselineSaved: (name: string): string => `Saved baseline ${q(name)}`,
  baselineRenamed: (from: string, to: string): string => `Renamed baseline ${q(from)} to ${q(to)}`,
  baselineRemoved: (name: string): string => `Removed baseline ${q(name)}`,
  planRenamed: (name: string): string => `Renamed the plan to ${q(name)}`,
  created: (name: string): string => `Created the plan ${q(name)}`,
};

export const sentence = {
  trashUndo: "Undo brings it back.",
  trashUndoMany: "Undo brings them back.",
  calendarUndo: "Undo puts the old one back.",
};

export const refusal = {
  emptyName: "The name is empty. Type at least one character.",
  nothing: "Nothing to change.",
  loop: (names: readonly string[]): string => `This link would close a loop: ${[...names, names[0]].map(q).join(" → ")}.`,
  self: "An item cannot depend on itself.",
  groupLink: "Groups take no dependencies; link the tasks inside them.",
  noWorkdays: "A calendar needs at least one working day.",
  closure: "A closure needs a name and a first day.",
  closureOrder: "The last day is before the first day.",
  closureLength: CLOSURE_TOO_LONG,
  taskDur: "A task lasts at least 1 working day.",
  milestoneDur: "Milestones have no duration.",
  progress: "Progress is a whole number from 0 to 100.",
  noDates: (name: string): string => `${q(name)} has no dates yet. Schedule it first.`,
  trashed: (name: string): string => `${q(name)} is in the Trash. Restore it first.`,
  inside: (name: string, group: string): string => `${q(name)} is inside ${q(group)}, which is in the Trash. Restore ${q(group)} first.`,
  selfParent: "A group cannot go inside itself.",
  milestoneStatus: (name: string): string => `${q(name)} is done when its predecessors are done.`,
  lockedFix: (name: string, lock: "done" | "doing"): string =>
    `${q(name)} is ${STATUS[lock]}; done and in-progress items keep their dates. Shorten the lag or remove the link.`,
  heldFix: (name: string): string => `${q(name)} is held in an open choice. Choose a version first.`,
  loopFix: "A loop is fixed by removing one of its links.",
  fixed: "This conflict is already fixed.",
  doneProgress: "A done item is at 100 %.",
  doneSetProgress: (name: string): string => `${q(name)} is done. Mark it in progress to set its progress.`,
};
