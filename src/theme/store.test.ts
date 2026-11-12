import { beforeEach, describe, expect, it } from "vitest";
import type { Seeds } from "./derive";
import {
  DEFAULT_STORE,
  MAX_MINE,
  THEME_KEY,
  allThemes,
  loadStore,
  nextMineId,
  parseStore,
  saveStore,
  shownTheme,
  themeById,
  withChosen,
  withMode,
  withRemoved,
  withSaved,
  withSlot,
  type ThemeStore,
} from "./store";
import { PRESETS } from "./presets";

const DARK_SEEDS: Seeds = { ground: "#0B1630", text: "#C9D6EA", accent: "#7CC4FF", highlight: "#FFD166", danger: "#FF6B88" };
const LIGHT_SEEDS: Seeds = { ground: "#FFFFFF", text: "#111418", accent: "#1F5FD1", highlight: "#A35400", danger: "#CC1F3D" };
const FAILING_SEEDS: Seeds = { ground: "#0A0A14", text: "#15151F", accent: "#24E0FF", highlight: "#FFB000", danger: "#FF3B6B" };

const raw = (over: Record<string, unknown>): string =>
  JSON.stringify({ v: 1, mode: "fixed", active: "cyberdeck", dark: "cyberdeck", light: "daylight", mine: [], ...over });

const mineEntry = (n: number, name: string, seeds: Seeds = DARK_SEEDS): { id: string; name: string; seeds: Seeds } => ({ id: `mine-${n}`, name, seeds });

const withMine = (...entries: { id: string; name: string; seeds: Seeds }[]): ThemeStore => {
  const parsed = parseStore(raw({ mine: entries }));
  if (parsed === null) throw new Error("fixture did not parse");
  return parsed;
};

