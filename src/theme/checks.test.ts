import { describe, expect, it } from "vitest";
import { checks, fix, passes, type CheckId } from "./checks";
import { contrast, hslToHex, isRedish } from "./colour";
import { derive, type Seeds } from "./derive";
import { PRESETS, tokensOf } from "./presets";

const cyberdeck: Seeds = { ground: "#0A0A14", text: "#C8D3E0", accent: "#24E0FF", highlight: "#FFB000", danger: "#FF3B6B" };

const failing = (s: Seeds): CheckId[] => checks(s, derive(s)).filter((c) => !c.pass).map((c) => c.id);
const checkOf = (id: CheckId, s: Seeds) => {
  const c = checks(s, derive(s)).find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}`);
  return c;
};

const ALONE: readonly (readonly [CheckId, Seeds])[] = [
  ["dim", { ...cyberdeck, text: "#7A7A7A" }],
  ["accent", { ...cyberdeck, accent: "#333344" }],
  ["highlight", { ...cyberdeck, highlight: "#5A4A00" }],
  ["danger", { ...cyberdeck, danger: "#7A1030" }],
  ["apart-hi", { ...cyberdeck, danger: "#FF6A3D" }],
  ["apart-acc", { ...cyberdeck, accent: "#FF5CD0" }],
  ["apart-acc-hi", { ...cyberdeck, accent: "#FFE066" }],
  ["danger-red", { ...cyberdeck, danger: "#C070FF" }],
  ["only-danger-red", { ...cyberdeck, highlight: "#FF704D", danger: "#FF3399" }],
];

const WITH_OTHERS: readonly (readonly [CheckId, Seeds])[] = [
  ["text", { ...cyberdeck, text: "#0A0A14" }],
  ["only-danger-red", { ...cyberdeck, highlight: "#FF3B6B" }],
];

describe("checks", () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s passes every check", (_id, theme) => {
    const t = tokensOf(theme);
    const failed = checks(theme.seeds, t).filter((c) => !c.pass).map((c) => `${c.id} ${c.value.toFixed(2)} < ${c.need}`);
    expect(failed, `${theme.id} fails: ${failed.join(", ")}`).toEqual([]);
    expect(passes(theme.seeds, t)).toBe(true);
  });

  it("returns the 11 checks in order with their labels", () => {
    expect(checks(cyberdeck, derive(cyberdeck)).map((c) => [c.id, c.label, c.unit])).toEqual([
      ["text", "Text on background", "ratio"],
      ["dim", "Secondary text on panels", "ratio"],
      ["accent", "Accent on background", "ratio"],
      ["label", "Labels on accent", "ratio"],
      ["highlight", "Highlight on background", "ratio"],
      ["danger", "Danger on background", "ratio"],
      ["apart-hi", "Danger apart from highlight", "deg"],
      ["apart-acc", "Danger apart from accent", "deg"],
      ["apart-acc-hi", "Accent apart from highlight", "deg"],
      ["danger-red", "Danger is red", "bool"],
      ["only-danger-red", "Only danger is red", "bool"],
    ]);
  });

  it("measures accent, highlight and danger against the worst surface", () => {
    const s = { ...cyberdeck, accent: "#5C7080", highlight: "#806040", danger: "#A03050" };
    const t = derive(s);
    const worst = (c: string, on: readonly string[]): number => Math.min(...on.map((x) => contrast(c, x)));
    const surfaces = [t.void, t.panel, t["panel-2"]];
    expect(checkOf("accent", s).value).toBe(worst(s.accent, surfaces));
    expect(checkOf("highlight", s).value).toBe(worst(s.highlight, surfaces));
    expect(checkOf("danger", s).value).toBe(worst(s.danger, [...surfaces, t["danger-bg"]]));
    expect(checkOf("accent", s).value).toBeLessThan(contrast(s.accent, t.void));
  });

  it("uses 4.5 for contrast, 30 degrees for gaps and true for red", () => {
    const c = checks(cyberdeck, derive(cyberdeck));
    expect(c.filter((x) => x.unit === "ratio").every((x) => x.need === 4.5)).toBe(true);
    expect(c.filter((x) => x.unit === "deg").every((x) => x.need === 30)).toBe(true);
    expect(c.filter((x) => x.unit === "bool").every((x) => x.need === 1 && x.value === 1)).toBe(true);
  });

  it.each(ALONE)("fixes %s when it is the only failure", (id, s) => {
    expect(failing(s)).toEqual([id]);
    const fixed = fix(id, s);
    expect(fixed).not.toBeNull();
    if (fixed === null) return;
    expect(checkOf(id, fixed).pass).toBe(true);
  });

  it.each(WITH_OTHERS)("fixes %s alongside other failures", (id, s) => {
    expect(failing(s)).toContain(id);
    const fixed = fix(id, s);
    expect(fixed).not.toBeNull();
    if (fixed === null) return;
    expect(checkOf(id, fixed).pass).toBe(true);
  });

  it("cannot fail the label check, since black or white always reaches 4.58:1", () => {
    const greys = Array.from({ length: 256 }, (_, v) => `#${v.toString(16).padStart(2, "0").repeat(3).toUpperCase()}`);
    const hues = Array.from({ length: 72 }, (_, i) => i * 5).flatMap((h) => [0.25, 0.4, 0.5, 0.6, 0.75].map((l) => hslToHex([h, 1, l])));
    const grounds = ["#0A0A14", "#767676", "#FFFFFF"];
    const worstLabel = Math.min(...grounds.flatMap((ground) => [...greys, ...hues].map((accent) => checkOf("label", { ...cyberdeck, ground, accent }).value)));
    expect(worstLabel).toBeGreaterThanOrEqual(4.58);
    expect(fix("label", cyberdeck)).toEqual(cyberdeck);
  });

  it("keeps the rotated danger inside the red band despite hex rounding", () => {
    const fixed = fix("danger-red", { ...cyberdeck, danger: "#C070FF" });
    if (fixed === null) throw new Error("danger-red fix failed");
    expect(isRedish(fixed.danger)).toBe(true);
    expect(failing(fixed)).toEqual([]);
  });

  it("fixes text to at least 7:1", () => {
    const fixed = fix("text", { ...cyberdeck, text: "#0A0A14", ground: "#0A0A14" });
    expect(fixed).not.toBeNull();
    if (fixed === null) return;
    expect(contrast(fixed.text, fixed.ground)).toBeGreaterThanOrEqual(7);
    expect(checkOf("text", fixed).pass).toBe(true);
  });

  it("walks contrast fixes to the first 4.6 against the worst surface", () => {
    const fixed = fix("accent", { ...cyberdeck, accent: "#333344" });
    if (fixed === null) throw new Error("accent fix failed");
    expect(checkOf("accent", fixed).value).toBeGreaterThanOrEqual(4.6);
    expect(checkOf("accent", fixed).value).toBeLessThan(5);
  });

  it("returns null when no lightness reaches the target", () => {
    const s = { ...cyberdeck, ground: "#757575", accent: "#7A7A7A" };
    expect(checkOf("accent", s).pass).toBe(false);
    expect(fix("accent", s)).toBeNull();
  });

  it("walks the other way when the preferred direction cannot reach the target", () => {
    const s = { ...cyberdeck, ground: "#767676", accent: "#7A7A7A" };
    expect(checkOf("accent", s).pass).toBe(false);
    const fixed = fix("accent", s);
    if (fixed === null) throw new Error("accent fix failed on a mid-grey ground");
    expect(contrast(fixed.accent, "#000000")).toBeLessThan(contrast(s.accent, "#000000"));
    expect(checkOf("accent", fixed).pass).toBe(true);
  });

  it("separates danger from an accent just past hue 0", () => {
    const s = { ...cyberdeck, danger: hslToHex([345, 0.9, 0.7]), accent: hslToHex([2, 0.4, 0.72]) };
    expect(failing(s)).toEqual(["apart-acc"]);
    const fixed = fix("apart-acc", s);
    if (fixed === null) throw new Error("apart-acc fix failed");
    expect(isRedish(fixed.danger)).toBe(true);
    expect(failing(fixed)).toEqual([]);
  });

  it("returns null when a hue rotation cannot separate greys", () => {
    const s = { ...cyberdeck, accent: "#AAAAAA", highlight: "#BBBBBB" };
    expect(checkOf("apart-acc-hi", s).pass).toBe(false);
    expect(fix("apart-acc-hi", s)).toBeNull();
  });

  it("leaves other seeds alone", () => {
    const s = { ...cyberdeck, accent: "#333344" };
    const fixed = fix("accent", s);
    expect(fixed === null ? null : { ...fixed, accent: s.accent }).toEqual(s);
  });
});
