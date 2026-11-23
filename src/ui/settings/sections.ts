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
  section("general", [row("device", "This device"), row(UPDATES_ROW, "Updates"), row("about", "About")]),
  section("theme", [
    row("themes", "Themes", false),
    row("follow", "Follow the system", false),
    row("colours", "Colours", false),
    row("import", "Import colours", false),
    row("readability", "Readability", false),
    row("save", "Save theme", false),
  ]),
  section("sync", [row("status", "Status"), ...PANE_ORDER.map((pane) => row(pane, PANE_LABELS[pane]))]),
  section("files", [row("import", "Import"), row("export", "Export")]),
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

export function shownSections(hasPlan: boolean, hasUpdates: boolean): readonly SectionSpec[] {
  return SETTINGS_SECTIONS.filter((s) => hasPlan || !s.plan).map((s) => (s.id === "general" && !hasUpdates ? { ...s, rows: s.rows.filter((r) => r.id !== UPDATES_ROW) } : s));
}

export function filterSections(list: readonly SectionSpec[], query: string): SectionMatch[] {
  const q = query.trim().toLowerCase();
  if (q === "") return list.map((s) => ({ section: s, rows: [], byTitle: false }));
  return list
    .map((s) => ({ section: s, rows: s.rows.filter((r) => r.label.toLowerCase().includes(q) || r.terms.some((t) => t.includes(q))), byTitle: s.title.toLowerCase().includes(q) }))
    .filter((m) => m.byTitle || m.rows.length > 0);
}
