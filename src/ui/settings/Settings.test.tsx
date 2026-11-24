import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { createRef, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import { stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import type { UpdateState, Updates } from "../../store/updates";
import type { SyncState } from "../../sync/manager";
import { fixedClock } from "../../services/clock";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { testRegistry } from "../../test/shell";
import { deviced } from "../../test/theme";
import { withSync } from "../../test/withSync";
import { IPAD, IPHONE, MAC, setPlatform } from "../../test/platform";
import { resetTauri, tauri } from "../../test/tauriMock";
import { DEFAULT_STORE } from "../../theme/store";
import { ThemeProvider } from "../../theme/ThemeContext";
import { HOLIDAY_ATTRIBUTION } from "../common/About";
import { UNSAVED_TITLE, type CloseReason } from "../common/dismiss";
import { CALENDAR_DRAFT } from "../calendar/CalendarDialog";
import { toast } from "../common/Toast";
import { refusal } from "../../actions/copy";
import { DEFAULT_DEVICE, DEVICE_KEY } from "../device";
import { OpenChoice } from "../run";
import { exportFlow, exportIcsFlow, exportListCsvFlow } from "../shell/fileFlows";
import type { PlanFiles } from "../shell/selection";
import { UiContext, useUi, type SettingsSection, type SyncPane, type UiState } from "../state";
import { DISCARDED } from "../theme/ThemePanel";
import type { SettingsFrame } from "./frame";
import { SETTINGS_KEY } from "./lastSection";
import { SETTINGS_TITLE, SettingsView, THEME_DRAFT, trashLocked } from "./Settings";
import type { PlanListing } from "../../store/registry";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../common/Toast", () => ({ toast: vi.fn() }));
vi.mock("../shell/fileFlows", () => ({
  exportFlow: vi.fn(async () => undefined),
  exportListCsvFlow: vi.fn(async () => undefined),
  exportIcsFlow: vi.fn(async () => undefined),
  backupFlow: vi.fn(async () => undefined),
  importFlow: vi.fn(async () => undefined),
}));

beforeEach(() => {
  setPlatform(MAC);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.mocked(toast).mockClear();
  vi.mocked(exportFlow).mockClear();
  vi.mocked(exportListCsvFlow).mockClear();
  vi.mocked(exportIcsFlow).mockClear();
});

const CYBERDECK_VOID = "#0A0A14";

const voidNow = (): string => document.documentElement.style.getPropertyValue("--void");

const AVAILABLE: UpdateState = { k: "available", version: "9.9.9" };

const fakeUpdates = (): Updates => ({
  state: () => AVAILABLE,
  subscribe: () => () => undefined,
  start: () => undefined,
  stop: () => undefined,
  check: async () => undefined,
  install: async () => undefined,
});

const fakeFiles = (): PlanFiles => ({
  creating: false,
  importing: false,
  newPlan: vi.fn(),
  newExample: vi.fn(),
  importPlan: vi.fn(),
});

interface Opts {
  frame?: SettingsFrame;
  section?: SettingsSection;
  session?: PlanSession | null;
  t?: TestSession;
  sync?: SyncState;
  updates?: Updates | null;
  hover?: boolean;
  readOnly?: boolean;
  planLocked?: boolean;
  row?: string;
  root?: boolean;
}

function UiHost(p: { seen: { current: UiState | null }; children: ReactNode }) {
  const [ui, setUi] = useUi("timeline");
  p.seen.current = ui;
  return <UiContext.Provider value={{ ui, setUi }}>{p.children}</UiContext.Provider>;
}

function mount(o: Opts = {}) {
  const onSection = vi.fn<(s: SettingsSection) => void>();
  const onClose = vi.fn<() => void>();
  const onSyncPane = vi.fn<(pane: SyncPane) => void>();
  const onTrashPlan = vi.fn<(id: string) => void>();
  const onRoot = vi.fn<(root: boolean) => void>();
  const openChoice = vi.fn();
  const seen: { current: UiState | null } = { current: null };
  const closer = createRef<((r: CloseReason) => boolean) | null>();
  const files = fakeFiles();
  const backup = vi.fn<() => void>();
  const panes = (pane: SyncPane | null) => (
    <div className="stub-panes" data-pane={pane ?? "resolved"}>
      {(["setup", "join", "pair", "devices"] as const).map((k) => (
        <section key={k} data-settings-row={`sync.${k}`} hidden={pane !== k}>
          <button type="button">{`${k} field`}</button>
        </section>
      ))}
    </div>
  );
  const clock = o.t?.clock ?? fixedClock("2026-11-09");
  const registry = o.t === undefined ? null : testRegistry(o.t);
  const synced = (el: ReactElement): ReactElement => (registry === null ? el : withSync(el, { registry }));
  const onRowShown = vi.fn<() => void>();
  let row: string | null = o.row ?? null;
  onRowShown.mockImplementation(() => {
    row = null;
  });
  const ui = (section: SettingsSection, session: PlanSession | null, pane: SyncPane | null, frameNow: SettingsFrame, rootNow: boolean, roNow: boolean) => synced(
    <OpenChoice.Provider value={openChoice}>
      <UiHost seen={seen}>
        <ThemeProvider storage={window.localStorage} initial={{ store: DEFAULT_STORE, unreadable: null }}>
          {deviced(
            <SettingsView
              frame={frameNow}
              section={section}
              root={rootNow}
              onRoot={onRoot}
              row={row}
              onRowShown={onRowShown}
              session={session}
              readOnly={roNow}
              device="Rokas’s Mac"
              renameDevice={vi.fn()}
              backup={backup}
              clock={clock}
              hover={o.hover ?? false}
              closer={closer}
              files={files}
              onSection={onSection}
              syncPane={pane}
              onClose={onClose}
              onSyncPane={onSyncPane}
              onTrashPlan={onTrashPlan}
              sync={o.sync ?? { kind: "off" }}
              syncName={(doc) => (doc === "p1" ? "Launch" : null)}
              updates={o.updates === undefined ? null : o.updates}
              syncPanes={panes(pane)}
              planLocked={o.planLocked ?? false}
            />,
          )}
        </ThemeProvider>
      </UiHost>
    </OpenChoice.Provider>,
  );
  let section = o.section ?? "general";
  let session = o.session ?? o.t?.session ?? null;
  let pane: SyncPane | null = null;
  let frame = o.frame ?? "modal";
  let root = o.root ?? false;
  let ro = o.readOnly ?? false;
  const again = (): void => view.rerender(ui(section, session, pane, frame, root, ro));
  const view = render(ui(section, session, pane, frame, root, ro));
  onSection.mockImplementation((s) => {
    section = s;
    again();
  });
  onSyncPane.mockImplementation((k) => {
    pane = k;
    again();
  });
  onRoot.mockImplementation((r) => {
    root = r;
    again();
  });
  return {
    view,
    onSection,
    onRoot,
    onRowShown,
    onClose,
    onSyncPane,
    onTrashPlan,
    closer,
    files,
    backup,
    registry,
    uiNow(): UiState {
      if (seen.current === null) throw new Error("no ui state");
      return seen.current;
    },
    root: (): HTMLElement => view.getByRole("dialog"),
    show(s: SettingsSection): void {
      section = s;
      again();
    },
    plan(s: PlanSession | null): void {
      session = s;
      again();
    },
    reframe(f: SettingsFrame): void {
      frame = f;
      again();
    },
    rooted(r: boolean): void {
      root = r;
      again();
    },
    lock(r: boolean): void {
      ro = r;
      again();
    },
  };
}

const nav = (root: HTMLElement): HTMLElement => within(root).getByRole("navigation", { name: "Settings sections" });

const navItems = (root: HTMLElement): string[] => [...nav(root).querySelectorAll<HTMLElement>("button.settings-nav-item")].map((b) => b.textContent ?? "");

const current = (root: HTMLElement): string[] =>
  [...nav(root).querySelectorAll<HTMLElement>('button.settings-nav-item[aria-current="page"]')].map((b) => b.dataset["section"] ?? "");

const shownSection = (root: HTMLElement): string[] => [...root.querySelectorAll<HTMLElement>("section.settings-section:not([hidden])")].map((s) => s.dataset["section"] ?? "");

const search = (root: HTMLElement): HTMLInputElement => {
  const el = within(root).getByRole("searchbox", { name: "Search settings" });
  if (!(el instanceof HTMLInputElement)) throw new Error("not an input");
  return el;
};

const typeSearch = (root: HTMLElement, value: string): void => {
  fireEvent.change(search(root), { target: { value } });
};

const sectionEl = (root: HTMLElement, id: SettingsSection): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`section.settings-section[data-section="${id}"]`);
  if (el === null) throw new Error(`no ${id} section`);
  return el;
};

const rootList = (sheet: HTMLElement): HTMLElement => {
  const el = sheet.querySelector<HTMLElement>("div.settings-root");
  if (el === null) throw new Error("no Settings root");
  return el;
};

const rootRow = (sheet: HTMLElement, id: SettingsSection): HTMLElement => {
  const el = rootList(sheet).querySelector<HTMLElement>(`button.settings-root-row[data-section="${id}"]`);
  if (el === null) throw new Error(`no ${id} root row`);
  return el;
};

const pageEl = (sheet: HTMLElement, id: SettingsSection): HTMLElement => {
  const el = sheet.querySelector<HTMLElement>(`section.settings-page[data-section="${id}"]`);
  if (el === null) throw new Error(`no ${id} page`);
  return el;
};

const shownPages = (sheet: HTMLElement): string[] => [...sheet.querySelectorAll<HTMLElement>("section.settings-page:not([hidden])")].map((s) => s.dataset["section"] ?? "");

const barTitle = (sheet: HTMLElement): string | null => sheet.querySelector(".sheet-head .sheet-title")?.textContent ?? null;

const back = (sheet: HTMLElement): HTMLElement => {
  const el = sheet.querySelector<HTMLElement>(".sheet-head button.sheet-back");
  if (el === null) throw new Error("no Back");
  return el;
};

const sheetBody = (sheet: HTMLElement): HTMLElement => {
  const el = sheet.querySelector<HTMLElement>(".sheet-body");
  if (el === null) throw new Error("no sheet body");
  return el;
};

const draftBackground = (root: HTMLElement): void => {
  const field = within(sectionEl(root, "theme")).getByRole("textbox", {
    name: "Background hex",
  });
  fireEvent.change(field, { target: { value: "#222222" } });
  fireEvent.blur(field);
};

