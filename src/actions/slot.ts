import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export interface Keyed {
  id: string;
  order: string;
}

export interface Slot {
  order: string;
  rekeyed: readonly Keyed[];
}

export function slotAfter(sibs: readonly Keyed[], after: string | null, missing: () => Error): Slot {
  const a = after === null ? null : sibs.find((s) => s.id === after);
  if (a === undefined) throw missing();
  const at = a === null ? 0 : sibs.indexOf(a) + 1;
  const next = at < sibs.length ? sibs[at] : null;
  if (a === null || next === null || next.order !== a.order) {
    return { order: generateKeyBetween(a?.order ?? null, next?.order ?? null), rekeyed: [] };
  }
  const first = sibs.findIndex((s) => s.order === a.order);
  const run = sibs.filter((s) => s.order === a.order);
  const last = first + run.length;
  const keys = generateNKeysBetween(first > 0 ? sibs[first - 1].order : null, last < sibs.length ? sibs[last].order : null, run.length + 1);
  const slot = at - first;
  return {
    order: keys[slot],
    rekeyed: run.map((s, k) => ({ id: s.id, order: keys[k < slot ? k : k + 1] })),
  };
}
