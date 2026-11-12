import { contrast, hslToHex, hueGap, isRedish, rgbToHsl, type Hex } from "./colour";
import { derive, onAccentOf, schemeOf, type Seeds, type Tokens } from "./derive";

export type CheckId =
  | "text"
  | "dim"
  | "accent"
  | "label"
  | "highlight"
  | "danger"
  | "apart-hi"
  | "apart-acc"
  | "apart-acc-hi"
  | "danger-red"
  | "only-danger-red";

export interface Check {
  id: CheckId;
  label: string;
  value: number;
  need: number;
  unit: "ratio" | "deg" | "bool";
  pass: boolean;
}

type Coloured = "accent" | "highlight" | "danger";

const NEED_RATIO = 4.5;
const NEED_GAP = 30;
const FIX_RATIO = 4.6;
const FIX_TEXT = 7;
const FIX_DIM = 9;
const WALK_SAMPLES = 201;
const DANGER_HUES: readonly number[] = Array.from({ length: 91 }, (_, i) => (330 + i / 2) % 360);
const ROTATIONS: readonly number[] = Array.from({ length: 11 }, (_, i) => (i + 1) * 30);
const NOT_RED: readonly ("accent" | "highlight")[] = ["accent", "highlight"];

const surfaces = (role: Coloured, t: Tokens): readonly Hex[] =>
  role === "danger" ? [t.void, t.panel, t["panel-2"], t["danger-bg"]] : [t.void, t.panel, t["panel-2"]];

const worst = (c: Hex, on: readonly Hex[]): number => Math.min(...on.map((x) => contrast(c, x)));

const ratio = (id: CheckId, label: string, value: number): Check => ({ id, label, value, need: NEED_RATIO, unit: "ratio", pass: value >= NEED_RATIO });

const gap = (id: CheckId, label: string, value: number): Check => ({ id, label, value, need: NEED_GAP, unit: "deg", pass: value >= NEED_GAP });

const bool = (id: CheckId, label: string, ok: boolean): Check => ({ id, label, value: ok ? 1 : 0, need: 1, unit: "bool", pass: ok });

export const checks = (s: Seeds, t: Tokens): readonly Check[] => [
  ratio("text", "Text on background", contrast(s.text, s.ground)),
  ratio("dim", "Secondary text on panels", contrast(t.dim, t["panel-2"])),
  ratio("accent", "Accent on background", worst(s.accent, surfaces("accent", t))),
  ratio("label", "Labels on accent", contrast(t["on-accent"], s.accent)),
  ratio("highlight", "Highlight on background", worst(s.highlight, surfaces("highlight", t))),
  ratio("danger", "Danger on background", worst(s.danger, surfaces("danger", t))),
  gap("apart-hi", "Danger apart from highlight", hueGap(s.danger, s.highlight)),
  gap("apart-acc", "Danger apart from accent", hueGap(s.danger, s.accent)),
  gap("apart-acc-hi", "Accent apart from highlight", hueGap(s.accent, s.highlight)),
  bool("danger-red", "Danger is red", isRedish(s.danger)),
  bool("only-danger-red", "Only danger is red", !isRedish(s.accent) && !isRedish(s.highlight)),
];

export const passes = (s: Seeds, t: Tokens): boolean => checks(s, t).every((c) => c.pass);

const withSeed = (s: Seeds, role: keyof Seeds, c: Hex): Seeds => ({ ...s, [role]: c });

const firstHit = (h: number, sat: number, l: number, lighter: boolean, target: number, measure: (c: Hex) => number): { c: Hex; moved: number } | null => {
  const hit = Array.from({ length: WALK_SAMPLES }, (_, i) => i / (WALK_SAMPLES - 1))
    .map((t) => (lighter ? l + (1 - l) * t : l * (1 - t)))
    .map((next) => ({ c: hslToHex([h, sat, next]), moved: Math.abs(next - l) }))
    .find((x) => measure(x.c) >= target);
  return hit ?? null;
};

const walk = (colour: Hex, away: Hex, target: number, measure: (c: Hex) => number): Hex | null => {
  const [h, sat, l] = rgbToHsl(colour);
  const preferLighter = schemeOf(away) === "dark";
  const hits = [preferLighter, !preferLighter]
    .map((lighter) => firstHit(h, sat, l, lighter, target, measure))
    .filter((x): x is { c: Hex; moved: number } => x !== null);
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => (b.moved < a.moved ? b : a)).c;
};

const readable = (role: Coloured, s: Seeds): Seeds | null => {
  const c = walk(s[role], s.ground, FIX_RATIO, (x) => {
    const next = withSeed(s, role, x);
    return worst(x, surfaces(role, derive(next)));
  });
  return c === null ? null : withSeed(s, role, c);
};

const textTo = (target: number, s: Seeds): Seeds | null => {
  const c = walk(s.text, s.ground, target, (x) => contrast(x, s.ground));
  return c === null ? null : withSeed(s, "text", c);
};

const minGap = (c: Hex, s: Seeds): number => Math.min(hueGap(c, s.highlight), hueGap(c, s.accent));

const separateDanger = (s: Seeds): Seeds | null => {
  const [, sat, l] = rgbToHsl(s.danger);
  const red = DANGER_HUES.map((h) => hslToHex([h, Math.max(sat, 0.6), l])).filter(isRedish);
  if (red.length === 0) return null;
  const best = red.reduce((a, b) => (minGap(b, s) > minGap(a, s) ? b : a));
  return readable("danger", withSeed(s, "danger", best));
};

const unRed = (s: Seeds): Seeds | null =>
  NOT_RED.filter((role) => isRedish(s[role])).reduce<Seeds | null>((acc, role) => {
    if (acc === null) return null;
    const [h, sat, l] = rgbToHsl(acc[role]);
    return readable(role, withSeed(acc, role, hslToHex([h <= 15 ? 30 : 315, sat, l])));
  }, s);

const apartHighlight = (s: Seeds): Seeds | null => {
  const [h, sat, l] = rgbToHsl(s.highlight);
  const c = ROTATIONS.map((r) => hslToHex([h + r, sat, l])).find((x) => hueGap(s.accent, x) >= NEED_GAP);
  return c === undefined ? null : withSeed(s, "highlight", c);
};

const label = (s: Seeds): Seeds | null => {
  const c = walk(s.accent, onAccentOf(s.accent, s.ground), FIX_RATIO, (x) => contrast(x, onAccentOf(x, s.ground)));
  return c === null ? null : withSeed(s, "accent", c);
};

const FIXES: Record<CheckId, (s: Seeds) => Seeds | null> = {
  text: (s) => textTo(FIX_TEXT, s),
  dim: (s) => textTo(FIX_DIM, s),
  accent: (s) => readable("accent", s),
  label,
  highlight: (s) => readable("highlight", s),
  danger: (s) => readable("danger", s),
  "apart-hi": separateDanger,
  "apart-acc": separateDanger,
  "apart-acc-hi": apartHighlight,
  "danger-red": separateDanger,
  "only-danger-red": unRed,
};

const holds = (id: CheckId, s: Seeds): boolean => checks(s, derive(s)).some((c) => c.id === id && c.pass);

export const fix = (id: CheckId, s: Seeds): Seeds | null => {
  const next = FIXES[id](s);
  return next !== null && holds(id, next) ? next : null;
};
