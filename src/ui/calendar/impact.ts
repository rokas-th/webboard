const CLOSE = "Done items keep their dates, and nothing moves earlier on its own.";

export function impactText(p: { endsChanged: number; movedLater: number }): string {
  if (p.endsChanged === 0 && p.movedLater === 0) return "Applying changes no dates in this plan.";
  const ends = `Applying changes the end date of ${p.endsChanged} ${p.endsChanged === 1 ? "item" : "items"}`;
  const moves = p.movedLater === 0 ? "" : `; ${p.movedLater} ${p.movedLater === 1 ? "moves" : "move"} later to keep ${p.movedLater === 1 ? "its" : "their"} dependencies`;
  return `${ends}${moves}. ${CLOSE}`;
}
