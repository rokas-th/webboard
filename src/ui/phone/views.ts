import type { UiState, ViewKind } from "../state";

export const PHONE_VIEWS: readonly (readonly [ViewKind, string])[] = [
  ["timeline", "Timeline"],
  ["board", "Board"],
  ["list", "List"],
];

export function phoneViewPatch(from: ViewKind, to: ViewKind): Partial<UiState> | null {
  if (from === to) return null;
  return to === "timeline" ? { view: to, query: "" } : { view: to };
}
