import { describe, expect, it } from "vitest";
import { STEP_COLOURS, type StepColour } from "../domain/model";
import { contrast, isHex, luminance, mix, type Hex } from "./colour";
import { derive, HEX_TOKENS, schemeOf, SLOT_BASES, SLOT_RATIO, slotOf, type Seeds, type Tokens } from "./derive";
import { PRESETS, tokensOf } from "./presets";

const seedsOf = (id: string): Seeds => {
  const t = PRESETS.find((p) => p.id === id);
  if (t === undefined) throw new Error(`no preset ${id}`);
  return t.seeds;
};

describe("derive", () => {
  it("decides the scheme from ground luminance", () => {
    expect(schemeOf("#0A0A14")).toBe("dark");
    expect(schemeOf("#E9EDF3")).toBe("light");
  });

  it("finds a dim that reads on panel-2", () => {
    const t = derive(seedsOf("phosphor"));
    expect(contrast(t.dim, t["panel-2"])).toBeGreaterThanOrEqual(4.6);
  });

  it("lifts light panels toward white", () => {
    const s = seedsOf("daylight");
    const t = derive(s);
    expect(t.panel).toBe(mix(s.ground, "#FFFFFF", 0.7));
    expect(t["panel-2"]).toBe(mix(s.ground, s.text, 0.05));
    expect(t.line).toBe(mix(s.ground, s.text, 0.15));
    expect(t.heading).toBe(mix(s.text, "#000000", 0.6));
    expect(t["danger-bg"]).toBe(mix(s.ground, s.danger, 0.09));
    expect(t.hover).toBe("rgba(0, 109, 134, 0.08)");
    expect(t.active).toBe("rgba(145, 86, 0, 0.12)");
    expect(t.scrim).toBe("rgba(27, 35, 50, 0.35)");
    expect(t.scheme).toBe("light");
  });

  it("maps dark seeds by the §3 table", () => {
    const s = seedsOf("blueprint");
    const t = derive(s);
    expect(t.void).toBe(s.ground);
    expect(t.panel).toBe(mix(s.ground, s.text, 0.04));
    expect(t["panel-2"]).toBe(mix(s.ground, s.text, 0.08));
    expect(t.line).toBe(mix(s.ground, s.text, 0.16));
    expect(t.cyan).toBe(s.accent);
    expect(t["cyan-dim"]).toBe(mix(s.accent, s.ground, 0.42));
    expect(t.amber).toBe(s.highlight);
    expect(t.magenta).toBe(s.danger);
    expect(t.text).toBe(s.text);
    expect(t["dot-idle"]).toBe(mix(s.ground, s.text, 0.28));
    expect(t.heading).toBe(mix(s.text, "#FFFFFF", 0.6));
    expect(t["danger-bg"]).toBe(mix(s.ground, s.danger, 0.13));
    expect(t.hover).toBe("rgba(124, 196, 255, 0.06)");
    expect(t.active).toBe("rgba(255, 209, 102, 0.08)");
    expect(t.scrim).toBe(`rgba(${[0x0b, 0x16, 0x30].map((v) => Math.round(v * 0.4)).join(", ")}, 0.72)`);
    expect(t.scheme).toBe("dark");
  });

  it("picks the largest dim mix that reaches 4.6", () => {
    const s = seedsOf("graphite");
    const t = derive(s);
    const steps = Array.from({ length: 56 }, (_, i) => (60 - i) / 100);
    const want = steps.find((x) => contrast(mix(s.text, s.ground, x), t["panel-2"]) >= 4.6);
    expect(want).toBeDefined();
    expect(t.dim).toBe(mix(s.text, s.ground, want ?? 0));
  });

  it("chooses the label colour with the most contrast", () => {
    expect(derive(seedsOf("paper"))["on-accent"]).toBe("#FFFFFF");
    expect(derive(seedsOf("cyberdeck"))["on-accent"]).toBe("#000000");
  });

  it("lists the 14 hex tokens and they are all hex", () => {
    expect(HEX_TOKENS).toHaveLength(14);
    PRESETS.forEach((p) => {
      const t = derive(p.seeds);
      expect(HEX_TOKENS.filter((k) => !isHex(t[k]))).toEqual([]);
    });
  });

  it("derives slots that reach 4.5 on void, panel and panel-2 in every preset", () => {
    const slot = (t: Tokens, c: StepColour): Hex => {
      switch (c) {
        case "cyan":
          return t.cyan;
        case "magenta":
          return t.magenta;
        case "amber":
          return t.amber;
        case "slate":
          return t.dim;
        case "violet":
          return t["s-violet"];
        case "lime":
          return t["s-lime"];
        case "coral":
          return t["s-coral"];
        case "sky":
          return t["s-sky"];
      }
    };
    expect(STEP_COLOURS).toHaveLength(8);
    const short = PRESETS.flatMap((p) => {
      const t = tokensOf(p);
      return STEP_COLOURS.flatMap((c) =>
        [t.void, t.panel, t["panel-2"]].filter((on) => contrast(slot(t, c), on) < 4.5).map((on) => `${p.id} ${c} ${slot(t, c)} on ${on}: ${contrast(slot(t, c), on).toFixed(2)}`),
      );
    });
    expect(short).toEqual([]);
  });

  it("keeps every person slot at 4.5 on void, panel and panel-2 whenever the text and dim checks pass, the text fallback included", () => {
    const greys = Array.from({ length: 52 }, (_, i) => Math.min(255, i * 5).toString(16).padStart(2, "0").toUpperCase()).map((v): Hex => `#${v}${v}${v}`);
    const tints: readonly Hex[] = ["#0A0A14", "#14100A", "#0B1630", "#F4EFE6", "#E9EDF3", "#FFF8E0", "#6E6E6E", "#7A6A8A", "#8A8A6A", "#9A9A9A", "#5A5A5A"];
    const grounds = [...greys, ...tints];
    const texts = [...greys, ...tints];
    const pairs = grounds.flatMap((ground) => texts.map((text): Seeds => ({ ground, text, accent: "#24E0FF", highlight: "#FFB020", danger: "#FF3D6E" })));
    const governed = pairs.map((s) => ({ s, t: derive(s) })).filter(({ s, t }) => contrast(s.text, s.ground) >= 4.5 && contrast(t.dim, t["panel-2"]) >= 4.5);
    expect(governed.length).toBeGreaterThan(50);
    const textShort = governed.filter(({ s, t }) => {
      return [t.void, t.panel, t["panel-2"]].some((on) => contrast(s.text, on) < 4.5);
    });
    expect(textShort).toEqual([]);
    const short = governed.flatMap(({ s, t }) => {
      return (["s-violet", "s-lime", "s-coral", "s-sky"] as const).flatMap((k) =>
        [t.void, t.panel, t["panel-2"]].filter((on) => contrast(t[k], on) < 4.5).map((on) => `${s.ground}/${s.text} ${k} ${t[k]} on ${on}: ${contrast(t[k], on).toFixed(2)}`),
      );
    });
    expect(short).toEqual([]);
  });

  it("keeps Cyberdeck's four slots at their bases", () => {
    const t = tokensOf(PRESETS.filter((p) => p.id === "cyberdeck")[0]);
    expect({ "s-violet": t["s-violet"], "s-lime": t["s-lime"], "s-coral": t["s-coral"], "s-sky": t["s-sky"] }).toEqual(SLOT_BASES);
    expect(SLOT_BASES).toEqual({ "s-violet": "#A98BFF", "s-lime": "#9BE84A", "s-coral": "#FF7D5C", "s-sky": "#5CA8FF" });
    expect(SLOT_RATIO).toBe(4.6);
  });

  it("darkens lime on a light ground toward the text, at the first step that reaches the ratio", () => {
    const s = seedsOf("daylight");
    const t = derive(s);
    expect(luminance(t["s-lime"])).toBeLessThan(luminance(SLOT_BASES["s-lime"]));
    const on = [t.void, t.panel, t["panel-2"]];
    const worst = (c: Hex): number => Math.min(...on.map((x) => contrast(c, x)));
    const k = Array.from({ length: 40 }, (_, i) => i + 1).find((n) => worst(mix(SLOT_BASES["s-lime"], s.text, n / 40)) >= SLOT_RATIO);
    expect(k).toBeDefined();
    expect(t["s-lime"]).toBe(mix(SLOT_BASES["s-lime"], s.text, (k ?? 0) / 40));
  });

  it("returns the base when it already reads, and the text when no mix reaches the ratio", () => {
    expect(slotOf("#A98BFF", "#C8D3E0", ["#0A0A14"])).toBe("#A98BFF");
    expect(slotOf("#9BE84A", "#A0E050", ["#9BE84A"])).toBe("#A0E050");
  });
});
