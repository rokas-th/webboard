import { DATE_FORMATS, WEEK_STARTS, type DateFormat, type WeekStart } from "../domain/dates";
import type { PersonId, PlanId } from "../domain/model";
import type { Platform } from "../platform";
import { isPlanId } from "../store/plan-id";
import { toast } from "./common/Toast";
import type { ViewKind } from "./state";

export type Density = "comfortable" | "compact";
export type TextSize = "small" | "default";
export type Glow = "full" | "reduced";

export interface DevicePrefs {
  v: 1;
  tab: ViewKind;
  week: WeekStart;
  dates: DateFormat;
  density: Density;
  text: TextSize;
  glow: Glow;
  me: Readonly<Record<PlanId, PersonId>>;
}

export interface Look {
  density: Density;
  text: TextSize;
  glow: Glow;
}

export const DEVICE_KEY = "webboard.device";
export const DEVICE_UNREADABLE = "Saved device settings could not be read; they were reset.";
export const SMALL_TEXT_ZOOM = 0.92;

export const TABS: readonly ViewKind[] = ["timeline", "board", "list"];
export const DENSITIES: readonly Density[] = ["comfortable", "compact"];
export const TEXT_SIZES: readonly TextSize[] = ["small", "default"];
export const GLOWS: readonly Glow[] = ["full", "reduced"];

export const DEFAULT_DEVICE: DevicePrefs = Object.freeze({
  v: 1,
  tab: "timeline",
  week: 1,
  dates: "system",
  density: "comfortable",
  text: "default",
  glow: "full",
  me: Object.freeze({}),
});

const RECORD_KEYS: readonly string[] = ["dates", "density", "glow", "me", "tab", "text", "v", "week"];
const PERSON_ID = /^[A-Za-z0-9_-]+$/;

export type DeviceRead = { ok: true; value: DevicePrefs } | { ok: false; reason: string };

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);

const field = (v: object, key: string): unknown => Object.getOwnPropertyDescriptor(v, key)?.value;

const hasExactKeys = (v: object, keys: readonly string[]): boolean => {
  const own = Object.keys(v).sort();
  return own.length === keys.length && keys.every((k, i) => own[i] === k);
};

const valueOf = (v: unknown): string => (v === undefined ? "missing" : JSON.stringify(v));

const keysOf = (v: unknown): string => (isObject(v) ? `{${Object.keys(v).join(", ")}}` : Array.isArray(v) ? "[]" : valueOf(v));

const oneOf = <T>(list: readonly T[], v: unknown): T | null => list.find((x) => x === v) ?? null;

const choices = (list: readonly (string | number)[]): string => (list.length === 2 ? `${list[0]} or ${list[1]}` : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`);

function readEnum<T extends string | number>(v: object, key: string, list: readonly T[]): Read<T> {
  const raw = field(v, key);
  const value = oneOf(list, raw);
  return value === null ? fail(`${key} is ${valueOf(raw)}, not ${choices(list)}`) : { ok: true, value };
}

const isMeEntry = (e: [string, unknown]): e is [PlanId, PersonId] => typeof e[1] === "string" && PERSON_ID.test(e[1]);

function readMe(v: unknown): Read<Readonly<Record<PlanId, PersonId>>> {
  if (!isObject(v)) return fail(`me is ${keysOf(v)}, not a map of plans to people`);
  const entries = Object.entries(v);
  const badKey = entries.find(([plan]) => !isPlanId(plan));
  if (badKey !== undefined) return fail(`me has the key ${JSON.stringify(badKey[0])}, which is not a plan id`);
  const bad = entries.find((e) => !isMeEntry(e));
  if (bad !== undefined) return fail(`me.${bad[0]} is ${valueOf(bad[1])}, not a person id`);
  return { ok: true, value: Object.freeze(Object.fromEntries(entries.filter(isMeEntry))) };
}

export function readDevice(raw: string): DeviceRead {
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
  const tab = readEnum(v, "tab", TABS);
  if (!tab.ok) return tab;
  const week = readEnum(v, "week", WEEK_STARTS);
  if (!week.ok) return week;
  const dates = readEnum(v, "dates", DATE_FORMATS);
  if (!dates.ok) return dates;
  const density = readEnum(v, "density", DENSITIES);
  if (!density.ok) return density;
  const text = readEnum(v, "text", TEXT_SIZES);
  if (!text.ok) return text;
  const glow = readEnum(v, "glow", GLOWS);
  if (!glow.ok) return glow;
  const me = readMe(field(v, "me"));
  if (!me.ok) return me;
  return { ok: true, value: { v: 1, tab: tab.value, week: week.value, dates: dates.value, density: density.value, text: text.value, glow: glow.value, me: me.value } };
}

export function loadDevice(storage: Storage): DevicePrefs {
  const raw = storage.getItem(DEVICE_KEY);
  if (raw === null) return DEFAULT_DEVICE;
  const read = readDevice(raw);
  if (read.ok) return read.value;
  storage.removeItem(DEVICE_KEY);
  toast(DEVICE_UNREADABLE, "bad", read.reason);
  return DEFAULT_DEVICE;
}

export function saveDevice(storage: Storage, next: DevicePrefs): void {
  const record: DevicePrefs = { v: 1, tab: next.tab, week: next.week, dates: next.dates, density: next.density, text: next.text, glow: next.glow, me: next.me };
  const text = JSON.stringify(record);
  const check = readDevice(text);
  if (!check.ok) throw new Error(`Device settings would not read back: ${check.reason}`);
  storage.setItem(DEVICE_KEY, text);
}

export const DESK_TEXT_SIZES: readonly TextSize[] = ["small", "default"];
export const PAD_TEXT_SIZES: readonly TextSize[] = ["default"];
export const PHONE_TEXT_SIZES: readonly TextSize[] = ["default"];

export const textSizesOn = (platform: Platform): readonly TextSize[] => (platform.os !== "ios" ? DESK_TEXT_SIZES : platform.idiom === "pad" ? PAD_TEXT_SIZES : PHONE_TEXT_SIZES);

export const meFor = (prefs: DevicePrefs, plan: PlanId): PersonId | null => Object.entries(prefs.me).find(([id]) => id === plan)?.[1] ?? null;

export function bootDevice(storage: Storage, platform: Platform, show: (look: Look) => void, root: HTMLElement): DevicePrefs {
  try {
    const device = loadDevice(storage);
    show(lookOf(device, platform));
    return device;
  } catch (e) {
    root.textContent = `WebBoard could not start: its device settings could not be loaded (${e instanceof Error ? e.message : String(e)}).`;
    throw e;
  }
}

export function lookOf(prefs: DevicePrefs, platform: Platform): Look {
  const text: TextSize = textSizesOn(platform).includes(prefs.text) ? prefs.text : "default";
  return { density: platform.os === "ios" ? "comfortable" : prefs.density, text, glow: prefs.glow };
}
