import { describe, expect, it } from "vitest";
import type { SettingsSection } from "../state";
import { filterSections, isPlanSection, sectionTitle, SETTINGS_SECTIONS, shownSections } from "./sections";

const ALL: readonly SettingsSection[] = ["general", "theme", "sync", "files", "overview", "people", "workflow", "working-time", "baselines", "danger"];

const labels = (id: SettingsSection, hasUpdates: boolean): string[] => {
  const found = shownSections(true, hasUpdates).find((s) => s.id === id);
  if (found === undefined) throw new Error(`no ${id} section`);
  return found.rows.map((r) => r.label);
};

describe("the settings sections", () => {
  it("titles every section as the sidebar names it", () => {
    expect(ALL.map(sectionTitle)).toEqual(["General", "Theme", "Sync", "Import & export", "Overview", "People", "Workflow", "Working time", "Baselines", "Danger zone"]);
  });

  it("lists the app sections in order with their rows, Updates only with an updater", () => {
    expect(shownSections(false, false).map((s) => s.id)).toEqual(["general", "theme", "sync", "files"]);
    expect(labels("general", false)).toEqual(["This device", "About"]);
    expect(labels("general", true)).toEqual(["This device", "Updates", "About"]);
    expect(labels("theme", false)).toEqual(["Themes", "Follow the system", "Colours", "Import colours", "Readability", "Save theme"]);
    expect(labels("sync", false)).toEqual(["Status", "Set up sync", "Join with a code", "Add a device", "Devices"]);
    expect(labels("files", false)).toEqual(["Import", "Export"]);
  });

  it("lists the plan sections after the app ones, with their rows", () => {
    expect(shownSections(true, false).map((s) => s.id)).toEqual(["general", "theme", "sync", "files", "overview", "people", "workflow", "working-time", "baselines", "danger"]);
    expect(labels("overview", false)).toEqual(["Name"]);
    expect(labels("people", false)).toEqual(["People", "Add person"]);
    expect(labels("workflow", false)).toEqual(["Steps", "Add step", "New items"]);
    expect(labels("working-time", false)).toEqual(["Region", "Working days", "Closures", "Days off and holidays"]);
    expect(labels("baselines", false)).toEqual(["Baselines"]);
    expect(labels("danger", false)).toEqual(["Move to Trash", "Delete forever"]);
  });

  it("anchors every row but the Theme ones", () => {
    const rows = shownSections(true, true).flatMap((s) => s.rows.map((r) => [s.id, r.anchor] as const));
    expect(rows.filter(([id, anchor]) => anchor === (id === "theme"))).toEqual([]);
  });

  it("plan sections need a plan", () => {
    expect(ALL.filter(isPlanSection)).toEqual(["overview", "people", "workflow", "working-time", "baselines", "danger"]);
    expect(shownSections(false, true).filter((s) => s.plan)).toEqual([]);
    expect(shownSections(true, true).map((s) => s.id)).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(SETTINGS_SECTIONS.every((s) => s.plan === isPlanSection(s.id))).toBe(true);
  });

  it("filters by title and row label", () => {
    const list = shownSections(false, true);
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
});
