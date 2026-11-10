import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import { exportPlan, fileNameOf, importPlan } from "../../store/file";
import type { DeviceInfo, Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { countedConflicts } from "../choices/HeadCounts";
import { toast } from "../common/Toast";
import { showConverted } from "./ConvertedReport";

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

const exporting = new Map<PlanSession, Promise<void>>();
let importing: Promise<void> | null = null;

async function exportOnce(session: PlanSession, platform: DeviceInfo["platform"]): Promise<void> {
  const written = await shown(exportPlan(session, platform));
  if (!written.ok || written.value === null) return;
  const { path, unreadable } = written.value;
  toast(
    unreadable === 0
      ? `Exported to ${fileNameOf(path)}`
      : `Exported. This file holds ${count(unreadable, "action", "actions")} this app cannot read yet, so Import will refuse it until they are resolved.`,
  );
}

async function importOnce(registry: Registry, open: (id: PlanId) => void): Promise<void> {
  const imported = await shown(importPlan(registry));
  if (!imported.ok || imported.value === null) return;
  const { planId: id, converted } = imported.value;
  if (converted !== null) await showConverted(converted);
  open(id);
  const session = await shown(registry.session(id));
  if (!session.ok) return;
  const view = session.value.view();
  const conflicts = countedConflicts(view).length;
  const name = `Imported “${view.plan.name}”`;
  toast(conflicts === 0 ? name : `${name} — ${count(conflicts, "conflict", "conflicts")} to fix`);
}

export function exportFlow(session: PlanSession, platform: DeviceInfo["platform"]): Promise<void> {
  const running = exporting.get(session);
  if (running !== undefined) return running;
  const run = exportOnce(session, platform).finally(() => exporting.delete(session));
  exporting.set(session, run);
  return run;
}

export function importFlow(registry: Registry, open: (id: PlanId) => void): Promise<void> {
  if (importing !== null) return importing;
  const run = importOnce(registry, open).finally(() => {
    importing = null;
  });
  importing = run;
  return run;
}
