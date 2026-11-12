import { checks, fix, type CheckId } from "./checks";
import { hslToHex, hueGap, isRedish, luminance, mix, rgbToHex, rgbToHsl, type Hex } from "./colour";
import { derive, type Scheme, type Seeds } from "./derive";

type Pixel = readonly [number, number, number];
type Channel = 0 | 1 | 2;

export interface Assigned {
  seeds: Seeds;
  notes: readonly string[];
}

const COLOUR = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b|rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi;
const CHANNEL_MAX = 255;
const CHANNELS: readonly Channel[] = [0, 1, 2];
const OPAQUE = 128;
const DARK_GROUND_MAX = 0.012;
const LIGHT_GROUND_MIN = 0.85;
const MIN_CHROMA = 0.04;
const OPPOSITES: readonly number[] = [120, 135, 150, 165, 180, 195, 210, 225, 240];
const FIX_ORDER: readonly CheckId[] = ["text", "dim", "accent", "label", "highlight", "danger", "apart-hi", "apart-acc", "apart-acc-hi", "danger-red", "only-danger-red"];
const ADJUSTABLE: readonly ("accent" | "highlight" | "danger")[] = ["accent", "highlight", "danger"];

const OWN: Record<Scheme, { accent: Hex; danger: Hex }> = {
  dark: { accent: "#24E0FF", danger: "#FF3B6B" },
  light: { accent: "#007A96", danger: "#C8174A" },
};

const fromHexDigits = (digits: string): Hex => {
  const opaque = digits.length === 4 || digits.length === 8 ? digits.slice(0, digits.length - digits.length / 4) : digits;
  const full = opaque.length === 3 ? opaque.split("").map((c) => c + c).join("") : opaque;
  return `#${full.toUpperCase()}`;
};

const channelsOf = (m: RegExpMatchArray): readonly number[] => [m[2], m[3], m[4]].map(Number);

const inRange = (m: RegExpMatchArray): boolean => m[1] !== undefined || channelsOf(m).every((c) => c <= CHANNEL_MAX);

const colourOf = (m: RegExpMatchArray): Hex => (m[1] === undefined ? rgbToHex(channelsOf(m)) : fromHexDigits(m[1]));

export const parseColours = (text: string): readonly Hex[] => [...new Set([...text.matchAll(COLOUR)].filter(inRange).map(colourOf))];

export const outOfRange = (text: string): readonly string[] => [...new Set([...text.matchAll(COLOUR)].filter((m) => !inRange(m)).map((m) => `${m[0]})`))];

export const pixelsOf = (data: Uint8ClampedArray): readonly Pixel[] =>
  Array.from({ length: Math.floor(data.length / 4) }, (_, i) => i * 4)
    .filter((o) => data[o + 3] >= OPAQUE)
    .map((o): Pixel => [data[o], data[o + 1], data[o + 2]]);

interface Box {
  pixels: readonly Pixel[];
  channel: Channel;
  score: number;
}

const rangeOf = (pixels: readonly Pixel[], ch: Channel): number => {
  const [lo, hi] = pixels.reduce<readonly [number, number]>(([a, b], p) => [Math.min(a, p[ch]), Math.max(b, p[ch])], [Infinity, -Infinity]);
  return hi - lo;
};

const boxOf = (pixels: readonly Pixel[]): Box => {
  const ranges = CHANNELS.map((ch) => rangeOf(pixels, ch));
  const channel = CHANNELS.reduce((a, b) => (ranges[b] > ranges[a] ? b : a));
  return { pixels, channel, score: ranges[channel] * Math.log(pixels.length + 1) };
};

const split = (boxes: readonly Box[], n: number): readonly Box[] => {
  if (boxes.length >= n) return boxes;
  const ranked = [...boxes].sort((x, y) => y.score - x.score);
  const [top, ...others] = ranked;
  if (top.pixels.length < 2 || top.score === 0) return boxes;
  const sorted = [...top.pixels].sort((p, q) => p[top.channel] - q[top.channel]);
  const mid = sorted.length >> 1;
  return split([...others, boxOf(sorted.slice(0, mid)), boxOf(sorted.slice(mid))], n);
};

