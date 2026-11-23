import { workCalendar } from "../domain/calendar";
import { toDay, toIso, type IsoDate } from "../domain/dates";
import type { ItemId, ItemKind, StepId } from "../domain/model";
import type { PlanView } from "../store/doc";
import type { Intent } from "./intents";

export type NewItemAt = { parent: ItemId | null; after: ItemId | null } | { column: StepId };

type CreateIntent = Extract<Intent, { t: "create" }>;

export function newItemIntent(view: PlanView, today: IsoDate, kind: ItemKind, name: string, at: NewItemAt): CreateIntent {
  const d = view.defaults;
  const who = kind === "group" || d.who === null ? {} : { who: d.who };
  if ("column" in at) {
    if (kind !== "task") throw new Error(`Board + adds tasks only, not a ${kind}`);
    return { t: "create", kind, name, parent: d.group, after: null, start: null, step: at.column, ...who };
  }
  const place = { parent: at.parent, after: at.after };
  if (kind === "group") return { t: "create", kind, name, ...place, start: null };
  const start = d.dated ? toIso(workCalendar(view.plan.calendar).after(toDay(today))) : null;
  return kind === "task" ? { t: "create", kind, name, ...place, start, dur: d.dur, ...who } : { t: "create", kind, name, ...place, start, ...who };
}
