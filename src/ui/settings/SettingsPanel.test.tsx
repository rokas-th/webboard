import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import type { UpdateState, Updates } from "../../store/updates";
import type { SyncState } from "../../sync/manager";
import { DEFAULT_STORE } from "../../theme/store";
import { ThemeProvider } from "../../theme/ThemeContext";
import { HOLIDAY_ATTRIBUTION } from "../common/About";
import { toast } from "../common/Toast";
import type { SettingsTab, SyncPane } from "../state";
import { DISCARDED } from "../theme/ThemePanel";
import { SETTINGS_TITLE, SettingsView, TAB_LABELS } from "./SettingsPanel";

vi.mock("../common/Toast", () => ({ toast: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(toast).mockClear();
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

interface Mounted {
  root: HTMLElement;
  onTab: ReturnType<typeof vi.fn<(tab: SettingsTab) => void>>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
  onSync: ReturnType<typeof vi.fn<(pane: SyncPane) => void>>;
  show(tab: SettingsTab): void;
  unmount(): void;
}

function mount(o: { frame?: "panel" | "sheet"; tab?: SettingsTab; sync?: SyncState; updates?: Updates | null; hover?: boolean } = {}): Mounted {
  const frame = o.frame ?? "panel";
  const onTab = vi.fn<(tab: SettingsTab) => void>();
  const onClose = vi.fn<() => void>();
  const onSync = vi.fn<(pane: SyncPane) => void>();
  const ui = (tab: SettingsTab) => (
    <ThemeProvider storage={window.localStorage} initial={{ store: DEFAULT_STORE, unreadable: null }}>
      <SettingsView
        frame={frame}
        tab={tab}
        hover={o.hover ?? false}
        onTab={onTab}
        onClose={onClose}
        onSync={onSync}
        sync={o.sync ?? { kind: "off" }}
        syncName={(doc) => (doc === "p1" ? "Launch" : null)}
        updates={o.updates === undefined ? null : o.updates}
      />
    </ThemeProvider>
  );
  const view = render(ui(o.tab ?? "theme"));
  const root = (): HTMLElement => (frame === "panel" ? view.getByRole("region", { name: SETTINGS_TITLE }) : view.getByRole("dialog", { name: SETTINGS_TITLE }));
  return {
    get root() {
      return root();
    },
    onTab,
    onClose,
    onSync,
    show: (tab) => view.rerender(ui(tab)),
    unmount: view.unmount,
  };
}

const tabs = (root: HTMLElement): string[] => within(root).getAllByRole("tab").map((t) => t.textContent ?? "");

const selected = (root: HTMLElement): string[] =>
  within(root)
    .getAllByRole("tab")
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.textContent ?? "");

const pane = (root: HTMLElement, name: string): HTMLElement => {
  const panel = document.getElementById(within(root).getByRole("tab", { name }).getAttribute("aria-controls") ?? "");
  if (panel === null || panel.getAttribute("role") !== "tabpanel") throw new Error(`no ${name} tab panel`);
  return panel;
};

const accent = (root: HTMLElement): HTMLInputElement => {
  const el = within(pane(root, "Theme")).getByRole("textbox", { name: "Accent hex", hidden: true });
  if (!(el instanceof HTMLInputElement)) throw new Error("not an input");
  return el;
};

const draftBackground = (root: HTMLElement, value: string): void => {
  const field = within(pane(root, "Theme")).getByRole("textbox", { name: "Background hex" });
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

describe("SettingsView", () => {
  it("is titled Settings with a labelled tab row in both frames", () => {
    expect(SETTINGS_TITLE).toBe("Settings");
    expect(TAB_LABELS).toEqual({ theme: "Theme", sync: "Sync", updates: "Updates", about: "About" });
    const a = mount();
    expect(within(a.root).getByRole("heading", { level: 2, name: "Settings" })).toBeTruthy();
    expect(within(a.root).getByRole("tablist", { name: "Settings sections" })).toBeTruthy();
    expect(tabs(a.root)).toEqual(["Theme", "Sync", "About"]);
    expect(selected(a.root)).toEqual(["Theme"]);
    a.unmount();
    const b = mount({ frame: "sheet" });
    expect(b.root.getAttribute("aria-modal")).toBe("true");
    expect(within(b.root).getByRole("tablist", { name: "Settings sections" })).toBeTruthy();
  });

  it("links each tab to its panel and keeps the inactive panels mounted but hidden", () => {
    const m = mount({ updates: fakeUpdates() });
    const all = within(m.root).getAllByRole("tab");
    expect(all.map((t) => t.textContent)).toEqual(["Theme", "Sync", "Updates", "About"]);
    all.forEach((t) => {
      const panel = document.getElementById(t.getAttribute("aria-controls") ?? "");
      if (panel === null) throw new Error(`no panel for ${t.textContent}`);
      expect(panel.getAttribute("role")).toBe("tabpanel");
      expect(panel.getAttribute("aria-labelledby")).toBe(t.id);
      expect(panel.hidden).toBe(t.getAttribute("aria-selected") !== "true");
    });
  });

  it("asks for the clicked tab and clears the hover preview on the way", () => {
    const m = mount({ hover: true });
    fireEvent.pointerEnter(within(pane(m.root, "Theme")).getByRole("button", { name: /^Phosphor/ }));
    expect(voidNow()).toBe("#060C09");
    fireEvent.click(within(m.root).getByRole("tab", { name: "Sync" }));
    expect(m.onTab.mock.calls).toEqual([["sync"]]);
    expect(voidNow()).toBe(CYBERDECK_VOID);
  });

  it("keeps a theme draft and its live colours across a tab switch and back", () => {
    const m = mount();
    draftBackground(m.root, "#222222");
    fireEvent.change(accent(m.root), { target: { value: "#335577" } });
    fireEvent.blur(accent(m.root));
    expect(voidNow()).toBe("#222222");
    m.show("about");
    expect(selected(m.root)).toEqual(["About"]);
    expect(pane(m.root, "Theme").hidden).toBe(true);
    expect(voidNow()).toBe("#222222");
    expect(accent(m.root).value).toBe("#335577");
    m.show("theme");
    expect(within(pane(m.root, "Theme")).getByText("Unsaved")).toBeTruthy();
    expect(accent(m.root).value).toBe("#335577");
    expect(voidNow()).toBe("#222222");
    expect(toast).not.toHaveBeenCalled();
    expect(m.onClose).not.toHaveBeenCalled();
  });

  it.each([
    ["the panel's Close", "panel" as const, (root: HTMLElement) => fireEvent.click(within(root).getAllByRole("button", { name: "Close" })[0])],
    ["the sheet's Close", "sheet" as const, (root: HTMLElement) => fireEvent.click(within(root).getAllByRole("button", { name: "Close" })[0])],
    ["Escape inside the panel", "panel" as const, (root: HTMLElement) => fireEvent.keyDown(within(root).getByRole("tab", { name: "About" }), { key: "Escape" })],
    ["Escape inside the sheet", "sheet" as const, (root: HTMLElement) => fireEvent.keyDown(within(root).getByRole("tab", { name: "About" }), { key: "Escape" })],
  ])("discards a draft with the toast when closed by %s, from any tab", (_how, frame, close) => {
    const m = mount({ frame });
    draftBackground(m.root, "#222222");
    m.show("about");
    close(m.root);
    expect(vi.mocked(toast).mock.calls).toEqual([[DISCARDED]]);
    expect(voidNow()).toBe(CYBERDECK_VOID);
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it("closes without a toast when there is no draft", () => {
    const m = mount({ tab: "sync" });
    fireEvent.click(within(m.root).getAllByRole("button", { name: "Close" })[0]);
    expect(toast).not.toHaveBeenCalled();
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it("offers one button per sync pane, which closes Settings through the discard path and asks for that pane", () => {
    const panes: readonly (readonly [string, SyncPane])[] = [
      ["Set up sync", "setup"],
      ["Join with a code", "join"],
      ["Add a device", "pair"],
      ["Devices", "devices"],
    ];
    panes.forEach(([label, want], i) => {
      const m = mount({ tab: "sync" });
      const sync = pane(m.root, "Sync");
      expect(within(sync).getAllByRole("button").map((b) => b.textContent)).toEqual(panes.map(([l]) => l));
      if (i === 0) {
        m.show("theme");
        draftBackground(m.root, "#222222");
        m.show("sync");
      }
      fireEvent.click(within(sync).getByRole("button", { name: label }));
      expect(m.onSync.mock.calls).toEqual([[want]]);
      expect(m.onClose).not.toHaveBeenCalled();
      expect(vi.mocked(toast).mock.calls).toEqual(i === 0 ? [[DISCARDED]] : []);
      expect(voidNow()).toBe(CYBERDECK_VOID);
      vi.mocked(toast).mockClear();
      m.unmount();
    });
  });

  it.each([
    [{ kind: "off" } as SyncState, "Local only", "cyan"],
    [{ kind: "synced" } as SyncState, "Synced", "cyan"],
    [{ kind: "offline", waiting: 2 } as SyncState, "Offline — 2 changes waiting", "amber"],
    [{ kind: "error", code: "revoked", since: 0, doc: null, waiting: 0, message: "This device was removed.", cause: null, op: null } as SyncState, "This device was removed.", "magenta"],
  ])("tones the sync sentence like the chip (%#)", (sync, text, tone) => {
    const m = mount({ tab: "sync", sync });
    const line = pane(m.root, "Sync").querySelector("p.settings-status");
    if (line === null) throw new Error("no sync sentence");
    expect([line.textContent, line.className]).toEqual([text, `settings-status ${tone}`]);
  });

  it("has no Updates tab without an updater, and shows the update line with one", () => {
    const a = mount();
    expect(within(a.root).queryByRole("tab", { name: "Updates" })).toBeNull();
    expect(a.root.querySelector(".update-line")).toBeNull();
    a.unmount();
    const b = mount({ tab: "updates", updates: fakeUpdates() });
    expect(selected(b.root)).toEqual(["Updates"]);
    const updates = pane(b.root, "Updates");
    expect(updates.hidden).toBe(false);
    expect(within(updates).getByText("WebBoard 9.9.9 is available")).toBeTruthy();
    expect(within(updates).getByRole("button", { name: "Install and restart" })).toBeTruthy();
  });

  it("refuses to show an Updates tab that has no updater", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount({ tab: "updates" })).toThrow("Settings has no updates tab here");
    error.mockRestore();
  });

  it("shows the mark, the version and the holiday attribution in the About tab", () => {
    const m = mount({ tab: "about" });
    const about = pane(m.root, "About");
    expect(about.hidden).toBe(false);
    expect(about.querySelector("img.about-mark")?.getAttribute("src")).toBe("/logo-mark.svg");
    expect([...about.querySelectorAll("p")].map((p) => p.textContent)).toEqual([`WebBoard ${version}`, HOLIDAY_ATTRIBUTION]);
  });
});
