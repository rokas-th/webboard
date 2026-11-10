import * as Y from "yjs";
import type { Baseline, BaselineId, Item, ItemId, Link, LinkKey, PlanId, PlanState } from "../domain/model";
import { linkKey } from "../domain/model";
import type { Closure } from "../domain/calendar";
import { newId } from "../log/ids";
import { LogState } from "../log/state";
import type { Action, DeviceId, SessionId, Write } from "../log/types";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { existence, key, parseKey, stateWrites, validateWrite } from "../plan/units";
import { AppError, callBytes, callName } from "../services/ipc";
import { decodeAction } from "./doc";
import { newPlanId } from "./plan-id";
import type { GanttReport } from "../import/gantt";
import type { Registry } from "./registry";
import type { PlanSession } from "./session";

export interface WbxHeader {
  planId: PlanId;
  name: string;
  exportedAt: string;
  updateLength: number;
}

export interface ImportResult {
  planId: PlanId;
  action: Action;
  newNotes: readonly ItemId[];
  notes: ReadonlyMap<ItemId, string>;
  idMap: ReadonlyMap<string, string>;
}

const MAGIC: readonly number[] = [0x57, 0x42, 0x58, 0x31];
const FIXED = 12;
const VERSION = 1;
const GANTT_EXTENSION = ".gantt";
const NAME_LENGTH = 4;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const foreign = (): AppError => new AppError("import.foreign", "This file is not a WebBoard plan.");
const truncated = (n: number, m: number): AppError =>
  new AppError("import.truncated", `This file is incomplete (${n} of ${m} bytes); export it again.`);
const newer = (v: number): AppError =>
  new AppError("import.newer", `This file comes from a newer WebBoard (format ${v}); update WebBoard to open it.`);
const corrupt = (reason: string): AppError => new AppError("import.corrupt", `This file is damaged: ${reason}`);
const unknownUnits = (keys: readonly string[], damage: string | undefined): AppError =>
  new AppError(
    "import.unknown_units",
    `This plan uses data this WebBoard does not know (${keys.join(", ")}); update WebBoard to open it.` +
      (damage === undefined ? "" : ` It is also damaged: ${damage}`),
  );

export function encodeWbx(h: WbxHeader, update: Uint8Array): Uint8Array {
  if (h.updateLength !== update.length) throw new Error(`updateLength ${h.updateLength} does not match the update's ${update.length} bytes`);
  const header = new TextEncoder().encode(JSON.stringify({ planId: h.planId, name: h.name, exportedAt: h.exportedAt, updateLength: h.updateLength }));
  const out = new Uint8Array(FIXED + header.length + update.length);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, header.length, true);
  out.set(header, FIXED);
  out.set(update, FIXED + header.length);
  return out;
}

const startsWithMagic = (bytes: Uint8Array, length: number): boolean => MAGIC.slice(0, length).every((b, i) => bytes[i] === b);

function readHeaderJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    throw corrupt(`its header is not readable: ${messageOf(e)}`);
  }
}

function parseHeader(raw: unknown): WbxHeader {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw corrupt("its header is not an object");
  const text = (field: "planId" | "name" | "exportedAt"): string => {
    const v: unknown = field in raw ? Reflect.get(raw, field) : undefined;
    if (typeof v !== "string") throw corrupt(`its header has no ${field}`);
    return v;
  };
  const length: unknown = "updateLength" in raw ? raw.updateLength : undefined;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) throw corrupt("its header has no valid updateLength");
  return { planId: text("planId"), name: text("name"), exportedAt: text("exportedAt"), updateLength: length };
}

export function decodeWbx(bytes: Uint8Array): { header: WbxHeader; update: Uint8Array } {
  const n = bytes.length;
  if (n < FIXED) {
    if (startsWithMagic(bytes, Math.min(n, MAGIC.length))) throw truncated(n, FIXED);
    throw foreign();
  }
  if (!startsWithMagic(bytes, MAGIC.length)) throw foreign();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version > VERSION) throw newer(version);
  if (version !== VERSION) throw corrupt(`its format version is ${version}`);
  const headerEnd = FIXED + view.getUint32(8, true);
  if (n < headerEnd) throw truncated(n, headerEnd);
  const header = parseHeader(readHeaderJson(bytes.subarray(FIXED, headerEnd)));
  const end = headerEnd + header.updateLength;
  if (n < end) throw truncated(n, end);
  if (n > end) throw corrupt(`${n - end} bytes follow the plan`);
  return { header, update: bytes.slice(headerEnd, end) };
}

