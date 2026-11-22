import { toast } from "../common/Toast";
import type { SettingsSection } from "../state";
import { isPlanSection, SETTINGS_SECTIONS } from "./sections";

export const SETTINGS_KEY = "webboard.settings";

export const SETTINGS_UNREADABLE = "The saved Settings section could not be read; Settings opens on General.";

const isSection = (v: unknown): v is SettingsSection => typeof v === "string" && SETTINGS_SECTIONS.some((s) => s.id === v);

export function parseSettingsPlace(raw: string): SettingsSection | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  if (Object.keys(v).sort().join(",") !== "at,v") return null;
  if (!("v" in v) || v.v !== 1 || !("at" in v) || !isSection(v.at)) return null;
  return v.at;
}

export function lastSection(storage: Storage, hasPlan: boolean): SettingsSection {
  const raw = storage.getItem(SETTINGS_KEY);
  if (raw === null) return "general";
  const at = parseSettingsPlace(raw);
  if (at === null) {
    storage.removeItem(SETTINGS_KEY);
    toast(SETTINGS_UNREADABLE, "bad");
    return "general";
  }
  return isPlanSection(at) && !hasPlan ? "general" : at;
}

export function saveSection(storage: Storage, at: SettingsSection): void {
  storage.setItem(SETTINGS_KEY, JSON.stringify({ v: 1, at }));
}
