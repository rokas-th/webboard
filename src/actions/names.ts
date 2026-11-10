import type { PlanState } from "../domain/model";
import type { LogState } from "../log/state";
import type { UnitKey } from "../log/types";
import { decodeAs } from "../plan/units";

export const baselineName = (log: LogState, plans: readonly PlanState[], u: UnitKey, id: string): string => {
  const live = plans.map((p) => p.baselines.get(id)).find((x) => x !== undefined);
  if (live !== undefined) return live.name;
  const written = [...log.writers(u)]
    .reverse()
    .map((a) => {
      const action = log.get(a);
      if (action === undefined) throw new Error(`Action ${a} is not ready`);
      const x = action.w.find((y) => y.u === u);
      if (x === undefined) throw new Error(`Action ${a} holds no write to ${u}`);
      return decodeAs("baseline", u, x.v);
    })
    .find((v) => v !== null);
  if (written === undefined) throw new Error(`No baseline ${id}`);
  return written.name;
};