describe("Settings in the modal frame", () => {
  it("is a settings dialog titled by its section, with the App group in the sidebar", () => {
    expect(SETTINGS_TITLE).toBe("Settings");
    const m = mount({ section: "sync" });
    const root = m.root();
    expect([root.className, root.hasAttribute("data-settings-modal"), root.getAttribute("aria-label")]).toEqual(["modal modal-settings", true, "Sync"]);
    expect(within(root).getByRole("heading", { level: 3 }).textContent).toBe("Sync");
    expect(search(root).placeholder).toBe("Search settings");
    expect([...nav(root).querySelectorAll<HTMLElement>(".settings-nav-group")].map((g) => [g.dataset["group"], g.querySelector(".settings-nav-title")?.textContent])).toEqual([
      ["app", "App"],
    ]);
    expect(navItems(root)).toEqual(["General", "Theme", "Sync", "Import & export"]);
    expect([current(root), shownSection(root)]).toEqual([["sync"], ["sync"]]);
  });

  it("title follows the section", () => {
    const m = mount();
    expect([m.root().getAttribute("aria-label"), current(m.root())]).toEqual(["General", ["general"]]);
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Import & export" }));
    expect(m.onSection.mock.calls).toEqual([["files"]]);
    expect([m.root().getAttribute("aria-label"), within(m.root()).getByRole("heading", { level: 3 }).textContent, current(m.root()), shownSection(m.root())]).toEqual([
      "Import & export",
      "Import & export",
      ["files"],
      ["files"],
    ]);
  });

  it("mounts a section on its first visit and keeps it, hidden, until Settings closes", () => {
    const m = mount();
    expect([...m.root().querySelectorAll<HTMLElement>("section.settings-section")].map((s) => s.dataset["section"])).toEqual(["general"]);
    m.show("theme");
    draftBackground(m.root());
    m.show("sync");
    expect([...m.root().querySelectorAll<HTMLElement>("section.settings-section")].map((s) => [s.dataset["section"], s.hidden])).toEqual([
      ["general", true],
      ["theme", true],
      ["sync", false],
    ]);
    m.show("theme");
    expect(within(sectionEl(m.root(), "theme")).getByText("Unsaved")).toBeTruthy();
    expect(voidNow()).toBe("#222222");
    expect(toast).not.toHaveBeenCalled();
  });

  it("clears a hover preview when it switches section", () => {
    const m = mount({ section: "theme", hover: true });
    fireEvent.pointerEnter(
      within(sectionEl(m.root(), "theme")).getByRole("button", {
        name: /^Phosphor/,
      }),
    );
    expect(voidNow()).toBe("#060C09");
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Sync" }));
    expect(voidNow()).toBe(CYBERDECK_VOID);
  });

  it("resets the main column's scroll on a switch", () => {
    const m = mount();
    const main = m.root().querySelector<HTMLElement>(".settings-main");
    if (main === null) throw new Error("no main column");
    main.scrollTop = 120;
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Theme" }));
    expect(main.scrollTop).toBe(0);
  });

  it("reopens on the last section: each switch saves it", () => {
    mount({ section: "sync" }).view.unmount();
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe(JSON.stringify({ v: 1, at: "sync" }));
    const m = mount({ section: "sync" });
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Theme" }));
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe(JSON.stringify({ v: 1, at: "theme" }));
  });

  it("search filters sections and rows, and says when nothing matches", () => {
    const m = mount();
    typeSearch(m.root(), "port");
    expect(navItems(m.root())).toEqual(["Theme", "Import & export"]);
    expect([...nav(m.root()).querySelectorAll<HTMLElement>("button.settings-nav-row")].map((b) => [b.dataset["row"], b.textContent])).toEqual([
      ["theme.import", "Import colours"],
      ["files.import", "Import"],
      ["files.export", "Export"],
    ]);
    typeSearch(m.root(), "  qqq ");
    expect([navItems(m.root()), m.root().querySelector("p.settings-empty")?.textContent]).toEqual([[], "No setting matches “qqq”."]);
    typeSearch(m.root(), "");
    expect([navItems(m.root()), m.root().querySelector("p.settings-empty"), nav(m.root()).querySelectorAll("button.settings-nav-row").length]).toEqual([
      ["General", "Theme", "Sync", "Import & export"],
      null,
      0,
    ]);
  });

  it("finds This is me by mine and the device name by rename, and a row entry focuses the device field", () => {
    const m = mount();
    const rows = (): (string | undefined)[][] => [...nav(m.root()).querySelectorAll<HTMLElement>("button.settings-nav-row")].map((b) => [b.dataset["row"], b.textContent ?? undefined]);
    typeSearch(m.root(), "mine");
    expect(rows()).toEqual([["general.me", "This is me"]]);
    typeSearch(m.root(), "rename");
    expect(rows()).toEqual([["general.device", "Device name"]]);
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Device name" }));
    expect(document.activeElement?.matches('[data-settings-row="general.device"] input.settings-device-name')).toBe(true);
  });

  it.each([["modal"], ["sheet"]] as const)("opened at the me row in the %s, focuses the This is me pick and hands the row back", async (frame) => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, frame, row: "me" });
    expect(document.activeElement?.matches('[data-settings-row="general.me"] button.settings-pick[data-pick="me"]')).toBe(true);
    expect(m.onRowShown).toHaveBeenCalledTimes(1);
    await t.session.close();
  });

  it("Return in the search opens the first match", () => {
    const m = mount();
    typeSearch(m.root(), "sync");
    fireEvent.keyDown(search(m.root()), { key: "Enter" });
    expect([m.onSection.mock.calls, shownSection(m.root())]).toEqual([[["sync"]], ["sync"]]);
    typeSearch(m.root(), "colours");
    fireEvent.keyDown(search(m.root()), { key: "Enter" });
    expect(shownSection(m.root())).toEqual(["theme"]);
  });

  it("Escape in a search with text clears it and keeps Settings open; with none it closes", () => {
    const m = mount();
    typeSearch(m.root(), "theme");
    const esc = fireEvent.keyDown(search(m.root()), { key: "Escape" });
    expect([esc, search(m.root()).value, m.onClose.mock.calls.length, navItems(m.root()).length]).toEqual([false, "", 0, 4]);
    fireEvent.keyDown(search(m.root()), { key: "Escape" });
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it("a row entry opens its section, scrolls the row into view and focuses its first control", () => {
    const m = mount({ updates: fakeUpdates() });
    typeSearch(m.root(), "import");
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Import" }));
    const row = m.root().querySelector<HTMLElement>('[data-settings-row="files.import"]');
    if (row === null) throw new Error("no import row");
    expect(shownSection(m.root())).toEqual(["files"]);
    expect(scrolled.mock.contexts).toEqual([row]);
    expect(document.activeElement).toBe(row.querySelector("button"));
    typeSearch(m.root(), "updates");
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Updates" }));
    expect(document.activeElement?.textContent).toBe("Install and restart");
  });

  it("Theme ends with Density, Text size and Reduce glow on the Mac, and search jumps to each", () => {
    const m = mount({ section: "theme" });
    const rows = (): (string | undefined)[] => [...sectionEl(m.root(), "theme").querySelectorAll<HTMLElement>("[data-settings-row]")].map((r) => r.dataset["settingsRow"]);
    expect(rows()).toEqual(["theme.density", "theme.text-size", "theme.glow"]);
    m.show("general");
    typeSearch(m.root(), "glow");
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Reduce glow" }));
    expect(shownSection(m.root())).toEqual(["theme"]);
    expect(document.activeElement).toBe(within(sectionEl(m.root(), "theme")).getByRole("switch", { name: "Reduce glow" }));
    typeSearch(m.root(), "density");
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Density" }));
    expect(document.activeElement?.textContent).toBe("Comfortable");
  });

  it("Theme drops Density and Text size on the iPad, and search finds neither", () => {
    setPlatform(IPAD);
    const m = mount({ section: "theme" });
    const theme = sectionEl(m.root(), "theme");
    expect([...theme.querySelectorAll<HTMLElement>("[data-settings-row]")].map((r) => r.dataset["settingsRow"])).toEqual(["theme.glow"]);
    expect(within(theme).queryAllByRole("radio")).toEqual([]);
    typeSearch(m.root(), "density");
    expect(within(nav(m.root())).queryByRole("button", { name: "Density" })).toBeNull();
    typeSearch(m.root(), "text size");
    expect(within(nav(m.root())).queryByRole("button", { name: "Text size" })).toBeNull();
    typeSearch(m.root(), "glow");
    expect(within(nav(m.root())).getByRole("button", { name: "Reduce glow" })).toBeTruthy();
  });

  it("an anchorless row entry opens its section at the top", () => {
    const m = mount();
    const main = m.root().querySelector<HTMLElement>(".settings-main");
    if (main === null) throw new Error("no main column");
    m.show("theme");
    main.scrollTop = 300;
    typeSearch(m.root(), "readability");
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Readability" }));
    expect([shownSection(m.root()), main.scrollTop, scrolled.mock.calls.length]).toEqual([["theme"], 0, 0]);
  });

  it.each<[string, (root: HTMLElement) => void]>([
    ["the ✕", (root) => fireEvent.click(within(root).getByRole("button", { name: "Close" }))],
    ["Escape", (root) => fireEvent.keyDown(root, { key: "Escape" })],
    [
      "a scrim press",
      () => {
        const scrim = document.querySelector(".overlay");
        if (scrim === null) throw new Error("no scrim");
        const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(scrim);
        fireEvent.pointerDown(scrim, {
          button: 0,
          pointerType: "mouse",
          clientX: 5,
          clientY: 5,
        });
        fireEvent.pointerUp(scrim, {
          button: 0,
          pointerType: "mouse",
          clientX: 5,
          clientY: 5,
        });
        fireEvent.click(scrim, { button: 0, clientX: 5, clientY: 5 });
        under.mockRestore();
      },
    ],
  ])("discards a theme draft with the toast when closed by %s, from any section", (_how, close) => {
    const m = mount({ section: "theme" });
    draftBackground(m.root());
    m.show("general");
    close(m.root());
    expect(vi.mocked(toast).mock.calls).toEqual([[DISCARDED]]);
    expect(voidNow()).toBe(CYBERDECK_VOID);
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it("points the closer at its own close while open, and clears it on unmount", () => {
    const m = mount({ section: "theme" });
    draftBackground(m.root());
    const close = m.closer.current;
    if (close === null) throw new Error("no closer");
    let closed = false;
    act(() => {
      closed = close("x");
    });
    expect([closed, m.onClose.mock.calls.length, vi.mocked(toast).mock.calls]).toEqual([true, 1, [[DISCARDED]]]);
    m.view.unmount();
    expect(m.closer.current).toBeNull();
  });

  it("General shows This is me, the device name, the update line with an updater, and About", () => {
    const m = mount({ updates: fakeUpdates() });
    const general = sectionEl(m.root(), "general");
    const rows = [...general.querySelectorAll<HTMLElement>(".settings-row")];
    expect(rows.map((r) => [r.dataset["settingsRow"], r.querySelector(".settings-label")?.textContent])).toEqual([
      ["general.tab", "Default tab"],
      ["general.week", "Week starts on"],
      ["general.dates", "Date format"],
      ["general.me", "This is me"],
      ["general.device", "Device name"],
      ["general.updates", "Updates"],
      ["general.about", "About"],
    ]);
    expect(rows[3].querySelector(".settings-control")?.textContent).toBe("Open a plan to choose who you are in it.");
    expect(rows[4].querySelector<HTMLInputElement>(".settings-control input.settings-device-name")?.value).toBe("Rokas’s Mac");
    expect(within(rows[5]).getByText("WebBoard 9.9.9 is available")).toBeTruthy();
    expect(rows[6].querySelector("img.about-mark")?.getAttribute("src")).toBe("/logo-mark.svg");
    expect([...rows[6].querySelectorAll("p")].map((p) => p.textContent)).toEqual([`WebBoard ${version}`, HOLIDAY_ATTRIBUTION]);
  });

  it("General has no Updates row without an updater", () => {
    const m = mount();
    expect([...sectionEl(m.root(), "general").querySelectorAll<HTMLElement>(".settings-row")].map((r) => r.dataset["settingsRow"])).toEqual(["general.tab", "general.week", "general.dates", "general.me", "general.device", "general.about"]);
  });

  it.each([
    [{ kind: "off" } as const, "Local only", "cyan"],
    [{ kind: "offline", waiting: 2 } as const, "Offline — 2 changes waiting", "amber"],
  ])("tones the sync status like the chip (%#)", (sync, text, tone) => {
    const m = mount({ section: "sync", sync });
    const line = sectionEl(m.root(), "sync").querySelector("p.settings-status");
    expect([line?.textContent, line?.className]).toEqual([text, `settings-status ${tone}`]);
  });

  it("shows the sync panes inline under the status, and keeps Settings open", () => {
    const m = mount({ section: "theme" });
    draftBackground(m.root());
    m.show("sync");
    const sync = sectionEl(m.root(), "sync");
    expect([...sync.querySelectorAll<HTMLElement>(".settings-row")].map((r) => [r.dataset["settingsRow"], r.querySelector(".settings-label")?.textContent])).toEqual([
      ["sync.status", "Status"],
    ]);
    expect([...sync.children].map((c) => c.className)).toEqual(["settings-row", "settings-sync"]);
    expect(sync.querySelector(".settings-sync > .stub-panes")?.getAttribute("data-pane")).toBe("resolved");
    expect(within(sync).queryByRole("button", { name: "Open…" })).toBeNull();
    expect([m.onClose.mock.calls.length, vi.mocked(toast).mock.calls]).toEqual([0, []]);
  });

  it("a pane row entry opens Sync on that pane and focuses its first control", () => {
    const m = mount();
    typeSearch(m.root(), "add a device");
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Add a device" }));
    const row = m.root().querySelector<HTMLElement>('[data-settings-row="sync.pair"]');
    if (row === null) throw new Error("no pair pane");
    expect([m.onSyncPane.mock.calls, shownSection(m.root()), m.root().querySelector(".stub-panes")?.getAttribute("data-pane")]).toEqual([[["pair"]], ["sync"], "pair"]);
    expect(scrolled.mock.contexts).toEqual([row]);
    expect(document.activeElement?.textContent).toBe("pair field");
    typeSearch(m.root(), "status");
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Status" }));
    expect(m.onSyncPane.mock.calls).toEqual([["pair"]]);
  });

  it("imports through the plan files, and exports the open plan", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ section: "files" });
    const files = sectionEl(m.root(), "files");
    expect(within(files).getByText("Open a plan to export it.")).toBeTruthy();
    expect(within(files).queryByRole("button", { name: "Export plan…" })).toBeNull();
    fireEvent.click(within(files).getByRole("button", { name: "Import plan…" }));
    expect(m.files.importPlan).toHaveBeenCalledTimes(1);
    m.plan(t.session);
    fireEvent.click(
      within(sectionEl(m.root(), "files")).getByRole("button", {
        name: "Export plan…",
      }),
    );
    expect(vi.mocked(exportFlow).mock.calls).toEqual([[t.session]]);
    await t.session.close();
  });

  it("exports the open plan's List as CSV, and says what the CSV holds", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ section: "files" });
    expect(within(sectionEl(m.root(), "files")).queryByRole("button", { name: "Export List as CSV…" })).toBeNull();
    m.plan(t.session);
    const row = m.root().querySelector<HTMLElement>('[data-settings-row="files.export"]');
    if (row === null) throw new Error("no export row");
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Export plan…", "Export List as CSV…"]);
    expect(within(row).getByText("CSV holds the List's columns, sort, scope and filters on this device.")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Export List as CSV…" }));
    expect([vi.mocked(exportListCsvFlow).mock.calls, vi.mocked(exportFlow).mock.calls]).toEqual([[[t.session, null]], []]);
    await t.session.close();
  });

  it("exports the List as CSV with this device's me for the plan", async () => {
    const t = await testSession(MESA_SEED);
    window.localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...DEFAULT_DEVICE, me: { [t.session.view().plan.id]: "mira" } }));
    const m = mount({ section: "files" });
    m.plan(t.session);
    const row = m.root().querySelector<HTMLElement>('[data-settings-row="files.export"]');
    if (row === null) throw new Error("no export row");
    fireEvent.click(within(row).getByRole("button", { name: "Export List as CSV…" }));
    expect(vi.mocked(exportListCsvFlow).mock.calls).toEqual([[t.session, "mira"]]);
    await t.session.close();
  });

  it("exports the open plan's milestones as ICS, and backs up all plans with or without a plan", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ section: "files" });
    const rowOf = (id: string): HTMLElement => {
      const row = m.root().querySelector<HTMLElement>(`[data-settings-row="files.${id}"]`);
      if (row === null) throw new Error(`no ${id} row`);
      return row;
    };
    expect([...sectionEl(m.root(), "files").querySelectorAll<HTMLElement>(".settings-row")].map((r) => r.dataset["settingsRow"])).toEqual(["files.import", "files.export", "files.ics", "files.backup"]);
    expect([rowOf("ics").querySelector(".settings-label")?.textContent, rowOf("ics").querySelector(".settings-value.dim")?.textContent, within(rowOf("ics")).queryByRole("button")]).toEqual([
      "Calendar (ICS)",
      "Open a plan to export its milestones.",
      null,
    ]);
    const backup = within(rowOf("backup")).getByRole("button", { name: "Back up…" });
    expect([rowOf("backup").querySelector(".settings-label")?.textContent, rowOf("backup").querySelector(".settings-hint")?.textContent, backup.getAttribute("aria-describedby")]).toEqual([
      "Back up all plans",
      "One .zip with every plan as a .webboard file. Unzip it and import a plan to restore it.",
      rowOf("backup").querySelector(".settings-hint")?.id,
    ]);
    fireEvent.click(backup);
    expect(m.backup).toHaveBeenCalledTimes(1);
    m.plan(t.session);
    const name = t.session.view().plan.name;
    const ics = within(rowOf("ics")).getByRole("button", { name: "Export milestones…" });
    expect(rowOf("ics").querySelector(".settings-hint")?.textContent).toBe(`Dated milestones of “${name}” as all-day events.`);
    fireEvent.click(ics);
    expect(vi.mocked(exportIcsFlow).mock.calls.map(([session, clock]) => [session, clock.now()])).toEqual([[t.session, fixedClock("2026-11-09").now()]]);
    act(() => t.session.apply({ t: "planName", name: "MESA 2.0" }));
    expect(rowOf("ics").querySelector(".settings-hint")?.textContent).toBe("Dated milestones of “MESA 2.0” as all-day events.");
    fireEvent.click(within(rowOf("backup")).getByRole("button", { name: "Back up…" }));
    expect([m.backup.mock.calls.length, vi.mocked(exportFlow).mock.calls]).toEqual([2, []]);
    await t.session.close();
  });

  it("finds Calendar (ICS) and Back up all plans by their search terms", () => {
    const m = mount();
    const rows = (): (string | undefined)[][] => [...nav(m.root()).querySelectorAll<HTMLElement>("button.settings-nav-row")].map((b) => [b.dataset["row"], b.textContent ?? undefined]);
    typeSearch(m.root(), "milestones");
    expect(rows()).toEqual([["files.ics", "Calendar (ICS)"]]);
    typeSearch(m.root(), "ZIP");
    expect(rows()).toEqual([["files.backup", "Back up all plans"]]);
    typeSearch(m.root(), "archive");
    expect(rows()).toEqual([["files.backup", "Back up all plans"]]);
  });

  it("plan group absent without a plan", async () => {
    const m = mount();
    expect([...nav(m.root()).querySelectorAll<HTMLElement>(".settings-nav-group")].map((g) => g.dataset["group"])).toEqual(["app"]);
    expect(m.root().querySelector('[data-group="plan"]')).toBeNull();
  });

  it("a plan section with no plan shows and asks for General, and keeps the saved place", () => {
    const m = mount({ section: "overview" });
    expect([m.onSection.mock.calls, m.root().getAttribute("aria-label"), shownSection(m.root())]).toEqual([[["general"]], "General", ["general"]]);
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it("a forced General does not overwrite a saved plan section; a chosen one does", () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ v: 1, at: "baselines" }));
    const m = mount({ section: "baselines" });
    expect([shownSection(m.root()), window.localStorage.getItem(SETTINGS_KEY)]).toEqual([["general"], JSON.stringify({ v: 1, at: "baselines" })]);
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "General" }));
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe(JSON.stringify({ v: 1, at: "general" }));
  });

  it("clears a hover preview when the section changes from outside", () => {
    const m = mount({ section: "theme", hover: true });
    fireEvent.pointerEnter(within(sectionEl(m.root(), "theme")).getByRole("button", { name: /^Phosphor/ }));
    expect(voidNow()).toBe("#060C09");
    m.show("sync");
    expect([shownSection(m.root()), voidNow()]).toEqual([["sync"], CYBERDECK_VOID]);
  });

  it("Return that ends an IME composition in the search does not jump", () => {
    const m = mount();
    typeSearch(m.root(), "sync");
    fireEvent.keyDown(search(m.root()), { key: "Enter", isComposing: true });
    expect([m.onSection.mock.calls, shownSection(m.root())]).toEqual([[], ["general"]]);
    fireEvent.keyDown(search(m.root()), { key: "Enter" });
    expect(shownSection(m.root())).toEqual(["sync"]);
  });

  it("names each sidebar group by its title, announces the match count, and Down moves into the results", () => {
    const m = mount();
    const groups = [...nav(m.root()).querySelectorAll<HTMLElement>(".settings-nav-group")];
    expect(groups.map((g) => [g.getAttribute("role"), document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent])).toEqual([["group", "App"]]);
    expect(within(nav(m.root())).getByRole("group", { name: "App" })).toBeTruthy();
    const live = within(m.root()).getByRole("status");
    expect([live.getAttribute("aria-live"), live.textContent]).toEqual(["polite", ""]);
    typeSearch(m.root(), "port");
    expect(live.textContent).toBe("2 sections match.");
    typeSearch(m.root(), "sync");
    expect(live.textContent).toBe("1 section matches.");
    const down = fireEvent.keyDown(search(m.root()), { key: "ArrowDown" });
    expect([down, document.activeElement?.textContent]).toEqual([false, "Sync"]);
    typeSearch(m.root(), "qqq");
    expect(live.textContent).toBe("No setting matches “qqq”.");
    search(m.root()).focus();
    expect(fireEvent.keyDown(search(m.root()), { key: "ArrowDown" })).toBe(true);
    expect(document.activeElement).toBe(search(m.root()));
  });
});

