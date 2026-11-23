import { useLayoutEffect, useSyncExternalStore } from "react";
import type { PlanId } from "../../domain/model";
import { toast } from "../common/Toast";
import { COLUMNS } from "./columns";
import { CHIP_LIMIT, LIST_PREFS_UNREADABLE, recordText, SORT_LIMIT } from "./text";

export type ColumnId = "name" | "step" | "status" | "assignees" | "start" | "end" | "days" | "progress" | "late" | "deps" | "blocks" | "group" | "kind" | "note";

export type ScopeId = "open" | "soon" | "late" | "blocked" | "unscheduled" | "unassigned" | "milestones" | "done" | "all";

export type ChipField = "step" | "assignee" | "kind" | "group";

export interface Chip {
  f: ChipField;
  v: string | null;
}

export type GroupBy = "outline" | "step" | "assignee" | "none";

export type SortDir = "asc" | "desc";

export interface ColumnPref {
  id: ColumnId;
  w: number;
}

export interface SortKey {
  id: ColumnId;
  dir: SortDir;
}

export interface ListPrefs {
  v: 1;
  cols: readonly ColumnPref[];
  sort: readonly SortKey[];
  scope: ScopeId;
  chips: readonly Chip[];
  group: GroupBy;
}

export const SCOPE_IDS: readonly ScopeId[] = ["open", "soon", "late", "blocked", "unscheduled", "unassigned", "milestones", "done", "all"];

export const MAX_SORT = 3;
export const MAX_CHIPS = 32;
export const MAX_WIDTH = 640;

const SHOWN_RAW = 200;
const ID = /^[A-Za-z0-9_-]+$/;
const RECORD_KEYS: readonly string[] = ["chips", "cols", "group", "scope", "sort", "v"];
const COL_KEYS: readonly string[] = ["id", "w"];
const SORT_KEYS: readonly string[] = ["dir", "id"];
const CHIP_KEYS: readonly string[] = ["f", "v"];
const FIELDS: readonly ChipField[] = ["step", "assignee", "kind", "group"];
const GROUPS: readonly GroupBy[] = ["outline", "step", "assignee", "none"];
const DIRS: readonly SortDir[] = ["asc", "desc"];
const KINDS: readonly string[] = ["task", "milestone"];
const DEFAULT_COLS: readonly ColumnId[] = ["name", "step", "assignees", "start", "end", "status"];

export const DEFAULT_LIST_PREFS: ListPrefs = Object.freeze({
  v: 1,
  cols: Object.freeze(DEFAULT_COLS.map((id) => Object.freeze({ id, w: specOf(id).defaultWidth }))),
  sort: Object.freeze([]),
  scope: "open",
  chips: Object.freeze([]),
  group: "outline",
});

function specOf(id: ColumnId) {
  const spec = COLUMNS.find((c) => c.id === id);
  if (spec === undefined) throw new Error(`List prefs: no column ${id}`);
  return spec;
}

export const listKey = (plan: PlanId): string => `webboard.list.${plan}`;

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);

const field = (v: object, key: string): unknown => Object.getOwnPropertyDescriptor(v, key)?.value;

const hasExactKeys = (v: object, keys: readonly string[]): boolean => {
  const own = Object.keys(v).sort();
  return own.length === keys.length && keys.every((k, i) => own[i] === k);
};

const valueOf = (v: unknown): string => (v === undefined ? "missing" : typeof v === "number" && !Number.isFinite(v) ? String(v) : JSON.stringify(v));

const keysOf = (v: unknown): string => (isObject(v) ? `{${Object.keys(v).join(", ")}}` : Array.isArray(v) ? "[]" : valueOf(v));

const shape = (keys: readonly string[]): string => `{${keys.join(", ")}}`;

const columnIdOf = (v: unknown): ColumnId | null => COLUMNS.find((c) => c.id === v)?.id ?? null;

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => list.find((x) => x === v) ?? null;

const firstFailure = <T>(reads: readonly Read<T>[]): { ok: false; reason: string } | null => {
  const bad = reads.find((r) => !r.ok);
  return bad === undefined || bad.ok ? null : bad;
};

const valuesOf = <T>(reads: readonly Read<T>[]): T[] => reads.flatMap((r) => (r.ok ? [r.value] : []));

