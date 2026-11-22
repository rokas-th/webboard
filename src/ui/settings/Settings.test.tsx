import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { createRef, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import type { PlanSession } from "../../store/session";
import type { UpdateState, Updates } from "../../store/updates";
import type { SyncState } from "../../sync/manager";
import { fixedClock } from "../../services/clock";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { testRegistry } from "../../test/shell";
import { withSync } from "../../test/withSync";
import { MAC, setPlatform } from "../../test/platform";
import { DEFAULT_STORE } from "../../theme/store";
import { ThemeProvider } from "../../theme/ThemeContext";
import { HOLIDAY_ATTRIBUTION } from "../common/About";
import type { CloseReason } from "../common/dismiss";
import { toast } from "../common/Toast";
import { refusal } from "../../actions/copy";
import { OpenChoice } from "../run";
import { exportFlow } from "../shell/fileFlows";
import type { PlanFiles } from "../shell/selection";
import { UiContext, useUi, type SettingsSection, type SyncPane, type UiState } from "../state";
import { DISCARDED } from "../theme/ThemePanel";
import type { SettingsFrame } from "./frame";
import { SETTINGS_KEY } from "./lastSection";
import { SETTINGS_TITLE, SettingsView, trashLocked } from "./Settings";
import type { PlanListing } from "../../store/registry";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../common/Toast", () => ({ toast: vi.fn() }));
vi.mock("../shell/fileFlows", () => ({
  exportFlow: vi.fn(async () => undefined),
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
}

function UiHost(p: { seen: { current: UiState | null }; children: ReactNode }) {
  const [ui, setUi] = useUi();
  p.seen.current = ui;
  return <UiContext.Provider value={{ ui, setUi }}>{p.children}</UiContext.Provider>;
}

function mount(o: Opts = {}) {
  const onSection = vi.fn<(s: SettingsSection) => void>();
  const onClose = vi.fn<() => void>();
  const onSyncPane = vi.fn<(pane: SyncPane) => void>();
  const onTrashPlan = vi.fn<(id: string) => void>();
  const openChoice = vi.fn();
  const seen: { current: UiState | null } = { current: null };
  const closer = createRef<((r: CloseReason) => boolean) | null>();
  const files = fakeFiles();
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
  const ui = (section: SettingsSection, session: PlanSession | null, pane: SyncPane | null, frameNow: SettingsFrame) => synced(
    <OpenChoice.Provider value={openChoice}>
      <UiHost seen={seen}>
        <ThemeProvider storage={window.localStorage} initial={{ store: DEFAULT_STORE, unreadable: null }}>
          <SettingsView
            frame={frameNow}
            section={section}
            session={session}
            readOnly={o.readOnly ?? false}
            device="Rokas’s Mac"
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
          />
        </ThemeProvider>
      </UiHost>
    </OpenChoice.Provider>,
  );
  let section = o.section ?? "general";
  let session = o.session ?? o.t?.session ?? null;
  let pane: SyncPane | null = null;
  let frame = o.frame ?? "modal";
  const again = (): void => view.rerender(ui(section, session, pane, frame));
  const view = render(ui(section, session, pane, frame));
  onSection.mockImplementation((s) => {
    section = s;
    again();
  });
  onSyncPane.mockImplementation((k) => {
    pane = k;
    again();
  });
  return {
    view,
    onSection,
    onClose,
    onSyncPane,
    onTrashPlan,
    closer,
    files,
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

  it("General shows this device, the update line with an updater, and About", () => {
    const m = mount({ updates: fakeUpdates() });
    const general = sectionEl(m.root(), "general");
    const rows = [...general.querySelectorAll<HTMLElement>(".settings-row")];
    expect(rows.map((r) => [r.dataset["settingsRow"], r.querySelector(".settings-label")?.textContent])).toEqual([
      ["general.device", "This device"],
      ["general.updates", "Updates"],
      ["general.about", "About"],
    ]);
    expect(rows[0].querySelector(".settings-control")?.textContent).toBe("Rokas’s Mac");
    expect(within(rows[1]).getByText("WebBoard 9.9.9 is available")).toBeTruthy();
    expect(rows[2].querySelector("img.about-mark")?.getAttribute("src")).toBe("/logo-mark.svg");
    expect([...rows[2].querySelectorAll("p")].map((p) => p.textContent)).toEqual([`WebBoard ${version}`, HOLIDAY_ATTRIBUTION]);
  });

  it("General has no Updates row without an updater", () => {
    const m = mount();
    expect([...sectionEl(m.root(), "general").querySelectorAll<HTMLElement>(".settings-row")].map((r) => r.dataset["settingsRow"])).toEqual(["general.device", "general.about"]);
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
    expect(navItems(m.root())).toEqual(["General", "Theme", "Sync", "Import & export", "Overview", "Workflow", "Working time", "Baselines", "Danger zone"]);
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

  it("Workflow renders the same rows in the phone sheet", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ frame: "sheet", t });
    const group = m.view.getByRole("dialog", { name: "Settings" }).querySelector<HTMLElement>('section.settings-group[data-section="workflow"]');
    if (group === null) throw new Error("no Workflow group");
    expect([group.querySelector("h2")?.textContent, [...group.querySelectorAll<HTMLElement>("li.workflow-row")].map((r) => r.dataset["step"]), group.querySelector(".workflow-add")?.textContent]).toEqual([
      "Workflow",
      ["now", "next", "later", "done"],
      "+ Add step",
    ]);
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
  it("lists the plan sections after the plan's name", async () => {
    const t = await testSession(MESA_SEED);
    const m = mount({ frame: "sheet", t });
    const sheet = m.view.getByRole("dialog", { name: "Settings" });
    const list = sheet.querySelector(".settings-list");
    if (list === null) throw new Error("no list");
    const order = [...list.querySelectorAll<HTMLElement>("p.settings-list-plan, section.settings-group > h2")].map((el) => el.textContent);
    expect(order).toEqual(["General", "Theme", "Sync", "Import & export", t.session.view().plan.name, "Overview", "Workflow", "Working time", "Baselines", "Danger zone"]);
    await t.session.close();
  });

  it("is the Settings sheet listing every section as a group, headings in order, with no search", () => {
    const m = mount({ frame: "sheet", updates: fakeUpdates() });
    const sheet = m.view.getByRole("dialog", { name: "Settings" });
    expect(sheet.classList.contains("sheet")).toBe(true);
    expect(within(sheet).queryByRole("searchbox")).toBeNull();
    expect(sheet.querySelector(".settings-list")).not.toBeNull();
    expect([...sheet.querySelectorAll<HTMLElement>("section.settings-group")].map((s) => [s.dataset["section"], s.querySelector("h2.settings-group-title")?.textContent])).toEqual([
      ["general", "General"],
      ["theme", "Theme"],
      ["sync", "Sync"],
      ["files", "Import & export"],
    ]);
    expect(sheet.querySelector(".settings-list-plan")).toBeNull();
    expect(within(sheet).getByText("WebBoard 9.9.9 is available")).toBeTruthy();
  });

  it("scrolls the asked section's heading into view on open", () => {
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    const m = mount({ frame: "sheet", section: "sync" });
    const heading = m.view.getByRole("dialog").querySelector('section.settings-group[data-section="sync"] h2');
    expect(scrolled.mock.contexts).toEqual([heading]);
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