const knownPrefix = (u: string): boolean => {
  const colon = u.indexOf(":");
  return Object.prototype.hasOwnProperty.call(key, colon < 0 ? u : u.slice(0, colon));
};

function readLog(doc: Y.Doc): Action[] {
  const unknown = new Set<string>();
  const damage: string[] = [];
  const actions = [...doc.getMap("actions").entries()].flatMap(([id, raw]): Action[] => {
    let a: Action;
    try {
      a = decodeAction(id, raw);
    } catch (e) {
      damage.push(messageOf(e));
      return [];
    }
    a.w.forEach((w) => checkWrite(w, unknown, damage));
    return [a];
  });
  if (unknown.size > 0) throw unknownUnits([...unknown].sort().slice(0, 3), damage[0]);
  if (damage.length > 0) throw corrupt(damage[0]);
  return actions;
}

function checkWrite(w: Write, unknown: Set<string>, damage: string[]): void {
  try {
    parseKey(w.u);
  } catch (e) {
    if (knownPrefix(w.u)) damage.push(messageOf(e));
    else unknown.add(w.u);
    return;
  }
  try {
    validateWrite(w);
  } catch (e) {
    damage.push(messageOf(e));
  }
}

function ownTrashOf(log: LogState, item: ItemId): boolean {
  const u = key.e(item);
  const state = log.unit(u);
  if (state !== undefined) return existence.dec(state.value).t;
  if (log.writers(u).length === 0) throw new Error(`Item ${item} has no existence unit`);
  return true;
}

function readPlan(
  id: PlanId,
  update: Uint8Array,
): { plan: PlanState; notes: ReadonlyMap<ItemId, string>; ownTrashed: ReadonlyMap<ItemId, boolean> } {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
  } catch (e) {
    throw corrupt(`its plan data cannot be read: ${messageOf(e)}`);
  }
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) throw corrupt("its plan data refers to parts that are missing");
  const log = new LogState(planRules);
  const delta = log.add(readLog(doc));
  if (delta.refused.length > 0) throw corrupt(delta.refused[0].message);
  if (log.pending.length > 0) throw corrupt(`${log.pending.length} actions refer to missing parents`);
  let plan: PlanState;
  try {
    plan = projectPlan(id, log);
  } catch (e) {
    throw corrupt(messageOf(e));
  }
  const notes = new Map(
    [...doc.getMap("notes").entries()].map(([item, text]): [ItemId, string] => {
      if (!(text instanceof Y.Text)) throw corrupt(`the note of ${item} is not text`);
      if (!plan.items.has(item)) throw corrupt(`a note belongs to no item (${item})`);
      return [item, text.toString()];
    }),
  );
  const ownTrashed = new Map([...plan.items.keys()].map((item): [ItemId, boolean] => [item, ownTrashOf(log, item)]));
  return { plan, notes, ownTrashed };
}

function remap(plan: PlanState, planId: PlanId): { plan: PlanState; idMap: ReadonlyMap<string, string> } {
  const idMap = new Map<string, string>();
  const fresh = (old: string): string => {
    const known = idMap.get(old);
    if (known !== undefined) return known;
    const made = newId();
    idMap.set(old, made);
    return made;
  };
  const items = new Map(
    [...plan.items.values()].map((i): [ItemId, Item] => {
      const id = fresh(i.id);
      return [id, { ...i, id, place: { parent: i.place.parent === null ? null : fresh(i.place.parent), order: i.place.order } }];
    }),
  );
  const links = new Map(
    [...plan.links.values()].map((l): [LinkKey, Link] => {
      const from = fresh(l.from);
      const to = fresh(l.to);
      return [linkKey(from, to), { ...l, from, to }];
    }),
  );
  const closures = new Map(
    [...plan.calendar.closures.values()].map((c): [string, Closure] => {
      const id = fresh(c.id);
      return [id, { ...c, id }];
    }),
  );
  const baselines = new Map(
    [...plan.baselines.values()].map((b): [BaselineId, Baseline] => {
      const id = fresh(b.id);
      return [id, { ...b, id, dates: Object.fromEntries(Object.entries(b.dates).map(([item, d]) => [fresh(item), { ...d }])) }];
    }),
  );
  return { plan: { id: planId, name: plan.name, items, links, calendar: { ...plan.calendar, closures }, baselines }, idMap };
}

