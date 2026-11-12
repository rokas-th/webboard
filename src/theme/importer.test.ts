import { describe, expect, it } from "vitest";
import { checks, passes } from "./checks";
import { derive, type Scheme, type Seeds } from "./derive";
import { assignRoles, fixAll, medianCut, outOfRange, parseColours, pixelsOf, unfixedNotes } from "./importer";

const SUNSET = ["#FFEABA", "#FED3A4", "#FEC759", "#FEB484", "#FF96A6", "#F58A65"];
const GREYS = ["#000000", "#FFFFFF", "#808080"];
const SCHEMES: readonly Scheme[] = ["dark", "light"];

const failing = (s: Seeds): string[] => checks(s, derive(s)).filter((c) => !c.pass).map((c) => c.id);
const values = (s: Seeds): string[] => [s.ground, s.text, s.accent, s.highlight, s.danger];

describe("parseColours", () => {
  it("reads hex in any case, uppercased, in order", () => {
    expect(parseColours("#1b2b4a, #F2C14E")).toEqual(["#1B2B4A", "#F2C14E"]);
  });

  it("expands three-digit hex", () => {
    expect(parseColours("#abc")).toEqual(["#AABBCC"]);
  });

  it("reads rgb and rgba with spaces or commas", () => {
    expect(parseColours("rgb(255 0 0) rgba(0, 128, 255, .5)")).toEqual(["#FF0000", "#0080FF"]);
  });

  it("reads a colorfetcher CSS export and drops duplicates", () => {
    expect(parseColours(":root { --color-1: #FFEABA; --color-2: #FED3A4; --color-1b: #ffeaba; }")).toEqual(["#FFEABA", "#FED3A4"]);
  });

  it("keeps the order of first appearance across hex and rgb", () => {
    expect(parseColours("rgb(1, 2, 3) #FFFFFF rgb(1 2 3) #fff")).toEqual(["#010203", "#FFFFFF"]);
  });

  it("drops the alpha of #RRGGBBAA and #RGBA", () => {
    expect(parseColours("#1B2B4A80 #abcd")).toEqual(["#1B2B4A", "#AABBCC"]);
  });

  it("skips rgb with a channel above 255 and names it", () => {
    expect(parseColours("rgb(300, 0, 0) rgb(255, 0, 0)")).toEqual(["#FF0000"]);
    expect(outOfRange("rgb(300, 0, 0) rgb(255, 0, 0)")).toEqual(["rgb(300, 0, 0)"]);
    expect(outOfRange("#FF0000 rgb(1, 2, 3)")).toEqual([]);
  });

  it("finds nothing in plain text or a five-digit hex", () => {
    expect(parseColours("no colours here")).toEqual([]);
    expect(parseColours("#12345")).toEqual([]);
  });
});

describe("pixelsOf", () => {
  it("skips pixels with alpha below 128", () => {
    expect(pixelsOf(new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 255, 1, 2, 3, 127, 4, 5, 6, 128]))).toEqual([
      [40, 50, 60],
      [4, 5, 6],
    ]);
  });
});

describe("medianCut", () => {
  it("separates two clusters", () => {
    const pixels = [...Array.from({ length: 100 }, () => [255, 0, 0] as const), ...Array.from({ length: 100 }, () => [0, 0, 255] as const)];
    expect([...medianCut(pixels, 2)].sort()).toEqual(["#0000FF", "#FF0000"]);
  });

  it("puts the largest box first", () => {
    const pixels = [...Array.from({ length: 30 }, () => [0, 255, 0] as const), ...Array.from({ length: 170 }, () => [0, 0, 255] as const)];
    expect(medianCut(pixels, 2)[0]).toBe("#0000FF");
  });

  it("returns nothing for no pixels", () => {
    expect(medianCut([], 8)).toEqual([]);
  });

  it("returns one colour for one pixel", () => {
    expect(medianCut([[12, 34, 56]], 8)).toEqual(["#0C2238"]);
  });

  it("never returns more than n colours", () => {
    const pixels = Array.from({ length: 4096 }, (_, i) => [i % 256, (i * 7) % 256, (i * 13) % 256] as const);
    expect(medianCut(pixels, 8).length).toBeLessThanOrEqual(8);
  });
});