function readCol(v: unknown, i: number, before: readonly unknown[]): Read<ColumnPref> {
  const at = `cols[${i}]`;
  if (!isObject(v) || !hasExactKeys(v, COL_KEYS)) return fail(`${at} is ${keysOf(v)}, not {id, w}`);
  const raw = field(v, "id");
  const id = columnIdOf(raw);
  if (id === null) return fail(`${at}.id is ${valueOf(raw)}, not a List column`);
  if (i === 0 && id !== "name") return fail(`${at} is ${id}, not name`);
  if (before.some((b) => isObject(b) && field(b, "id") === id)) return fail(`${at} repeats ${id}`);
  const w = field(v, "w");
  const min = specOf(id).minWidth;
  if (typeof w !== "number" || !Number.isSafeInteger(w) || w < min || w > MAX_WIDTH) return fail(`${at}.w is ${valueOf(w)}, not a whole number from ${min} to ${MAX_WIDTH}`);
  return { ok: true, value: { id, w } };
}

function readCols(v: unknown): Read<readonly ColumnPref[]> {
  if (!Array.isArray(v)) return fail(`cols is ${valueOf(v)}, not a list`);
  if (v.length < 1 || v.length > COLUMNS.length) return fail(`cols holds ${v.length} columns, not 1 to ${COLUMNS.length}`);
  const list: readonly unknown[] = v;
  const reads = list.map((c, i) => readCol(c, i, list.slice(0, i)));
  return firstFailure(reads) ?? { ok: true, value: valuesOf(reads) };
}

function readSortKey(v: unknown, i: number, before: readonly unknown[], cols: readonly ColumnPref[]): Read<SortKey> {
  const at = `sort[${i}]`;
  if (!isObject(v) || !hasExactKeys(v, SORT_KEYS)) return fail(`${at} is ${keysOf(v)}, not {id, dir}`);
  const raw = field(v, "id");
  const id = columnIdOf(raw);
  if (id === null) return fail(`${at}.id is ${valueOf(raw)}, not a List column`);
  if (!cols.some((c) => c.id === id)) return fail(`${at}.id is ${id}, which is not among the columns`);
  if (before.some((b) => isObject(b) && field(b, "id") === id)) return fail(`${at} repeats ${id}`);
  const rawDir = field(v, "dir");
  const dir = oneOf(DIRS, rawDir);
  if (dir === null) return fail(`${at}.dir is ${valueOf(rawDir)}, not asc or desc`);
  return { ok: true, value: { id, dir } };
}

function readSort(v: unknown, cols: readonly ColumnPref[]): Read<readonly SortKey[]> {
  if (!Array.isArray(v)) return fail(`sort is ${valueOf(v)}, not a list`);
  if (v.length > MAX_SORT) return fail(`sort holds ${v.length} keys, not at most ${MAX_SORT}`);
  const list: readonly unknown[] = v;
  const reads = list.map((s, i) => readSortKey(s, i, list.slice(0, i), cols));
  return firstFailure(reads) ?? { ok: true, value: valuesOf(reads) };
}

const chipName = (c: Chip): string => `${c.f} ${c.v === null ? "null" : c.v}`;

function readChip(v: unknown, i: number, before: readonly Chip[]): Read<Chip> {
  const at = `chips[${i}]`;
  if (!isObject(v) || !hasExactKeys(v, CHIP_KEYS)) return fail(`${at} is ${keysOf(v)}, not {f, v}`);
  const rawF = field(v, "f");
  const f = oneOf(FIELDS, rawF);
  if (f === null) return fail(`${at}.f is ${valueOf(rawF)}, not step, assignee, kind or group`);
  const value = field(v, "v");
  if (f === "kind" && (typeof value !== "string" || !KINDS.includes(value))) return fail(`${at}.v is ${valueOf(value)}, not task or milestone`);
  if (!(value === null || (typeof value === "string" && ID.test(value)))) return fail(`${at}.v is ${valueOf(value)}, not null or an id`);
  const chip: Chip = { f, v: value };
  if (before.some((b) => b.f === chip.f && b.v === chip.v)) return fail(`${at} repeats ${chipName(chip)}`);
  return { ok: true, value: chip };
}