export function buildImport(bytes: Uint8Array, fileName: string, dev: DeviceId, ses: SessionId, now: number): ImportResult {
  const { header, update } = decodeWbx(bytes);
  const source = readPlan(header.planId, update);
  const planId = newPlanId();
  const { plan, idMap } = remap(source.plan, planId);
  const notes = new Map([...source.notes].map(([item, text]): [ItemId, string] => [idMap.get(item) ?? missingId(item, "a note"), text]));
  const ownTrashed = new Map([...source.ownTrashed].map(([item, t]): [ItemId, boolean] => [idMap.get(item) ?? missingId(item, "an existence unit"), t]));
  const ownOf = (item: ItemId): boolean => {
    const t = ownTrashed.get(item);
    if (t === undefined) throw new Error(`Item ${item} has no existence unit`);
    return t;
  };
  const action: Action = {
    id: newId(),
    dev,
    ses,
    at: now,
    par: [],
    lbl: `Imported from ${fileName}`,
    w: stateWrites(plan, "own", ownOf),
    meta: { imported: fileName },
  };
  return { planId, action, newNotes: [...notes.keys()], notes, idMap };
}

function missingId(item: ItemId, what: string): never {
  throw new Error(`Item ${item} has ${what} but no new id`);
}

type Exported = { name: string; unreadable: number } | null;

function snapshot(session: PlanSession): { body: Uint8Array; unreadable: number } {
  const view = session.view();
  const { id, name } = view.plan;
  const u = session.encodeState();
  return {
    body: encodeWbx({ planId: id, name, exportedAt: new Date(Date.now()).toISOString(), updateLength: u.length }, u),
    unreadable: view.unreadable.length + view.pending,
  };
}

export async function exportPlan(session: PlanSession): Promise<Exported> {
  const name = session.view().plan.name;
  if (/\p{Cs}/u.test(name)) throw new AppError("file.io", "The plan name holds a character that cannot be written to a file name; rename the plan and export again.");
  const { body, unreadable } = snapshot(session);
  const written = await callName("plan_export", body, { headers: { "x-name": encodeURIComponent(name) } });
  return written === null ? null : { name: written, unreadable };
}

export function unframe(b: Uint8Array): { name: string; bytes: Uint8Array } {
  const short = (): AppError => new AppError("ipc.shape", `plan_import answered ${b.length} bytes, which do not hold a file name and its file`);
  if (b.length < NAME_LENGTH) throw short();
  const end = NAME_LENGTH + new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
  if (end > b.length) throw short();
  if (end === NAME_LENGTH) throw new AppError("ipc.shape", "plan_import sent an empty file name");
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(NAME_LENGTH, end));
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    throw new AppError("ipc.shape", "plan_import sent a file name that is not UTF-8", e);
  }
  return { name, bytes: b.slice(end) };
}

export interface Imported {
  planId: PlanId;
  converted: GanttReport | null;
}

async function fromGantt(bytes: Uint8Array, fileName: string, dev: DeviceId): Promise<{ result: ImportResult; report: GanttReport }> {
  const gantt = await import("../import/gantt");
  try {
    return gantt.importGantt({ bytes, fileName, dev, ses: newId(), now: Date.now() });
  } catch (e) {
    if (e instanceof gantt.GanttError) throw new AppError("import.gantt", e.message);
    throw e;
  }
}

export async function importPlan(registry: Registry, review: (report: GanttReport) => Promise<void>): Promise<Imported | null> {
  const answer = await callBytes("plan_import");
  if (answer.length === 0) return null;
  const { name: fileName, bytes } = unframe(answer);
  if (fileName.toLowerCase().endsWith(GANTT_EXTENSION)) {
    const { result, report } = await fromGantt(bytes, fileName, registry.device.deviceId);
    await review(report);
    return { planId: await registry.createPlanFrom(result), converted: report };
  }
  const r = buildImport(bytes, fileName, registry.device.deviceId, newId(), Date.now());
  return { planId: await registry.createPlanFrom(r), converted: null };
}
