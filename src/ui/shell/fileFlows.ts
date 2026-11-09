import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import { exportPlan, fileNameOf, importPlan } from "../../store/file";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { countedConflicts } from "../choices/HeadCounts";
import { toast } from "../common/Toast";

type Outcome<T> = { ok: true; value: T } | { ok: false };

async function shown<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work };
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    toast(e.message, "bad");
    return { ok: false };
  }
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function exportFlow(session: PlanSession): Promise<void> {
  const written = await shown(exportPlan(session));
  if (!written.ok || written.value === null) return;
  const view = session.view();
  const unreadable = view.unreadable.length + view.pending;
  toast(
    unreadable === 0
      ? `Exported to ${fileNameOf(written.value)}`
      : `Exported. This file holds ${count(unreadable, "action", "actions")} this app cannot read yet, so Import will refuse it until they are resolved.`,
  );
}

export async function importFlow(registry: Registry, open: (id: PlanId) => void): Promise<void> {
  const imported = await shown(importPlan(registry));
  if (!imported.ok || imported.value === null) return;
  const id = imported.value;
  open(id);
  const session = await shown(registry.session(id));
  if (!session.ok) return;
  const view = session.value.view();
  const conflicts = countedConflicts(view).length;
  const name = `Imported “${view.plan.name}”`;
  toast(conflicts === 0 ? name : `${name} — ${count(conflicts, "conflict", "conflicts")} to fix`);
}
