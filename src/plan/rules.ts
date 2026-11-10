import { toDay } from "../domain/dates";
import type { Rules, UnitKey, Write } from "../log/types";
import { decodeAs, parseKey } from "./units";

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const rb = b as Record<string, unknown>;
  return ka.length === kb.length && ka.every((k) => k in rb && deepEqual((a as Record<string, unknown>)[k], rb[k]));
};

const sameYear = (u: UnitKey, a: unknown, b: unknown): boolean => {
  const ya = decodeAs("holidayYear", u, a);
  const yb = decodeAs("holidayYear", u, b);
  if (ya === null || yb === null) return ya === yb;
  return deepEqual(ya.region, yb.region) && deepEqual(ya.days, yb.days);
};

const startOf = (u: UnitKey, w: Write): number => {
  const start = decodeAs("sched", u, w.v).start;
  if (start === null) throw new Error(`Derived write to ${u} has no start`);
  return toDay(start);
};

const derivedUnit = (u: UnitKey): void => {
  if (parseKey(u).kind !== "s") throw new Error(`Derived write to ${u}`);
};

export const planRules: Rules = {
  same(u, a, b) {
    return parseKey(u).kind === "ch" ? sameYear(u, a, b) : deepEqual(a, b);
  },
  mergeDerived(u, earlier, later) {
    derivedUnit(u);
    return startOf(u, earlier) > startOf(u, later) ? earlier : later;
  },
  mergeable(u, a, b) {
    derivedUnit(u);
    const x = decodeAs("sched", u, a.v);
    const y = decodeAs("sched", u, b.v);
    return x.dur === y.dur && x.status === y.status && x.progress === y.progress && x.horizon === y.horizon;
  },
};
