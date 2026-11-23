import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import { exportListCsv, exportPlan, importPlan } from "../../store/file";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { countedConflicts } from "../choices/HeadCounts";
import { toast } from "../common/Toast";
import { rowContext } from "../list/columns";
import { listCsv } from "../list/csv";
import { readSavedListPrefs } from "../list/prefs";
import { showConverted } from "./ConvertedReport";

type Outcome<T> = { ok: true; value: T } | { ok: false };

async function shown<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work };
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    if (e.message.includes("\n")) toast(e.message, "bad", e.message);
    else toast(e.message, "bad");
    return { ok: false };
  }
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const LIST_CSV_EMPTY = "The List shows no items, so there is nothing to export.";

export const LIST_CSV_UNREADABLE = "Saved List settings for this plan could not be read, so nothing was exported. Open the List to reset them.";

const exporting = new Map<PlanSession, Promise<void>>();
const exportingCsv = new Map<PlanSession, Promise<void>>();
let importing: Promise<void> | null = null;

async function exportOnce(session: PlanSession): Promise<void> {
  const written = await shown(exportPlan(session));
  if (!written.ok || written.value === null) return;
  const { name, unreadable } = written.value;
  toast(
    unreadable === 0
      ? `Exported to ${name}`
      : `Exported. This file holds ${count(unreadable, "action", "actions")} this app cannot read yet, so Import will refuse it until they are resolved.`,
  );
}

async function exportCsvOnce(session: PlanSession): Promise<void> {
  const view = session.view();
  const ctx = rowContext(view, (id) => session.note(id).toString());
  const saved = readSavedListPrefs(window.localStorage, view.plan.id);
  if (!saved.ok) {
    toast(LIST_CSV_UNREADABLE, "bad", saved.detail);
    return;
  }
  const { text, rows } = listCsv(ctx, saved.value);
  if (rows === 0) {
    toast(LIST_CSV_EMPTY);
    return;
  }
  const written = await shown(exportListCsv(view.plan.name, text));
  if (!written.ok || written.value === null) return;
  toast(`Exported ${count(rows, "row", "rows")} to ${written.value}`);
}

async function importOnce(registry: Registry, open: (id: PlanId) => void): Promise<void> {
  const imported = await shown(importPlan(registry, showConverted));
  if (!imported.ok || imported.value === null) return;
  const id = imported.value.planId;
  open(id);
  const session = await shown(registry.session(id));
  if (!session.ok) return;
  const view = session.value.view();
  const conflicts = countedConflicts(view).length;
  const name = `Imported “${view.plan.name}”`;
  toast(conflicts === 0 ? name : `${name} — ${count(conflicts, "conflict", "conflicts")} to fix`);
}

export function exportFlow(session: PlanSession): Promise<void> {
  const running = exporting.get(session);
  if (running !== undefined) return running;
  const run = exportOnce(session).finally(() => exporting.delete(session));
  exporting.set(session, run);
  return run;
}

export function exportListCsvFlow(session: PlanSession): Promise<void> {
  const running = exportingCsv.get(session);
  if (running !== undefined) return running;
  const run = exportCsvOnce(session).finally(() => exportingCsv.delete(session));
  exportingCsv.set(session, run);
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
