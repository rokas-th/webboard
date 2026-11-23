import { describe, expect, it } from "vitest";
import { IPAD, IPHONE, LINUX, MAC } from "../../test/platform";
import type { SettingsSection } from "../state";
import { filterSections, isPlanSection, sectionTitle, SETTINGS_SECTIONS, shownSections } from "./sections";

const ALL: readonly SettingsSection[] = ["general", "theme", "sync", "files", "overview", "people", "workflow", "working-time", "defaults", "baselines", "danger"];

const labels = (id: SettingsSection, hasUpdates: boolean): string[] => {
  const found = shownSections(true, hasUpdates, MAC).find((s) => s.id === id);
  if (found === undefined) throw new Error(`no ${id} section`);
  return found.rows.map((r) => r.label);
};

describe("the settings sections", () => {
  it("titles every section as the sidebar names it", () => {
    expect(ALL.map(sectionTitle)).toEqual(["General", "Theme", "Sync", "Import & export", "Overview", "People", "Workflow", "Working time", "Defaults", "Baselines", "Danger zone"]);
  });

  it("lists the app sections in order with their rows, Updates only with an updater", () => {
    expect(shownSections(false, false, MAC).map((s) => s.id)).toEqual(["general", "theme", "sync", "files"]);
    expect(labels("general", false)).toEqual(["Default tab", "Week starts on", "Date format", "This is me", "Device name", "About"]);
    expect(labels("general", true)).toEqual(["Default tab", "Week starts on", "Date format", "This is me", "Device name", "Updates", "About"]);
    expect(labels("theme", false)).toEqual(["Themes", "Follow the system", "Colours", "Import colours", "Readability", "Save theme", "Density", "Text size", "Reduce glow"]);
    expect(labels("sync", false)).toEqual(["Status", "Set up sync", "Join with a code", "Add a device", "Devices"]);
    expect(labels("files", false)).toEqual(["Import", "Export", "Calendar (ICS)", "Back up all plans"]);
  });

  it("lists the plan sections after the app ones, with their rows", () => {
    expect(shownSections(true, false, MAC).map((s) => s.id)).toEqual(["general", "theme", "sync", "files", "overview", "people", "workflow", "working-time", "defaults", "baselines", "danger"]);
    expect(labels("overview", false)).toEqual(["Name"]);
    expect(labels("people", false)).toEqual(["People", "Add person"]);
    expect(labels("workflow", false)).toEqual(["Steps", "Add step", "New items"]);
    expect(labels("working-time", false)).toEqual(["Region", "Working days", "Closures", "Days off and holidays"]);
    expect(labels("defaults", false)).toEqual(["New task duration", "New items are", "Default assignee", "Board + puts items in", "Step for new undated items"]);
    expect(labels("baselines", false)).toEqual(["Baselines"]);
    expect(labels("danger", false)).toEqual(["Move to Trash", "Delete forever"]);
  });

  it("anchors every row but the Theme ones", () => {
    const rows = shownSections(true, true, MAC).flatMap((s) => s.rows.map((r) => [s.id, r.id, r.anchor] as const));
    expect(rows.filter(([, , anchor]) => !anchor)).toEqual([
      ["theme", "themes", false],
      ["theme", "follow", false],
      ["theme", "colours", false],
      ["theme", "import", false],
      ["theme", "readability", false],
      ["theme", "save", false],
    ]);
  });

  it("drops the Theme rows each platform caps away: Density and Text size on iOS", () => {
    const themeRows = (platform: typeof MAC): string[] => {
      const theme = shownSections(false, false, platform).find((s) => s.id === "theme");
      if (theme === undefined) throw new Error("no theme section");
      return theme.rows.filter((r) => r.anchor).map((r) => r.id);
    };
    expect([themeRows(MAC), themeRows(LINUX), themeRows(IPAD), themeRows(IPHONE)]).toEqual([
      ["density", "text-size", "glow"],
      ["density", "text-size", "glow"],
      ["glow"],
      ["glow"],
    ]);
  });

  it("drops Default tab on the iPhone only, which always opens on its List", () => {
    const generalRows = (platform: typeof MAC): string[] => {
      const general = shownSections(false, true, platform).find((s) => s.id === "general");
      if (general === undefined) throw new Error("no general section");
      return general.rows.map((r) => r.id);
    };
    expect([generalRows(MAC), generalRows(LINUX), generalRows(IPAD), generalRows(IPHONE)]).toEqual([
      ["tab", "week", "dates", "me", "device", "updates", "about"],
      ["tab", "week", "dates", "me", "device", "updates", "about"],
      ["tab", "week", "dates", "me", "device", "updates", "about"],
      ["week", "dates", "me", "device", "updates", "about"],
    ]);
    expect(filterSections(shownSections(false, true, IPHONE), "launch")).toEqual([]);
  });

  it("finds the Look rows by label on every platform that shows them", () => {
    const ids = (platform: typeof MAC, q: string): string[] => filterSections(shownSections(false, false, platform), q).flatMap((m) => m.rows.map((r) => r.id));
    expect([ids(MAC, "density"), ids(MAC, "text size"), ids(MAC, "glow"), ids(IPAD, "density"), ids(IPHONE, "text size"), ids(IPHONE, "glow")]).toEqual([["density"], ["text-size"], ["glow"], [], [], ["glow"]]);
  });

  it("plan sections need a plan", () => {
    expect(ALL.filter(isPlanSection)).toEqual(["overview", "people", "workflow", "working-time", "defaults", "baselines", "danger"]);
    expect(shownSections(false, true, MAC).filter((s) => s.plan)).toEqual([]);
    expect(shownSections(true, true, MAC).map((s) => s.id)).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(SETTINGS_SECTIONS.every((s) => s.plan === isPlanSection(s.id))).toBe(true);
  });

  it("finds the General rows by their search terms", () => {
    const list = shownSections(false, true, MAC);
    const rowsFor = (q: string): (string | boolean)[][] => filterSections(list, q).map((m) => [m.section.id, m.byTitle, ...m.rows.map((r) => r.id)]);
    expect([rowsFor("launch"), rowsFor("start"), rowsFor("monday"), rowsFor("SUNDAY"), rowsFor("iso")]).toEqual([
      [["general", false, "tab"]],
      [["general", false, "tab", "week"]],
      [["general", false, "week"]],
      [["general", false, "week"]],
      [["general", false, "dates"]],
    ]);
    expect(rowsFor("date")).toEqual([["general", false, "dates", "updates"]]);
    expect([rowsFor("mine"), rowsFor("person"), rowsFor("This is"), rowsFor("rename"), rowsFor("device name")]).toEqual([
      [["general", false, "me"]],
      [["general", false, "me"]],
      [["general", false, "me"]],
      [["general", false, "device"]],
      [["general", false, "device"]],
    ]);
    expect(rowsFor("device")).toEqual([
      ["general", false, "device"],
      ["sync", false, "pair", "devices"],
    ]);
  });

  it("filters by title and row label", () => {
    const list = shownSections(false, true, MAC);
    expect(filterSections(list, "  ")).toEqual(list.map((section) => ({ section, rows: [], byTitle: false })));
    const theme = filterSections(list, " THEME ");
    expect(theme.map((m) => [m.section.id, m.byTitle, m.rows.map((r) => r.label)])).toEqual([["theme", true, ["Themes", "Save theme"]]]);
    const join = filterSections(list, "join");
    expect(join.map((m) => [m.section.id, m.byTitle, m.rows.map((r) => r.label)])).toEqual([["sync", false, ["Join with a code"]]]);
    const port = filterSections(list, "port");
    expect(port.map((m) => [m.section.id, m.byTitle, m.rows.map((r) => r.label)])).toEqual([
      ["theme", false, ["Import colours"]],
      ["files", true, ["Import", "Export"]],
    ]);
    expect(filterSections(list, "nothing like this")).toEqual([]);
  });

  it("filters by a row's search terms as well as its label", () => {
    const list = shownSections(true, true, MAC);
    const rowsFor = (q: string) => filterSections(list, q).map((m) => [m.section.id, m.rows.map((r) => r.id)]);
    expect([rowsFor("undated"), rowsFor("GROUP")]).toEqual([[["defaults", ["dated", "step"]]], [["defaults", ["group"]]]]);
    expect([rowsFor("ics"), rowsFor("calendar"), rowsFor("milestones")]).toEqual([[["files", ["ics"]]], [["files", ["ics"]]], [["files", ["ics"]]]]);
    expect([rowsFor("backup"), rowsFor("zip"), rowsFor("archive")]).toEqual([[["files", ["backup"]]], [["files", ["backup"]]], [["files", ["backup"]]]]);
  });
});
