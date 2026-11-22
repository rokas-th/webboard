import { useLayoutEffect, useSyncExternalStore } from "react";
import type { PlanId, StepId } from "../../domain/model";
import { toast } from "../common/Toast";
import { HIDE_LIMIT, PREFS_UNREADABLE } from "./text";

export interface BoardPrefs {
  v: 1;
  hidden: readonly StepId[];
  doneOpen: boolean;
}

export const EMPTY_BOARD_PREFS: BoardPrefs = Object.freeze({ v: 1, hidden: Object.freeze([]), doneOpen: false });

export const MAX_HIDDEN = 64;

const SHOWN_RAW = 200;
const ID = /^[A-Za-z0-9_-]+$/;
const KEYS: readonly string[] = ["doneOpen", "hidden", "v"];

export const boardKey = (plan: PlanId): string => `webboard.board.${plan}`;

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);

const field = (v: object, key: string): unknown => Object.getOwnPropertyDescriptor(v, key)?.value;

const isIds = (v: unknown): v is StepId[] =>
  Array.isArray(v) && v.length <= MAX_HIDDEN && v.every((x) => typeof x === "string" && ID.test(x)) && new Set(v).size === v.length;

export function parseBoardPrefs(raw: string): BoardPrefs | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  if (!isObject(v)) return null;
  const own = Object.keys(v).sort();
  if (own.length !== KEYS.length || !KEYS.every((k, i) => own[i] === k)) return null;
  const hidden = field(v, "hidden");
  const doneOpen = field(v, "doneOpen");
  if (field(v, "v") !== 1 || !isIds(hidden) || typeof doneOpen !== "boolean") return null;
  return { v: 1, hidden, doneOpen };
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

export function readBoardPrefs(storage: Storage, plan: PlanId): BoardPrefs {
  const raw = storage.getItem(boardKey(plan));
  if (raw === null) return EMPTY_BOARD_PREFS;
  const parsed = parseBoardPrefs(raw);
  if (parsed !== null) return parsed;
  storage.removeItem(boardKey(plan));
  toast(PREFS_UNREADABLE, "bad", `The record was: ${raw.length > SHOWN_RAW ? `${raw.slice(0, SHOWN_RAW)}… (${raw.length} characters)` : raw}`);
  notify();
  return EMPTY_BOARD_PREFS;
}

export function writeBoardPrefs(storage: Storage, plan: PlanId, next: BoardPrefs, live: ReadonlySet<StepId>): void {
  const record: BoardPrefs = { v: 1, hidden: next.hidden.filter((id) => live.has(id)), doneOpen: next.doneOpen };
  if (record.hidden.length > MAX_HIDDEN) {
    toast(HIDE_LIMIT, "bad");
    return;
  }
  storage.setItem(boardKey(plan), JSON.stringify(record));
  notify();
}

interface Entry {
  raw: string | null;
  prefs: BoardPrefs;
  bad: boolean;
}

const cache = new Map<PlanId, Entry>();

const entryOf = (plan: PlanId): Entry => {
  const raw = window.localStorage.getItem(boardKey(plan));
  const cached = cache.get(plan);
  if (cached !== undefined && cached.raw === raw) return cached;
  const parsed = raw === null ? EMPTY_BOARD_PREFS : parseBoardPrefs(raw);
  const entry: Entry = parsed === null ? { raw, prefs: EMPTY_BOARD_PREFS, bad: true } : { raw, prefs: parsed, bad: false };
  cache.set(plan, entry);
  return entry;
};

export function useBoardPrefs(plan: PlanId | null): BoardPrefs {
  const bad = useSyncExternalStore(subscribe, () => plan !== null && entryOf(plan).bad);
  useLayoutEffect(() => {
    if (plan !== null) readBoardPrefs(window.localStorage, plan);
  }, [plan, bad]);
  return useSyncExternalStore(subscribe, () => (plan === null ? EMPTY_BOARD_PREFS : entryOf(plan).prefs));
}