const groupTitles = (root: HTMLElement): (string | null | undefined)[][] =>
  [...nav(root).querySelectorAll<HTMLElement>(".settings-nav-group")].map((g) => [g.dataset["group"], g.querySelector(".settings-nav-title")?.textContent]);

const rowsOf = (root: HTMLElement, id: SettingsSection): (string | null | undefined)[][] =>
  [...sectionEl(root, id).querySelectorAll<HTMLElement>(".settings-row")].map((r) => [r.dataset["settingsRow"], r.querySelector(".settings-label")?.textContent]);

describe("the plan group: Overview, Baselines, Danger zone", () => {
  it("lists the plan's sections under the plan's name", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session });
    const name = t.session.view().plan.name;
    expect(groupTitles(m.root())).toEqual([
      ["app", "App"],
      ["plan", name],
    ]);
    expect(navItems(m.root())).toEqual(["General", "Theme", "Sync", "Import & export", "Overview", "People", "Workflow", "Working time", "Defaults", "Baselines", "Danger zone"]);
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Danger zone" }));
    expect([m.onSection.mock.calls, m.root().getAttribute("aria-label"), shownSection(m.root())]).toEqual([[["danger"]], "Danger zone", ["danger"]]);
    await t.session.close();
  });

  it("Overview renames the plan with the plan name rule, and the group title follows", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session, section: "overview" });
    expect(rowsOf(m.root(), "overview")).toEqual([["overview.name", "Name"]]);
    const field = within(sectionEl(m.root(), "overview")).getByRole("textbox", {
      name: "Plan name",
    });
    if (!(field instanceof HTMLInputElement)) throw new Error("no Plan name field");
    expect(field.value).toBe(t.session.view().plan.name);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.change(field, { target: { value: "  Dome\tworks  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect([apply.mock.calls, t.session.view().plan.name, groupTitles(m.root())[1]]).toEqual([[[{ t: "planName", name: "Dome works" }]], "Dome works", ["plan", "Dome works"]]);
    vi.mocked(toast).mockClear();
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.blur(field);
    expect([vi.mocked(toast).mock.calls, apply.mock.calls.length, t.session.view().plan.name, field.value]).toEqual([[[refusal.emptyName, "bad"]], 1, "Dome works", "Dome works"]);
    await t.session.close();
  });

  it("Workflow lists the steps under its three rows, and search finds it by a row", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session, section: "workflow" });
    expect([m.root().getAttribute("aria-label"), shownSection(m.root())]).toEqual(["Workflow", ["workflow"]]);
    const workflow = sectionEl(m.root(), "workflow");
    expect([...workflow.querySelectorAll<HTMLElement>("[data-settings-row]")].map((r) => r.dataset["settingsRow"])).toEqual(["workflow.steps", "workflow.add", "workflow.new-items"]);
    expect([...workflow.querySelectorAll<HTMLElement>("li.workflow-row")].map((r) => r.dataset["step"])).toEqual(["now", "next", "later", "done"]);
    typeSearch(m.root(), "add step");
    expect([navItems(m.root()), [...nav(m.root()).querySelectorAll<HTMLElement>("button.settings-nav-row")].map((b) => b.dataset["row"])]).toEqual([["Workflow"], ["workflow.add"]]);
    await t.session.close();
  });

  it("Esc in the Workflow colour popover closes the popover and leaves Settings open", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session, section: "workflow" });
    const root = m.root();
    fireEvent.click(within(root).getByRole("button", { name: "Colour · Now" }));
    const pop = within(root).getByRole("dialog", { name: "Colour · Now" });
    expect(pop.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? pop, { key: "Escape" });
    expect([within(root).queryByRole("dialog", { name: "Colour · Now" }), root.isConnected, m.root().getAttribute("aria-label")]).toEqual([null, true, "Workflow"]);
    await t.session.close();
  });

  it("Workflow renders its steps in the list form on its pushed page in the phone sheet, with Edit in the bar", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ frame: "sheet", t, root: true });
    const sheet = m.view.getByRole("dialog", { name: "Settings" });
    fireEvent.click(rootRow(sheet, "workflow"));
    const page = pageEl(sheet, "workflow");
    expect([
      barTitle(sheet),
      page.hidden,
      [...page.querySelectorAll<HTMLElement>('ul.ios-list[data-list="workflow"] li.ios-row[data-step]')].map((r) => r.dataset["step"]),
      page.querySelector("button.ios-add")?.textContent,
      page.querySelectorAll("li.workflow-row").length,
      sheet.querySelector(".sheet-head .sheet-actions button.sheet-edit")?.textContent,
    ]).toEqual(["Workflow", false, ["now", "next", "later", "done"], "+Add step", 0, "Edit"]);
    await t.session.close();
  });

  it("Overview shows the name as text when the plan is read-only", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({
      session: t.session,
      section: "overview",
      readOnly: true,
    });
    const overview = sectionEl(m.root(), "overview");
    expect([within(overview).queryByRole("textbox"), overview.querySelector(".settings-control")?.textContent]).toEqual([null, t.session.view().plan.name]);
    await t.session.close();
  });

  it("Baselines saves, shows one at a time, renames and removes, without its own heading", async () => {
    const t = await testSession(MESA_SEED);
    act(() => {
      t.session.apply({ t: "baseline", op: "save", name: "Before" });
    });
    const m = mount({ session: t.session, section: "baselines" });
    const section = (): HTMLElement => sectionEl(m.root(), "baselines");
    expect([rowsOf(m.root(), "baselines"), section().querySelector("h2")]).toEqual([[["baselines.baselines", "Baselines"]], null]);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(section()).getByRole("button", { name: "Save baseline" }));
    expect(apply.mock.calls).toEqual([[{ t: "baseline", op: "save", name: "Baseline 9 Nov 2026" }]]);
    const idOf = (name: string): string => {
      const found = [...t.session.view().plan.baselines.values()].find((b) => b.name === name);
      if (found === undefined) throw new Error("no baseline " + name);
      return found.id;
    };
    const rowOf = (name: string): HTMLElement => {
      const row = section().querySelector<HTMLElement>(`[data-baseline="${idOf(name)}"]`);
      if (row === null) throw new Error("no row for " + name);
      return row;
    };
    fireEvent.click(within(rowOf("Before")).getByRole("button", { name: "Show" }));
    expect(m.uiNow().baseline).toBe(idOf("Before"));
    fireEvent.click(within(rowOf("Baseline 9 Nov 2026")).getByRole("button", { name: "Show" }));
    expect([m.uiNow().baseline, within(rowOf("Before")).queryByRole("button", { name: "Hide" })]).toEqual([idOf("Baseline 9 Nov 2026"), null]);
    fireEvent.click(within(rowOf("Baseline 9 Nov 2026")).getByRole("button", { name: "Hide" }));
    expect(m.uiNow().baseline).toBeNull();
    const nameField = within(rowOf("Before")).getByLabelText("Baseline name");
    act(() => nameField.focus());
    act(() => nameField.blur());
    fireEvent.change(nameField, { target: { value: " Before " } });
    fireEvent.keyDown(nameField, { key: "Enter" });
    expect(apply.mock.calls).toHaveLength(1);
    fireEvent.change(nameField, { target: { value: "Kickoff" } });
    fireEvent.keyDown(nameField, { key: "Enter" });
    expect(apply.mock.calls[1]).toEqual([{ t: "baseline", op: "rename", id: idOf("Kickoff"), name: "Kickoff" }]);
    const kickoff = idOf("Kickoff");
    fireEvent.click(within(rowOf("Kickoff")).getByRole("button", { name: "Remove" }));
    expect([apply.mock.calls[2], section().querySelector(`[data-baseline="${kickoff}"]`)]).toEqual([[{ t: "baseline", op: "remove", id: kickoff }], null]);
    await t.session.close();
  });

  it("Baselines keeps Show and Hide and drops every writing control when read-only", async () => {
    const t = await testSession(MESA_SEED);
    act(() => {
      t.session.apply({ t: "baseline", op: "save", name: "Before" });
    });
    const m = mount({ session: t.session, section: "baselines", readOnly: true });
    const section = sectionEl(m.root(), "baselines");
    expect([section.querySelectorAll("input").length, section.textContent?.includes("Before")]).toEqual([0, true]);
    expect([within(section).queryByRole("button", { name: "Save baseline" }), within(section).queryByRole("button", { name: "Remove" })]).toEqual([null, null]);
    fireEvent.click(within(section).getByRole("button", { name: "Show" }));
    expect(within(section).getByRole("button", { name: "Hide" })).toBeTruthy();
    await t.session.close();
  });

  it("Danger zone offers Move to Trash and says how to delete forever, with no Duplicate", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session, section: "danger" });
    const danger = sectionEl(m.root(), "danger");
    const name = t.session.view().plan.name;
    expect(rowsOf(m.root(), "danger")).toEqual([
      ["danger.trash", "Move to Trash"],
      ["danger.delete", "Delete forever"],
    ]);
    const trash = within(danger).getByRole("button", { name: "Move to Trash" });
    expect([trash.className, [...danger.querySelectorAll("p.settings-line")].map((p) => p.textContent), [...danger.querySelectorAll("button")].map((b) => b.textContent)]).toEqual([
      "button-danger",
      [`Moves “${name}” to the Trash. Restore it from the plan list's Trash.`, "To delete this plan forever, move it to the Trash, then choose Delete forever there."],
      ["Move to Trash"],
    ]);
    await t.session.close();
  });

  it("Move to Trash closes Settings first, then trashes the open plan", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session, section: "danger" });
    fireEvent.click(
      within(sectionEl(m.root(), "danger")).getByRole("button", {
        name: "Move to Trash",
      }),
    );
    expect([m.onClose.mock.calls.length, m.onTrashPlan.mock.calls]).toEqual([1, [[t.session.view().plan.id]]]);
    expect(m.onClose.mock.invocationCallOrder[0]).toBeLessThan(m.onTrashPlan.mock.invocationCallOrder[0]);
    await t.session.close();
  });

  it("Move to Trash stops when Settings does not close, as on a calendar ask", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session, section: "danger" });
    const refused = vi.fn<(r: CloseReason) => boolean>(() => false);
    m.closer.current = refused;
    fireEvent.click(
      within(sectionEl(m.root(), "danger")).getByRole("button", {
        name: "Move to Trash",
      }),
    );
    expect([refused.mock.calls.map((c) => c[0]), m.onClose.mock.calls.length, m.onTrashPlan.mock.calls.length]).toEqual([["x"], 0, 0]);
    await t.session.close();
  });

  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, true],
  ])("Move to Trash is disabled as in the plan list (locked %s, read-only %s)", async (planLocked, readOnly, disabled) => {
    const t = await testSession(MESA_SEED);
    const m = mount({
      session: t.session,
      section: "danger",
      planLocked,
      readOnly,
    });
    const trash = within(sectionEl(m.root(), "danger")).getByRole("button", {
      name: "Move to Trash",
    });
    expect(trash instanceof HTMLButtonElement && trash.disabled).toBe(disabled);
    await t.session.close();
  });

  it("a search for a plan row jumps into the plan group", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session });
    typeSearch(m.root(), "forever");
    expect([...nav(m.root()).querySelectorAll<HTMLElement>("button.settings-nav-row")].map((b) => b.dataset["row"])).toEqual(["danger.delete"]);
    typeSearch(m.root(), "trash");
    expect([...nav(m.root()).querySelectorAll<HTMLElement>("button.settings-nav-row")].map((b) => b.dataset["row"])).toEqual(["danger.trash"]);
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Move to Trash" }));
    expect([shownSection(m.root()), document.activeElement?.textContent]).toEqual([["danger"], "Move to Trash"]);
    await t.session.close();
  });

  it("a search for assignee, duration, undated, dated or group finds the Defaults rows", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session });
    const found = (q: string): (string[] | (string | undefined)[])[] => {
      typeSearch(m.root(), q);
      return [navItems(m.root()), [...nav(m.root()).querySelectorAll<HTMLElement>("button.settings-nav-row")].map((b) => b.dataset["row"])];
    };
    expect([found("assignee"), found("duration"), found("undated"), found("dated"), found("group")]).toEqual([
      [["Defaults"], ["defaults.assignee"]],
      [["Defaults"], ["defaults.duration"]],
      [["Defaults"], ["defaults.dated", "defaults.step"]],
      [["Defaults"], ["defaults.dated", "defaults.step"]],
      [["Defaults"], ["defaults.group"]],
    ]);
    typeSearch(m.root(), "assignee");
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Default assignee" }));
    expect([shownSection(m.root()), m.root().getAttribute("aria-label"), document.activeElement?.getAttribute("data-pick")]).toEqual([["defaults"], "Defaults", "who"]);
    expect(rowsOf(m.root(), "defaults")).toEqual([
      ["defaults.duration", "New task duration"],
      ["defaults.dated", "New items are"],
      ["defaults.assignee", "Default assignee"],
      ["defaults.group", "Board + puts items in"],
      ["defaults.step", "Step for new undated items"],
    ]);
    await t.session.close();
  });

  it("Add people in Settings… in Defaults opens People on Add person", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ session: t.session, section: "defaults" });
    fireEvent.click(within(sectionEl(m.root(), "defaults")).getByRole("button", { name: "Default assignee: Nobody" }));
    fireEvent.click(within(m.root()).getByRole("menuitem", { name: "Add people in Settings…" }));
    expect([m.onSection.mock.calls, shownSection(m.root()), document.activeElement?.textContent]).toEqual([[["people"]], ["people"], "+ Add person"]);
    await t.session.close();
  });

  it("Defaults renders its rows and status line on its page in the phone sheet, where Add people in Settings… pushes People on Add person", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ frame: "sheet", t, section: "defaults" });
    const sheet = m.view.getByRole("dialog", { name: "Settings" });
    const page = pageEl(sheet, "defaults");
    expect([barTitle(sheet), [...page.querySelectorAll<HTMLElement>(".defaults-row")].map((r) => r.dataset["settingsRow"]), page.querySelectorAll('p.defaults-line[role="status"]').length]).toEqual([
      "Defaults",
      ["defaults.duration", "defaults.dated", "defaults.assignee", "defaults.group", "defaults.step"],
      1,
    ]);
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    fireEvent.click(within(page).getByRole("button", { name: "Default assignee: Nobody" }));
    fireEvent.click(within(sheet).getByRole("menuitem", { name: "Add people in Settings…" }));
    const add = pageEl(sheet, "people").querySelector('[data-settings-row="people.add"]');
    expect([m.onSection.mock.calls, barTitle(sheet), shownPages(sheet), scrolled.mock.contexts, document.activeElement?.textContent, back(sheet).getAttribute("aria-label")]).toEqual([
      [["people"]],
      "People",
      ["people"],
      [add],
      "+Add person",
      "Back to Settings",
    ]);
    await t.session.close();
  });

  it("a plan change on a plan section goes to General, and keeps the saved place", async () => {
    const a = await testSession(MESA_SEED);
    const b = await testSession(MESA_SEED, { plan: "plan0000002" });
    const m = mount({ session: a.session, section: "baselines" });
    expect(shownSection(m.root())).toEqual(["baselines"]);
    m.plan(b.session);
    expect([m.onSection.mock.lastCall, shownSection(m.root())]).toEqual([["general"], ["general"]]);
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe(JSON.stringify({ v: 1, at: "baselines" }));
    await a.session.close();
    await b.session.close();
  });

  it("a plan section asked for after a plan change opens on the new plan", async () => {
    const a = await testSession(MESA_SEED);
    const b = await testSession(MESA_SEED, { plan: "plan0000002" });
    const m = mount({ session: a.session });
    m.plan(b.session);
    m.show("baselines");
    expect([shownSection(m.root()), m.onSection.mock.calls]).toEqual([["baselines"], []]);
    m.show("general");
    m.plan(a.session);
    m.show("overview");
    expect(shownSection(m.root())).toEqual(["overview"]);
    await a.session.close();
    await b.session.close();
  });

  it("locks Move to Trash for a listed plan in a read-only space, and for an open plan the list does not hold", () => {
    const listing = (space: string | null): PlanListing => ({ id: "plan0000001", name: "MESA 1.0", trashed: false, loaded: true, space, example: false });
    expect([
      trashLocked([listing(null)], "plan0000001", true),
      trashLocked([listing("sp000000000")], "plan0000001", false),
      trashLocked([listing("sp000000000")], "plan0000001", true),
      trashLocked([], "plan0000001", false),
      trashLocked([], null, true),
    ]).toEqual([false, false, true, true, false]);
  });
});

