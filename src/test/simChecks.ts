import type { LogState } from "../log/state";
import { OWNER_CAUSES, type Action, type ActionId, type UnitKey } from "../log/types";
import { choices, heldItems } from "../plan/choices";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { FIXTURE_DEVICES, PLAN_ID } from "./planCtx";

export const viewOf = (log: LogState) => {
  const plan = projectPlan(PLAN_ID, log);
  const cs = choices(log, plan, FIXTURE_DEVICES);
  return { plan, choices: cs, held: heldItems(cs, plan) };
};

export const actionOf = (log: LogState, id: ActionId): Action => {
  const a = log.get(id);
  if (a === undefined) throw new Error(`Action ${id} is not ready`);
  return a;
};

export const lostWrites = (log: LogState): string[] =>
  log
    .order()
    .filter((id) => log.active(id))
    .flatMap((id) =>
      actionOf(log, id)
        .w.filter((x) => OWNER_CAUSES.has(x.c))
        .filter((x) => {
          const st = log.unit(x.u);
          if (st !== undefined && (st.from === id || planRules.same(x.u, st.value, x.v) || (st.clash ?? []).includes(id))) return false;
          return !log.writers(x.u).some((w) => w !== id && log.active(w) && log.seen(id, w));
        })
        .map((x) => `${id} ${x.u} = ${JSON.stringify(x.v)}, now ${JSON.stringify(stateOf(log, x.u))}`),
    );

const stateOf = (log: LogState, u: UnitKey) => log.unit(u) ?? null;
