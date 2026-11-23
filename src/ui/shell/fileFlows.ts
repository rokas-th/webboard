import type { PersonId, PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import { q } from "../../actions/copy";
import type { Clock } from "../../services/clock";
import { exportBackup, exportIcs, exportListCsv, exportPlan, importPlan } from "../../store/file";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { countedConflicts } from "../choices/HeadCounts";
import { toast } from "../common/Toast";
import { rowContext } from "../list/columns";
import { listCsv } from "../list/csv";
import { mineLine } from "../list/MineNote";
import { readSavedListPrefs } from "../list/prefs";
import { showConverted } from "./ConvertedReport";
import { icsOf } from "./ics";

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

async function exportCsvOnce(session: PlanSession, me: PersonId | null): Promise<void> {
  const view = session.view();
  const ctx = rowContext(view, (id) => session.note(id).toString(), me, null);
  const saved = readSavedListPrefs(window.localStorage, view.plan.id);
  if (!saved.ok) {
    toast(LIST_CSV_UNREADABLE, "bad", saved.detail);
    return;
  }
  const mine = mineLine(saved.value.scope, ctx.me);
  if (mine !== null) {
    toast(mine.text);
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

export function exportListCsvFlow(session: PlanSession, me: PersonId | null): Promise<void> {
  const running = exportingCsv.get(session);
  if (running !== undefined) return running;
  const run = exportCsvOnce(session, me).finally(() => exportingCsv.delete(session));
  exportingCsv.set(session, run);
  return run;
}

export const ICS_EMPTY = "This plan has no dated milestones, so there is nothing to export.";

export const BACKUP_EMPTY = "There are no plans to back up.";

const undatedLine = (n: number): string => (n === 1 ? " 1 milestone without a date was left out." : ` ${n} milestones without dates were left out.`);

const unreadablePlansLine = (n: number): string =>
  n === 1
    ? " 1 plan holds changes this app cannot read yet; Import will refuse it until they are resolved."
    : ` ${n} plans hold changes this app cannot read yet; Import will refuse them until they are resolved.`;

interface OpenFailure {
  reason: unknown;
  name: string | null;
}

interface OpenRefusal {
  reason: AppError;
  name: string | null;
}

const isRefusal = (f: OpenFailure): f is OpenRefusal => f.reason instanceof AppError;

const planName = (name: string | null): string => (name === null ? "A plan" : q(name));

const andList = (names: readonly string[]): string => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

function openFailedText(refused: readonly OpenRefusal[]): [string, string | null] {
  if (refused.length === 1) return [`${planName(refused[0].name)} could not be opened, so nothing was backed up. ${refused[0].reason.message}`, null];
  const names = refused.map((r, i) => (r.name !== null ? q(r.name) : i === 0 ? "A plan" : "a plan"));
  return [`${andList(names)} could not be opened, so nothing was backed up.`, refused.map((r) => `${planName(r.name)}: ${r.reason.message}`).join("\n")];
}

const exportingIcs = new Map<PlanSession, Promise<void>>();
let backingUp: Promise<void> | null = null;

async function exportIcsOnce(session: PlanSession, clock: Clock): Promise<void> {
  const view = session.view();
  const ctx = rowContext(view, (id) => session.note(id).toString(), null, null);
  const { text, events, undated } = icsOf(ctx, clock.now());
  if (events === 0) {
    toast(ICS_EMPTY);
    return;
  }
  const written = await shown(exportIcs(view.plan.name, text));
  if (!written.ok || written.value === null) return;
  toast(`Exported ${count(events, "milestone", "milestones")} to ${written.value}${undated === 0 ? "" : undatedLine(undated)}`);
}

async function backupOnce(registry: Registry, clock: Clock): Promise<void> {
  const listed = registry.plans().filter((l) => !l.trashed);
  if (listed.length === 0) {
    toast(BACKUP_EMPTY);
    return;
  }
  const opened = await Promise.allSettled(listed.map((l) => registry.session(l.id)));
  const failures = opened.flatMap((o, i): OpenFailure[] => (o.status === "rejected" ? [{ reason: o.reason, name: listed[i].name }] : []));
  const bug = failures.find((f) => !isRefusal(f));
  if (bug !== undefined) throw bug.reason;
  const refused = failures.filter(isRefusal);
  if (refused.length > 0) {
    const [text, details] = openFailedText(refused);
    if (details === null) toast(text, "bad");
    else toast(text, "bad", details);
    return;
  }
  const sessions = opened.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
  const written = await shown(exportBackup(sessions, clock.today(), new Date(clock.now())));
  if (!written.ok || written.value === null) return;
  const { name, plans, unreadable } = written.value;
  toast(`Backed up ${count(plans, "plan", "plans")} to ${name}${unreadable === 0 ? "" : unreadablePlansLine(unreadable)}`);
}

export function exportIcsFlow(session: PlanSession, clock: Clock): Promise<void> {
  const running = exportingIcs.get(session);
  if (running !== undefined) return running;
  const run = exportIcsOnce(session, clock).finally(() => exportingIcs.delete(session));
  exportingIcs.set(session, run);
  return run;
}

export function backupFlow(registry: Registry, clock: Clock): Promise<void> {
  if (backingUp !== null) return backingUp;
  const run = backupOnce(registry, clock).finally(() => {
    backingUp = null;
  });
  backingUp = run;
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
