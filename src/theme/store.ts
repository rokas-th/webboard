import { isHex } from "./colour";
import { derive, schemeOf, type Scheme, type Seeds } from "./derive";
import { passes } from "./checks";
import { DEFAULT_DARK, DEFAULT_ID, DEFAULT_LIGHT, PRESETS, type Theme } from "./presets";

export const THEME_KEY = "webboard.theme";
export const THEME_BACKUP_KEY = "webboard.theme.unreadable";
export const THEME_UNREADABLE = "Theme settings were unreadable, so WebBoard uses Cyberdeck.";
export const MAX_MINE = 24;
export const NAME_MAX = 40;

export type Mode = "fixed" | "system";

export interface ThemeStore {
  v: 1;
  mode: Mode;
  active: string;
  dark: string;
  light: string;
  mine: readonly Theme[];
}

export const DEFAULT_STORE: ThemeStore = { v: 1, mode: "fixed", active: DEFAULT_ID, dark: DEFAULT_DARK, light: DEFAULT_LIGHT, mine: [] };

const MINE_ID = /^mine-([1-9][0-9]*)$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isMode = (v: unknown): v is Mode => v === "fixed" || v === "system";

const mineTheme = (id: string, name: string, seeds: Seeds): Theme => ({ id, name, note: "Yours", group: "mine", seeds });

const parseSeeds = (v: unknown): Seeds | null => {
  if (!isRecord(v)) return null;
  const { ground, text, accent, highlight, danger } = v;
  if (!isHex(ground) || !isHex(text) || !isHex(accent) || !isHex(highlight) || !isHex(danger)) return null;
  return { ground, text, accent, highlight, danger };
};

const nameOk = (name: string): boolean => name.trim().length > 0 && name.length <= NAME_MAX;

const parseMine = (v: unknown): Theme | null => {
  if (!isRecord(v)) return null;
  const { id, name } = v;
  const seeds = parseSeeds(v.seeds);
  if (typeof id !== "string" || !MINE_ID.test(id) || typeof name !== "string" || !nameOk(name) || seeds === null) return null;
  return mineTheme(id, name, seeds);
};

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const schemeOfTheme = (t: Theme): Scheme => schemeOf(t.seeds.ground);

const find = (s: ThemeStore, id: string): Theme | undefined => allThemes(s).find((t) => t.id === id);

const slotHolds = (s: ThemeStore, scheme: Scheme, id: string): boolean => {
  const t = find(s, id);
  return t !== undefined && schemeOfTheme(t) === scheme;
};

const problemOf = (s: ThemeStore): string | null =>
  [
    s.mine.length > MAX_MINE ? `${s.mine.length} saved themes, more than ${MAX_MINE}` : null,
    unique(s.mine.map((t) => t.id)) ? null : "two saved themes share an id",
    unique(s.mine.map((t) => t.name.toLowerCase())) ? null : "two saved themes share a name",
    find(s, s.active) === undefined ? `the active theme ${s.active} does not exist` : null,
    slotHolds(s, "dark", s.dark) ? null : `the dark slot ${s.dark} is not a dark theme`,
    slotHolds(s, "light", s.light) ? null : `the light slot ${s.light} is not a light theme`,
  ].find((p) => p !== null) ?? null;

