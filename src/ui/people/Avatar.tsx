import type { Assignee } from "../../domain/people";
import { UNKNOWN_INITIALS } from "./text";

export function Avatar(p: { assignee: Assignee }) {
  const a = p.assignee;
  if (a.kind === "former") {
    return (
      <span className="avatar former" aria-hidden="true">
        {a.initials ?? UNKNOWN_INITIALS}
      </span>
    );
  }
  return (
    <span className="avatar" aria-hidden="true" style={{ "--person": `var(--s-${a.person.colour})` }}>
      {a.person.initials}
    </span>
  );
}
