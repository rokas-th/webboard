import type { Choice, ChoiceSide } from "../../plan/choices";

export function orderedSides(choice: Choice, local: string): ChoiceSide[] {
  const rank = (s: ChoiceSide): number => (s.label === local ? 0 : 1);
  return [...choice.sides].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, "en"));
}
