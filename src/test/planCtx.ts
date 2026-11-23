import type { Ctx } from "../actions/intents";
import type { IsoDate } from "../domain/dates";
import { projectDefaults } from "../domain/defaults";
import { derive } from "../domain/derive";
import { projectPeople } from "../domain/people";
import type { LogState } from "../log/state";
import type { DeviceId, SessionId } from "../log/types";
import { choices, heldItems } from "../plan/choices";
import { defaultNames, formerPeople } from "../plan/former";
import { projectPlan } from "../plan/project";

export const FIXTURE_DEVICES: ReadonlyMap<DeviceId, string> = new Map([
  ["d1", "Mac"],
  ["d2", "iPhone"],
  ["d3", "iPad"],
]);

export const PLAN_ID = "P";

export function ctxOf(
  log: LogState,
  dev: DeviceId,
  today: IsoDate,
  devices: ReadonlyMap<DeviceId, string> = FIXTURE_DEVICES,
  o: { ses?: SessionId; now?: number; cachedHolidays?: Ctx["cachedHolidays"] } = {},
): Ctx {
  const plan = projectPlan(PLAN_ID, log);
  const cs = choices(log, plan, devices);
  const held = heldItems(cs, plan);
  return {
    view: { plan, derived: derive(plan, held, today), people: projectPeople(plan, formerPeople(log, plan)), defaults: projectDefaults(plan, defaultNames(log, plan)), choices: cs, held, pending: log.pending.length, today, unreadable: [], newer: false },
    log,
    dev,
    ses: o.ses ?? "s-" + dev,
    now: o.now ?? 0,
    devices,
    cachedHolidays: o.cachedHolidays ?? (() => null),
  };
}
