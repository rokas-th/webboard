import { describe, expect, it } from "vitest";
import tokensCss from "./tokens.css?raw";
import probeCss from "../probe/probe.css?raw";
import { channels } from "../theme/colour";
import { HEX_TOKENS, type Tokens } from "../theme/derive";
import { PRESETS, tokensOf } from "../theme/presets";
import { paint, swatch } from "../ui/theme/ThemeCards";
import { TABBAR_HEIGHT } from "../ui/phone/nativeTabBar";

const SHEETS: Record<string, string> = import.meta.glob("./*.css", { query: "?raw", import: "default", eager: true });

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const rootBlock = (css: string): string => {
  const match = /:root\s*\{([^}]*)\}/.exec(stripComments(css));
  if (match === null) throw new Error("tokens.css has no :root block");
  return match[1];
};

const declarations = (block: string): Map<string, string> =>
  new Map([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

const ROOT = declarations(rootBlock(tokensCss));

const cyberdeckTheme = PRESETS.find((t) => t.id === "cyberdeck");
if (cyberdeckTheme === undefined) throw new Error("no cyberdeck preset");
const CYBERDECK = tokensOf(cyberdeckTheme);

const INLINE = [...Object.keys(paint(CYBERDECK)), ...Object.keys(swatch(CYBERDECK.void)), TABBAR_HEIGHT];

const DECLARED = new Set([...[...stripComments(tokensCss).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]), ...INLINE]);

const COLOUR_TOKENS = (Object.keys(CYBERDECK) as (keyof Tokens)[]).filter((name) => name !== "scheme");

const LITERALS: readonly RegExp[] = [
  /#[0-9A-Fa-f]{3,8}\b/,
  /\brgba?\(\s*[\d.]/,
  /\bhsla?\(/,
  /(?<![\w-])(?:white|black)(?![\w-])/,
];

const literalsIn = (css: string): string[] =>
  stripComments(css)
    .split("\n")
    .filter((line) => LITERALS.some((re) => re.test(line)))
    .map((line) => line.trim());

const referenced = (css: string): string[] => [...stripComments(css).matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);

describe("theme token layer", () => {
  it("declares Cyberdeck's value for every colour token in tokens.css", () => {
    expect(COLOUR_TOKENS.length).toBeGreaterThan(15);
    expect(COLOUR_TOKENS.map((name) => [name, ROOT.get(`--${name}`)])).toEqual(COLOUR_TOKENS.map((name) => [name, CYBERDECK[name]]));
  });

  it("declares a channel token with Cyberdeck's channels for every hex token", () => {
    expect(HEX_TOKENS.map((name) => [name, ROOT.get(`--${name}-rgb`)])).toEqual(HEX_TOKENS.map((name) => [name, channels(CYBERDECK[name])]));
    expect(ROOT.get("--shadow-rgb")).toBe("0, 0, 0");
    expect(ROOT.get("--on-accent")).toBe("#000000");
    expect(ROOT.get("--scrim")).toBe("rgba(4, 4, 10, 0.72)");
    expect(rootBlock(tokensCss)).toMatch(/color-scheme:\s*dark;/);
  });

  it("finds colour literals when they are there", () => {
    expect(literalsIn("a { color: #FFB000; }")).toEqual(["a { color: #FFB000; }"]);
    expect(literalsIn("a { box-shadow: 0 0 4px rgba(0, 0, 0, 0.5); }")).toHaveLength(1);
    expect(literalsIn("a { color: rgb(1 2 3); }")).toHaveLength(1);
    expect(literalsIn("a { color: hsl(10, 50%, 50%); }")).toHaveLength(1);
    expect(literalsIn("a { color: white; }")).toHaveLength(1);
    expect(literalsIn("a { border: 1px solid black; }")).toHaveLength(1);
    expect(literalsIn("a { white-space: nowrap; background: rgba(var(--amber-rgb), 0.45); }")).toEqual([]);
  });

  it("keeps colour literals out of every stylesheet but tokens.css and print.css", () => {
    const sheets = Object.entries(SHEETS).filter(([name]) => name !== "./tokens.css" && name !== "./print.css");
    expect(sheets.length).toBeGreaterThan(10);
    expect(sheets.flatMap(([name, css]) => literalsIn(css).map((line) => `${name}: ${line}`))).toEqual([]);
  });

  it("declares every custom property the stylesheets and the probe read", () => {
    const sheets = { ...SHEETS, "../probe/probe.css": probeCss };
    const used = Object.entries(sheets).flatMap(([name, css]) => referenced(css).map((prop) => [name, prop]));
    expect(used.length).toBeGreaterThan(100);
    expect(used.filter(([, prop]) => !DECLARED.has(prop))).toEqual([]);
    expect(referenced("a { color: rgba(var(--nope-rgb), 0.5); }").filter((prop) => !DECLARED.has(prop))).toEqual(["--nope-rgb"]);
  });

  it("inverts the calendar picker icon only in a dark scheme", () => {
    const base = SHEETS["./base.css"];
    if (base === undefined) throw new Error("base.css not read");
    const rules = [...stripComments(base).matchAll(/([^{}]*::-webkit-calendar-picker-indicator[^{]*)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2].trim()]);
    expect(rules).toEqual([['html[data-scheme="dark"] ::-webkit-calendar-picker-indicator', "filter: invert(0.7);"]]);
  });
});