const average = (pixels: readonly Pixel[]): Hex =>
  rgbToHex(CHANNELS.map((ch) => pixels.reduce((acc, p) => acc + p[ch], 0) / pixels.length));

export const medianCut = (pixels: readonly Pixel[], n: number): readonly Hex[] => {
  if (pixels.length === 0 || n < 1) return [];
  const boxes = [...split([boxOf(pixels)], n)].sort((a, b) => b.pixels.length - a.pixels.length);
  return [...new Set(boxes.map((b) => average(b.pixels)))];
};

const chroma = (h: Hex): number => {
  const [, s, l] = rgbToHsl(h);
  return s * (1 - Math.abs(2 * l - 1));
};

const groundFrom = (base: Hex, scheme: Scheme): Hex => {
  if (scheme === "dark") return luminance(base) > DARK_GROUND_MAX ? mix(base, "#000000", 0.82) : base;
  return luminance(base) < LIGHT_GROUND_MIN ? mix(base, "#FFFFFF", 0.86) : base;
};

const minGap = (c: Hex, a: Hex, b: Hex): number => Math.min(hueGap(c, a), hueGap(c, b));

const oppositeOf = (accent: Hex, danger: Hex): Hex => {
  const [h, s, l] = rgbToHsl(accent);
  return OPPOSITES.map((o) => hslToHex([h + o, Math.max(s, 0.6), l])).reduce((a, b) => (minGap(b, accent, danger) > minGap(a, accent, danger) ? b : a));
};

const failing = (id: CheckId, s: Seeds): boolean => checks(s, derive(s)).some((c) => c.id === id && !c.pass);

const fixPass = (s: Seeds): Seeds => FIX_ORDER.reduce((acc, id) => (failing(id, acc) ? (fix(id, acc) ?? acc) : acc), s);

export const fixAll = (s: Seeds): Seeds => fixPass(fixPass(s));

export const unfixedNotes = (s: Seeds): readonly string[] =>
  checks(s, derive(s))
    .filter((c) => !c.pass)
    .map((c) => `Could not fix ${c.label} automatically; change the colour by hand.`);

export const assignRoles = (colours: readonly Hex[], scheme: Scheme): Assigned => {
  const unique = [...new Set(colours)];
  if (unique.length < 3) throw new Error("assignRoles needs at least three colours");
  const sorted = [...unique].sort((a, b) => luminance(a) - luminance(b));
  const darkest = sorted[0];
  const lightest = sorted[sorted.length - 1];
  const baseGround = scheme === "dark" ? darkest : lightest;
  const baseText = scheme === "dark" ? lightest : darkest;
  const ground = groundFrom(baseGround, scheme);
  const groundNote =
    ground === baseGround ? [] : [`${scheme === "dark" ? "Darkened" : "Lightened"} ${baseGround} into the background so text stays readable.`];
  const textStart = scheme === "dark" ? mix(baseText, "#FFFFFF", 0.6) : mix(baseText, "#000000", 0.7);
  const rest = unique.filter((c) => c !== baseGround && c !== baseText).sort((a, b) => chroma(b) - chroma(a));
  const red = rest.find(isRedish);
  const danger = red ?? OWN[scheme].danger;
  const others = rest.filter((c) => c !== red && chroma(c) >= MIN_CHROMA);
  const accent = others.length > 0 ? others[0] : OWN[scheme].accent;
  const second = others.find((c) => c !== accent && hueGap(c, accent) >= 45 && hueGap(c, danger) >= 30);
  const highlight = second ?? oppositeOf(accent, danger);
  const start: Seeds = { ground, text: textStart, accent, highlight, danger };
  const raw: Seeds = { ...start, text: fix("text", start)?.text ?? textStart };
  const seeds = fixAll(raw);
  const notes = [
    ...groundNote,
    ...(red === undefined ? ["No red in the palette, so danger keeps WebBoard's own."] : []),
    ...(second === undefined ? ["The palette has no second hue, so the highlight is the accent's opposite."] : []),
    ...ADJUSTABLE.filter((role) => seeds[role] !== raw[role]).map(
      (role) => `Adjusted ${role} from ${raw[role]} to ${seeds[role]} to keep it readable and distinct.`,
    ),
    ...unfixedNotes(seeds),
  ];
  return { seeds, notes };
};