const parseJson = (raw: string): { value: unknown } | { reason: string } => {
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { reason: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
};

export function readStore(raw: string): { store: ThemeStore } | { reason: string } {
  const json = parseJson(raw);
  if ("reason" in json) return json;
  const v = json.value;
  if (!isRecord(v)) return { reason: "not an object" };
  if (v.v !== 1) return { reason: `version ${JSON.stringify(v.v)} is not 1` };
  if (!isMode(v.mode)) return { reason: `mode ${JSON.stringify(v.mode)} is not fixed or system` };
  if (!Array.isArray(v.mine)) return { reason: "mine is not a list" };
  const { mode, active, dark, light } = v;
  if (typeof active !== "string" || typeof dark !== "string" || typeof light !== "string") return { reason: "active, dark or light is not a theme id" };
  const parsed = v.mine.map(parseMine);
  const bad = parsed.findIndex((t) => t === null);
  if (bad !== -1) return { reason: `saved theme ${bad + 1} is invalid` };
  const mine = parsed.filter((t): t is Theme => t !== null);
  const store: ThemeStore = { v: 1, mode, active, dark, light, mine };
  const problem = problemOf(store);
  return problem === null ? { store } : { reason: problem };
}

export function parseStore(raw: string): ThemeStore | null {
  const r = readStore(raw);
  return "store" in r ? r.store : null;
}

export function loadStore(storage: Storage): { store: ThemeStore; unreadable: string | null } {
  const raw = storage.getItem(THEME_KEY);
  if (raw === null) return { store: DEFAULT_STORE, unreadable: null };
  const r = readStore(raw);
  if ("store" in r) return { store: r.store, unreadable: null };
  storage.setItem(THEME_BACKUP_KEY, raw);
  return { store: DEFAULT_STORE, unreadable: r.reason };
}

export function saveStore(storage: Storage, s: ThemeStore): void {
  const { v, mode, active, dark, light } = s;
  storage.setItem(THEME_KEY, JSON.stringify({ v, mode, active, dark, light, mine: s.mine.map(({ id, name, seeds }) => ({ id, name, seeds })) }));
}

export const allThemes = (s: ThemeStore): readonly Theme[] => [...PRESETS, ...s.mine];

export function themeById(s: ThemeStore, id: string): Theme {
  const t = find(s, id);
  if (t === undefined) throw new Error(`No theme ${id}`);
  return t;
}

export const shownTheme = (s: ThemeStore, systemDark: boolean): Theme =>
  themeById(s, s.mode === "fixed" ? s.active : systemDark ? s.dark : s.light);

const mineNumber = (id: string): number => {
  const m = MINE_ID.exec(id);
  if (m === null) throw new Error(`Not a saved theme id: ${id}`);
  return Number(m[1]);
};

export const nextMineId = (s: ThemeStore): string => `mine-${s.mine.map((t) => mineNumber(t.id)).reduce((a, b) => Math.max(a, b), 0) + 1}`;

const requireMine = (s: ThemeStore, id: string): Theme => {
  const t = s.mine.find((m) => m.id === id);
  if (t === undefined) throw new Error(`No saved theme ${id}`);
  return t;
};

const reslot = (s: ThemeStore): ThemeStore => ({
  ...s,
  active: find(s, s.active) === undefined ? DEFAULT_ID : s.active,
  dark: slotHolds(s, "dark", s.dark) ? s.dark : DEFAULT_DARK,
  light: slotHolds(s, "light", s.light) ? s.light : DEFAULT_LIGHT,
});

export class ThemeSaveError extends Error {
  override readonly name = "ThemeSaveError";
}

const SCHEMES: readonly Scheme[] = ["dark", "light"];

export const resetSlots = (before: ThemeStore, after: ThemeStore): readonly Scheme[] => SCHEMES.filter((scheme) => before[scheme] !== after[scheme]);

export function withSaved(s: ThemeStore, name: string, seeds: Seeds, replace: string | null): { store: ThemeStore; id: string } {
  const clean = name.trim();
  if (clean.length === 0) throw new ThemeSaveError("Name the theme first.");
  if (clean.length > NAME_MAX) throw new ThemeSaveError(`Use at most ${NAME_MAX} characters.`);
  if (replace !== null) requireMine(s, replace);
  if (s.mine.some((t) => t.id !== replace && t.name.toLowerCase() === clean.toLowerCase())) throw new ThemeSaveError(`You already have a theme called ${clean}.`);
  if (replace === null && s.mine.length >= MAX_MINE) throw new ThemeSaveError(`You can keep ${MAX_MINE} themes; delete one first.`);
  if (!passes(seeds, derive(seeds))) throw new ThemeSaveError("Fix the failing checks before saving.");
  const id = replace ?? nextMineId(s);
  const theme = mineTheme(id, clean, seeds);
  const mine = replace === null ? [...s.mine, theme] : s.mine.map((t) => (t.id === replace ? theme : t));
  return { store: reslot({ ...s, mine }), id };
}

export function withRemoved(s: ThemeStore, id: string): ThemeStore {
  requireMine(s, id);
  return reslot({ ...s, mine: s.mine.filter((t) => t.id !== id) });
}

const put = (s: ThemeStore, scheme: Scheme, id: string): ThemeStore => (scheme === "dark" ? { ...s, dark: id } : { ...s, light: id });

export function withChosen(s: ThemeStore, id: string): ThemeStore {
  const t = themeById(s, id);
  if (s.mode === "fixed") return { ...s, active: id };
  return put(s, schemeOfTheme(t), id);
}

export function withMode(s: ThemeStore, mode: Mode): ThemeStore {
  if (mode === "fixed") return { ...s, mode };
  return put({ ...s, mode }, schemeOfTheme(themeById(s, s.active)), s.active);
}

export function withSlot(s: ThemeStore, scheme: Scheme, id: string): ThemeStore {
  const t = themeById(s, id);
  if (schemeOfTheme(t) !== scheme) throw new Error(`${t.name} is not a ${scheme} theme.`);
  return put(s, scheme, id);
}