describe("theme store", () => {
  beforeEach(() => window.localStorage.removeItem(THEME_KEY));

  it("round-trips through storage", () => {
    const s = withSaved(withMode(DEFAULT_STORE, "system"), "Night", DARK_SEEDS, null).store;
    saveStore(window.localStorage, s);
    const back = loadStore(window.localStorage);
    expect(back.unreadable).toBe(false);
    expect(back.store).toEqual(s);
    expect(JSON.parse(window.localStorage.getItem(THEME_KEY) ?? "")).toEqual({
      v: 1,
      mode: "system",
      active: "cyberdeck",
      dark: "cyberdeck",
      light: "daylight",
      mine: [{ id: "mine-1", name: "Night", seeds: DARK_SEEDS }],
    });
  });

  it("a missing key gives the defaults and is not unreadable", () => {
    expect(loadStore(window.localStorage)).toEqual({ store: DEFAULT_STORE, unreadable: false });
    expect(DEFAULT_STORE).toEqual({ v: 1, mode: "fixed", active: "cyberdeck", dark: "cyberdeck", light: "daylight", mine: [] });
  });

  const invalid: readonly [string, string][] = [
    ["not JSON", "{nope"],
    ["v 2", raw({ v: 2 })],
    ["unknown mode", raw({ mode: "auto" })],
    ["unknown active id", raw({ active: "mine-9" })],
    ["light theme in the dark slot", raw({ dark: "daylight" })],
    ["dark theme in the light slot", raw({ light: "phosphor" })],
    ["short hex seed", raw({ mine: [{ ...mineEntry(1, "A"), seeds: { ...DARK_SEEDS, text: "#fff" } }] })],
    ["empty name", raw({ mine: [mineEntry(1, "")] })],
    ["41-char name", raw({ mine: [mineEntry(1, "x".repeat(41))] })],
    ["duplicate names differing in case", raw({ mine: [mineEntry(1, "Night"), mineEntry(2, "NIGHT")] })],
    ["25 mine entries", raw({ mine: Array.from({ length: 25 }, (_, i) => mineEntry(i + 1, `T${i}`)) })],
    ["mine id not mine-<n>", raw({ mine: [{ ...mineEntry(1, "A"), id: "custom" }] })],
    ["array instead of object", "[]"],
    ["missing seeds", raw({ mine: [{ id: "mine-1", name: "A" }] })],
  ];

  it.each(invalid)("%s → parseStore null and loadStore unreadable with defaults", (_, value) => {
    expect(parseStore(value)).toBeNull();
    window.localStorage.setItem(THEME_KEY, value);
    expect(loadStore(window.localStorage)).toEqual({ store: DEFAULT_STORE, unreadable: true });
  });

  it("parses a saved theme whose seeds are valid hex but fail today's checks", () => {
    const s = parseStore(raw({ mine: [mineEntry(1, "Old", FAILING_SEEDS)], active: "mine-1", dark: "mine-1" }));
    expect(s?.active).toBe("mine-1");
    expect(s?.mine[0]).toEqual({ id: "mine-1", name: "Old", note: "Yours", group: "mine", seeds: FAILING_SEEDS });
  });

  it("lists presets then saved themes and finds by id", () => {
    const s = withMine(mineEntry(3, "Night"));
    expect(allThemes(s).map((t) => t.id)).toEqual([...PRESETS.map((t) => t.id), "mine-3"]);
    expect(themeById(s, "mine-3").name).toBe("Night");
    expect(() => themeById(s, "mine-4")).toThrow("No theme mine-4");
    expect(nextMineId(s)).toBe("mine-4");
    expect(nextMineId(DEFAULT_STORE)).toBe("mine-1");
  });

  it("shows the active theme when fixed and the OS slot when following the system", () => {
    const s: ThemeStore = { ...DEFAULT_STORE, active: "paper", dark: "phosphor", light: "daylight" };
    expect(shownTheme(s, true).id).toBe("paper");
    expect(shownTheme({ ...s, mode: "system" }, true).id).toBe("phosphor");
    expect(shownTheme({ ...s, mode: "system" }, false).id).toBe("daylight");
  });

  it("removing the active saved theme falls back to cyberdeck", () => {
    const s = { ...withMine(mineEntry(1, "Night")), active: "mine-1", dark: "mine-1" };
    const next = withRemoved(s, "mine-1");
    expect(next.active).toBe("cyberdeck");
    expect(next.dark).toBe("cyberdeck");
    expect(next.mine).toEqual([]);
  });

  it("removing a saved theme in the light slot falls back to daylight", () => {
    const s = { ...withMine(mineEntry(1, "Day", LIGHT_SEEDS)), light: "mine-1" };
    const next = withRemoved(s, "mine-1");
    expect(next.light).toBe("daylight");
    expect(next.active).toBe("cyberdeck");
  });

  it("refuses to remove a built-in theme", () => {
    expect(() => withRemoved(DEFAULT_STORE, "paper")).toThrow("No saved theme paper");
  });

  it("withSaved adds and replaces", () => {
    const added = withSaved(DEFAULT_STORE, "  Night  ", DARK_SEEDS, null);
    expect(added.id).toBe("mine-1");
    expect(added.store.mine).toEqual([{ id: "mine-1", name: "Night", note: "Yours", group: "mine", seeds: DARK_SEEDS }]);
    const replaced = withSaved(added.store, "Night", LIGHT_SEEDS, "mine-1");
    expect(replaced.id).toBe("mine-1");
    expect(replaced.store.mine).toHaveLength(1);
    expect(replaced.store.mine[0].seeds).toEqual(LIGHT_SEEDS);
  });

  it("withSaved moves a replaced theme out of a slot whose scheme it no longer has", () => {
    const s = { ...withSaved(DEFAULT_STORE, "Night", DARK_SEEDS, null).store, dark: "mine-1" };
    expect(withSaved(s, "Night", LIGHT_SEEDS, "mine-1").store.dark).toBe("cyberdeck");
  });

  it("withSaved errors with the exact messages", () => {
    const one = withSaved(DEFAULT_STORE, "Night", DARK_SEEDS, null).store;
    expect(() => withSaved(DEFAULT_STORE, "   ", DARK_SEEDS, null)).toThrow("Name the theme first.");
    expect(() => withSaved(DEFAULT_STORE, "x".repeat(41), DARK_SEEDS, null)).toThrow("Use at most 40 characters.");
    expect(() => withSaved(one, "night", DARK_SEEDS, null)).toThrow("You already have a theme called night.");
    expect(withSaved(one, "night", DARK_SEEDS, "mine-1").store.mine[0].name).toBe("night");
    const full = Array.from({ length: MAX_MINE }, (_, i) => i).reduce((s, i) => withSaved(s, `T${i}`, DARK_SEEDS, null).store, DEFAULT_STORE);
    expect(() => withSaved(full, "More", DARK_SEEDS, null)).toThrow("You can keep 24 themes; delete one first.");
    expect(() => withSaved(DEFAULT_STORE, "Bad", FAILING_SEEDS, null)).toThrow("Fix the failing checks before saving.");
    expect(() => withSaved(DEFAULT_STORE, "Bad", DARK_SEEDS, "paper")).toThrow("No saved theme paper");
  });

  it("withChosen in fixed mode sets active", () => {
    expect(withChosen(DEFAULT_STORE, "phosphor").active).toBe("phosphor");
    expect(() => withChosen(DEFAULT_STORE, "nope")).toThrow("No theme nope");
  });

  it("withChosen in system mode with a light theme sets the light slot and keeps active", () => {
    const next = withChosen({ ...DEFAULT_STORE, mode: "system" }, "paper");
    expect(next.light).toBe("paper");
    expect(next.active).toBe("cyberdeck");
    expect(next.dark).toBe("cyberdeck");
  });

  it("withMode(system) from active paper puts paper in the light slot", () => {
    const next = withMode({ ...DEFAULT_STORE, active: "paper" }, "system");
    expect(next.mode).toBe("system");
    expect(next.light).toBe("paper");
    expect(next.dark).toBe("cyberdeck");
    expect(withMode(next, "fixed").mode).toBe("fixed");
  });

  it("withSlot checks the scheme", () => {
    expect(withSlot(DEFAULT_STORE, "dark", "phosphor").dark).toBe("phosphor");
    expect(withSlot(DEFAULT_STORE, "light", "paper").light).toBe("paper");
    expect(() => withSlot(DEFAULT_STORE, "dark", "paper")).toThrow("Paper is not a dark theme.");
  });
});
