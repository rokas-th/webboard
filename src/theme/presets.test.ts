import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, DEFAULT_ID, DEFAULT_LIGHT, PRESETS, tokensOf, type Group } from "./presets";
import { derive, schemeOf } from "./derive";

const TABLE: readonly (readonly [string, string, "dark" | "light", string])[] = [
  ["cyberdeck", "Cyberdeck", "dark", "#0A0A14 #C8D3E0 #24E0FF #FFB000 #FF3B6B"],
  ["phosphor", "Phosphor", "dark", "#060C09 #B9D6C3 #3DFF8F #E4E75C #FF6A4D"],
  ["blueprint", "Blueprint", "dark", "#0B1630 #C9D6EA #7CC4FF #FFD166 #FF6B88"],
  ["tungsten", "Tungsten", "dark", "#110D0B #DDD0C5 #F2A65A #7FD6C8 #FF4F6E"],
  ["graphite", "Graphite", "dark", "#141517 #CED2D7 #9FB7CF #E2B44A #F25C5C"],
  ["daylight", "Daylight", "light", "#E9EDF3 #1B2332 #006D86 #915600 #BC1646"],
  ["paper", "Paper", "light", "#FFFFFF #111418 #1F5FD1 #A35400 #CC1F3D"],
  ["fetcher-dark", "ColorFetcher", "dark", "#161513 #FAF6F0 #3DD1A8 #FFB13D #FF4A77"],
  ["fetcher-light", "ColorFetcher", "light", "#FAF6F0 #1A1A1A #005FEB #985B00 #CC0034"],
  ["sunset-dark", "Sunset", "dark", "#292214 #FFEABA #FEC759 #BACFFF #FF96A6"],
  ["sunset-light", "Sunset", "light", "#F8F6F2 #242119 #8F5F01 #0D57FF #CC001F"],
  ["ocean-dark", "Ocean", "dark", "#142629 #C9ECE6 #30C9DD #DDD19A #DD9AA6"],
  ["ocean-light", "Ocean", "light", "#F2F8F7 #192324 #057485 #786928 #B43C52"],
  ["botanical-dark", "Botanical", "dark", "#252617 #FFD9CC #4BB073 #F67B2E #FF6A8E"],
  ["botanical-light", "Botanical", "light", "#FFD9CC #241C19 #9C4007 #2C6844 #B01441"],
];

const NOTES: Record<string, string> = {
  cyberdeck: "Default",
  phosphor: "Green terminal",
  blueprint: "Navy, sky accent",
  tungsten: "Warm, little blue",
  graphite: "Quiet, almost grey",
  daylight: "Cyberdeck in light",
  paper: "White, high contrast",
  "fetcher-dark": "The site's own colours",
  "fetcher-light": "The site's own colours",
  "sunset-dark": "From the sample image",
  "sunset-light": "From the sample image",
  "ocean-dark": "From the sample image",
  "ocean-light": "From the sample image",
  "botanical-dark": "From the sample image",
  "botanical-light": "From the sample image",
};

const byId = (id: string) => {
  const t = PRESETS.find((p) => p.id === id);
  if (t === undefined) throw new Error(`no preset ${id}`);
  return t;
};

describe("presets", () => {
  it("has 15 themes with unique ids in §4 order", () => {
    expect(PRESETS).toHaveLength(15);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(15);
    expect(PRESETS.map((p) => p.id)).toEqual(TABLE.map(([id]) => id));
  });

  it.each(TABLE)("%s has the §4 name, scheme and seeds", (id, name, scheme, seeds) => {
    const t = byId(id);
    const [ground, text, accent, highlight, danger] = seeds.split(" ");
    expect(t.name).toBe(name);
    expect(t.seeds).toEqual({ ground, text, accent, highlight, danger });
    expect(schemeOf(t.seeds.ground)).toBe(scheme);
    expect(tokensOf(t).scheme).toBe(scheme);
  });

  it("groups 7 webboard and 8 colorfetcher themes", () => {
    const count = (g: Group): number => PRESETS.filter((p) => p.group === g).length;
    expect(count("webboard")).toBe(7);
    expect(count("colorfetcher")).toBe(8);
    expect(count("mine")).toBe(0);
    expect(PRESETS.slice(0, 7).every((p) => p.group === "webboard")).toBe(true);
  });

  it("carries the notes", () => {
    expect(Object.fromEntries(PRESETS.map((p) => [p.id, p.note]))).toEqual(NOTES);
  });

  it("names the defaults", () => {
    expect(DEFAULT_ID).toBe("cyberdeck");
    expect(DEFAULT_DARK).toBe("cyberdeck");
    expect(DEFAULT_LIGHT).toBe("daylight");
    expect(schemeOf(byId(DEFAULT_LIGHT).seeds.ground)).toBe("light");
  });

  it("keeps Cyberdeck's computed colours exactly", () => {
    expect(tokensOf(byId("cyberdeck"))).toEqual({
      void: "#0A0A14",
      panel: "#10101E",
      "panel-2": "#16162A",
      line: "#23233D",
      cyan: "#24E0FF",
      "cyan-dim": "#158CA6",
      amber: "#FFB000",
      magenta: "#FF3B6B",
      text: "#C8D3E0",
      dim: "#7485A0",
      "dot-idle": "#3A4258",
      heading: "#EAF3FF",
      "danger-bg": "#2A0F1A",
      "on-accent": "#000000",
      hover: "rgba(36, 224, 255, 0.06)",
      active: "rgba(255, 176, 0, 0.08)",
      scrim: "rgba(4, 4, 10, 0.72)",
      scheme: "dark",
    });
  });

  it("derives every other preset without overrides", () => {
    PRESETS.filter((p) => p.id !== "cyberdeck").forEach((p) => {
      expect(p.exact).toBeUndefined();
      expect(tokensOf(p)).toEqual(derive(p.seeds));
    });
  });
});