function readChips(v: unknown): Read<readonly Chip[]> {
  if (!Array.isArray(v)) return fail(`chips is ${valueOf(v)}, not a list`);
  if (v.length > MAX_CHIPS) return fail(`chips holds ${v.length} chips, not at most ${MAX_CHIPS}`);
  const list: readonly unknown[] = v;
  const step = (acc: Read<readonly Chip[]>, c: unknown, i: number): Read<readonly Chip[]> => {
    if (!acc.ok) return acc;
    const read = readChip(c, i, acc.value);
    return read.ok ? { ok: true, value: [...acc.value, read.value] } : read;
  };
  return list.reduce<Read<readonly Chip[]>>(step, { ok: true, value: [] });
}

export function readListPrefsRecord(raw: string): Read<ListPrefs> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    if (e instanceof SyntaxError) return fail(`it is not JSON (${e.message})`);
    throw e;
  }
  if (!isObject(v) || !hasExactKeys(v, RECORD_KEYS)) return fail(`the record is ${keysOf(v)}, not ${shape(RECORD_KEYS)}`);
  const version = field(v, "v");
  if (version !== 1) return fail(`v is ${valueOf(version)}, not 1`);
  const cols = readCols(field(v, "cols"));
  if (!cols.ok) return cols;
  const sort = readSort(field(v, "sort"), cols.value);
  if (!sort.ok) return sort;
  const rawScope = field(v, "scope");
  const scope = oneOf(SCOPE_IDS, rawScope);
  if (scope === null) return fail(`scope is ${valueOf(rawScope)}, not one of ${SCOPE_IDS.join(", ")}`);
  const chips = readChips(field(v, "chips"));
  if (!chips.ok) return chips;
  const rawGroup = field(v, "group");
  const group = oneOf(GROUPS, rawGroup);
  if (group === null) return fail(`group is ${valueOf(rawGroup)}, not outline, step, assignee or none`);
  return { ok: true, value: { v: 1, cols: cols.value, sort: sort.value, scope, chips: chips.value, group } };
}

const listeners = new Set<() => void>();

const notify = (): void => {
  [...listeners].forEach((cb) => cb());
};

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function readListPrefs(storage: Storage, plan: PlanId): ListPrefs {
  const raw = storage.getItem(listKey(plan));
  if (raw === null) return DEFAULT_LIST_PREFS;
  const read = readListPrefsRecord(raw);
  if (read.ok) return read.value;
  storage.removeItem(listKey(plan));
  toast(LIST_PREFS_UNREADABLE, "bad", recordText(read.reason, raw, SHOWN_RAW));
  notify();
  return DEFAULT_LIST_PREFS;
}

export function writeListPrefs(storage: Storage, plan: PlanId, next: ListPrefs): void {
  if (next.sort.length > MAX_SORT) {
    toast(SORT_LIMIT, "bad");
    return;
  }
  if (next.chips.length > MAX_CHIPS) {
    toast(CHIP_LIMIT, "bad");
    return;
  }
  const record: ListPrefs = { v: 1, cols: next.cols, sort: next.sort, scope: next.scope, chips: next.chips, group: next.group };
  const text = JSON.stringify(record);
  const check = readListPrefsRecord(text);
  if (!check.ok) throw new Error(`List prefs for ${plan} would not read back: ${check.reason}`);
  storage.setItem(listKey(plan), text);
  notify();
}

interface Entry {
  raw: string | null;
  prefs: ListPrefs;
  bad: boolean;
}

const cache = new Map<PlanId, Entry>();

const entryOf = (plan: PlanId): Entry => {
  const raw = window.localStorage.getItem(listKey(plan));
  const cached = cache.get(plan);
  if (cached !== undefined && cached.raw === raw) return cached;
  const read = raw === null ? null : readListPrefsRecord(raw);
  const entry: Entry = read === null ? { raw, prefs: DEFAULT_LIST_PREFS, bad: false } : read.ok ? { raw, prefs: read.value, bad: false } : { raw, prefs: DEFAULT_LIST_PREFS, bad: true };
  cache.set(plan, entry);
  return entry;
};

export function useListPrefs(plan: PlanId | null): ListPrefs {
  const bad = useSyncExternalStore(subscribe, () => plan !== null && entryOf(plan).bad);
  useLayoutEffect(() => {
    if (plan !== null) readListPrefs(window.localStorage, plan);
  }, [plan, bad]);
  return useSyncExternalStore(subscribe, () => (plan === null ? DEFAULT_LIST_PREFS : entryOf(plan).prefs));
}
