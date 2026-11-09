import { q } from "../../actions/copy";
import type { OutcomeRow, Pick, ResolveOptions } from "../../actions/resolve";
import type { Lock } from "../../domain/schedule";
import type { Choice } from "../../plan/choices";
import type { PlanSession } from "../../store/session";
import { impactText } from "../calendar/impact";
import { describeUnit, unitSubject } from "./describe";
import { sideSummary } from "./outcome";

export interface SideContent {
  summary: string;
  values: string[];
  stopped: string[];
  kept: string[];
  impact: string | null;
  rows: readonly OutcomeRow[];
}

const REASON: Readonly<Record<Lock, string>> = { held: "held", done: "done", doing: "in progress" };

export function sideContent(session: PlanSession, choice: Choice, pick: Pick, opts: ResolveOptions): SideContent {
  const rp = session.previewResolve(choice.id, pick, opts);
  const plan = session.view().plan;
  const side = choice.sides.find((s) => s.key === pick.side);
  if (side === undefined) throw new Error(`Choice ${choice.id} has no side ${pick.side}`);
  const labels = new Map(session.history().map((e) => [e.id, e.label]));
  const values = choice.units.filter((u) => side.values.has(u)).map((u) => `${unitSubject(u, plan)}: ${describeUnit(u, side.values.get(u), plan, labels)}`);
  const stopped = rp.preview.stopped.map((s) => {
    const it = plan.items.get(s.id);
    if (it === undefined) throw new Error(`No item ${s.id}`);
    return `stopped at ${REASON[s.reason]} ${q(it.name)}`;
  });
  return {
    summary: sideSummary(rp),
    values,
    stopped,
    kept: [...rp.preview.kept],
    impact: choice.kind === "calendar" ? impactText(rp.preview) : null,
    rows: rp.rows,
  };
}
