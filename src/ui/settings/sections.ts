import type { Platform } from "../../platform";
import { textSizesOn } from "../device";
import type { SettingsSection } from "../state";
import { PANE_LABELS, PANE_ORDER } from "../sync/SyncPanes";

export interface RowSpec {
  id: string;
  label: string;
  anchor: boolean;
  terms: readonly string[];
}

export const DEFAULTS_LABELS = {
  duration: "New task duration",
  dated: "New items are",
  assignee: "Default assignee",
  group: "Board + puts items in",
  step: "Step for new undated items",
} as const;

export const GENERAL_LABELS = {
  tab: "Default tab",
  week: "Week starts on",
  dates: "Date format",
  me: "This is me",
  device: "Device name",
  updates: "Updates",
  about: "About",
} as const;

export const LOOK_LABELS = {
  density: "Density",
  "text-size": "Text size",
  glow: "Reduce glow",
} as const;

export const FILES_LABELS = {
  import: "Import",
  export: "Export",
  ics: "Calendar (ICS)",
  backup: "Back up all plans",
} as const;

export interface SectionSpec {
  id: SettingsSection;
  title: string;
  plan: boolean;
  rows: readonly RowSpec[];
}

export interface SectionMatch {
  section: SectionSpec;
  rows: readonly RowSpec[];
  byTitle: boolean;
}

const TITLES: Readonly<Record<SettingsSection, string>> = {
  general: "General",
  theme: "Theme",
  sync: "Sync",
  files: "Import & export",
  overview: "Overview",
  people: "People",
  workflow: "Workflow",
  "working-time": "Working time",
  defaults: "Defaults",
  baselines: "Baselines",
  danger: "Danger zone",
};

const PLAN_SECTIONS: readonly SettingsSection[] = ["overview", "people", "workflow", "working-time", "defaults", "baselines", "danger"];

const UPDATES_ROW = "updates";

const row = (id: string, label: string, anchor = true, terms: readonly string[] = []): RowSpec => ({ id, label, anchor, terms });

const section = (id: SettingsSection, rows: readonly RowSpec[]): SectionSpec => ({ id, title: TITLES[id], plan: PLAN_SECTIONS.includes(id), rows });

export const SETTINGS_SECTIONS: readonly SectionSpec[] = [
  section("general", [
    row("tab", GENERAL_LABELS.tab, true, ["launch", "start"]),
    row("week", GENERAL_LABELS.week, true, ["monday", "sunday"]),
    row("dates", GENERAL_LABELS.dates, true, ["iso", "date"]),
    row("me", GENERAL_LABELS.me, true, ["mine", "me", "person"]),
    row("device", GENERAL_LABELS.device, true, ["device", "rename"]),
    row(UPDATES_ROW, GENERAL_LABELS.updates),
    row("about", GENERAL_LABELS.about),
  ]),
  section("theme", [
    row("themes", "Themes", false),
    row("follow", "Follow the system", false),
    row("colours", "Colours", false),
    row("import", "Import colours", false),
    row("readability", "Readability", false),
    row("save", "Save theme", false),
    row("density", LOOK_LABELS.density),
    row("text-size", LOOK_LABELS["text-size"]),
    row("glow", LOOK_LABELS.glow),
  ]),
  section("sync", [row("status", "Status"), ...PANE_ORDER.map((pane) => row(pane, PANE_LABELS[pane]))]),
  section("files", [
    row("import", FILES_LABELS.import),
    row("export", FILES_LABELS.export),
    row("ics", FILES_LABELS.ics, true, ["ics", "calendar", "milestones"]),
    row("backup", FILES_LABELS.backup, true, ["backup", "zip", "archive"]),
  ]),
  section("overview", [row("name", "Name")]),
  section("people", [row("people", "People"), row("add", "Add person")]),
  section("workflow", [row("steps", "Steps"), row("add", "Add step"), row("new-items", "New items")]),
  section("working-time", [row("region", "Region"), row("days", "Working days"), row("closures", "Closures"), row("days-off", "Days off and holidays")]),
  section("defaults", [
    row("duration", DEFAULTS_LABELS.duration),
    row("dated", DEFAULTS_LABELS.dated, true, ["dated", "undated"]),
    row("assignee", DEFAULTS_LABELS.assignee),
    row("group", DEFAULTS_LABELS.group, true, ["group"]),
    row("step", DEFAULTS_LABELS.step),
  ]),
  section("baselines", [row("baselines", "Baselines")]),
  section("danger", [row("trash", "Move to Trash"), row("delete", "Delete forever")]),
];

export const isPlanSection = (id: SettingsSection): boolean => PLAN_SECTIONS.includes(id);

export const sectionTitle = (id: SettingsSection): string => TITLES[id];

export const cappedLookRows = (platform: Platform): readonly string[] => [...(platform.os === "ios" ? ["density"] : []), ...(textSizesOn(platform).length < 2 ? ["text-size"] : [])];

const droppedRows = (id: SettingsSection, hasUpdates: boolean, platform: Platform): readonly string[] =>
  id === "general" ? (hasUpdates ? [] : [UPDATES_ROW]) : id === "theme" ? cappedLookRows(platform) : [];

export function shownSections(hasPlan: boolean, hasUpdates: boolean, platform: Platform): readonly SectionSpec[] {
  return SETTINGS_SECTIONS.filter((s) => hasPlan || !s.plan).map((s) => {
    const dropped = droppedRows(s.id, hasUpdates, platform);
    return dropped.length === 0 ? s : { ...s, rows: s.rows.filter((r) => !dropped.includes(r.id)) };
  });
}

export function filterSections(list: readonly SectionSpec[], query: string): SectionMatch[] {
  const q = query.trim().toLowerCase();
  if (q === "") return list.map((s) => ({ section: s, rows: [], byTitle: false }));
  return list
    .map((s) => ({ section: s, rows: s.rows.filter((r) => r.label.toLowerCase().includes(q) || r.terms.some((t) => t.includes(q))), byTitle: s.title.toLowerCase().includes(q) }))
    .filter((m) => m.byTitle || m.rows.length > 0);
}