describe("Working time", () => {
  const ASK = "Discard calendar changes?";
  const settingsRoot = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('[data-settings-modal], .sheet[aria-label="Settings"]');
    if (el === null) throw new Error("no Settings");
    return el;
  };
  const working = (): HTMLElement => {
    const el = settingsRoot().querySelector<HTMLElement>('section[data-section="working-time"]');
    if (el === null) throw new Error("no Working time section");
    return el;
  };
  const weekday = (name: string): HTMLElement => within(within(working()).getByRole("group", { name: "Working days" })).getByRole("button", { name });
  const action = (name: string): HTMLButtonElement => {
    const b = within(working()).getByRole("button", { name });
    if (!(b instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`);
    return b;
  };
  const review = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Review changes"]');
  const shownReview = (): HTMLElement => {
    const el = review();
    if (el === null) throw new Error("no Review changes");
    return el;
  };
  const impactLine = (): string | null => working().querySelector(".impact")?.textContent ?? null;

  it("shows today's calendar body inline, with its rows anchored and the live impact line", async () => {
    const t = await testSession(MESA_SEED);
    mount({ t, section: "working-time" });
    expect([settingsRoot().getAttribute("aria-label"), working().querySelector(".cal-body") !== null]).toEqual(["Working time", true]);
    expect([...working().querySelectorAll<HTMLElement>("[data-settings-row]")].map((r) => r.dataset["settingsRow"])).toEqual([
      "working-time.region",
      "working-time.days",
      "working-time.closures",
      "working-time.days-off",
    ]);
    expect([impactLine(), action("Discard changes").disabled, action("Review changes…").disabled]).toEqual(["Applying changes no dates in this plan.", true, true]);
    expect(within(working()).queryByRole("button", { name: "Apply" })).toBeNull();
    expect(within(working()).queryByRole("button", { name: "Cancel" })).toBeNull();
    await t.session.close();
  });

  it("Review applies: it opens the impact with Cancel and Apply, and Apply writes the draft and starts afresh", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, section: "working-time" });
    const atOpen = t.session.view().plan.calendar;
    fireEvent.click(weekday("Fri"));
    const live = impactLine();
    expect([action("Discard changes").disabled, action("Review changes…").disabled]).toEqual([false, false]);
    fireEvent.click(action("Review changes…"));
    expect([review()?.querySelector(".review-impact")?.textContent, [...shownReview().querySelectorAll(".modal-actions button")].map((b) => b.textContent)]).toEqual([live, ["Cancel", "Apply"]]);
    fireEvent.click(within(shownReview()).getByRole("button", { name: "Cancel" }));
    expect([review(), weekday("Fri").getAttribute("aria-pressed")]).toEqual([null, "false"]);
    fireEvent.click(action("Review changes…"));
    fireEvent.keyDown(shownReview(), { key: "Escape" });
    expect([review(), m.onClose.mock.calls.length, within(document.body).queryByRole("alertdialog")]).toEqual([null, 0, null]);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(action("Review changes…"));
    fireEvent.click(within(shownReview()).getByRole("button", { name: "Apply" }));
    expect(apply).toHaveBeenCalledTimes(1);
    const intent = apply.mock.calls[0][0];
    if (intent.t !== "calendar") throw new Error("not a calendar intent");
    expect([intent.base, intent.next.workdays]).toEqual([atOpen, [1, 2, 3, 4]]);
    expect([review(), m.onClose.mock.calls.length, t.session.view().plan.calendar.workdays]).toEqual([null, 0, [1, 2, 3, 4]]);
    expect([weekday("Fri").getAttribute("aria-pressed"), action("Discard changes").disabled, action("Review changes…").disabled]).toEqual(["false", true, true]);
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    expect([working().contains(document.activeElement), document.activeElement?.className]).toEqual([true, "settings-calendar"]);
    await t.session.close();
  });

  it("Review changes is disabled while the plan is read-only", async () => {
    const t = await testSession(MESA_SEED);
    mount({ t, section: "working-time", readOnly: true });
    act(() => t.session.setReadOnly(true));
    fireEvent.click(weekday("Fri"));
    expect([action("Discard changes").disabled, action("Review changes…").disabled]).toEqual([false, true]);
    await t.session.close();
  });

  it("Discard resets the draft and the half-typed day off", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, section: "working-time" });
    fireEvent.click(weekday("Sat"));
    fireEvent.change(within(working()).getByLabelText("Day off name"), { target: { value: "Offsite" } });
    fireEvent.click(action("Discard changes"));
    const name = within(working()).getByLabelText("Day off name");
    expect([weekday("Sat").getAttribute("aria-pressed"), name instanceof HTMLInputElement && name.value, action("Discard changes").disabled, action("Review changes…").disabled]).toEqual([
      "false",
      "",
      true,
      true,
    ]);
    fireEvent.click(within(m.root()).getByRole("button", { name: "Close" }));
    expect([document.querySelector('[role="alertdialog"]'), m.onClose.mock.calls.length]).toEqual([null, 1]);
    await t.session.close();
  });

  it("switching keeps the draft", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, section: "working-time" });
    fireEvent.click(weekday("Sat"));
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Theme" }));
    expect(shownSection(m.root())).toEqual(["theme"]);
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Working time" }));
    expect([shownSection(m.root()), weekday("Sat").getAttribute("aria-pressed")]).toEqual([["working-time"], "true"]);
    await t.session.close();
  });

  it("close asks once for a calendar draft from any section, and Discard then closes", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, section: "working-time" });
    fireEvent.click(weekday("Sat"));
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "General" }));
    fireEvent.click(within(m.root()).getByRole("button", { name: "Close" }));
    const ask = (): HTMLElement | null => within(document.body).queryByRole("alertdialog", { name: ASK });
    const box = ask();
    if (box === null) throw new Error("no discard ask");
    expect(m.onClose).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByRole("button", { name: "Keep editing" }));
    expect([ask(), m.onClose.mock.calls.length]).toEqual([null, 0]);
    fireEvent.click(within(m.root()).getByRole("button", { name: "Close" }));
    const again = ask();
    if (again === null) throw new Error("no second discard ask");
    fireEvent.click(within(again).getByRole("button", { name: "Discard" }));
    expect(m.onClose).toHaveBeenCalledTimes(1);
    await t.session.close();
  });

  it("Move to Trash stops on a calendar ask", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, section: "working-time" });
    fireEvent.click(weekday("Sat"));
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Danger zone" }));
    fireEvent.click(within(sectionEl(m.root(), "danger")).getByRole("button", { name: "Move to Trash" }));
    expect([within(document.body).queryByRole("alertdialog", { name: ASK }) !== null, m.onClose.mock.calls.length, m.onTrashPlan.mock.calls.length]).toEqual([true, 0, 0]);
    await t.session.close();
  });

  it("Move to Trash goes on after Discard in the calendar ask, and not after Keep editing", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, section: "working-time" });
    fireEvent.click(weekday("Sat"));
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Danger zone" }));
    const trash = (): void => {
      fireEvent.click(within(sectionEl(m.root(), "danger")).getByRole("button", { name: "Move to Trash" }));
    };
    const ask = (): HTMLElement => within(document.body).getByRole("alertdialog", { name: ASK });
    trash();
    fireEvent.click(within(ask()).getByRole("button", { name: "Keep editing" }));
    expect([m.onClose.mock.calls.length, m.onTrashPlan.mock.calls.length]).toEqual([0, 0]);
    trash();
    fireEvent.click(within(ask()).getByRole("button", { name: "Discard" }));
    expect([m.onClose.mock.calls.length, m.onTrashPlan.mock.calls]).toEqual([1, [[t.session.view().plan.id]]]);
    expect(m.onClose.mock.invocationCallOrder[0]).toBeLessThan(m.onTrashPlan.mock.invocationCallOrder[0]);
    await t.session.close();
  });

  it("keeps the closer and an unapplied draft when the frame flips while open", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, section: "working-time" });
    fireEvent.click(weekday("Sat"));
    fireEvent.change(within(working()).getByLabelText("Day off name"), { target: { value: "Offsite" } });
    m.reframe("sheet");
    const name = within(working()).getByLabelText("Day off name");
    expect([settingsRoot().classList.contains("sheet"), weekday("Sat").getAttribute("aria-pressed"), name instanceof HTMLInputElement && name.value, action("Discard changes").disabled]).toEqual([
      true,
      "true",
      "Offsite",
      false,
    ]);
    m.reframe("modal");
    expect([settingsRoot().hasAttribute("data-settings-modal"), weekday("Sat").getAttribute("aria-pressed")]).toEqual([true, "true"]);
    const close = m.closer.current;
    if (close === null) throw new Error("no closer");
    act(() => {
      close("x");
    });
    expect([within(document.body).queryByRole("alertdialog", { name: ASK }) !== null, m.onClose.mock.calls.length]).toEqual([true, 0]);
    await t.session.close();
  });

  it("a frame flip after an apply starts from the plan's calendar, not the applied draft", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, section: "working-time" });
    fireEvent.click(weekday("Fri"));
    fireEvent.click(action("Review changes…"));
    fireEvent.click(within(shownReview()).getByRole("button", { name: "Apply" }));
    m.reframe("sheet");
    expect([weekday("Fri").getAttribute("aria-pressed"), action("Discard changes").disabled, action("Review changes…").disabled]).toEqual(["false", true, true]);
    await t.session.close();
  });

  it("a Working days row entry opens the section and focuses Mon", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t });
    typeSearch(m.root(), "working days");
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Working days" }));
    expect([shownSection(m.root()), document.activeElement?.textContent]).toEqual([["working-time"], "Mon"]);
    await t.session.close();
  });

  it("reviews in a sheet in the sheet frame", async () => {
    const t = await testSession(MESA_SEED);
    mount({ t, frame: "sheet", section: "working-time" });
    fireEvent.click(weekday("Fri"));
    fireEvent.click(action("Review changes…"));
    expect([shownReview().classList.contains("sheet"), within(shownReview()).getByRole("button", { name: "Close" }) !== null]).toEqual([true, true]);
    await t.session.close();
  });
});

describe("Settings in the sheet frame", () => {
  const ASK = "Discard calendar changes?";
  const sheetNow = (m: ReturnType<typeof mount>): HTMLElement => m.view.getByRole("dialog", { name: "Settings" });
  const rowsIn = (sheet: HTMLElement, group: string): (string | undefined)[][] =>
    [...rootList(sheet).querySelectorAll<HTMLElement>(`div.settings-root-group[data-group="${group}"] button.settings-root-row`)].map((b) => [
      b.dataset["section"],
      b.querySelector(".settings-root-name")?.textContent ?? undefined,
      b.querySelector(".settings-chev")?.getAttribute("aria-hidden") ?? undefined,
    ]);

  it("opens on the root: an untitled App group, then the plan's group under the plan's name, with no search", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ frame: "sheet", t, root: true });
    const sheet = sheetNow(m);
    const groups = [...rootList(sheet).querySelectorAll<HTMLElement>("div.settings-root-group")];
    expect([
      sheet.classList.contains("sheet"),
      barTitle(sheet),
      sheet.querySelector(".sheet-back"),
      rootList(sheet).hidden,
      groups.map((g) => [g.dataset["group"], g.querySelector("h2.settings-root-title")?.textContent ?? null]),
      within(sheet).getByRole("group", { name: "App" }) === groups[0],
      within(sheet).getByRole("group", { name: t.session.view().plan.name }) === groups[1],
      within(sheet).queryByRole("searchbox"),
      sheet.querySelectorAll("section.settings-page").length,
    ]).toEqual([
      true,
      "Settings",
      null,
      false,
      [
        ["app", null],
        ["plan", t.session.view().plan.name],
      ],
      true,
      true,
      null,
      0,
    ]);
    expect([rowsIn(sheet, "app"), rowsIn(sheet, "plan")]).toEqual([
      [
        ["general", "General", "true"],
        ["theme", "Theme", "true"],
        ["sync", "Sync", "true"],
        ["files", "Import & export", "true"],
      ],
      [
        ["overview", "Overview", "true"],
        ["people", "People", "true"],
        ["workflow", "Workflow", "true"],
        ["working-time", "Working time", "true"],
        ["defaults", "Defaults", "true"],
        ["baselines", "Baselines", "true"],
        ["danger", "Danger zone", "true"],
      ],
    ]);
    await t.session.close();
  });

  it("has only the App group without a plan, and General shows the update line once pushed", () => {
    const m = mount({ frame: "sheet", updates: fakeUpdates(), root: true });
    const sheet = sheetNow(m);
    expect([rootList(sheet).querySelectorAll("div.settings-root-group").length, sheet.querySelector(".settings-root-title"), rowsIn(sheet, "app").map((r) => r[0])]).toEqual([
      1,
      null,
      ["general", "theme", "sync", "files"],
    ]);
    fireEvent.click(rootRow(sheet, "general"));
    expect([barTitle(sheet), within(pageEl(sheet, "general")).getByText("WebBoard 9.9.9 is available") !== null]).toEqual(["General", true]);
  });

  it("a row pushes its page with its title and Back; Back returns to the root where it was and focuses the row", () => {
    const m = mount({ frame: "sheet", root: true });
    const sheet = sheetNow(m);
    sheetBody(sheet).scrollTop = 120;
    fireEvent.click(rootRow(sheet, "sync"));
    expect([m.onRoot.mock.calls, m.onSection.mock.calls, barTitle(sheet), sheet.getAttribute("aria-label"), rootList(sheet).hidden, shownPages(sheet), sheetBody(sheet).scrollTop, document.activeElement === back(sheet), back(sheet).getAttribute("aria-label"), back(sheet).textContent]).toEqual([
      [[false]],
      [["sync"]],
      "Sync",
      "Settings",
      true,
      ["sync"],
      0,
      true,
      "Back to Settings",
      "‹",
    ]);
    fireEvent.click(back(sheet));
    expect([m.onRoot.mock.calls, barTitle(sheet), rootList(sheet).hidden, shownPages(sheet), pageEl(sheet, "sync").hidden, sheetBody(sheet).scrollTop, document.activeElement === rootRow(sheet, "sync"), sheet.querySelector(".sheet-back")]).toEqual([
      [[false], [true]],
      "Settings",
      false,
      [],
      true,
      120,
      true,
      null,
    ]);
    fireEvent.click(rootRow(sheet, "theme"));
    expect([shownPages(sheet), [...sheet.querySelectorAll<HTMLElement>("section.settings-page")].map((s) => s.dataset["section"])]).toEqual([["theme"], ["theme", "sync"]]);
  });

  it("a directed section opens on its page", () => {
    const m = mount({ frame: "sheet", section: "sync" });
    const sheet = sheetNow(m);
    expect([barTitle(sheet), back(sheet).getAttribute("aria-label"), rootList(sheet).hidden, shownPages(sheet), m.onRoot.mock.calls]).toEqual(["Sync", "Back to Settings", true, ["sync"], []]);
  });

  it("the root saves nothing; a push saves its section", () => {
    const m = mount({ frame: "sheet", root: true, section: "sync" });
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
    fireEvent.click(rootRow(sheetNow(m), "theme"));
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe(JSON.stringify({ v: 1, at: "theme" }));
  });

  it("a plan page without a plan shows General", () => {
    const m = mount({ frame: "sheet", section: "people" });
    const sheet = sheetNow(m);
    expect([m.onSection.mock.lastCall, barTitle(sheet), shownPages(sheet)]).toEqual([["general"], "General", ["general"]]);
  });

  it("a plan change on a plan page shows General", async () => {
    const a = await testSession(MESA_SEED);
    const b = await testSession(MESA_SEED, { plan: "plan0000002" });
    const m = mount({ frame: "sheet", session: a.session, section: "baselines" });
    expect(barTitle(sheetNow(m))).toBe("Baselines");
    m.plan(b.session);
    expect([m.onSection.mock.lastCall, barTitle(sheetNow(m)), shownPages(sheetNow(m))]).toEqual([["general"], "General", ["general"]]);
    await a.session.close();
    await b.session.close();
  });

  it("a calendar draft still asks after Back", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ frame: "sheet", t, section: "working-time" });
    const sheet = sheetNow(m);
    fireEvent.click(within(within(pageEl(sheet, "working-time")).getByRole("group", { name: "Working days" })).getByRole("button", { name: "Sat" }));
    fireEvent.click(back(sheet));
    expect([rootList(sheet).hidden, pageEl(sheet, "working-time").hidden]).toEqual([false, true]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect([within(document.body).queryByRole("alertdialog", { name: ASK }) !== null, m.onClose.mock.calls.length]).toEqual([true, 0]);
    await t.session.close();
  });

  it("a settingsRow jump from the root pushes the page, scrolls the row in and focuses it", async () => {
    const t = await testSession(MESA_SEED);
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    const m = mount({ frame: "sheet", t, root: true, row: "me" });
    expect(m.onRoot.mock.calls).toEqual([[false]]);
    m.rooted(false);
    const sheet = sheetNow(m);
    const row = pageEl(sheet, "general").querySelector('[data-settings-row="general.me"]');
    expect([m.onRoot.mock.calls, barTitle(sheet), shownPages(sheet), scrolled.mock.contexts, document.activeElement?.matches('button.settings-pick[data-pick="me"]'), m.onRowShown.mock.calls.length]).toEqual([
      [[false]],
      "General",
      ["general"],
      [row],
      true,
      1,
    ]);
    await t.session.close();
  });

  it.each([
    ["the root", "root"],
    ["a section page", "page"],
    ["a person page, from Back", "person"],
    ["a person page, from the name field after the field's own Escape", "person-name"],
    ["a step page", "step"],
  ] as const)("Escape closes from %s", async (_where, at) => {
    const t = await testSession(MESA_SEED);
    act(() => {
      t.session.apply({ t: "person", op: "add", name: "Mira Okafor", initials: "MO", colour: "violet", after: null });
    });
    const person = t.session.view().people.people[0].id;
    const m = mount({ frame: "sheet", t, root: at === "root", section: at === "root" || at === "page" ? "theme" : at === "step" ? "workflow" : "people" });
    const sheet = sheetNow(m);
    const open = (sel: string): void => {
      const el = sheet.querySelector<HTMLElement>(sel);
      if (el === null) throw new Error(`no ${sel}`);
      fireEvent.click(el);
    };
    if (at === "person" || at === "person-name") open(`li.ios-row[data-person="${person}"] button.ios-row-main`);
    if (at === "step") open('li.ios-row[data-step="later"] button.ios-row-main');
    const field = sheet.querySelector<HTMLElement>('section[data-detail="person"] input.people-name');
    const target = at === "root" ? rootRow(sheet, "theme") : at === "person-name" ? field : back(sheet);
    if (target === null) throw new Error("no name field");
    act(() => {
      target.focus();
    });
    fireEvent.keyDown(target, { key: "Escape" });
    const reverted = m.onClose.mock.calls.length;
    if (at === "person-name") fireEvent.keyDown(document.activeElement ?? sheet, { key: "Escape" });
    expect(reverted).toBe(at === "person-name" ? 0 : 1);
    expect([barTitle(sheet), m.onClose.mock.calls.length]).toEqual([at === "root" ? "Settings" : at === "page" ? "Theme" : at === "step" ? "Later" : "Mira Okafor", 1]);
    await t.session.close();
  });

  it.each([
    ["person", "people", 'li.ios-row[data-person] button.ios-row-main'],
    ["step", "workflow", 'li.ios-row[data-step="later"] button.ios-row-main'],
  ] as const)("a plan that closes under a %s page shows General", async (kind, section, row) => {
    const t = await testSession(MESA_SEED);
    act(() => {
      t.session.apply({ t: "person", op: "add", name: "Mira Okafor", initials: "MO", colour: "violet", after: null });
    });
    const m = mount({ frame: "sheet", t, section });
    const sheet = sheetNow(m);
    const main = sheet.querySelector<HTMLElement>(row);
    if (main === null) throw new Error("no row");
    fireEvent.click(main);
    expect(sheet.querySelector(`section.settings-page[data-detail="${kind}"]`)).not.toBeNull();
    m.plan(null);
    expect([barTitle(sheetNow(m)), sheetNow(m).querySelector("section.settings-page[data-detail]"), shownPages(sheetNow(m)), back(sheetNow(m)).getAttribute("aria-label"), m.onSection.mock.lastCall]).toEqual([
      "General",
      null,
      ["general"],
      "Back to Settings",
      ["general"],
    ]);
    await t.session.close();
  });

  it("a section chosen in the modal opened on the root is the page a flip to the sheet shows", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, root: true, section: "general" });
    fireEvent.click(within(nav(m.root())).getByRole("button", { name: "Workflow" }));
    expect(m.onRoot.mock.calls).toEqual([[false]]);
    m.reframe("sheet");
    const sheet = sheetNow(m);
    expect([barTitle(sheet), rootList(sheet).hidden, shownPages(sheet), back(sheet).getAttribute("aria-label")]).toEqual(["Workflow", true, ["workflow"], "Back to Settings"]);
    await t.session.close();
  });

  it("a modal opened on the root that stays on its section keeps the root for a flip to the sheet", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ t, root: true, section: "general" });
    m.reframe("sheet");
    expect([m.onRoot.mock.calls, barTitle(sheetNow(m)), rootList(sheetNow(m)).hidden]).toEqual([[], "Settings", false]);
    await t.session.close();
  });

  it("a jump to a row with nothing enabled to focus focuses Back", async () => {
    const t = await testSession(MESA_SEED);
    expect(t.session.view().people.people).toEqual([]);
    setPlatform(IPHONE);
    const m = mount({ frame: "sheet", t, section: "people", row: "add", readOnly: true });
    const sheet = sheetNow(m);
    expect([barTitle(sheet), pageEl(sheet, "people").querySelector<HTMLButtonElement>("button.ios-add")?.disabled, document.activeElement === back(sheet), back(sheet).getAttribute("aria-label")]).toEqual([
      "People",
      true,
      true,
      "Back to Settings",
    ]);
    await t.session.close();
  });

  describe("People", () => {
    const crew = async (): Promise<{ t: TestSession; ids: string[] }> => {
      const t = await testSession(MESA_SEED);
      act(() => {
        t.session.apply({ t: "person", op: "add", name: "Mira Okafor", initials: "MO", colour: "violet", after: null });
      });
      act(() => {
        t.session.apply({ t: "person", op: "add", name: "Ole Berg", initials: "OB", colour: "lime", after: t.session.view().people.people[0].id });
      });
      return { t, ids: t.session.view().people.people.map((p) => p.id) };
    };
    const edit = (sheet: HTMLElement): HTMLButtonElement => {
      const el = sheet.querySelector<HTMLButtonElement>(".sheet-head .sheet-actions button.sheet-edit");
      if (el === null) throw new Error("no Edit");
      return el;
    };
    const personRow = (sheet: HTMLElement, id: string): HTMLElement => {
      const el = pageEl(sheet, "people").querySelector<HTMLElement>(`li.ios-row[data-person="${id}"]`);
      if (el === null) throw new Error(`no row for ${id}`);
      return el;
    };
    const detail = (sheet: HTMLElement): HTMLElement | null => sheet.querySelector<HTMLElement>('section.settings-page[data-detail="person"]');

    it("puts Edit in the bar of the People page only; Edit shows minus and grips, Done and Back end it", async () => {
      const { t, ids } = await crew();
      const m = mount({ frame: "sheet", t, section: "people" });
      const sheet = sheetNow(m);
      expect([edit(sheet).textContent, edit(sheet).getAttribute("aria-pressed"), edit(sheet).disabled, pageEl(sheet, "people").querySelectorAll("button.ios-minus").length]).toEqual(["Edit", null, false, 0]);
      fireEvent.click(edit(sheet));
      expect([edit(sheet).textContent, edit(sheet).getAttribute("aria-pressed"), pageEl(sheet, "people").querySelectorAll("button.ios-minus").length, pageEl(sheet, "people").querySelectorAll("button.ios-grip").length]).toEqual(["Done", null, ids.length, ids.length]);
      fireEvent.click(edit(sheet));
      expect([edit(sheet).textContent, pageEl(sheet, "people").querySelectorAll("button.ios-minus").length]).toEqual(["Edit", 0]);
      fireEvent.click(edit(sheet));
      fireEvent.click(back(sheet));
      expect(sheet.querySelector(".sheet-edit")).toBeNull();
      fireEvent.click(rootRow(sheet, "people"));
      expect([edit(sheet).textContent, pageEl(sheet, "people").querySelectorAll("button.ios-minus").length]).toEqual(["Edit", 0]);
      fireEvent.click(back(sheet));
      fireEvent.click(rootRow(sheet, "overview"));
      expect(sheet.querySelector(".sheet-edit")).toBeNull();
      await t.session.close();
    });

    it("disables Edit and Add when the plan is read-only", async () => {
      const { t } = await crew();
      const m = mount({ frame: "sheet", t, section: "people", readOnly: true });
      const sheet = sheetNow(m);
      expect([edit(sheet).disabled, pageEl(sheet, "people").querySelector<HTMLButtonElement>("button.ios-add")?.disabled]).toEqual([true, true]);
      await t.session.close();
    });

    it("a person row pushes the person page under the person's name; Back returns to People and focuses the row", async () => {
      const { t, ids } = await crew();
      const m = mount({ frame: "sheet", t, section: "people" });
      const sheet = sheetNow(m);
      sheetBody(sheet).scrollTop = 40;
      const main = personRow(sheet, ids[1]).querySelector<HTMLElement>("button.ios-row-main");
      if (main === null) throw new Error("no row main");
      fireEvent.click(main);
      const page = detail(sheet);
      expect([
        barTitle(sheet),
        sheet.getAttribute("aria-label"),
        back(sheet).getAttribute("aria-label"),
        document.activeElement === back(sheet),
        sheetBody(sheet).scrollTop,
        page?.hidden,
        page?.getAttribute("aria-label"),
        pageEl(sheet, "people").hidden,
        sheet.querySelector(".sheet-edit"),
        page?.querySelector<HTMLInputElement>("input.people-name")?.value,
      ]).toEqual(["Ole Berg", "Settings", "Back to People", true, 0, false, "Ole Berg", true, null, "Ole Berg"]);
      fireEvent.click(back(sheet));
      expect([barTitle(sheet), detail(sheet), pageEl(sheet, "people").hidden, sheetBody(sheet).scrollTop, document.activeElement === personRow(sheet, ids[1]).querySelector("button.ios-row-main"), back(sheet).getAttribute("aria-label"), m.onRoot.mock.calls]).toEqual([
        "People",
        null,
        false,
        40,
        true,
        "Back to Settings",
        [],
      ]);
      await t.session.close();
    });

    it("Add person pushes the new person's page with Initials focused", async () => {
      const { t } = await crew();
      const m = mount({ frame: "sheet", t, section: "people" });
      const sheet = sheetNow(m);
      const add = pageEl(sheet, "people").querySelector<HTMLElement>("button.ios-add");
      if (add === null) throw new Error("no Add");
      fireEvent.click(add);
      const draft = pageEl(sheet, "people").querySelector<HTMLInputElement>("li.ios-draft input.people-draft-name");
      if (draft === null) throw new Error("no draft");
      fireEvent.change(draft, { target: { value: "Dana Lee" } });
      fireEvent.keyDown(draft, { key: "Enter" });
      const initials = detail(sheet)?.querySelector<HTMLInputElement>("input.people-initials");
      expect([barTitle(sheet), document.activeElement === initials, initials?.value, back(sheet).getAttribute("aria-label")]).toEqual(["Dana Lee", true, "DL", "Back to People"]);
      await t.session.close();
    });

    it("Remove person on the person page pops back to People and focuses the next row", async () => {
      const { t, ids } = await crew();
      const m = mount({ frame: "sheet", t, section: "people" });
      const sheet = sheetNow(m);
      const main = personRow(sheet, ids[0]).querySelector<HTMLElement>("button.ios-row-main");
      if (main === null) throw new Error("no row main");
      fireEvent.click(main);
      const danger = detail(sheet)?.querySelector<HTMLElement>("button.settings-detail-danger");
      if (danger === undefined || danger === null) throw new Error("no Remove person");
      fireEvent.click(danger);
      fireEvent.click(within(within(document.body).getByRole("dialog", { name: "Remove person" })).getByRole("button", { name: "Remove" }));
      expect([barTitle(sheet), detail(sheet), [...pageEl(sheet, "people").querySelectorAll<HTMLElement>("li.ios-row[data-person]")].map((r) => r.dataset["person"]), document.activeElement === personRow(sheet, ids[1]).querySelector("button.ios-row-main")]).toEqual([
        "People",
        null,
        [ids[1]],
        true,
      ]);
      await t.session.close();
    });

    it("a person removed elsewhere leaves a line on the page, titled Person; Back focuses Add person", async () => {
      const { t, ids } = await crew();
      const m = mount({ frame: "sheet", t, section: "people" });
      const sheet = sheetNow(m);
      const main = personRow(sheet, ids[0]).querySelector<HTMLElement>("button.ios-row-main");
      if (main === null) throw new Error("no row main");
      fireEvent.click(main);
      act(() => {
        t.session.apply({ t: "person", op: "remove", person: ids[0], to: null });
      });
      expect([barTitle(sheet), detail(sheet)?.querySelector("p.settings-line")?.textContent, back(sheet).getAttribute("aria-label")]).toEqual(["Person", "This person is no longer in this plan.", "Back to People"]);
      fireEvent.click(back(sheet));
      expect([barTitle(sheet), document.activeElement === pageEl(sheet, "people").querySelector("button.ios-add")]).toEqual(["People", true]);
      await t.session.close();
    });

    it("on a read-only plan, Back from a person removed elsewhere focuses Back, since Add is disabled", async () => {
      const { t, ids } = await crew();
      const m = mount({ frame: "sheet", t, section: "people", readOnly: true });
      const sheet = sheetNow(m);
      const main = personRow(sheet, ids[0]).querySelector<HTMLElement>("button.ios-row-main");
      if (main === null) throw new Error("no row main");
      fireEvent.click(main);
      act(() => {
        t.session.apply({ t: "person", op: "remove", person: ids[0], to: null });
      });
      act(() => {
        sheet.focus();
      });
      fireEvent.click(back(sheet));
      expect([barTitle(sheet), document.activeElement === back(sheet), back(sheet).getAttribute("aria-label")]).toEqual(["People", true, "Back to Settings"]);
      await t.session.close();
    });

    it("a plan that turns read-only ends Edit, which stays off when it turns writable again", async () => {
      const { t } = await crew();
      const m = mount({ frame: "sheet", t, section: "people" });
      const sheet = sheetNow(m);
      fireEvent.click(edit(sheet));
      expect([edit(sheet).textContent, pageEl(sheet, "people").querySelectorAll("button.ios-minus").length]).toEqual(["Done", 2]);
      m.lock(true);
      expect([edit(sheet).textContent, edit(sheet).disabled]).toEqual(["Edit", true]);
      m.lock(false);
      expect([edit(sheet).textContent, edit(sheet).disabled, pageEl(sheet, "people").querySelectorAll("button.ios-minus").length, pageEl(sheet, "people").querySelectorAll("button.ios-grip").length]).toEqual([
        "Edit",
        false,
        0,
        0,
      ]);
      await t.session.close();
    });
  });

  describe("Workflow", () => {
    const edit = (sheet: HTMLElement): HTMLButtonElement => {
      const el = sheet.querySelector<HTMLButtonElement>(".sheet-head .sheet-actions button.sheet-edit");
      if (el === null) throw new Error("no Edit");
      return el;
    };
    const stepRow = (sheet: HTMLElement, id: string): HTMLElement => {
      const el = pageEl(sheet, "workflow").querySelector<HTMLElement>(`li.ios-row[data-step="${id}"]`);
      if (el === null) throw new Error(`no row for ${id}`);
      return el;
    };
    const openStep = (sheet: HTMLElement, id: string): void => {
      const main = stepRow(sheet, id).querySelector<HTMLElement>("button.ios-row-main");
      if (main === null) throw new Error("no row main");
      fireEvent.click(main);
    };
    const detail = (sheet: HTMLElement): HTMLElement | null => sheet.querySelector<HTMLElement>('section.settings-page[data-detail="step"]');

    it("puts Edit in the bar of the Workflow page; Edit shows minus and grips, Done and Back end it", async () => {
      const t = await testSession(MESA_SEED);
      const m = mount({ frame: "sheet", t, section: "workflow" });
      const sheet = sheetNow(m);
      const page = pageEl(sheet, "workflow");
      expect([edit(sheet).textContent, edit(sheet).getAttribute("aria-pressed"), page.querySelectorAll("button.ios-minus").length]).toEqual(["Edit", null, 0]);
      fireEvent.click(edit(sheet));
      expect([edit(sheet).textContent, edit(sheet).getAttribute("aria-pressed"), page.querySelectorAll("button.ios-minus").length, page.querySelectorAll("button.ios-grip").length, page.querySelector("p.settings-foot")?.textContent]).toEqual([
        "Done",
        null,
        4,
        4,
        "Drag a handle to reorder, tap the red minus to delete. Tap Done when finished.",
      ]);
      fireEvent.click(edit(sheet));
      expect([edit(sheet).textContent, page.querySelectorAll("button.ios-minus").length]).toEqual(["Edit", 0]);
      fireEvent.click(edit(sheet));
      fireEvent.click(back(sheet));
      fireEvent.click(rootRow(sheet, "workflow"));
      expect([edit(sheet).textContent, page.querySelectorAll("button.ios-minus").length]).toEqual(["Edit", 0]);
      await t.session.close();
    });

    it("disables Edit and Add when the plan is read-only", async () => {
      const t = await testSession(MESA_SEED);
      const m = mount({ frame: "sheet", t, section: "workflow", readOnly: true });
      const sheet = sheetNow(m);
      expect([edit(sheet).disabled, pageEl(sheet, "workflow").querySelector<HTMLButtonElement>("button.ios-add")?.disabled]).toEqual([true, true]);
      await t.session.close();
    });

    it("a step row pushes the step page under the step's name; Back returns to Workflow and focuses the row", async () => {
      const t = await testSession(MESA_SEED);
      const m = mount({ frame: "sheet", t, section: "workflow" });
      const sheet = sheetNow(m);
      sheetBody(sheet).scrollTop = 30;
      openStep(sheet, "later");
      const page = detail(sheet);
      expect([
        barTitle(sheet),
        sheet.getAttribute("aria-label"),
        back(sheet).getAttribute("aria-label"),
        document.activeElement === back(sheet),
        sheetBody(sheet).scrollTop,
        page?.hidden,
        page?.getAttribute("aria-label"),
        pageEl(sheet, "workflow").hidden,
        sheet.querySelector(".sheet-edit"),
        page?.querySelector<HTMLInputElement>("input.workflow-name")?.value,
        page?.querySelector('button.switch[role="switch"]')?.getAttribute("aria-label"),
      ]).toEqual(["Later", "Settings", "Back to Workflow", true, 0, false, "Later", true, null, "Later", "Later completes items"]);
      fireEvent.click(back(sheet));
      expect([barTitle(sheet), detail(sheet), pageEl(sheet, "workflow").hidden, sheetBody(sheet).scrollTop, document.activeElement === stepRow(sheet, "later").querySelector("button.ios-row-main"), back(sheet).getAttribute("aria-label"), m.onRoot.mock.calls]).toEqual([
        "Workflow",
        null,
        false,
        30,
        true,
        "Back to Settings",
        [],
      ]);
      await t.session.close();
    });

    it("a rename on the step page retitles the bar", async () => {
      const t = await testSession(MESA_SEED);
      const m = mount({ frame: "sheet", t, section: "workflow" });
      const sheet = sheetNow(m);
      openStep(sheet, "next");
      const name = detail(sheet)?.querySelector<HTMLInputElement>("input.workflow-name");
      if (name === null || name === undefined) throw new Error("no name");
      act(() => {
        name.focus();
      });
      fireEvent.change(name, { target: { value: "Review" } });
      fireEvent.keyDown(name, { key: "Enter" });
      expect([barTitle(sheet), detail(sheet)?.getAttribute("aria-label")]).toEqual(["Review", "Review"]);
      await t.session.close();
    });

    it("Add step pushes the new step's page with the name selected", async () => {
      const t = await testSession(MESA_SEED);
      const m = mount({ frame: "sheet", t, section: "workflow" });
      const sheet = sheetNow(m);
      const add = pageEl(sheet, "workflow").querySelector<HTMLElement>("button.ios-add");
      if (add === null) throw new Error("no Add");
      fireEvent.click(add);
      const name = detail(sheet)?.querySelector<HTMLInputElement>("input.workflow-name");
      expect([barTitle(sheet), document.activeElement === name, name?.value, name?.selectionStart, name?.selectionEnd, back(sheet).getAttribute("aria-label")]).toEqual([
        "New step",
        true,
        "New step",
        0,
        8,
        "Back to Workflow",
      ]);
      await t.session.close();
    });

    it("a step deleted from its page leaves the line, titled Step; Back focuses Add step", async () => {
      const t = await testSession(MESA_SEED);
      act(() => {
        t.session.apply({ t: "step", op: "add", name: "Spare", colour: "sky", after: "done" });
      });
      const id = stepsOf(t.session.view().plan).find((s) => s.name === "Spare")?.id;
      if (id === undefined) throw new Error("no Spare");
      const m = mount({ frame: "sheet", t, section: "workflow" });
      const sheet = sheetNow(m);
      openStep(sheet, id);
      const danger = detail(sheet)?.querySelector<HTMLElement>("button.settings-detail-danger");
      if (danger === undefined || danger === null) throw new Error("no Delete step");
      fireEvent.click(danger);
      fireEvent.click(within(within(document.body).getByRole("dialog", { name: "Delete step" })).getByRole("button", { name: "Delete" }));
      expect([barTitle(sheet), detail(sheet)?.querySelector("p.settings-line")?.textContent, back(sheet).getAttribute("aria-label")]).toEqual(["Step", "This step is no longer in this plan.", "Back to Workflow"]);
      fireEvent.click(back(sheet));
      expect([barTitle(sheet), document.activeElement === pageEl(sheet, "workflow").querySelector("button.ios-add")]).toEqual(["Workflow", true]);
      await t.session.close();
    });

    it("Back from a step page then Back again returns to the root at the Workflow row", async () => {
      const t = await testSession(MESA_SEED);
      const m = mount({ frame: "sheet", t, section: "workflow" });
      const sheet = sheetNow(m);
      openStep(sheet, "now");
      fireEvent.click(back(sheet));
      fireEvent.click(back(sheet));
      expect([barTitle(sheet), document.activeElement === rootRow(sheet, "workflow"), sheet.querySelector('section.settings-page[data-detail]')]).toEqual(["Settings", true, null]);
      await t.session.close();
    });
  });

  describe("an unsaved theme draft on iOS", () => {
    const SHEET_HEIGHT = 600;
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    };
    const draftOn = (sheet: HTMLElement): void => {
      const field = within(pageEl(sheet, "theme")).getByRole("textbox", { name: "Background hex" });
      fireEvent.change(field, { target: { value: "#222222" } });
      fireEvent.blur(field);
    };
    const closeX = (sheet: HTMLElement): void => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    };
    const swipeDown = (sheet: HTMLElement): void => {
      const head = sheet.querySelector<HTMLElement>(".sheet-head");
      if (head === null) throw new Error("no sheet head");
      vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 200, 390, SHEET_HEIGHT));
      const to = SHEET_HEIGHT * 0.25 + 10;
      fireEvent.pointerDown(head, { button: 0, pointerId: 7, pointerType: "touch", clientX: 100, clientY: 220 });
      fireEvent.pointerMove(head, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 220 + to / 2 });
      fireEvent.pointerMove(head, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 220 + to });
      fireEvent.pointerUp(head, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 220 + to });
    };
    const asks = (): unknown[] => tauri.calls.filter((c) => c.cmd === "alert_ask").map((c) => c.args);
    const theAsk = (guard: { title: string; message: string }): unknown => ({ ask: { title: guard.title, message: guard.message, confirm: { label: "Discard", destructive: true }, cancel: "Keep editing" } });

    beforeEach(() => {
      setPlatform(IPHONE);
    });

    afterEach(() => {
      resetTauri({});
      vi.restoreAllMocks();
    });

    it("names the theme draft", () => {
      expect(THEME_DRAFT).toEqual({ title: "Discard theme changes?", message: "Your colour changes are not saved yet." });
    });

    it.each([
      ["the X", closeX],
      ["a swipe down", swipeDown],
    ])("%s asks UIKit with the theme draft; Keep editing keeps the page and the draft", async (_how, close) => {
      resetTauri({ alert_ask: () => "cancel" });
      const m = mount({ frame: "sheet", section: "theme" });
      const sheet = sheetNow(m);
      draftOn(sheet);
      close(sheet);
      await settle();
      expect([asks(), m.onClose.mock.calls.length, barTitle(sheet), shownPages(sheet), voidNow(), vi.mocked(toast).mock.calls, within(document.body).queryByRole("alertdialog")]).toEqual([
        [theAsk(THEME_DRAFT)],
        0,
        "Theme",
        ["theme"],
        "#222222",
        [],
        null,
      ]);
    });

    it.each([
      ["the X", closeX],
      ["a swipe down", swipeDown],
    ])("%s with Discard closes and drops the draft without the toast", async (_how, close) => {
      resetTauri({ alert_ask: () => "confirm" });
      const m = mount({ frame: "sheet", section: "theme" });
      const sheet = sheetNow(m);
      draftOn(sheet);
      close(sheet);
      await settle();
      expect([asks(), m.onClose.mock.calls.length, vi.mocked(toast).mock.calls, voidNow()]).toEqual([[theAsk(THEME_DRAFT)], 1, [], CYBERDECK_VOID]);
    });

    it("closes at once without a draft, asking nothing", async () => {
      resetTauri({ alert_ask: () => "confirm" });
      const m = mount({ frame: "sheet", section: "theme" });
      closeX(sheetNow(m));
      await settle();
      expect([asks(), m.onClose.mock.calls.length, vi.mocked(toast).mock.calls]).toEqual([[], 1, []]);
    });

    it("toasts a failed ask and keeps the page and the draft", async () => {
      resetTauri({
        alert_ask: () => {
          throw { code: "alert.busy", message: "The alert cannot be shown: something else is already presented over the window." };
        },
      });
      const m = mount({ frame: "sheet", section: "theme" });
      const sheet = sheetNow(m);
      draftOn(sheet);
      closeX(sheet);
      await settle();
      expect([m.onClose.mock.calls.length, vi.mocked(toast).mock.calls.map((c) => [c[0], c[1]]), shownPages(sheet), voidNow()]).toEqual([
        0,
        [["The alert cannot be shown: something else is already presented over the window.", "bad"]],
        ["theme"],
        "#222222",
      ]);
    });

    it("a theme draft and a calendar draft ask once, naming both", async () => {
      resetTauri({ alert_ask: () => "cancel" });
      const t = await testSession(MESA_SEED);
      const m = mount({ frame: "sheet", t, section: "working-time" });
      const sheet = sheetNow(m);
      fireEvent.click(within(within(pageEl(sheet, "working-time")).getByRole("group", { name: "Working days" })).getByRole("button", { name: "Sat" }));
      fireEvent.click(back(sheet));
      fireEvent.click(rootRow(sheet, "theme"));
      draftOn(sheet);
      closeX(sheet);
      await settle();
      expect([asks(), m.onClose.mock.calls.length]).toEqual([[theAsk({ title: UNSAVED_TITLE, message: `${THEME_DRAFT.message} ${CALENDAR_DRAFT.message}` })], 0]);
      await t.session.close();
    });

    it("a phone-sized Mac window keeps the inline path and the toast", () => {
      setPlatform(MAC);
      const m = mount({ frame: "sheet", section: "theme" });
      const sheet = sheetNow(m);
      draftOn(sheet);
      closeX(sheet);
      expect([asks(), m.onClose.mock.calls.length, vi.mocked(toast).mock.calls]).toEqual([[], 1, [[DISCARDED]]]);
    });
  });

  it("discards a theme draft with the toast when the sheet closes", () => {
    const m = mount({ frame: "sheet", section: "theme" });
    const field = within(m.view.getByRole("dialog")).getByRole("textbox", {
      name: "Background hex",
    });
    fireEvent.change(field, { target: { value: "#222222" } });
    fireEvent.blur(field);
    fireEvent.click(within(m.view.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect([vi.mocked(toast).mock.calls, m.onClose.mock.calls.length, voidNow()]).toEqual([[[DISCARDED]], 1, CYBERDECK_VOID]);
  });
});
