export type Hex = string;

type Rgb = readonly [number, number, number];
type Hsl = readonly [number, number, number];

const HEX = /^#[0-9A-F]{6}$/;

export const isHex = (v: unknown): v is Hex => typeof v === "string" && HEX.test(v);

export const hexToRgb = (h: Hex): Rgb => {
  if (!isHex(h)) throw new Error(`Not a #RRGGBB colour: ${h}`);
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
};

export const rgbToHex = (c: readonly number[]): Hex => {
  if (c.length !== 3 || c.some((v) => !Number.isFinite(v))) throw new Error(`Not an RGB triple: ${c.join(", ")}`);
  return `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
};

export const mix = (a: Hex, b: Hex, t: number): Hex => {
  const y = hexToRgb(b);
  return rgbToHex(hexToRgb(a).map((v, i) => v * (1 - t) + y[i] * t));
};

const linear = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export const luminance = (h: Hex): number => {
  const [r, g, b] = hexToRgb(h).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrast = (a: Hex, b: Hex): number => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

export const rgbToHsl = (h: Hex): Hsl => {
  const [r, g, b] = hexToRgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const sector = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(sector * 60 + 360) % 360, s, l];
};

export const hslToHex = ([h, s, l]: Hsl): Hex => {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const rgb: Rgb =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex(rgb.map((v) => (v + m) * 255));
};

export const hueGap = (a: Hex, b: Hex): number => {
  const d = Math.abs(rgbToHsl(a)[0] - rgbToHsl(b)[0]) % 360;
  return Math.min(d, 360 - d);
};

export const isRedish = (h: Hex): boolean => {
  const [hue, s] = rgbToHsl(h);
  return (hue >= 330 || hue <= 15) && s > 0.45;
};

export const channels = (h: Hex): string => hexToRgb(h).join(", ");

export const rgba = (h: Hex, a: number): string => `rgba(${channels(h)}, ${a})`;
