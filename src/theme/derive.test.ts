import { describe, expect, it } from "vitest";
import { contrast, isHex, mix } from "./colour";
import { derive, HEX_TOKENS, schemeOf, type Seeds } from "./derive";
import { PRESETS } from "./presets";

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
});
