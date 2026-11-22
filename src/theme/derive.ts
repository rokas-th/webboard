import { contrast, luminance, mix, rgba, type Hex } from "./colour";

export interface Seeds {
  ground: Hex;
  text: Hex;
  accent: Hex;
  highlight: Hex;
  danger: Hex;
}

export type Scheme = "dark" | "light";

export interface Tokens {
  void: Hex;
  panel: Hex;
  "panel-2": Hex;
  line: Hex;
  cyan: Hex;
  "cyan-dim": Hex;
  amber: Hex;
  magenta: Hex;
  text: Hex;
  dim: Hex;
  "dot-idle": Hex;
  heading: Hex;
  "danger-bg": Hex;
  "on-accent": Hex;
  "s-violet": Hex;
  "s-lime": Hex;
  "s-coral": Hex;
  "s-sky": Hex;
  hover: string;
  active: string;
  scrim: string;
  scheme: Scheme;
}

export const HEX_TOKENS: readonly (keyof Tokens)[] = [
  "void",
  "panel",
  "panel-2",
  "line",
  "cyan",
  "cyan-dim",
  "amber",
  "magenta",
  "text",
  "dim",
  "dot-idle",
  "heading",
  "danger-bg",
  "on-accent",
];

export type SlotToken = "s-violet" | "s-lime" | "s-coral" | "s-sky";

export const SLOT_BASES: Readonly<Record<SlotToken, Hex>> = { "s-violet": "#A98BFF", "s-lime": "#9BE84A", "s-coral": "#FF7D5C", "s-sky": "#5CA8FF" };

export const SLOT_RATIO = 4.6;

const SLOT_STEPS: readonly number[] = Array.from({ length: 40 }, (_, i) => (i + 1) / 40);

const worstOn = (c: Hex, on: readonly Hex[]): number => Math.min(...on.map((x) => contrast(c, x)));

export const slotOf = (base: Hex, text: Hex, on: readonly Hex[]): Hex => {
  if (worstOn(base, on) >= SLOT_RATIO) return base;
  return SLOT_STEPS.map((k) => mix(base, text, k)).find((c) => worstOn(c, on) >= SLOT_RATIO) ?? text;
};

const DIM_STEPS: readonly number[] = Array.from({ length: 56 }, (_, i) => (60 - i) / 100);
const DIM_STRONGEST = 0.05;

export const schemeOf = (ground: Hex): Scheme => (luminance(ground) < 0.2 ? "dark" : "light");

export const onAccentOf = (accent: Hex, ground: Hex): Hex =>
  [ground, "#FFFFFF", "#000000"].reduce((best, c) => (contrast(c, accent) > contrast(best, accent) ? c : best));

export const derive = (s: Seeds): Tokens => {
  const dark = schemeOf(s.ground) === "dark";
  const panel2 = dark ? mix(s.ground, s.text, 0.08) : mix(s.ground, s.text, 0.05);
  const panel = dark ? mix(s.ground, s.text, 0.04) : mix(s.ground, "#FFFFFF", 0.7);
  const slot = (base: Hex): Hex => slotOf(base, s.text, [s.ground, panel, panel2]);
  const dimT = DIM_STEPS.find((t) => contrast(mix(s.text, s.ground, t), panel2) >= 4.6) ?? DIM_STRONGEST;
  return {
    void: s.ground,
    panel,
    "panel-2": panel2,
    line: mix(s.ground, s.text, dark ? 0.16 : 0.15),
    cyan: s.accent,
    "cyan-dim": mix(s.accent, s.ground, 0.42),
    amber: s.highlight,
    magenta: s.danger,
    text: s.text,
    dim: mix(s.text, s.ground, dimT),
    "dot-idle": mix(s.ground, s.text, 0.28),
    heading: dark ? mix(s.text, "#FFFFFF", 0.6) : mix(s.text, "#000000", 0.6),
    "danger-bg": mix(s.ground, s.danger, dark ? 0.13 : 0.09),
    "on-accent": onAccentOf(s.accent, s.ground),
    "s-violet": slot(SLOT_BASES["s-violet"]),
    "s-lime": slot(SLOT_BASES["s-lime"]),
    "s-coral": slot(SLOT_BASES["s-coral"]),
    "s-sky": slot(SLOT_BASES["s-sky"]),
    hover: rgba(s.accent, dark ? 0.06 : 0.08),
    active: rgba(s.highlight, dark ? 0.08 : 0.12),
    scrim: dark ? rgba(mix(s.ground, "#000000", 0.6), 0.72) : rgba(s.text, 0.35),
    scheme: dark ? "dark" : "light",
  };
};