describe("assignRoles", () => {
  it.each(SCHEMES)("turns the Sunset palette into a passing %s theme", (scheme) => {
    const { seeds } = assignRoles(SUNSET, scheme);
    expect(failing(seeds), JSON.stringify(seeds)).toEqual([]);
    expect(passes(seeds, derive(seeds))).toBe(true);
    expect(derive(seeds).scheme).toBe(scheme);
  });

  it.each(SCHEMES)("turns all greys into a passing %s theme with notes", (scheme) => {
    const { seeds, notes } = assignRoles(GREYS, scheme);
    expect(failing(seeds), JSON.stringify(seeds)).toEqual([]);
    expect(notes).toContain("No red in the palette, so danger keeps WebBoard's own.");
    expect(notes).toContain("The palette has no second hue, so the highlight is the accent's opposite.");
  });

  it("never makes a grey the accent", () => {
    expect(assignRoles(GREYS, "dark").seeds.accent).toBe("#24E0FF");
    expect(assignRoles(["#000000", "#FFFFFF", "#7F7F80", "#2E9CDB"], "dark").seeds.accent).toBe("#2E9CDB");
  });

  it("notes a ground that had to be darkened", () => {
    const { seeds, notes } = assignRoles(SUNSET, "dark");
    expect(seeds.ground).not.toBe("#F58A65");
    expect(notes).toContain("Darkened #F58A65 into the background so text stays readable.");
  });

  it("notes a ground that had to be lightened", () => {
    const { notes } = assignRoles(["#1B2B4A", "#F2C14E", "#3E8FB0"], "light");
    expect(notes).toContain("Lightened #F2C14E into the background so text stays readable.");
  });

  it("notes an adjusted role in the exact wording", () => {
    const { notes } = assignRoles(SUNSET, "light");
    const adjusted = notes.filter((n) => n.startsWith("Adjusted "));
    expect(adjusted.length).toBeGreaterThan(0);
    adjusted.forEach((n) => expect(n).toMatch(/^Adjusted (accent|highlight|danger) from #[0-9A-F]{6} to #[0-9A-F]{6} to keep it readable and distinct\.$/));
  });

  it("fixes secondary text when text passes but dim does not", () => {
    const start: Seeds = { ground: "#000000", text: "#777777", accent: "#24E0FF", highlight: "#FFB000", danger: "#FF3B6B" };
    expect(failing(start)).toEqual(["dim"]);
    expect(failing(fixAll(start))).toEqual([]);
  });

  it("names every check it could not fix", () => {
    const stuck: Seeds = { ground: "#808080", text: "#808080", accent: "#808080", highlight: "#808080", danger: "#808080" };
    const labels = checks(stuck, derive(stuck)).filter((c) => !c.pass).map((c) => c.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(unfixedNotes(stuck)).toEqual(labels.map((l) => `Could not fix ${l} automatically; change the colour by hand.`));
    expect(assignRoles(SUNSET, "dark").notes.filter((n) => n.startsWith("Could not fix"))).toEqual([]);
  });

  it("uses a red from the palette as danger", () => {
    const { seeds, notes } = assignRoles(["#0B0B12", "#E8E8F0", "#E0182E", "#2E9CDB"], "dark");
    expect(notes).not.toContain("No red in the palette, so danger keeps WebBoard's own.");
    expect(failing(seeds)).toEqual([]);
  });

  it("throws for fewer than three colours", () => {
    expect(() => assignRoles(["#FF0000", "#00FF00"], "dark")).toThrow("assignRoles needs at least three colours");
  });

  it("counts repeated colours once", () => {
    expect(() => assignRoles(["#FF0000", "#FF0000", "#00FF00"], "dark")).toThrow("assignRoles needs at least three colours");
  });

  it.each([
    ["sunset", SUNSET],
    ["greys", GREYS],
    ["one hue", ["#001020", "#004080", "#0080FF", "#80C0FF"]],
    ["near blacks", ["#000000", "#010101", "#020202"]],
    ["near whites", ["#FFFFFF", "#FEFEFE", "#FDFDFD"]],
  ])("never yields NaN for %s", (_, colours) => {
    SCHEMES.forEach((scheme) => {
      const { seeds } = assignRoles(colours, scheme);
      values(seeds).forEach((v) => {
        expect(v).not.toContain("NaN");
        expect(v).toMatch(/^#[0-9A-F]{6}$/);
      });
    });
  });

  it.each(SCHEMES)("one-hue palette gives a passing %s theme", (scheme) => {
    const { seeds } = assignRoles(["#001020", "#004080", "#0080FF", "#80C0FF"], scheme);
    expect(failing(seeds), JSON.stringify(seeds)).toEqual([]);
  });
});
