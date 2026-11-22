import { normalizeName } from "../../actions/build";
import { Refused } from "../../actions/intents";
import { toast } from "../common/Toast";
import type { Run } from "../run";

export function commitPlanName(run: Run, current: string, next: string): boolean {
  let name: string;
  try {
    name = normalizeName(next);
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    toast(e.message, "bad");
    return false;
  }
  if (name === current) return false;
  return run.run({ t: "planName", name }) !== null;
}
