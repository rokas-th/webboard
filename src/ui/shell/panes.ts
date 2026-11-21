import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Platform } from "../../platform";
import { toast } from "../common/Toast";
import { parsePlace, PLACE_KEY } from "../state";

export type PaneKey = "list" | "outline" | "inspector";

export type PaneDevice = "desk" | "padLandscape" | "padPortrait";

export interface PaneState {
  open: boolean;
  w: number | null;
}

export type PaneSet = Readonly<Record<PaneKey, PaneState>>;

export interface PanesRecord {
  v: 1;
  desk: PaneSet;
  padLandscape: PaneSet;
  padPortrait: PaneSet;
}

export const PANES_KEY = "webboard.panes";
export const PANES_UNREADABLE = "Saved pane sizes could not be read; they were reset.";

const PANE_KEYS: readonly PaneKey[] = ["list", "outline", "inspector"];
const DEVICES: readonly PaneDevice[] = ["desk", "padLandscape", "padPortrait"];
const RECORD_KEYS: readonly string[] = ["v", ...DEVICES];
const STATE_KEYS: readonly string[] = ["open", "w"];

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);

const hasExactKeys = (v: object, keys: readonly string[]): boolean => {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

const field = (v: object, key: string): unknown => Object.getOwnPropertyDescriptor(v, key)?.value;

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const valueOf = (v: unknown): string => (v === undefined ? "missing" : typeof v === "number" && !Number.isFinite(v) ? String(v) : JSON.stringify(v));

const keysOf = (v: unknown): string => (isObject(v) ? `{${Object.keys(v).join(", ")}}` : valueOf(v));

function readState(v: unknown, at: string): Read<PaneState> {
  if (!isObject(v) || !hasExactKeys(v, STATE_KEYS)) return fail(`${at} is ${keysOf(v)}, not {open, w}`);
  const open = field(v, "open");
  const w = field(v, "w");
  if (typeof open !== "boolean") return fail(`${at}.open is ${valueOf(open)}, not true or false`);
  if (!(w === null || (typeof w === "number" && Number.isSafeInteger(w) && w > 0))) return fail(`${at}.w is ${valueOf(w)}, not null or a whole number of pixels above 0`);
  return { ok: true, value: { open, w } };
}

function readSet(v: unknown, at: string): Read<PaneSet> {
  if (!isObject(v) || !hasExactKeys(v, PANE_KEYS)) return fail(`${at} is ${keysOf(v)}, not {${PANE_KEYS.join(", ")}}`);
  const list = readState(field(v, "list"), `${at}.list`);
  if (!list.ok) return list;
  const outline = readState(field(v, "outline"), `${at}.outline`);
  if (!outline.ok) return outline;
  const inspector = readState(field(v, "inspector"), `${at}.inspector`);
  if (!inspector.ok) return inspector;
  return { ok: true, value: { list: list.value, outline: outline.value, inspector: inspector.value } };
}

export function readPanes(raw: string): Read<PanesRecord> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    if (e instanceof SyntaxError) return fail(`it is not JSON (${e.message})`);
    throw e;
  }
  if (!isObject(v) || !hasExactKeys(v, RECORD_KEYS)) return fail(`the record is ${keysOf(v)}, not {${RECORD_KEYS.join(", ")}}`);
  const version = field(v, "v");
  if (version !== 1) return fail(`v is ${valueOf(version)}, not 1`);
  const desk = readSet(field(v, "desk"), "desk");
  if (!desk.ok) return desk;
  const padLandscape = readSet(field(v, "padLandscape"), "padLandscape");
  if (!padLandscape.ok) return padLandscape;
  const padPortrait = readSet(field(v, "padPortrait"), "padPortrait");
  if (!padPortrait.ok) return padPortrait;
  return { ok: true, value: { v: 1, desk: desk.value, padLandscape: padLandscape.value, padPortrait: padPortrait.value } };
}

export function parsePanes(raw: string): PanesRecord | null {
  const read = readPanes(raw);
  return read.ok ? read.value : null;
}

const DEFAULT_STATE: PaneState = { open: true, w: null };

export function seedPanes(placeRaw: string | null): PanesRecord {
  const place = placeRaw === null ? null : parsePlace(placeRaw);
  const list: PaneState = place === null ? DEFAULT_STATE : { open: place.sidebarOpen, w: place.sidebarWidth };
  const set: PaneSet = { list, outline: DEFAULT_STATE, inspector: DEFAULT_STATE };
  return { v: 1, desk: set, padLandscape: set, padPortrait: set };
}

export function paneDevice(platform: Platform, width: number, height: number): PaneDevice | "phone" {
  if (platform.os !== "ios") return "desk";
  if (platform.idiom === "phone") return "phone";
  return width >= height ? "padLandscape" : "padPortrait";
}

const writePanes = (record: PanesRecord): void => {
  window.localStorage.setItem(PANES_KEY, JSON.stringify(record));
};

interface Loaded {
  record: PanesRecord;
  write: boolean;
  unreadable: string | null;
}

function loadPanes(): Loaded {
  const raw = window.localStorage.getItem(PANES_KEY);
  if (raw === null) return { record: seedPanes(window.localStorage.getItem(PLACE_KEY)), write: true, unreadable: null };
  const read = readPanes(raw);
  if (read.ok) return { record: read.value, write: false, unreadable: null };
  return { record: seedPanes(null), write: true, unreadable: `${read.reason}. The record was: ${raw}` };
}

export function usePanes(device: PaneDevice): { panes: PaneSet; setPane(key: PaneKey, next: PaneState): void } {
  const [loaded] = useState(loadPanes);
  const [record, setRecord] = useState<PanesRecord>(loaded.record);
  const current = useRef<PanesRecord>(loaded.record);
  const settled = useRef(false);
  useLayoutEffect(() => {
    if (settled.current) return;
    settled.current = true;
    if (loaded.write) writePanes(loaded.record);
    if (loaded.unreadable !== null) toast(PANES_UNREADABLE, "bad", loaded.unreadable);
  }, [loaded]);
  const setPane = useCallback(
    (key: PaneKey, next: PaneState) => {
      const was = current.current;
      const updated: PanesRecord = { ...was, [device]: { ...was[device], [key]: { open: next.open, w: next.w } } };
      writePanes(updated);
      current.current = updated;
      setRecord(updated);
    },
    [device],
  );
  return { panes: record[device], setPane };
}
