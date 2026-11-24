import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Built } from "../../actions/intents";
import type { ItemId, PlanId } from "../../domain/model";
import { newId } from "../../log/ids";
import { fixedClock, type Clock } from "../../services/clock";
import { AppError } from "../../services/ipc";
import { importPlan } from "../../store/file";
import { Registry, type PlanListing } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { memoryStore } from "../../test/fixtures/store";
import { phoneRegistry, startOnList } from "../../test/phone";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { seededStore, shellFor, type SeededStore } from "../../test/shell";
import { emitFromRust, offeredSettings, resetTauri, tauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { closeConverted, CONVERTED_TITLE, OPEN_PLAN, shownConverted } from "../shell/ConvertedReport";
import { exportFlow, importFlow } from "../shell/fileFlows";
import { DEFAULT_LIST_PREFS, writeListPrefs } from "../list/prefs";
import { PLACE_KEY, useUi, type UiState, type ViewKind } from "../state";
import { DEFAULT_DEVICE, saveDevice } from "../device";
import { PhoneShell } from "./PhoneShell";
import { orderedSides } from "../choices/order";
import { sideText } from "../../plan/choices";
import { version } from "../../../package.json";
import { MESA_SEED } from "../../test/session";
import { CHOICE_TITLE } from "../choices/pick";
import { HOLIDAY_ATTRIBUTION } from "../common/About";
import { calendarSummary } from "../panel/calendarText";
import { revertText } from "../panel/historyText";
import type { HistoryEntry } from "../../store/session";
import { SyncManager, type SyncState } from "../../sync/manager";
import { fakeFactory, type FakeFactory, type FakeProvider } from "../../test/fakeProvider";
import { argsOf, fail, IX, ip, ixAct, NOW, own, remoteIndex, RESET_HINT, seedIndex, seedPlan, seedSpace, SPACE, syncWorld, TODAY, type SyncWorld } from "../../test/syncWorld";
import type { Answer } from "../../test/tauriMock";
import { NO_REGION } from "./PhoneStatus";
import { paintNative } from "../../theme/apply";
import { PRESETS, tokensOf } from "../../theme/presets";
import { Shell } from "../shell/Shell";
import { IPHONE, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import type { Platform } from "../../platform";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));
vi.mock("../../store/file", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../store/file")>();
  return { ...m, importPlan: vi.fn(m.importPlan) };
});
vi.mock("../shell/fileFlows", async (importOriginal) => {
  const m = await importOriginal<typeof import("../shell/fileFlows")>();
  return { ...m, importFlow: vi.fn(m.importFlow), exportFlow: vi.fn(m.exportFlow) };
});
vi.mock("../../log/ids", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../log/ids")>();
  return { ...m, newId: vi.fn(m.newId) };
});
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});
vi.mock("./PhoneList", async (importOriginal) => {
  const m = await importOriginal<typeof import("./PhoneList")>();
  function Probe() {
    const open = useContext(OpenChoice);
    if (open === null) throw new Error("Probe needs an OpenChoice provider");
    return (
      <button type="button" onClick={() => open("c1", "a2")}>
        Probe choice
      </button>
    );
  }
  return {
    ...m,
    PhoneList: (p: Parameters<typeof m.PhoneList>[0]) => (
      <>
        <m.PhoneList {...p} />
        <Probe />
      </>
    ),
  };
});

const sessions: PlanSession[] = [];
const registries: Registry[] = [];

let unstub = (): void => undefined;

beforeEach(() => {
  window.localStorage.clear();
  startOnList();
  setScreen(390, 844);
  unstub = stubVisualViewport();
});

afterEach(async () => {
  unstub();
  vi.useRealTimers();
  cleanup();
  clearToasts();
  if (shownConverted() !== null) closeConverted();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  vi.mocked(newId).mockReset();
  vi.mocked(importPlan).mockClear();
  vi.mocked(importFlow).mockClear();
  vi.mocked(exportFlow).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(registries.splice(0).map((r) => r.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const SEED: readonly SeedItem[] = [
  { name: "Review", start: "2026-11-10", dur: 2 },
  { name: "Ship", start: "2026-11-12", dur: 1 },
];

const made = async (): Promise<TestSession> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  return t;
};

const shown = async (t: TestSession, tab: ViewKind = "list"): Promise<void> => {
  saveDevice(window.localStorage, { ...DEFAULT_DEVICE, tab });
  const registry = await phoneRegistry(t);
  registries.push(registry);
  render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
  await settle();
};

const lastUi = () => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value[0];
};

const setUiNow = (patch: Partial<UiState>): void => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  const set = r.value[1];
  act(() => set(patch));
};

const rowOf = (name: string): HTMLElement => {
  const b = screen.getByText(name).closest("button");
  if (b === null) throw new Error("no row button for " + name);
  return b;
};

const views = (): HTMLElement => screen.getByRole("tablist", { name: "Views" });

describe('PhoneShell, data-form="phone"', () => {
  it("opens on the stored view, the List here, and switches to a read-only Timeline", async () => {
    const t = await made();
    const apply = vi.spyOn(t.session, "apply");
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: t.session.view().plan.id, view: "list", zoom: "W", collapsed: [], sidebarOpen: true, sidebarWidth: null }));
    await shown(t, "timeline");
    const list = within(views()).getByRole("tab", { name: "List" });
    expect(list.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".phone-list")).not.toBeNull();
    expect(document.querySelector(".tl-scroll")).toBeNull();
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    expect(within(views()).getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".phone-list")).toBeNull();
    expect(document.querySelectorAll(".tl-scroll")).toHaveLength(1);
    expect(document.querySelectorAll(".nub")).toHaveLength(0);
    expect(document.querySelectorAll(".bar .h")).toHaveLength(0);
    const bar = document.querySelector('[data-bar="Review"]');
    if (bar === null) throw new Error("no Review bar");
    const init = { clientX: 10, clientY: 0, button: 0, pointerId: 1, pointerType: "touch" };
    act(() => {
      fireEvent.pointerDown(bar, init);
    });
    act(() => {
      fireEvent.pointerUp(bar, init);
    });
    expect(screen.getByRole("dialog", { name: "Review" })).toBeTruthy();
    expect(apply).toHaveBeenCalledTimes(0);
  });

  it("each view tab controls the tab panel, which the selected tab labels", async () => {
    const t = await made();
    await shown(t);
    const panel = (): HTMLElement => screen.getByRole("tabpanel", { name: within(views()).getByRole("tab", { selected: true }).textContent ?? "" });
    const tabs = within(views()).getAllByRole("tab");
    expect(tabs.map((tb) => tb.getAttribute("aria-controls"))).toEqual(tabs.map(() => panel().id));
    expect(panel().querySelector(".phone-list")).not.toBeNull();
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    expect(panel().getAttribute("aria-labelledby")).toBe(within(views()).getByRole("tab", { name: "Timeline" }).id);
    expect(panel().querySelector(".tl-scroll")).not.toBeNull();
  });

  it("switching from the List to the Timeline clears the search, so no row is left dimmed", async () => {
    const t = await made();
    await shown(t);
    const field = (): HTMLElement => screen.getByRole("searchbox", { name: "Search this plan" });
    fireEvent.change(field(), { target: { value: "rev" } });
    expect([field().getAttribute("value"), lastUi().query]).toEqual(["rev", "rev"]);
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    expect(document.querySelectorAll(".tl-row")).not.toHaveLength(0);
    expect(document.querySelectorAll(".dimmed")).toHaveLength(0);
    expect(lastUi().query).toBe("");
    fireEvent.click(within(views()).getByRole("tab", { name: "List" }));
    expect([field().getAttribute("value"), lastUi().query]).toEqual(["", ""]);
    expect(document.querySelectorAll(".phone-list .prow")).toHaveLength(2);
  });

  it("reads Timeline, Board, List in its view tabs", async () => {
    const t = await made();
    await shown(t);
    expect(within(views()).getAllByRole("tab").map((tb) => tb.textContent)).toEqual(["Timeline", "Board", "List"]);
  });

  it("with no stored view opens the Default tab", async () => {
    const t = await made();
    await shown(t, "board");
    expect(within(views()).getByRole("tab", { selected: true }).textContent).toBe("Board");
    expect(document.querySelector(".phone-board")).not.toBeNull();
    cleanup();
    window.localStorage.clear();
    await shown(t, "timeline");
    expect(within(views()).getByRole("tab", { selected: true }).textContent).toBe("Timeline");
    expect(document.querySelector(".tl-scroll")).not.toBeNull();
  });

  it("a stored board opens the Board over the Default tab", async () => {
    const t = await made();
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: t.session.view().plan.id, view: "board", zoom: "W", collapsed: [], sidebarOpen: true, sidebarWidth: null }));
    await shown(t, "list");
    expect(within(views()).getByRole("tab", { selected: true }).textContent).toBe("Board");
    expect(document.querySelector(".phone-board")).not.toBeNull();
    expect(document.querySelector(".phone-list")).toBeNull();
  });

  it("a view tap is written to the stored place", async () => {
    const t = await made();
    await shown(t);
    const stored = (): unknown => {
      const raw = window.localStorage.getItem(PLACE_KEY);
      if (raw === null) throw new Error("no stored place");
      const place: unknown = JSON.parse(raw);
      if (typeof place !== "object" || place === null || !("view" in place)) throw new Error("the stored place has no view");
      return place.view;
    };
    fireEvent.click(within(views()).getByRole("tab", { name: "Board" }));
    expect([lastUi().view, stored()]).toEqual(["board", "board"]);
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    expect([lastUi().view, stored()]).toEqual(["timeline", "timeline"]);
  });

  it("a List search shows on the Board as its chip, and the Timeline clears it", async () => {
    const t = await made();
    await shown(t);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search this plan" }), { target: { value: "rev" } });
    fireEvent.click(within(views()).getByRole("tab", { name: "Board" }));
    expect(lastUi().query).toBe("rev");
    const chip = document.querySelector(".phone-board .filter-chip .chip-text");
    expect(chip?.textContent).toBe("Filtered: rev");
    expect([...document.querySelectorAll(".board-page .card")].map((c) => c.getAttribute("data-card"))).toEqual(["Review"]);
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    expect(lastUi().query).toBe("");
    fireEvent.click(within(views()).getByRole("tab", { name: "Board" }));
    expect(document.querySelector(".phone-board .filter-chip")).toBeNull();
  });

  it("the item sheet's Next follows the Board's order and carries the pager", async () => {
    const t = await testSession([
      { name: "Soon", start: "2026-11-10", dur: 2 },
      { name: "Far", start: "2027-03-01", dur: 2 },
      { name: "Undated", horizon: "next" },
    ]);
    sessions.push(t.session);
    await shown(t, "board");
    const card = document.querySelector('.board-page .card[data-card="Soon"]');
    if (card === null) throw new Error("no Soon card");
    fireEvent.keyDown(card, { key: "Enter" });
    const sheet = screen.getByRole("dialog", { name: "Soon" });
    expect(sheet.dataset.detent).toBe("medium");
    const next = sheet.querySelector(".detail-next");
    if (!(next instanceof HTMLButtonElement)) throw new Error("no Next button");
    fireEvent.click(next);
    expect(lastUi().selected).toBe("Undated");
    const bar = screen.getByRole("tablist", { name: "Steps" });
    expect(within(bar).getByRole("tab", { selected: true }).querySelector(".step-tab-name")?.textContent).toBe("Next");
  });

  it("a page's + opens the new task's sheet at medium height with its name selected", async () => {
    const t = await made();
    await shown(t, "board");
    fireEvent.click(screen.getByRole("button", { name: "Add a task to Now" }));
    const id = lastUi().selected;
    if (id === null) throw new Error("nothing selected");
    const sheets = [...document.querySelectorAll(".sheet")].filter((e): e is HTMLElement => e instanceof HTMLElement);
    expect(sheets.map((s) => [s.dataset.detent, s.getAttribute("aria-label")])).toEqual([["medium", "New task"]]);
    const field = sheets[0].querySelector(".title-input");
    if (!(field instanceof HTMLInputElement)) throw new Error("no name field");
    expect([document.activeElement, field.value, field.selectionStart, field.selectionEnd, lastUi().naming]).toEqual([field, "New task", 0, "New task".length, null]);
  });

  it("opens an item's sheet from the List and closes it", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(rowOf("Ship"));
    expect(screen.getByRole("dialog", { name: "Ship" })).toBeTruthy();
    expect(lastUi().selected).toBe("Ship");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Ship" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lastUi().selected).toBeNull();
  });

  it("the item sheet's Next and Previous follow the List's sort and search", async () => {
    const t = await made();
    await shown(t);
    const step = (by: 1 | -1): string | null => {
      const sheet = screen.getByRole("dialog");
      const button = sheet.querySelector(by > 0 ? ".detail-next" : ".detail-prev");
      if (!(button instanceof HTMLButtonElement)) throw new Error("no step button");
      fireEvent.click(button);
      return lastUi().selected;
    };
    fireEvent.click(rowOf("Review"));
    expect(step(1)).toBe("Ship");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    act(() => {
      writeListPrefs(window.localStorage, t.session.view().plan.id, { ...DEFAULT_LIST_PREFS, sort: [{ id: "name", dir: "desc" }] });
    });
    fireEvent.click(rowOf("Review"));
    expect(step(-1)).toBe("Ship");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search this plan" }), { target: { value: "rev" } });
    const rows = [...document.querySelectorAll(".phone-list .prow")];
    expect(rows.map((r) => r.querySelector(".prow-name")?.textContent)).toEqual(["Review"]);
    fireEvent.click(rows[0]);
    const sheet = screen.getByRole("dialog", { name: "Review" });
    expect([".detail-prev", ".detail-next"].map((s) => sheet.querySelector(s)?.hasAttribute("disabled"))).toEqual([true, true]);
  });

  it("open choice context: the sheet's useRun finds the provider, and a child opens a choice", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(rowOf("Review"));
    const sheet = screen.getByRole("dialog", { name: "Review" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Longer by one working day" }));
    expect(t.session.view().plan.items.get("Review")?.schedule?.dur).toBe(3);
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Probe choice" }));
    const dialogs = vi.mocked(useUi).mock.results.flatMap((r) => (r.type === "return" ? [r.value[0].dialog] : []));
    expect(dialogs).toContainEqual({ t: "choice", id: "c1", side: "a2" });
    await settle();
    expect(lastUi().dialog).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryAllByText("This choice was settled meanwhile.")).toHaveLength(1);
  });

  it("throws on a dialog kind the phone does not show yet", async () => {
    const t = await made();
    await shown(t);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => setUiNow({ dialog: { t: "palette" } })).toThrow(new Error("PhoneShell cannot show dialog palette"));
  });

  it("the read-only Timeline zooms by pinch, and a hold opens the item's sheet", async () => {
    const t = await made();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    const setUi = (): ((patch: { zoom: "M" }) => void) => {
      const results = vi.mocked(useUi).mock.results;
      const r = results[results.length - 1];
      if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
      return r.value[1];
    };
    act(() => setUi()({ zoom: "M" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chart = document.querySelector(".tl-chart");
    if (chart === null) throw new Error("no chart");
    const fire = (el: Element, kind: "down" | "move" | "up", x: number, y: number, pointerId: number): void => {
      const init = { clientX: x, clientY: y, button: 0, pointerId, pointerType: "touch", isPrimary: pointerId === 1 };
      act(() => {
        if (kind === "down") fireEvent.pointerDown(el, init);
        else if (kind === "move") fireEvent.pointerMove(el, init);
        else fireEvent.pointerUp(el, init);
      });
    };
    fire(chart, "down", 0, 400, 1);
    fire(chart, "down", 100, 400, 2);
    fire(chart, "move", 160, 400, 2);
    fire(chart, "up", 160, 400, 2);
    fire(chart, "up", 0, 400, 1);
    expect(lastUi().zoom).toBe("W");
    expect(screen.queryByRole("dialog")).toBeNull();
    const bar = document.querySelector('[data-bar="Review"]');
    if (!(bar instanceof HTMLElement)) throw new Error("no Review bar");
    const x = parseFloat(bar.style.left) + 20;
    const y = parseFloat(bar.style.top) + 9;
    fire(bar, "down", x, y, 1);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(document.querySelector(".drop-ghost")).toBeNull();
    fire(bar, "up", x + 1, y, 1);
    expect(screen.getByRole("dialog", { name: "Review" })).toBeTruthy();
    expect(apply).toHaveBeenCalledTimes(0);
  });

  it("the held count opens the choice that holds the items", async () => {
    const away = { unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null };
    let n = 0;
    vi.mocked(newId).mockImplementation(() => `id${String((n += 1)).padStart(9, "0")}`);
    const t = await testSession([{ name: "Review", start: "2026-11-10", dur: 2 }], {
      clashes: [away, { unit: "s:Review", mac: ["2026-11-10", 2, "todo", 0, "now"], iphone: ["2026-11-12", 2, "todo", 0, "now"] }],
    });
    sessions.push(t.session);
    const view = t.session.view();
    expect(view.choices[0].kind).toBe("calendar");
    const held = view.choices.find((c) => c.units.includes("s:Review"));
    if (held === undefined) throw new Error("fixture: no s:Review choice");
    await shown(t);
    const strip = document.querySelector(".phone-status .status-strip");
    if (!(strip instanceof HTMLElement)) throw new Error("no status strip");
    fireEvent.click(strip);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Status" })).getByRole("button", { name: "2 open choices · Choose…" }));
    const list = screen.getByRole("dialog", { name: "Open choices" });
    const local = "iPhone";
    expect(within(list).getAllByRole("button").filter((b) => b.classList.contains("choice-row")).map((b) => b.textContent)).toEqual(
      view.choices.map((c) => orderedSides(c, local).map((s) => sideText(c, s.key, view.plan)).join(" or ")),
    );
    fireEvent.click(within(list).getByRole("button", { name: "Close" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Status" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const count = screen.getByRole("button", { name: "1 held" });
    expect(count.classList.contains("chip-amber")).toBe(true);
    fireEvent.click(count);
    expect(lastUi().dialog).toEqual({ t: "choice", id: held.id });
    expect(held.id).not.toBe(view.choices[0].id);
    expect(screen.getByRole("dialog", { name: "Choose which to keep" })).toBeTruthy();
    expect(document.querySelectorAll(".choice-col")).toHaveLength(2);
    cleanup();
    const only = await testSession([{ name: "Review", start: "2026-11-10", dur: 2 }], { clashes: [away] });
    sessions.push(only.session);
    await shown(only);
    expect(screen.queryByRole("button", { name: /held/ })).toBeNull();
  });

  it("Shell renders the phone shell under phone, with no update line", async () => {
    const t = await made();
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    expect(document.documentElement.dataset.form).toBe("phone");
    expect(document.querySelector(".phone-list")).not.toBeNull();
    expect(document.querySelector(".sidebar")).toBeNull();
    expect(document.querySelector(".update-line")).toBeNull();
    expect(screen.queryByText(/Check for updates|Up to date|WebBoard \d/)).toBeNull();
  });
});

const INCOMPLETE = "This plan has not arrived yet; it opens once it syncs.";
const FILES_STAY = "The plan’s files stay on this device.";
const RELOAD = "Load again from the server";
const RELOAD_TEXT = "Changes this device had not sent to the server are not loaded again; the damaged files stay on this device.";
const EMPTY_NAME = "The name is empty. Type at least one character.";
const CUT_OFF = "The last change before WebBoard stopped was cut off while saving and was not kept.";
const INDEX_CUT = "The last change to the plan list before WebBoard closed was not saved.";

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const topBar = (): HTMLElement => {
  const el = document.querySelector(".phone-head");
  if (!(el instanceof HTMLElement)) throw new Error("no phone top bar");
  return el;
};

const plansSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Plans" });

const openPlans = (): HTMLElement => {
  fireEvent.click(within(topBar()).getByRole("button", { name: "Plans" }));
  return plansSheet();
};

const closePlans = (): void => {
  fireEvent.click(within(plansSheet()).getByRole("button", { name: "Close" }));
};

const planRow = (name: string): HTMLElement => {
  const li = within(plansSheet()).getByText(name).closest("li");
  if (!(li instanceof HTMLElement)) throw new Error("no Plans row " + name);
  return li;
};

const trashOf = (): HTMLElement => within(plansSheet()).getByRole("region", { name: "Trash" });

const listShows = (name: string): void => {
  expect(topBar().querySelector(".phone-plan-name")?.textContent).toBe(name);
  expect(document.querySelector(".phone-list")).not.toBeNull();
};

const emptyState = (): HTMLElement | null => document.querySelector(".empty-state");

const docArg = (args: unknown): string => {
  if (typeof args === "object" && args !== null && "doc" in args && typeof args.doc === "string") return args.doc;
  throw new Error("store_load without a doc");
};

const indexOpen = async (): Promise<{ registry: Registry; clock: Clock }> => {
  const clock = fixedClock("2026-11-09");
  const registry = await Registry.open({ clock });
  registries.push(registry);
  return { registry, clock };
};

const showIndex = async (r: { registry: Registry; clock: Clock }, connected = false): Promise<void> => {
  render(withSync(<PhoneShell registry={r.registry} clock={r.clock} />, { connected }));
  await settle();
};

const emptyIndex = async (): Promise<{ registry: Registry; clock: Clock }> => {
  resetTauri({ ...memoryStore().answers, settings_read: offeredSettings, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: "ios" }) });
  setPlatform(IPHONE);
  return indexOpen();
};

const failNewDocs = (seeded: ReadonlySet<string>): void => {
  const load = tauri.answers.store_load;
  if (load === undefined) throw new Error("no store_load answer");
  tauri.answers.store_load = (args, o) => {
    if (!seeded.has(docArg(args))) throw { code: "store.io", message: "Disk full." };
    return load(args, o);
  };
};

const tear = (docs: ReadonlySet<string>): void => {
  const load = tauri.answers.store_load;
  if (load === undefined) throw new Error("no store_load answer");
  tauri.answers.store_load = (args, o) => {
    const out = load(args, o);
    if (!(out instanceof ArrayBuffer)) throw new Error("store_load answered no bytes");
    if (!docs.has(docArg(args))) return out;
    const copy = out.slice(0);
    new DataView(copy).setUint8(0, 1);
    return copy;
  };
};

const notifier = (r: Registry): (() => void) => {
  const subscribers = new Set<() => void>();
  const real = r.subscribe.bind(r);
  vi.spyOn(r, "subscribe").mockImplementation((cb) => {
    subscribers.add(cb);
    const off = real(cb);
    return () => {
      subscribers.delete(cb);
      off();
    };
  });
  return () => [...subscribers].forEach((cb) => cb());
};

const gate = (): { wait: Promise<void>; open(): void } => {
  const opens: (() => void)[] = [];
  const wait = new Promise<void>((r) => {
    opens.push(r);
  });
  return { wait, open: () => opens.forEach((o) => o()) };
};

const withSpace = (registry: Registry, ids: ReadonlySet<PlanId>): void => {
  const real = registry.plans.bind(registry);
  vi.spyOn(registry, "plans").mockImplementation(() => real().map((l): PlanListing => (ids.has(l.id) ? { ...l, space: "S1" } : l)));
};

type BuildSpy = MockInstance<PlanSession["apply"]> | MockInstance<PlanSession["undo"]> | MockInstance<PlanSession["redo"]> | MockInstance<PlanSession["resolve"]>;

const builtOf = (spy: BuildSpy, i = 0): Built => {
  const r = spy.mock.results[i];
  if (r === undefined || r.type !== "return") throw new Error("the spy did not return");
  if (r.value === null) throw new Error("the spy returned no action");
  return r.value;
};

const mainFailed = (): HTMLElement => {
  const el = document.querySelector(".app.phone > .plan-failed");
  if (!(el instanceof HTMLElement)) throw new Error("no failed plan in the main area");
  return el;
};

describe("PhoneShell plans (Step 1)", () => {
  it("Plans lists the plans with the open one current, and a row opens its plan", async () => {
    const s = await seededStore(["Alpha", "Beta"]);
    const r = await indexOpen();
    const session = vi.spyOn(r.registry, "session");
    await showIndex(r);
    listShows("Alpha");
    const sheet = openPlans();
    expect(within(sheet).getByRole("button", { name: "Alpha" }).getAttribute("aria-current")).toBe("page");
    expect(within(sheet).getByRole("button", { name: "Beta" }).hasAttribute("aria-current")).toBe(false);
    fireEvent.click(within(sheet).getByRole("button", { name: "Beta" }));
    await settle();
    expect(session).toHaveBeenLastCalledWith(s.ids[1]);
    listShows("Beta");
  });

  it("a plan switch clears the List's search", async () => {
    await seededStore(["Alpha", "Beta"]);
    const r = await indexOpen();
    await showIndex(r);
    listShows("Alpha");
    const field = (): HTMLElement => screen.getByRole("searchbox", { name: "Search this plan" });
    fireEvent.change(field(), { target: { value: "dome" } });
    expect([field().getAttribute("value"), lastUi().query]).toEqual(["dome", "dome"]);
    fireEvent.click(within(openPlans()).getByRole("button", { name: "Beta" }));
    await settle();
    listShows("Beta");
    expect([field().getAttribute("value"), lastUi().query]).toEqual(["", ""]);
  });

  it("New plan creates the named plan and refuses an empty name", async () => {
    await seededStore(["Alpha", "Beta"]);
    const r = await indexOpen();
    const createPlan = vi.spyOn(r.registry, "createPlan");
    await showIndex(r);
    const sheet = openPlans();
    const field = within(sheet).getByRole("textbox", { name: "Plan name" });
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.click(within(sheet).getByRole("button", { name: "New plan" }));
    await settle();
    expect(createPlan).not.toHaveBeenCalled();
    expect(within(sheet).getByText(EMPTY_NAME).classList.contains("bad")).toBe(true);
    fireEvent.change(field, { target: { value: "  Gamma " } });
    fireEvent.click(within(sheet).getByRole("button", { name: "New plan" }));
    await settle();
    expect(createPlan.mock.calls).toEqual([["Gamma"]]);
    listShows("Gamma");
  });

  it("Move to Trash on the open plan opens the next one, and Restore keeps the open one", async () => {
    const s = await seededStore(["Alpha", "Beta"]);
    const r = await indexOpen();
    const trashPlan = vi.spyOn(r.registry, "trashPlan");
    const restorePlan = vi.spyOn(r.registry, "restorePlan");
    await showIndex(r);
    openPlans();
    fireEvent.click(within(planRow("Alpha")).getByRole("button", { name: "Move to Trash" }));
    await settle();
    expect(trashPlan.mock.calls).toEqual([[s.ids[0]]]);
    expect(toastTexts()).toEqual(["Moved “Alpha” to the Trash. Restore it from the Trash."]);
    expect(within(trashOf()).getByText("Alpha")).toBeTruthy();
    listShows("Beta");
    clearToasts();
    fireEvent.click(within(planRow("Alpha")).getByRole("button", { name: "Restore" }));
    await settle();
    expect(restorePlan.mock.calls).toEqual([[s.ids[0]]]);
    expect(toastTexts()).toEqual(["Restored “Alpha” from the Trash."]);
    expect(within(plansSheet()).queryByRole("region", { name: "Trash" })).toBeNull();
    listShows("Beta");
  });

  it("trashing the last open plan reaches the empty state", async () => {
    await seededStore(["Alpha", "Beta"]);
    const r = await indexOpen();
    await showIndex(r);
    openPlans();
    fireEvent.click(within(planRow("Alpha")).getByRole("button", { name: "Move to Trash" }));
    await settle();
    fireEvent.click(within(planRow("Beta")).getByRole("button", { name: "Move to Trash" }));
    await settle();
    expect(emptyState()).not.toBeNull();
    expect(document.querySelector(".phone-list")).toBeNull();
  });

  it("a store error shows in Plans", async () => {
    const s = await seededStore(["Alpha", "Beta"]);
    const alpha = s.ids[0];
    const r = await indexOpen();
    await showIndex(r);
    const list = document.querySelector(".phone-list");
    expect(list).not.toBeNull();
    s.mem.fail("store_append", alpha, { code: "store.io", message: "Disk full." });
    const session = await r.registry.session(alpha);
    act(() => {
      session.apply({ t: "planName", name: "Alpha 2" });
    });
    await settle();
    expect(r.registry.failures().get(alpha)?.message).toBe("Disk full.");
    expect(document.querySelector(".phone-list")).toBe(list);
    openPlans();
    expect(within(planRow("Alpha 2")).getByText("Disk full.").classList.contains("bad")).toBe(true);
    const retryPlan = vi.spyOn(r.registry, "retryPlan");
    s.mem.recover("store_append", alpha);
    fireEvent.click(within(planRow("Alpha 2")).getByRole("button", { name: "Try again" }));
    await settle();
    expect(retryPlan.mock.calls).toEqual([[alpha]]);
    expect(within(planRow("Alpha 2")).queryByText("Disk full.")).toBeNull();
    expect(document.querySelector(".phone-list")).toBe(list);
  });

  it("a failed new plan opens nothing", async () => {
    const s = await seededStore(["Alpha"]);
    failNewDocs(new Set(["local", ...s.ids]));
    const r = await indexOpen();
    const createPlan = vi.spyOn(r.registry, "createPlan");
    await showIndex(r);
    const sheet = openPlans();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Plan name" }), { target: { value: "Gamma" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "New plan" }));
    await settle();
    expect(createPlan.mock.calls).toEqual([["Gamma"]]);
    expect(within(plansSheet()).getByText("Disk full.").classList.contains("bad")).toBe(true);
    listShows("Alpha");
  });

  it("New plan shows it is busy", async () => {
    await seededStore(["Alpha"]);
    const r = await indexOpen();
    const real = r.registry.createPlan.bind(r.registry);
    const g = gate();
    const createPlan = vi.spyOn(r.registry, "createPlan").mockImplementation((name) => g.wait.then(() => real(name)));
    await showIndex(r);
    const sheet = openPlans();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Plan name" }), { target: { value: "Gamma" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "New plan" }));
    await settle();
    const busy = within(sheet).getByRole("button", { name: "Creating…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(busy.querySelector(".dim")?.textContent).toBe("Creating…");
    fireEvent.click(busy);
    expect(createPlan).toHaveBeenCalledTimes(1);
    await act(async () => g.open());
    await settle();
    listShows("Gamma");
    const idle = within(openPlans()).getByRole("button", { name: "New plan" });
    expect(idle.hasAttribute("disabled")).toBe(false);
  });

  it("Import plan… under New plan runs the import flow and opens the plan", async () => {
    await seededStore(["Alpha"]);
    const r = await indexOpen();
    vi.mocked(importPlan).mockImplementationOnce(async (reg) => ({ planId: await reg.createPlan("MESA 2027"), converted: null }));
    await showIndex(r);
    const sheet = openPlans();
    const names = within(sheet)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names.indexOf("Import plan…")).toBe(names.indexOf("New plan") + 1);
    fireEvent.click(within(sheet).getByRole("button", { name: "Import plan…" }));
    await settle();
    expect(vi.mocked(importFlow).mock.calls.map((c) => c[0])).toEqual([r.registry]);
    listShows("MESA 2027");
  });

  it("two Import plan… taps before a re-render start one import", async () => {
    await seededStore(["Alpha"]);
    const r = await indexOpen();
    vi.mocked(importPlan).mockResolvedValueOnce(null);
    await showIndex(r);
    const button = within(openPlans()).getByRole("button", { name: "Import plan…" });
    act(() => {
      button.click();
      button.click();
    });
    await settle();
    expect(importFlow).toHaveBeenCalledTimes(1);
  });

  it("the sheet's create error clears when the sheet closes", async () => {
    await seededStore(["Alpha"]);
    const r = await indexOpen();
    await showIndex(r);
    const sheet = openPlans();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Plan name" }), { target: { value: "   " } });
    fireEvent.click(within(sheet).getByRole("button", { name: "New plan" }));
    await settle();
    expect(within(plansSheet()).getByText(EMPTY_NAME).classList.contains("bad")).toBe(true);
    closePlans();
    expect(within(openPlans()).queryByText(EMPTY_NAME)).toBeNull();
  });

  it("a sheet create that fails after the sheet closed is one bad toast, and the sheet reopens clean", async () => {
    const s = await seededStore(["Alpha"]);
    failNewDocs(new Set(["local", ...s.ids]));
    const r = await indexOpen();
    const real = r.registry.createPlan.bind(r.registry);
    const g = gate();
    const createPlan = vi.spyOn(r.registry, "createPlan").mockImplementation((name) => g.wait.then(() => real(name)));
    await showIndex(r);
    const sheet = openPlans();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Plan name" }), { target: { value: "Gamma" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "New plan" }));
    await settle();
    closePlans();
    await act(async () => g.open());
    await settle();
    expect(createPlan.mock.calls).toEqual([["Gamma"]]);
    expect(Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => [e.textContent, e.className])).toEqual([["Disk full.", "toast bad"]]);
    expect(within(openPlans()).queryByText("Disk full.")).toBeNull();
    listShows("Alpha");
  });

  it("a sheet create that fails after the sheet closed and reopened is one bad toast, not the new sheet's message", async () => {
    const s = await seededStore(["Alpha"]);
    failNewDocs(new Set(["local", ...s.ids]));
    const r = await indexOpen();
    const real = r.registry.createPlan.bind(r.registry);
    const g = gate();
    vi.spyOn(r.registry, "createPlan").mockImplementation((name) => g.wait.then(() => real(name)));
    await showIndex(r);
    const sheet = openPlans();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Plan name" }), { target: { value: "Gamma" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "New plan" }));
    await settle();
    closePlans();
    openPlans();
    await act(async () => g.open());
    await settle();
    expect(Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => [e.textContent, e.className])).toEqual([["Disk full.", "toast bad"]]);
    expect(within(plansSheet()).queryByText("Disk full.")).toBeNull();
  });

  it("the top bar reads Loading… for a plan whose name has not arrived", async () => {
    await seededStore(["Alpha"]);
    const r = await indexOpen();
    const real = r.registry.plans.bind(r.registry);
    vi.spyOn(r.registry, "plans").mockImplementation(() => real().map((l): PlanListing => ({ ...l, name: null })));
    vi.spyOn(r.registry, "session").mockReturnValue(new Promise<PlanSession>(() => undefined));
    await showIndex(r);
    expect(topBar().querySelector(".phone-plan-name")?.textContent).toBe("Loading…");
  });
});

describe("PhoneShell failed plans and the empty state (Step 1b)", () => {
  const failing = async (code = "store.locked", message = "Locked by another process.", connected = false): Promise<{ s: SeededStore; registry: Registry }> => {
    const s = await seededStore(["Alpha", "Beta", "Gamma"]);
    s.mem.fail("store_load", s.ids[1], { code, message });
    s.mem.fail("store_load", s.ids[2], { code: "store.corrupt", message: "Bad record in seg-0.log." });
    const r = await indexOpen();
    await r.registry.warm();
    await showIndex(r, connected);
    return { s, registry: r.registry };
  };

  it("a locked plan offers Try again", async () => {
    const { s, registry } = await failing();
    const beta = s.ids[1];
    openPlans();
    expect(within(planRow("Beta")).getByText("Locked by another process.").classList.contains("bad")).toBe(true);
    expect(within(planRow("Beta")).queryByRole("button", { name: "Move to Trash" })).toBeNull();
    const retryPlan = vi.spyOn(registry, "retryPlan");
    s.mem.recover("store_load", beta);
    fireEvent.click(within(planRow("Beta")).getByRole("button", { name: "Try again" }));
    await settle();
    expect(retryPlan.mock.calls).toEqual([[beta]]);
    expect(within(planRow("Beta")).queryByText("Locked by another process.")).toBeNull();
    fireEvent.click(within(planRow("Beta")).getByRole("button", { name: "Beta" }));
    await settle();
    listShows("Beta");
  });

  it("a failed retry replaces the failure", async () => {
    const { s } = await failing();
    s.mem.fail("store_load", s.ids[1], { code: "store.io", message: "Disk full." });
    openPlans();
    fireEvent.click(within(planRow("Beta")).getByRole("button", { name: "Try again" }));
    await settle();
    expect(within(planRow("Beta")).getByText("Disk full.").classList.contains("bad")).toBe(true);
    expect(within(planRow("Beta")).queryByText("Locked by another process.")).toBeNull();
    expect(within(planRow("Beta")).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a plan whose load answers ipc.shape offers Try again", async () => {
    const { s, registry } = await failing("ipc.shape", "store_load did not return bytes.");
    openPlans();
    expect(within(planRow("Beta")).getByText("store_load did not return bytes.").classList.contains("bad")).toBe(true);
    const retryPlan = vi.spyOn(registry, "retryPlan");
    fireEvent.click(within(planRow("Beta")).getByRole("button", { name: "Try again" }));
    await settle();
    expect(retryPlan.mock.calls).toEqual([[s.ids[1]]]);
  });

  it("a corrupt plan offers Move to Trash", async () => {
    const { s, registry } = await failing();
    const gamma = s.ids[2];
    openPlans();
    const row = planRow("Gamma");
    expect(within(row).getByText("Bad record in seg-0.log.").classList.contains("bad")).toBe(true);
    expect(within(row).getByText(FILES_STAY)).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();
    const trashPlan = vi.spyOn(registry, "trashPlan");
    const from = tauri.calls.length;
    fireEvent.click(within(row).getByRole("button", { name: "Move to Trash" }));
    await settle();
    expect(trashPlan.mock.calls).toEqual([[gamma]]);
    expect(within(trashOf()).getByText("Gamma")).toBeTruthy();
    expect(new Set(tauri.calls.slice(from).map((c) => c.cmd).filter((c) => c.startsWith("store_")))).toEqual(new Set(["store_append"]));
  });

  it("a corrupt space plan loads again from the server", async () => {
    const { s, registry } = await failing(undefined, undefined, true);
    const gamma = s.ids[2];
    withSpace(registry, new Set([gamma]));
    const reload = vi.spyOn(registry, "reloadFromServer");
    const trashPlan = vi.spyOn(registry, "trashPlan");
    openPlans();
    const row = (): HTMLElement => planRow("Gamma");
    expect(within(row()).getByText("Bad record in seg-0.log.")).toBeTruthy();
    expect(within(row()).queryByRole("button", { name: "Move to Trash" })).toBeNull();
    expect(within(row()).queryByText(FILES_STAY)).toBeNull();
    fireEvent.click(within(row()).getByRole("button", { name: RELOAD }));
    const confirm = screen.getByRole("dialog", { name: RELOAD });
    expect(within(confirm).getByText(RELOAD_TEXT)).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: RELOAD })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    reload.mockRejectedValueOnce(new AppError("store.io", "Permission denied (os error 13)"));
    fireEvent.click(within(row()).getByRole("button", { name: RELOAD }));
    fireEvent.click(within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Load again" }));
    await settle();
    expect(reload.mock.calls).toEqual([[gamma]]);
    expect(Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((n) => [n.textContent, n.className])).toEqual([["Permission denied (os error 13)", "toast bad"]]);
    expect(screen.getByRole("dialog", { name: RELOAD })).toBeTruthy();
    reload.mockResolvedValueOnce(undefined);
    fireEvent.click(within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Load again" }));
    await settle();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog", { name: RELOAD })).toBeNull();
    expect(toastTexts()).toHaveLength(1);
    expect(trashPlan).not.toHaveBeenCalled();
    vi.spyOn(registry, "spaceReadOnly").mockReturnValue(true);
    closePlans();
    openPlans();
    expect(within(row()).getByText("Bad record in seg-0.log.")).toBeTruthy();
    expect(within(row()).getByText(FILES_STAY)).toBeTruthy();
    expect(within(row()).queryByRole("button", { name: RELOAD })).toBeNull();
    expect(within(row()).queryByRole("button", { name: "Move to Trash" })).toBeNull();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("Escape in a row's reload sheet closes only that sheet", async () => {
    const { s, registry } = await failing(undefined, undefined, true);
    withSpace(registry, new Set([s.ids[2]]));
    openPlans();
    fireEvent.click(within(planRow("Gamma")).getByRole("button", { name: RELOAD }));
    const confirm = screen.getByRole("dialog", { name: RELOAD });
    fireEvent.keyDown(within(confirm).getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: RELOAD })).toBeNull();
    expect(plansSheet()).toBeTruthy();
  });

  it("a plan trashed on another device", async () => {
    const s = await seededStore(["Alpha", "Beta"]);
    const r = await indexOpen();
    const notify = notifier(r.registry);
    const trashPlan = vi.spyOn(r.registry, "trashPlan");
    await showIndex(r);
    listShows("Alpha");
    let trashed = new Set([s.ids[0]]);
    const real = r.registry.plans.bind(r.registry);
    vi.spyOn(r.registry, "plans").mockImplementation(() => real().map((l) => (trashed.has(l.id) ? { ...l, trashed: true } : l)));
    act(() => notify());
    await settle();
    expect(toastTexts()).toEqual(["“Alpha” was moved to the Trash on another device. Restore it from the Trash."]);
    listShows("Beta");
    expect(trashPlan).not.toHaveBeenCalled();
    trashed = new Set(s.ids);
    act(() => notify());
    await settle();
    expect(emptyState()).not.toBeNull();
    expect(document.querySelector(".phone-list")).toBeNull();
  });

  it("an unknown stored plan opens the first", async () => {
    await seededStore(["Alpha", "Beta"]);
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: "zzzzzzzzzzz" }));
    const r = await indexOpen();
    const session = vi.spyOn(r.registry, "session");
    await showIndex(r);
    listShows("Alpha");
    expect(within(openPlans()).getByRole("button", { name: "Alpha" }).getAttribute("aria-current")).toBe("page");
    expect(toastTexts()).toEqual([]);
    expect(session.mock.calls.map((c) => c[0])).not.toContain("zzzzzzzzzzz");
  });

  it("a trashed stored plan opens the first untrashed", async () => {
    const s = await seededStore(["Alpha", "Beta"], { trash: [0] });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: s.ids[0] }));
    const r = await indexOpen();
    const trashPlan = vi.spyOn(r.registry, "trashPlan");
    await showIndex(r);
    listShows("Beta");
    expect(toastTexts()).toEqual([]);
    expect(trashPlan).not.toHaveBeenCalled();
    cleanup();
    const all = await seededStore(["Alpha", "Beta"], { trash: [0, 1] });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: all.ids[0] }));
    await showIndex(await indexOpen());
    expect(emptyState()).not.toBeNull();
  });

  it("a plan still arriving opens once it syncs", async () => {
    const s = await seededStore(["Alpha", "Beta", "Gamma", "Delta"]);
    const delta = s.ids[3];
    const r = await indexOpen();
    const notify = notifier(r.registry);
    const real = r.registry.session.bind(r.registry);
    let arriving = true;
    const session = vi.spyOn(r.registry, "session").mockImplementation((id) => {
      if (id === delta && arriving) {
        arriving = false;
        return Promise.reject(new AppError("plan.incomplete", INCOMPLETE));
      }
      return real(id);
    });
    await showIndex(r);
    fireEvent.click(within(openPlans()).getByRole("button", { name: "Delta" }));
    await settle();
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(r.registry.failures().has(delta)).toBe(false);
    expect(document.querySelector(".phone-list")).toBeNull();
    expect(session.mock.calls.filter((c) => c[0] === delta)).toHaveLength(1);
    act(() => notify());
    await settle();
    expect(session.mock.calls.filter((c) => c[0] === delta).length).toBeGreaterThanOrEqual(2);
    listShows("Delta");
  });

  it("opening a failed plan shows its error", async () => {
    await failing();
    fireEvent.click(within(openPlans()).getByRole("button", { name: "Beta" }));
    await settle();
    expect(screen.getByText("Locked by another process.").classList.contains("bad")).toBe(true);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(document.querySelector(".phone-list")).toBeNull();
  });

  it("a corrupt local plan in the main area offers Move to Trash", async () => {
    const { s, registry } = await failing();
    const gamma = s.ids[2];
    const trashPlan = vi.spyOn(registry, "trashPlan");
    fireEvent.click(within(openPlans()).getByRole("button", { name: "Gamma" }));
    await settle();
    const main = mainFailed();
    expect(within(main).getByText("Bad record in seg-0.log.").classList.contains("bad")).toBe(true);
    expect(within(main).getByText(FILES_STAY)).toBeTruthy();
    expect(within(main).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(main).queryByRole("button", { name: RELOAD })).toBeNull();
    fireEvent.click(within(main).getByRole("button", { name: "Move to Trash" }));
    await settle();
    expect(trashPlan.mock.calls).toEqual([[gamma]]);
    expect(toastTexts()).toEqual(["Moved “Gamma” to the Trash. Restore it from the Trash."]);
    listShows("Alpha");
  });

  it("a corrupt space plan in the main area opens the reload sheet", async () => {
    const { s, registry } = await failing(undefined, undefined, true);
    const gamma = s.ids[2];
    withSpace(registry, new Set([gamma]));
    const reload = vi.spyOn(registry, "reloadFromServer");
    fireEvent.click(within(openPlans()).getByRole("button", { name: "Gamma" }));
    await settle();
    const main = mainFailed();
    expect(within(main).getByText("Bad record in seg-0.log.")).toBeTruthy();
    expect(within(main).queryByText(FILES_STAY)).toBeNull();
    expect(within(main).queryByRole("button", { name: "Move to Trash" })).toBeNull();
    fireEvent.click(within(main).getByRole("button", { name: RELOAD }));
    const confirm = screen.getByRole("dialog", { name: RELOAD });
    expect(confirm.classList.contains("sheet")).toBe(true);
    expect(within(confirm).getByText(RELOAD_TEXT)).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: RELOAD })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    cleanup();
    await Promise.all(registries.splice(0).map((r) => r.close()));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const offline = await failing(undefined, undefined, true);
    withSpace(offline.registry, new Set([offline.s.ids[2]]));
    const offlineReload = vi.spyOn(offline.registry, "reloadFromServer");
    fireEvent.click(within(openPlans()).getByRole("button", { name: "Gamma" }));
    await settle();
    expect(within(topBar()).getByRole("button", { name: "Offline" }).classList.contains("chip-compact")).toBe(true);
    const button = within(mainFailed()).getByRole("button", { name: RELOAD });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(within(mainFailed()).getByText("Needs a connection to the server.").classList.contains("dim")).toBe(true);
    fireEvent.click(button);
    await settle();
    expect(screen.queryByRole("dialog", { name: RELOAD })).toBeNull();
    expect(offlineReload).not.toHaveBeenCalled();
  });

  it("Load again stays disabled while the registry reloads the plan", async () => {
    const { s, registry } = await failing(undefined, undefined, true);
    const gamma = s.ids[2];
    withSpace(registry, new Set([gamma]));
    vi.spyOn(registry, "reloading").mockImplementation((doc) => doc === gamma);
    const reload = vi.spyOn(registry, "reloadFromServer");
    fireEvent.click(within(openPlans()).getByRole("button", { name: "Gamma" }));
    await settle();
    fireEvent.click(within(mainFailed()).getByRole("button", { name: RELOAD }));
    const load = within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Load again" });
    expect(load.hasAttribute("disabled")).toBe(true);
    fireEvent.click(load);
    await settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it("a failed plan open at start shows its error in the main area", async () => {
    const s = await seededStore(["Alpha", "Beta"]);
    s.mem.fail("store_load", s.ids[1], { code: "store.locked", message: "Locked by another process." });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: s.ids[1] }));
    const r = await indexOpen();
    const retryPlan = vi.spyOn(r.registry, "retryPlan");
    await showIndex(r);
    const main = mainFailed();
    expect(within(main).getByText("Locked by another process.").classList.contains("bad")).toBe(true);
    expect(document.querySelector(".phone-list")).toBeNull();
    expect(topBar().querySelector(".phone-plan-name")?.textContent).toBe("Beta");
    s.mem.recover("store_load", s.ids[1]);
    fireEvent.click(within(main).getByRole("button", { name: "Try again" }));
    await settle();
    expect(retryPlan.mock.calls).toEqual([[s.ids[1]]]);
    listShows("Beta");
  });

  it("the empty state offers New plan", async () => {
    const r = await emptyIndex();
    const createPlan = vi.spyOn(r.registry, "createPlan");
    await showIndex(r);
    expect(screen.getByRole("button", { name: "New plan" })).toBeTruthy();
    expect(document.querySelector(".phone-list")).toBeNull();
    expect(within(topBar()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Plans", "Local only"]);
    expect(screen.queryByRole("button", { name: "+" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    await settle();
    expect(createPlan.mock.calls).toEqual([["New plan"]]);
    listShows("New plan");
    expect(emptyState()).toBeNull();
  });

  it("the empty state's Show an example plan creates the example and opens it", async () => {
    const r = await emptyIndex();
    const createExample = vi.spyOn(r.registry, "createExample");
    await showIndex(r);
    fireEvent.click(screen.getByRole("button", { name: "Show an example plan" }));
    await settle();
    expect(createExample).toHaveBeenCalledTimes(1);
    listShows("Example: Website relaunch");
    expect(emptyState()).toBeNull();
    expect(r.registry.plans().map((l) => [l.name, l.space])).toEqual([["Example: Website relaunch", null]]);
  });

  it("the empty state shows a failed Show an example plan under the button", async () => {
    const r = await emptyIndex();
    failNewDocs(new Set(["local"]));
    await showIndex(r);
    fireEvent.click(screen.getByRole("button", { name: "Show an example plan" }));
    await settle();
    const state = emptyState();
    if (state === null) throw new Error("no empty state");
    expect(within(state).getByText("Disk full.").classList.contains("bad")).toBe(true);
    expect(document.querySelector(".phone-list")).toBeNull();
  });

  it("the empty state shows a failed New plan under the button", async () => {
    const r = await emptyIndex();
    failNewDocs(new Set(["local"]));
    await showIndex(r);
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    await settle();
    const state = emptyState();
    if (state === null) throw new Error("no empty state");
    expect(within(state).getByText("Disk full.").classList.contains("bad")).toBe(true);
    expect(document.querySelector(".phone-list")).toBeNull();
    expect(within(openPlans()).queryByText("Disk full.")).toBeNull();
  });

  it("the empty state's New plan shows it is busy", async () => {
    const r = await emptyIndex();
    const real = r.registry.createPlan.bind(r.registry);
    const g = gate();
    const createPlan = vi.spyOn(r.registry, "createPlan").mockImplementation((name) => g.wait.then(() => real(name)));
    await showIndex(r);
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    await settle();
    const busy = screen.getByRole("button", { name: "Creating…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(busy.querySelector(".dim")?.textContent).toBe("Creating…");
    fireEvent.click(busy);
    expect(createPlan).toHaveBeenCalledTimes(1);
    await act(async () => g.open());
    await settle();
    listShows("New plan");
  });

  it("the empty state offers Import plan…", async () => {
    const r = await emptyIndex();
    vi.mocked(importPlan).mockImplementationOnce(async (reg) => ({ planId: await reg.createPlan("MESA 2027"), converted: null }));
    await showIndex(r);
    const state = emptyState();
    if (state === null) throw new Error("no empty state");
    expect(within(state).getAllByRole("button").map((b) => b.textContent)).toEqual(["New plan", "Show an example plan", "Import plan…", "Join with a code", "Set up sync"]);
    fireEvent.click(within(state).getByRole("button", { name: "Import plan…" }));
    await settle();
    expect(importPlan).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual(["Imported “MESA 2027”"]);
    listShows("MESA 2027");
    expect(emptyState()).toBeNull();
  });

  it("shows the .gantt conversion report in a sheet before it opens the imported plan", async () => {
    const r = await emptyIndex();
    const report = { fileName: "Fixture Plan 20260901.gantt", name: "MESA 2027", counts: { groups: 1, tasks: 2, milestones: 1, links: 2, notes: 1, people: 0, assignments: 0 }, dropped: ["TaskID on 4 items"] };
    vi.mocked(importPlan).mockImplementationOnce(async (reg, review) => {
      await review(report);
      return { planId: await reg.createPlan("MESA 2027"), converted: report };
    });
    await showIndex(r);
    const state = emptyState();
    if (state === null) throw new Error("no empty state");
    fireEvent.click(within(state).getByRole("button", { name: "Import plan…" }));
    await settle();
    const sheet = screen.getByRole("dialog", { name: CONVERTED_TITLE });
    expect(sheet.classList.contains("sheet")).toBe(true);
    expect(within(sheet).getByText("TaskID on 4 items")).toBeTruthy();
    expect(toastTexts()).toEqual([]);
    expect(emptyState()).not.toBeNull();
    expect(r.registry.plans()).toEqual([]);
    fireEvent.click(within(sheet).getByRole("button", { name: OPEN_PLAN }));
    await settle();
    expect(screen.queryByRole("dialog", { name: CONVERTED_TITLE })).toBeNull();
    expect(toastTexts()).toEqual(["Imported “MESA 2027”"]);
    listShows("MESA 2027");
  });

  it("a cancelled import from the empty state changes nothing", async () => {
    const r = await emptyIndex();
    vi.mocked(importPlan).mockResolvedValueOnce(null);
    const createPlan = vi.spyOn(r.registry, "createPlan");
    await showIndex(r);
    fireEvent.click(screen.getByRole("button", { name: "Import plan…" }));
    await settle();
    expect(emptyState()).not.toBeNull();
    expect(toastTexts()).toEqual([]);
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("all plans trashed is the empty state", async () => {
    const s = await seededStore(["Alpha", "Beta"], { trash: [0, 1] });
    const r = await indexOpen();
    const restorePlan = vi.spyOn(r.registry, "restorePlan");
    await showIndex(r);
    expect(screen.getByRole("button", { name: "New plan" })).toBeTruthy();
    expect(document.querySelector(".phone-list")).toBeNull();
    expect(screen.queryByRole("button", { name: "+" })).toBeNull();
    openPlans();
    expect(within(trashOf()).getByText("Alpha")).toBeTruthy();
    expect(within(trashOf()).getByText("Beta")).toBeTruthy();
    fireEvent.click(within(planRow("Beta")).getByRole("button", { name: "Restore" }));
    await settle();
    expect(restorePlan.mock.calls).toEqual([[s.ids[1]]]);
    listShows("Beta");
    expect(emptyState()).toBeNull();
  });

  it("repair notices toast once", async () => {
    const s = await seededStore(["Alpha", "Beta"]);
    tear(new Set([s.ids[0]]));
    const r = await indexOpen();
    await showIndex(r);
    listShows("Alpha");
    expect(toastTexts()).toEqual([CUT_OFF]);
    fireEvent.click(within(openPlans()).getByRole("button", { name: "Beta" }));
    await settle();
    fireEvent.click(within(openPlans()).getByRole("button", { name: "Alpha" }));
    await settle();
    listShows("Alpha");
    expect(toastTexts()).toEqual([CUT_OFF]);
    cleanup();
    clearToasts();
    await seededStore(["Alpha"]);
    tear(new Set(["local"]));
    await showIndex(await indexOpen());
    expect(toastTexts()).toEqual([INDEX_CUT]);
  });

  it("an index notice after start toasts once", async () => {
    const s = await seededStore(["Alpha", "Beta"]);
    const r = await indexOpen();
    let notice: string | null = null;
    vi.spyOn(r.registry, "takeIndexRepairNotice").mockImplementation(() => {
      const n = notice;
      notice = null;
      return n;
    });
    await showIndex(r);
    expect(toastTexts()).toEqual([]);
    notice = INDEX_CUT;
    act(() => r.registry.trashPlan(s.ids[1]));
    await settle();
    expect(toastTexts()).toEqual([INDEX_CUT]);
    act(() => r.registry.restorePlan(s.ids[1]));
    await settle();
    expect(toastTexts()).toEqual([INDEX_CUT]);
  });
});

describe("PhoneShell undo and redo (Step 2)", () => {
  const REVIEW: readonly SeedItem[] = [{ name: "Review", start: "2026-11-10", dur: 2 }];
  const undoButton = (): HTMLElement => within(topBar()).getByRole("button", { name: "Undo" });
  const redoButton = (): HTMLElement => within(topBar()).getByRole("button", { name: "Redo" });

  it("Undo and Redo are glyph buttons named by their words, so the plan name keeps the width", async () => {
    const t = await testSession(REVIEW);
    sessions.push(t.session);
    await shown(t);
    expect([undoButton().textContent, undoButton().getAttribute("aria-label"), undoButton().title]).toEqual(["↶", "Undo", "Undo"]);
    expect([redoButton().textContent, redoButton().getAttribute("aria-label"), redoButton().title]).toEqual(["↷", "Redo", "Redo"]);
    expect(undoButton().classList.contains("phone-glyph")).toBe(true);
  });

  it("Undo and Redo follow canUndo and canRedo and report their toasts", async () => {
    const t = await testSession(REVIEW);
    sessions.push(t.session);
    await shown(t);
    expect([undoButton().hasAttribute("disabled"), redoButton().hasAttribute("disabled")]).toEqual([true, true]);
    act(() => {
      t.session.apply({ t: "rename", item: "Review", name: "Review 2" });
    });
    expect([undoButton().hasAttribute("disabled"), redoButton().hasAttribute("disabled")]).toEqual([false, true]);
    const undo = vi.spyOn(t.session, "undo");
    const redo = vi.spyOn(t.session, "redo");
    fireEvent.click(undoButton());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual([builtOf(undo).toast]);
    expect([undoButton().hasAttribute("disabled"), redoButton().hasAttribute("disabled")]).toEqual([true, false]);
    clearToasts();
    fireEvent.click(redoButton());
    expect(redo).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual([builtOf(redo).toast]);
  });

  it("undo offer", async () => {
    const t = await testSession(REVIEW);
    sessions.push(t.session);
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    t.session.apply({ t: "move", items: ["Review"], days: 1 });
    peer.session.apply({ t: "move", items: ["Review"], days: 2 });
    peer.sync();
    expect(t.session.view().choices.map((c) => c.units)).toEqual([["s:Review"]]);
    const offer = t.session.undoOffer();
    if (offer === null) throw new Error("no undo offer");
    await shown(t);
    const undo = vi.spyOn(t.session, "undo");
    const resolve = vi.spyOn(t.session, "resolve");
    const actions = t.session.history().length;
    fireEvent.click(undoButton());
    expect(lastUi().dialog).toEqual({ t: "choice", id: offer.choice, side: offer.side });
    const sheet = screen.getByRole("dialog", { name: "Choose which to keep" });
    expect(undo).not.toHaveBeenCalled();
    expect(t.session.history()).toHaveLength(actions);
    fireEvent.click(within(sheet).getByRole("button", { name: "Apply" }));
    expect(resolve.mock.calls).toEqual([[offer.choice, { side: offer.side }, { pushFromPredecessors: true, returnPushed: true }]]);
    expect(toastTexts()).toEqual([builtOf(resolve).toast]);
  });
});

interface NewAsk {
  token: string;
  sections: { title: string | null; rows: { id: string; title: string }[] }[];
}

const newAsk = (): NewAsk => {
  const all = tauri.calls.filter((c) => c.cmd === "menu_show").map((c) => (c.args as { menu: NewAsk }).menu);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error("+ sent no menu_show");
  return last;
};

const openPlus = async (): Promise<NewAsk> => {
  fireEvent.click(within(topBar()).getByRole("button", { name: "+" }));
  await settle();
  return newAsk();
};

const pickNew = async (label: string): Promise<void> => chooseNew(await openPlus(), label);

const chooseNew = (ask: NewAsk, label: string): void => {
  const row = ask.sections.flatMap((s) => s.rows).find((r) => r.title === label);
  if (row === undefined) throw new Error(`the + menu has no row ${label}`);
  act(() => {
    emitFromRust("menu-ended", { token: ask.token });
    emitFromRust("menu-chosen", { token: ask.token, id: row.id });
  });
};

describe("PhoneShell new items (Step 3)", () => {
  it.each([
    ["New task", { t: "create", kind: "task", name: "New task", parent: null, after: null, start: "2026-11-10", dur: 3 }, "Added task “New task”"],
    ["New milestone", { t: "create", kind: "milestone", name: "New milestone", parent: null, after: null, start: "2026-11-10" }, "Added milestone “New milestone”"],
    ["New group", { t: "create", kind: "group", name: "New group", parent: null, after: null, start: null }, "Added group “New group”"],
  ])("+ → %s creates it with no selection and opens its sheet with the name selected", async (label, intent, history) => {
    const t = await testSession([{ name: "Review", start: "2026-11-10", dur: 2 }]);
    sessions.push(t.session);
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    const ask = await openPlus();
    expect(ask.sections.flatMap((s) => s.rows.map((r) => r.title))).toEqual(["New task", "New milestone", "New group"]);
    expect(screen.queryByRole("menu")).toBeNull();
    chooseNew(ask, label);
    expect(tauri.calls.filter((c) => c.cmd === "menu_show")).toHaveLength(1);
    expect(apply.mock.calls).toEqual([[intent]]);
    expect(t.session.history()[0]?.label).toBe(history);
    const created = builtOf(apply).action.w.find((w) => w.u.startsWith("e:"));
    if (created === undefined) throw new Error("the create wrote no e: unit");
    const id: ItemId = created.u.slice(2);
    expect(lastUi().selected).toBe(id);
    expect(screen.queryByRole("menu")).toBeNull();
    const field = within(screen.getByRole("dialog", { name: label })).getByRole("textbox", { name: "Name" });
    if (!(field instanceof HTMLInputElement)) throw new Error("no name input");
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, label.length]);
  });

  it("+ → New task creates with the plan defaults", async () => {
    const t = await testSession([{ id: "g", name: "Commission", kind: "group" }, { name: "Review", start: "2026-11-10", dur: 2 }]);
    sessions.push(t.session);
    t.session.apply({ t: "person", op: "add", name: "Mira Okafor", initials: "MO", colour: "cyan", after: null });
    const mira = [...t.session.view().plan.people.persons.keys()][0];
    t.session.apply({ t: "defaults", field: "dur", value: 5 });
    t.session.apply({ t: "defaults", field: "dated", value: false });
    t.session.apply({ t: "defaults", field: "who", value: mira });
    t.session.apply({ t: "defaults", field: "group", value: "g" });
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    chooseNew(await openPlus(), "New task");
    expect(apply.mock.calls).toEqual([[{ t: "create", kind: "task", name: "New task", parent: null, after: null, start: null, dur: 5, who: mira }]]);
    const id = lastUi().selected;
    if (id === null) throw new Error("nothing selected");
    expect(t.session.view().plan.items.get(id)?.schedule).toMatchObject({ start: null, dur: 5 });
    expect(t.session.view().plan.people.assignees.get(id)).toEqual([mira]);
  });
});

describe("PhoneShell + as a native menu", () => {
  const plus = (): HTMLElement => within(topBar()).getByRole("button", { name: "+" });

  it.each(["New task", "New milestone", "New group"])("a choice of %s creates it once, after the menu is gone", async (label) => {
    const t = await made();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    await pickNew(label);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toMatchObject({ t: "create", name: label });
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("dialog", { name: label })).toBeTruthy();
  });

  it("a menu that ends with no choice creates nothing", async () => {
    const t = await made();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    const ask = await openPlus();
    expect(plus().getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => emitFromRust("menu-ended", { token: ask.token }));
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    expect(apply).not.toHaveBeenCalled();
  });

  it("a second tap replaces the open menu, and only the newer menu's choice creates", async () => {
    const t = await made();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    const first = await openPlus();
    const second = await openPlus();
    expect(second.token).not.toBe(first.token);
    act(() => emitFromRust("menu-ended", { token: first.token }));
    expect(plus().getAttribute("aria-expanded")).toBe("true");
    chooseNew(second, "New milestone");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toMatchObject({ t: "create", kind: "milestone" });
    expect(plus().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("PhoneShell item sheet (Step 4)", () => {
  const EDIT_SEED: readonly SeedItem[] = [
    { id: "S4", name: "Sprint 4", kind: "group" },
    { name: "QA", kind: "group", parent: "S4" },
    { name: "Test", parent: "QA", start: "2026-11-10", dur: 1 },
    { name: "Review", parent: "S4", start: "2026-11-10", dur: 2 },
    { name: "Notes", horizon: "now" },
  ];
  const TRASHED_ON_IPHONE = "“Notes” was moved to the Trash on iPhone. Restore it from the Trash.";

  const withPeer = async () => {
    const t = await testSession(EDIT_SEED);
    sessions.push(t.session);
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    await shown(t);
    setUiNow({ selected: "Notes" });
    expect(screen.getByRole("dialog", { name: "Notes" })).toBeTruthy();
    return { t, peer };
  };

  it("a peer trash closes the sheet", async () => {
    const { t, peer } = await withPeer();
    act(() => {
      peer.session.apply({ t: "trash", items: ["Notes"] });
      peer.sync();
    });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual([TRASHED_ON_IPHONE]);
    expect(t.session.authorOf("e:Notes")).toEqual({ dev: "iphone", device: "iPhone" });
  });

  it("a peer trash of the group closes its item's sheet and names the group", async () => {
    const { peer } = await withPeer();
    setUiNow({ selected: "Review" });
    expect(screen.getByRole("dialog", { name: "Review" })).toBeTruthy();
    act(() => {
      peer.session.apply({ t: "trash", items: ["S4"] });
      peer.sync();
    });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual(["“Sprint 4” was moved to the Trash on iPhone. Restore it from the Trash."]);
  });

  it("a peer trash among local edits", async () => {
    const { t, peer } = await withPeer();
    act(() => {
      peer.session.apply({ t: "trash", items: ["Notes"] });
    });
    act(() => {
      t.session.apply({ t: "rename", item: "Review", name: "Review 2" });
    });
    act(() => peer.sync());
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual([TRASHED_ON_IPHONE]);
  });

  it("Undo after a create closes the new item's sheet with only the undo's toast", async () => {
    const t = await testSession(EDIT_SEED);
    sessions.push(t.session);
    await shown(t);
    await pickNew("New task");
    expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy();
    clearToasts();
    const undo = vi.spyOn(t.session, "undo");
    fireEvent.click(within(topBar()).getByRole("button", { name: "Undo" }));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual([builtOf(undo).toast]);
  });

  const NEW_W = { t: "create", kind: "task", name: "W", parent: null, after: "Notes", start: "2026-11-12", dur: 1 } as const;
  const itemNamed = (t: TestSession, name: string): ItemId => {
    const it = [...t.session.view().plan.items.values()].find((x) => x.name === name);
    if (it === undefined) throw new Error("no item " + name);
    return it.id;
  };

  it("a peer's undo that orphans an item this device renamed closes its sheet and names the peer", async () => {
    const t = await testSession(EDIT_SEED);
    sessions.push(t.session);
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    await shown(t);
    act(() => {
      peer.session.apply(NEW_W);
      peer.sync();
    });
    const x = itemNamed(t, "W");
    setUiNow({ selected: x });
    act(() => {
      t.session.apply({ t: "rename", item: x, name: "X" });
      peer.sync();
    });
    await settle();
    expect(screen.getByRole("dialog", { name: "X" })).toBeTruthy();
    clearToasts();
    act(() => {
      peer.session.undo();
      peer.sync();
    });
    await settle();
    expect(t.session.view().plan.items.get(x)?.trashed).toBe(true);
    expect(t.session.authorOf("e:" + x)).toBeNull();
    expect(t.session.trashAuthorOf(x)).toEqual({ dev: "iphone", device: "iPhone" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual(["“X” was moved to the Trash on iPhone. Restore it from the Trash."]);
  });

  it("undoing this device's create after a peer rename closes the sheet with only the undo's toast", async () => {
    const t = await testSession(EDIT_SEED);
    sessions.push(t.session);
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    await shown(t);
    act(() => {
      t.session.apply(NEW_W);
    });
    const x = itemNamed(t, "W");
    setUiNow({ selected: x });
    act(() => {
      peer.sync();
      peer.session.apply({ t: "rename", item: x, name: "X" });
      peer.sync();
    });
    await settle();
    expect(screen.getByRole("dialog", { name: "X" })).toBeTruthy();
    clearToasts();
    const undo = vi.spyOn(t.session, "undo");
    fireEvent.click(within(topBar()).getByRole("button", { name: "Undo" }));
    await settle();
    const done = builtOf(undo);
    expect(t.session.view().plan.items.get(x)?.trashed).toBe(true);
    expect(t.session.trashAuthorOf(x)).toEqual({ dev: "mac", device: "Mac" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(done.toast).toContain("“X” was changed since on the iPhone — moved to the Trash.");
    expect(toastTexts()).toEqual([done.toast]);
  });

  it("a ghost row keeps its sheet", async () => {
    const { t, peer } = await withPeer();
    act(() => {
      peer.session.apply({ t: "trash", items: ["Notes"] });
    });
    act(() => {
      t.session.apply({ t: "rename", item: "Notes", name: "Notes 2" });
    });
    act(() => peer.sync());
    await settle();
    expect(t.session.view().choices.filter((c) => c.kind === "delete")).toHaveLength(1);
    const sheet = screen.getByRole("dialog");
    expect(sheet.querySelector(".detail-body")?.firstElementChild?.classList.contains("choice-banner")).toBe(true);
    expect(toastTexts()).toEqual([]);
  });

  it("keeping a ghost in the Trash from its own sheet toasts only the resolve", async () => {
    const { t, peer } = await withPeer();
    act(() => {
      peer.session.apply({ t: "trash", items: ["Notes"] });
    });
    act(() => {
      t.session.apply({ t: "rename", item: "Notes", name: "Notes 2" });
    });
    act(() => peer.sync());
    await settle();
    const [c] = t.session.view().choices.filter((x) => x.kind === "delete");
    if (c === undefined) throw new Error("no delete choice");
    const trashed = c.sides.find((s) => s.label === "iPhone");
    if (trashed === undefined) throw new Error("no iPhone side");
    const keep = sideText(c, trashed.key, t.session.view().plan);
    expect(keep).toBe("“Notes 2” stays in the Trash");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Notes 2" })).getByRole("button", { name: "Choose" }));
    const choice = screen.getByRole("dialog", { name: CHOICE_TITLE });
    const resolve = vi.spyOn(t.session, "resolve");
    fireEvent.click(within(choice).getByRole("radio", { name: keep }));
    fireEvent.click(within(choice).getByRole("button", { name: "Apply" }));
    await settle();
    const done = builtOf(resolve);
    expect(t.session.view().plan.items.get("Notes")?.trashed).toBe(true);
    expect(t.session.trashAuthorOf("Notes").dev).toBe("mac");
    expect(lastUi().selected).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual([done.toast]);
  });
});

describe("PhoneShell read-only (Step 4b)", () => {
  const EDIT_SEED: readonly SeedItem[] = [
    { id: "S4", name: "Sprint 4", kind: "group" },
    { name: "QA", kind: "group", parent: "S4" },
    { name: "Test", parent: "QA", start: "2026-11-10", dur: 1 },
    { name: "Review", parent: "S4", start: "2026-11-10", dur: 2 },
    { name: "Notes", horizon: "now" },
  ];
  const EDITS = ["Group", "Unschedule", "Move up", "Move down", "Delete"];

  it("read-only drops edit controls", async () => {
    const t = await testSession(EDIT_SEED);
    sessions.push(t.session);
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    const root = document.querySelector(".app.phone");
    setUiNow({ selected: "Review" });
    act(() => t.session.setReadOnly(true));
    const plus = within(topBar()).getByRole("button", { name: "+" });
    expect(plus.hasAttribute("disabled")).toBe(true);
    fireEvent.click(plus);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(topBar()).getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(true);
    expect(within(topBar()).getByRole("button", { name: "Redo" }).hasAttribute("disabled")).toBe(true);
    const sheet = screen.getByRole("dialog", { name: "Review" });
    expect(sheet.querySelectorAll("input, select")).toHaveLength(0);
    expect(sheet.textContent).toContain("Review");
    expect(sheet.textContent).toContain("Sprint 4");
    EDITS.forEach((n) => expect([n, within(sheet).queryByRole("button", { name: n })]).toEqual([n, null]));
    expect(document.querySelector(".app.phone")).toBe(root);
    const nameText = sheet.querySelector(".title-input");
    if (nameText === null) throw new Error("no name text");
    fireEvent.keyDown(nameText, { key: "Enter" });
    within(sheet)
      .getAllByRole("button")
      .filter((b) => b.textContent !== "Close" && b.getAttribute("aria-label") !== "Close" && b.closest(".detail-head") === null)
      .forEach((b) => fireEvent.click(b));
    expect(apply).not.toHaveBeenCalled();
    act(() => t.session.setReadOnly(false));
    const back = screen.getByRole("dialog", { name: "Review" });
    expect(within(back).getByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(within(back).getByRole("combobox", { name: "Group" })).toBeTruthy();
    EDITS.filter((n) => n !== "Group").forEach((n) => expect(within(back).getByRole("button", { name: n })).toBeTruthy());
    setUiNow({ selected: "Notes" });
    act(() => t.session.setReadOnly(true));
    const notes = screen.getByRole("dialog", { name: "Notes" });
    expect(notes.textContent).toContain("Now");
    expect(within(notes).queryByRole("combobox", { name: "Horizon" })).toBeNull();
  });

  it("space plans follow spaceReadOnly", async () => {
    const s = await seededStore(["Alpha", "Beta", "Gamma"], { trash: [2] });
    const [alpha, , gamma] = s.ids;
    const r = await indexOpen();
    withSpace(r.registry, new Set([alpha, gamma]));
    const spaceReadOnly = vi.spyOn(r.registry, "spaceReadOnly").mockReturnValue(true);
    const trashPlan = vi.spyOn(r.registry, "trashPlan");
    const restorePlan = vi.spyOn(r.registry, "restorePlan");
    await showIndex(r);
    openPlans();
    const alphaTrash = within(planRow("Alpha")).getByRole("button", { name: "Move to Trash" });
    const gammaRestore = within(planRow("Gamma")).getByRole("button", { name: "Restore" });
    expect([alphaTrash.hasAttribute("disabled"), gammaRestore.hasAttribute("disabled")]).toEqual([true, true]);
    fireEvent.click(alphaTrash);
    fireEvent.click(gammaRestore);
    expect([trashPlan.mock.calls.length, restorePlan.mock.calls.length]).toEqual([0, 0]);
    expect(within(planRow("Beta")).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(false);
    spaceReadOnly.mockReturnValue(false);
    const session = await r.registry.session(alpha);
    act(() => session.setReadOnly(true));
    closePlans();
    openPlans();
    expect(within(planRow("Alpha")).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(false);
    expect(within(planRow("Gamma")).getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(false);
  });
});

const SHEET_SEED: readonly SeedItem[] = [...MESA_SEED, { name: "Old", start: "2026-11-20", dur: 1 }];

const planSheetMade = async (seed: readonly SeedItem[] = SHEET_SEED): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  if (seed.some((s) => s.name === "Old")) t.session.apply({ t: "trash", items: ["Old"] });
  t.session.apply({ t: "planName", name: "MESA 1.0" });
  return t;
};

const openPlanSheet = (): HTMLElement => {
  fireEvent.click(within(topBar()).getByRole("button", { name: "Plan" }));
  return screen.getByRole("dialog", { name: "Plan" });
};

const planSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Plan" });

const nameField = (): HTMLInputElement => {
  const el = within(planSheet()).getByRole("textbox", { name: "Plan name" });
  if (!(el instanceof HTMLInputElement)) throw new Error("the plan name is not a field");
  return el;
};

const historyRows = (): HTMLElement[] => [...planSheet().querySelectorAll<HTMLElement>(".history li")];

const historyRow = (id: string): HTMLElement => {
  const el = planSheet().querySelector(`.history li[data-action="${id}"]`);
  if (!(el instanceof HTMLElement)) throw new Error("no history row " + id);
  return el;
};

const sheetLines = (title: string): (string | null)[] => [...screen.getByRole("dialog", { name: title }).querySelectorAll(".revert-text p")].map((p) => p.textContent);

const onlyClose = (title: string): HTMLElement => {
  const sheet = screen.getByRole("dialog", { name: title });
  expect(within(sheet).queryByRole("button", { name: "Cancel" })).toBeNull();
  const close = within(sheet).getAllByRole("button", { name: "Close" });
  expect(close).toHaveLength(1);
  return close[0];
};

const newestLabel = (t: TestSession): string => {
  const e = t.session.history()[0];
  if (e === undefined) throw new Error("no history");
  return e.label;
};

describe("PhoneShell plan sheet (Task 5.8 Step 3)", () => {
  it("⋯ is absent in the empty state", async () => {
    await showIndex(await emptyIndex());
    expect(emptyState()).not.toBeNull();
    expect(within(topBar()).queryByRole("button", { name: "Plan" })).toBeNull();
  });

  it("renames the plan from its name field", async () => {
    const t = await planSheetMade();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    openPlanSheet();
    expect(nameField().value).toBe("MESA 1.0");
    fireEvent.focus(nameField());
    fireEvent.blur(nameField());
    fireEvent.change(nameField(), { target: { value: " MESA 1.0 " } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    fireEvent.change(nameField(), { target: { value: "   " } });
    fireEvent.blur(nameField());
    expect(apply).not.toHaveBeenCalled();
    expect(nameField().value).toBe("MESA 1.0");
    expect(toastTexts()).toEqual([EMPTY_NAME]);
    fireEvent.change(nameField(), { target: { value: "Roadmap 2" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(apply.mock.calls.map((c) => c[0])).toEqual([{ t: "planName", name: "Roadmap 2" }]);
    expect(newestLabel(t)).toBe("Renamed the plan to “Roadmap 2”");
    expect(topBar().querySelector(".phone-plan-name")?.textContent).toBe("Roadmap 2");
    fireEvent.change(nameField(), { target: { value: "Roadmap 3" } });
    fireEvent.blur(nameField());
    expect(apply.mock.calls.map((c) => c[0])).toEqual([
      { t: "planName", name: "Roadmap 2" },
      { t: "planName", name: "Roadmap 3" },
    ]);
  });

  it("history times", async () => {
    const t = await planSheetMade();
    const entries: HistoryEntry[] = [
      { id: "x1", label: "Renamed “A” to “B”", device: "Mac", at: new Date(2026, 10, 9, 14, 5).getTime(), active: true, root: false },
      { id: "x2", label: "Unscheduled “A”", device: "iPhone", at: new Date(2026, 10, 8, 9, 30).getTime(), active: true, root: false },
    ];
    vi.spyOn(t.session, "history").mockReturnValue(entries);
    await shown(t);
    openPlanSheet();
    expect(historyRows().map((r) => r.querySelector(".hist-text")?.textContent)).toEqual(["14:05 · Mac · Renamed “A” to “B”", "8 Nov 09:30 · iPhone · Unscheduled “A”"]);
  });

  it("revert preview names the action first", async () => {
    const t = await testSession([{ name: "Review", start: "2026-11-10", dur: 2 }]);
    sessions.push(t.session);
    const moved = t.session.apply({ t: "move", items: ["Review"], days: 2 });
    const revert = vi.spyOn(t.session, "revert");
    await shown(t);
    openPlanSheet();
    fireEvent.click(within(historyRow(moved.action.id)).getByRole("button", { name: "Revert this action" }));
    expect(screen.queryByRole("dialog", { name: "Plan" })).toBeNull();
    const lines = sheetLines("Revert this action");
    expect(lines).toEqual(revertText(moved.action.lbl, t.session.previewRevert(moved.action.id)));
    expect(lines[0]?.startsWith("Moved “Review” later by 2 working days")).toBe(true);
    expect(lines.join("\n")).not.toContain("0 move later");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Revert this action" })).getByRole("button", { name: "Apply" }));
    expect(revert.mock.calls).toEqual([[moved.action.id]]);
    const r = revert.mock.results[0];
    if (r === undefined || r.type !== "return") throw new Error("revert did not return");
    expect(toastTexts()).toContain(r.value.toast);
    expect(planSheet()).toBeTruthy();
  });

  it("a revert that changes no dates, then brings it back", async () => {
    const t = await testSession([{ name: "Review", start: "2026-11-10", dur: 2 }]);
    sessions.push(t.session);
    await shown(t);
    openPlanSheet();
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Save baseline" }));
    const saved = t.session.history()[0];
    expect(saved.label).toBe("Saved baseline “Baseline 9 Nov 2026”");
    fireEvent.click(within(historyRow(saved.id)).getByRole("button", { name: "Revert this action" }));
    expect(sheetLines("Revert this action")).toEqual([saved.label, "No item dates change."]);
    fireEvent.click(onlyClose("Revert this action"));
    fireEvent.click(within(topBar()).getByRole("button", { name: "Undo" }));
    expect(historyRow(saved.id).classList.contains("inactive")).toBe(true);
    const revert = vi.spyOn(t.session, "revert");
    fireEvent.click(within(historyRow(saved.id)).getByRole("button", { name: "Bring this action back" }));
    expect(sheetLines("Bring this action back")).toEqual(revertText(saved.label, t.session.previewRevert(saved.id)));
    expect(sheetLines("Bring this action back")).toEqual([saved.label, "No item dates change."]);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Bring this action back" })).getByRole("button", { name: "Apply" }));
    expect(revert.mock.calls).toEqual([[saved.id]]);
    expect(historyRow(saved.id).classList.contains("inactive")).toBe(false);
    expect(within(historyRow(saved.id)).getByRole("button", { name: "Revert this action" })).toBeTruthy();
  });

  it("the first entry has no button", async () => {
    const t = await planSheetMade();
    await shown(t);
    openPlanSheet();
    const entries = t.session.history();
    const root = entries.filter((e) => e.root);
    expect(root).toHaveLength(1);
    expect(within(historyRow(root[0].id)).queryAllByRole("button")).toEqual([]);
    entries
      .filter((e) => !e.root)
      .forEach((e) => expect(within(historyRow(e.id)).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-label")])).toEqual([e.active ? ["Revert", "Revert this action"] : ["Bring back", "Bring this action back"]]));
  });

  it("reverting a side opens its choice", async () => {
    const t = await testSession([{ name: "Review", start: "2026-11-10", dur: 2 }]);
    sessions.push(t.session);
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    const mine = t.session.apply({ t: "move", items: ["Review"], days: 1 });
    peer.session.apply({ t: "move", items: ["Review"], days: 2 });
    peer.sync();
    const choice = t.session.view().choices.find((c) => c.units.includes("s:Review"));
    if (choice === undefined) throw new Error("no s:Review choice");
    const iphone = choice.sides.find((s) => s.label === "iPhone");
    if (iphone === undefined) throw new Error("no iPhone side");
    const revert = vi.spyOn(t.session, "revert");
    const before = [...t.session.history()];
    await shown(t);
    openPlanSheet();
    fireEvent.click(within(historyRow(mine.action.id)).getByRole("button", { name: "Revert this action" }));
    expect(screen.queryByRole("dialog", { name: "Revert this action" })).toBeNull();
    expect(lastUi().dialog).toEqual({ t: "choice", id: choice.id, side: iphone.key });
    const sheet = screen.getByRole("dialog", { name: CHOICE_TITLE });
    expect(within(sheet).getByRole("radio", { name: "iPhone" }).getAttribute("aria-checked")).toBe("true");
    expect(revert).not.toHaveBeenCalled();
    expect(t.session.history()).toEqual(before);
  });

  it("restores a trashed item", async () => {
    const t = await planSheetMade();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    openPlanSheet();
    const row = planSheet().querySelector('[data-trashed="Old"]');
    if (!(row instanceof HTMLElement)) throw new Error("no Old in the Trash");
    expect(row.textContent).toContain("Old");
    fireEvent.click(within(row).getByRole("button", { name: "Restore" }));
    expect(apply.mock.calls.map((c) => c[0])).toEqual([{ t: "restore", items: ["Old"] }]);
  });

  it("shows the calendar summary and opens Settings at Working time, closing the plan sheet", async () => {
    const t = await planSheetMade();
    await shown(t);
    openPlanSheet();
    expect(within(planSheet()).getByText(calendarSummary(t.session.view().plan.calendar, 1))).toBeTruthy();
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Change calendar…" }));
    expect([screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label")), lastUi().settings]).toEqual([["Settings"], "working-time"]);
    expect(screen.getByRole("dialog", { name: "Settings" }).querySelector('section.settings-page[data-section="working-time"]:not([hidden]) .cal-body')).not.toBeNull();
    fireEvent.click(onlyClose("Settings"));
    expect([screen.queryAllByRole("dialog"), lastUi().settings]).toEqual([[], null]);
  });

  it("exports and imports from File", async () => {
    await seededStore(["Alpha"]);
    const r = await indexOpen();
    vi.mocked(exportFlow).mockResolvedValueOnce(undefined);
    vi.mocked(importFlow).mockResolvedValueOnce(undefined);
    await showIndex(r);
    listShows("Alpha");
    const alpha = r.registry.plans().find((l) => l.name === "Alpha");
    if (alpha === undefined) throw new Error("Alpha is not listed");
    openPlanSheet();
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Export plan…" }));
    expect(vi.mocked(exportFlow).mock.calls).toEqual([[await r.registry.session(alpha.id)]]);
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Import plan…" }));
    await settle();
    expect(importFlow).toHaveBeenCalledTimes(1);
    const call = vi.mocked(importFlow).mock.calls[0];
    expect(call).toHaveLength(2);
    const [registry, opener] = call;
    expect(registry).toBe(r.registry);
    expect(typeof opener).toBe("function");
    const imported = await act(async () => r.registry.createPlan("MESA 2027"));
    await settle();
    listShows("Alpha");
    act(() => opener(imported));
    await settle();
    listShows("MESA 2027");
  });

  it("about, through the Settings row of the ⋯ Plan sheet", async () => {
    const t = await planSheetMade();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    openPlanSheet();
    expect(within(planSheet()).queryByRole("button", { name: "About WebBoard" })).toBeNull();
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Settings…" }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Settings"]);
    const settings = screen.getByRole("dialog", { name: "Settings" });
    expect([lastUi().settings, lastUi().settingsRoot]).toEqual(["general", true]);
    const general = settings.querySelector<HTMLElement>('button.settings-root-row[data-section="general"]');
    if (general === null) throw new Error("no General row on the Settings root");
    fireEvent.click(general);
    expect([lastUi().settingsRoot, settings.querySelector(".sheet-head .sheet-title")?.textContent]).toEqual([false, "General"]);
    const about = settings.querySelector<HTMLElement>('section.settings-page[data-section="general"]:not([hidden]) [data-settings-row="general.about"]');
    if (about === null) throw new Error("no About row on the General page");
    expect(about.textContent).toContain(`WebBoard ${version}`);
    expect(about.textContent).toContain(HOLIDAY_ATTRIBUTION);
    expect(HOLIDAY_ATTRIBUTION).toBe("Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.");
    fireEvent.click(onlyClose("Settings"));
    expect(lastUi().settings).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    ["the empty state's Plans", async (): Promise<void> => showIndex(await emptyIndex())],
    ["an open plan's Plans", async (): Promise<void> => shown(await planSheetMade())],
  ])("offers the Settings row in %s, without an About row", async (_, show) => {
    await show();
    openPlans();
    expect(within(plansSheet()).queryByRole("button", { name: "About WebBoard" })).toBeNull();
    fireEvent.click(within(plansSheet()).getByRole("button", { name: "Settings…" }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Settings"]);
    expect(screen.getByRole("dialog", { name: "Settings" }).querySelector("div.settings-root:not([hidden])")).not.toBeNull();
  });

  it("baselines on the phone", async () => {
    const t = await testSession([{ name: "Review", start: "2026-11-10", dur: 2 }]);
    sessions.push(t.session);
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    openPlanSheet();
    const save = (): boolean => fireEvent.click(within(planSheet()).getByRole("button", { name: "Save baseline" }));
    save();
    expect(apply.mock.calls.map((c) => c[0])).toEqual([{ t: "baseline", op: "save", name: "Baseline 9 Nov 2026" }]);
    expect(newestLabel(t)).toBe("Saved baseline “Baseline 9 Nov 2026”");
    const [first] = [...t.session.view().plan.baselines.keys()];
    const rowOfBaseline = (id: string): HTMLElement => {
      const el = planSheet().querySelector(`[data-baseline="${id}"]`);
      if (!(el instanceof HTMLElement)) throw new Error("no baseline row " + id);
      return el;
    };
    expect(within(rowOfBaseline(first)).getByRole("textbox", { name: "Baseline name" })).toBeTruthy();
    expect(within(rowOfBaseline(first)).getByRole("button", { name: "Show" })).toBeTruthy();
    expect(within(rowOfBaseline(first)).getByRole("button", { name: "Remove" })).toBeTruthy();
    act(() => {
      t.session.apply({ t: "move", items: ["Review"], days: 3 });
    });
    const writes = apply.mock.calls.length;
    fireEvent.click(within(rowOfBaseline(first)).getByRole("button", { name: "Show" }));
    expect(lastUi().baseline).toBe(first);
    expect(within(rowOfBaseline(first)).getByRole("button", { name: "Hide" })).toBeTruthy();
    expect(apply.mock.calls.length).toBe(writes);
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Close" }));
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    expect(document.querySelectorAll(".ghost")).toHaveLength(1);
    expect([...document.querySelectorAll(".bar-label .meta")].map((e) => e.textContent)).toContain("+3d vs baseline");
    openPlanSheet();
    fireEvent.click(within(rowOfBaseline(first)).getByRole("button", { name: "Hide" }));
    expect(lastUi().baseline).toBeNull();
    expect(document.querySelectorAll(".ghost")).toHaveLength(0);
    save();
    const second = [...t.session.view().plan.baselines.keys()].find((k) => k !== first);
    if (second === undefined) throw new Error("no second baseline");
    fireEvent.click(within(rowOfBaseline(first)).getByRole("button", { name: "Show" }));
    fireEvent.click(within(rowOfBaseline(second)).getByRole("button", { name: "Show" }));
    expect(lastUi().baseline).toBe(second);
    expect(within(rowOfBaseline(first)).getByRole("button", { name: "Show" })).toBeTruthy();
    const firstName = (): HTMLElement => within(rowOfBaseline(first)).getByRole("textbox", { name: "Baseline name" });
    apply.mockClear();
    fireEvent.change(firstName(), { target: { value: "Baseline 9 Nov 2026" } });
    fireEvent.blur(firstName());
    expect(apply).not.toHaveBeenCalled();
    fireEvent.change(firstName(), { target: { value: "Kickoff" } });
    fireEvent.keyDown(firstName(), { key: "Enter" });
    expect(apply.mock.calls.map((c) => c[0])).toEqual([{ t: "baseline", op: "rename", id: first, name: "Kickoff" }]);
    expect(newestLabel(t)).toBe("Renamed baseline “Baseline 9 Nov 2026” to “Kickoff”");
    fireEvent.click(within(rowOfBaseline(first)).getByRole("button", { name: "Remove" }));
    expect(apply.mock.calls.map((c) => c[0])[1]).toEqual({ t: "baseline", op: "remove", id: first });
    expect(newestLabel(t)).toBe("Removed baseline “Kickoff”");
  });
});

describe("PhoneShell read-only plan sheet (Task 5.8 Step 3b)", () => {
  it("read-only plan sheet", async () => {
    const t = await planSheetMade();
    t.session.apply({ t: "baseline", op: "save", name: "Before" });
    t.session.apply({ t: "move", items: ["t3"], days: 1 });
    t.session.undo();
    const apply = vi.spyOn(t.session, "apply");
    const revert = vi.spyOn(t.session, "revert");
    const registry = await phoneRegistry(t);
    registries.push(registry);
    const restorePlan = vi.spyOn(registry, "restorePlan");
    render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
    await settle();
    openPlanSheet();
    expect(within(planSheet()).getAllByRole("button", { name: "Bring this action back" }).length).toBeGreaterThan(0);
    expect(within(planSheet()).getAllByRole("button", { name: "Revert this action" }).length).toBeGreaterThan(0);
    act(() => t.session.setReadOnly(true));
    const sheet = planSheet();
    expect(sheet.querySelector("input")).toBeNull();
    expect(within(sheet).getByLabelText("Plan name").textContent).toBe("MESA 1.0");
    const old = sheet.querySelector('[data-trashed="Old"]');
    if (!(old instanceof HTMLElement)) throw new Error("no Old in the Trash");
    expect(within(old).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Revert this action" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Bring this action back" })).toBeNull();
    const before = sheet.querySelector("[data-baseline]");
    if (!(before instanceof HTMLElement)) throw new Error("no baseline row");
    expect(within(before).getByLabelText("Baseline name").textContent).toBe("Before");
    expect(within(before).getByRole("button", { name: "Show" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Save baseline" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Remove" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Change calendar…" }));
    const settings = screen.getByRole("dialog", { name: "Settings" });
    const working = settings.querySelector<HTMLElement>('section.settings-page[data-section="working-time"]:not([hidden])');
    if (working === null) throw new Error("no Working time page");
    const reviewButton = within(working).getByRole("button", { name: "Review changes…" });
    expect([within(working).queryByRole("button", { name: "Apply" }), reviewButton instanceof HTMLButtonElement && reviewButton.disabled]).toEqual([null, true]);
    fireEvent.click(onlyClose("Settings"));
    expect(apply).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(restorePlan).not.toHaveBeenCalled();
    act(() => t.session.setReadOnly(false));
    openPlanSheet();
    expect(nameField().value).toBe("MESA 1.0");
  });
});

describe("PhoneShell sync (Task 6.7 Step 2)", () => {
  const NAMES = { P: "Launch", L: "Alpha", P2: "Pod" };
  const REMOVED = "This device was removed from the space. Its plans are read-only. Export saves changes the server never received.";
  const NO_KEY = "This device has no sync key. Join the space again with a pairing code.";
  const TOO_LARGE_HELD = "This plan is too large to sync. It keeps working on this device; export it to keep a copy.";
  const TOO_LARGE_MISSING = "This plan is too large to send to this device. Export it on a device that has it.";
  const REJECTED = "The server refused a change from this device. Update WebBoard, then try again.";
  const NOT_IN_SPACE = "Not in the space — set up sync again";
  const ACTIONS = ["Export…", "Reset sync", "Try again", RELOAD, "Open sync"];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  const deep = async (): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 12; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
    });
  };
  const tap = async (el: Element): Promise<void> => {
    act(() => {
      fireEvent.click(el);
    });
    await deep();
  };
  const openNamed = async (name: string): Promise<void> => {
    await tap(within(topBar()).getByRole("button", { name: "Plans" }));
    await tap(within(screen.getByRole("dialog", { name: "Plans" })).getByRole("button", { name }));
    listShows(name);
  };
  const world = (o: Parameters<typeof seedSpace>[1] & { answers?: Record<string, Answer> } = {}): SyncWorld => {
    const w = syncWorld({ names: NAMES, platform: IPHONE, answers: o.answers });
    seedSpace(w, o);
    return w;
  };
  const mounted = async (w: SyncWorld): Promise<{ r: Registry; f: FakeFactory }> => {
    const clock = fixedClock(TODAY, NOW);
    const r = await Registry.open({ clock });
    registries.push(r);
    const f = fakeFactory();
    const el = withSync(<PhoneShell registry={r} clock={clock} />, { factory: f });
    tauri.answers.sync_status = () => w.status();
    render(el);
    await deep();
    return { r, f };
  };
  const fresh = async (): Promise<void> => {
    cleanup();
    clearToasts();
    vi.restoreAllMocks();
    vi.mocked(exportFlow).mockReset();
    await Promise.all(registries.splice(0).map((r) => r.close()));
    window.localStorage.clear();
    startOnList();
  };
  const prov = (f: FakeFactory, doc: string): FakeProvider => {
    const p = f.providers.get(doc);
    if (p === undefined) throw new Error("no provider for " + doc);
    return p;
  };
  const syncAll = (f: FakeFactory): void => {
    act(() => {
      [...f.providers.values()].forEach((p) => {
        p.emitStatus("connected");
        p.emitSynced(true);
      });
    });
  };
  const damageIndex = async (w: SyncWorld, r: Registry, f: FakeFactory): Promise<void> => {
    w.mem.fail("store_append", IX, { code: "store.corrupt", message: "Bad record in seg-0.log." });
    act(() => remoteIndex(prov(f, IX), "s-bad", [own("dn:dev-B", "Phone")]));
    await deep();
    w.mem.recover("store_append", IX);
    expect(r.indexErrorOf(IX)?.code).toBe("store.corrupt");
  };
  const stubState = (s: SyncState): void => {
    vi.spyOn(SyncManager.prototype, "state").mockReturnValue(s);
  };
  const names = (root: HTMLElement, wanted: readonly string[] = ACTIONS): string[] =>
    within(root)
      .queryAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((n) => wanted.includes(n));
  const strip = (): HTMLElement => {
    const el = document.querySelector(".phone-status .status-strip");
    if (!(el instanceof HTMLElement)) throw new Error("no status strip");
    return el;
  };
  const stripText = (): string => strip().textContent ?? "";
  const statusSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Status" });
  const syncRow = async (text: string): Promise<HTMLElement> => {
    await tap(strip());
    const hit = [...statusSheet().querySelectorAll(".status-line")].find((li) => li.querySelector(".status-text")?.textContent === text);
    if (!(hit instanceof HTMLElement)) throw new Error("no status line " + text);
    return hit;
  };
  const messages = (root: HTMLElement): (string | null)[] => [...root.querySelectorAll(".sync-message.bad")].map((e) => e.textContent);
  const syncSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Settings" });
  const compact = (): HTMLElement => {
    const el = topBar().querySelector("button.sync-chip.chip-compact");
    if (!(el instanceof HTMLElement)) throw new Error("no compact chip");
    return el;
  };
  const planMenu = async (): Promise<HTMLElement> => {
    await tap(within(topBar()).getByRole("button", { name: "Plan" }));
    return screen.getByRole("dialog", { name: "Plan" });
  };
  const removedBanner = (): HTMLElement => {
    const el = screen.getByText(REMOVED).closest(".removed-banner");
    if (!(el instanceof HTMLElement)) throw new Error("no removed banner");
    return el;
  };
  const mainArea = (): HTMLElement => {
    const el = document.querySelector(".app.phone");
    if (!(el instanceof HTMLElement)) throw new Error("no phone shell");
    return el;
  };

  it("the removed banner shows on the phone", async () => {
    vi.mocked(exportFlow).mockResolvedValue(undefined);
    const w = world();
    w.status = () => ({ space: SPACE, revoked: true });
    const { r } = await mounted(w);
    await openNamed("Launch");
    expect(names(removedBanner(), ["Export…", "Join with a code", "Set up sync"])).toEqual(["Export…", "Join with a code", "Set up sync"]);
    expect(removedBanner().compareDocumentPosition(topBar()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await tap(within(removedBanner()).getByRole("button", { name: "Export…" }));
    expect(vi.mocked(exportFlow).mock.calls).toEqual([[await r.session("P")]]);
    await tap(within(topBar()).getByRole("button", { name: "Plans" }));
    await tap(within(screen.getByRole("dialog", { name: "Plans" })).getByRole("button", { name: "Alpha" }));
    listShows("Alpha");
    expect(names(removedBanner(), ["Export…", "Join with a code", "Set up sync"])).toEqual(["Join with a code", "Set up sync"]);
    await fresh();
    const v = syncWorld({ platform: IPHONE });
    v.status = () => ({ space: SPACE, revoked: true });
    await mounted(v);
    expect(emptyState()).not.toBeNull();
    expect(names(removedBanner(), ["Export…", "Join with a code", "Set up sync"])).toEqual(["Join with a code", "Set up sync"]);
  });

  it("Move to space on the phone", async () => {
    const w = world();
    const { r, f } = await mounted(w);
    syncAll(f);
    await deep();
    listShows("Alpha");
    const move = vi.spyOn(r, "movePlanToSpace");
    await tap(within(await planMenu()).getByRole("button", { name: "Move to space" }));
    expect(move.mock.calls).toEqual([["L"]]);
    expect(toastTexts()).toEqual(["Moved to the space"]);
    expect(within(screen.getByRole("dialog", { name: "Plan" })).queryByRole("button", { name: "Move to space" })).toBeNull();
    await fresh();
    const none = world();
    none.status = fail({ code: "ipc.failed", message: "sync_status: channel closed" });
    await mounted(none);
    listShows("Alpha");
    expect(within(await planMenu()).queryByRole("button", { name: "Move to space" })).toBeNull();
    await fresh();
    const spaced = world();
    const s = await mounted(spaced);
    syncAll(s.f);
    await deep();
    await openNamed("Launch");
    expect(within(await planMenu()).queryByRole("button", { name: "Move to space" })).toBeNull();
    await fresh();
    const removed = world();
    removed.status = () => ({ space: SPACE, revoked: true });
    const rm = await mounted(removed);
    expect(rm.r.spaceReadOnly()).toBe(true);
    listShows("Alpha");
    expect(within(await planMenu()).queryByRole("button", { name: "Move to space" })).toBeNull();
  });

  it("the Plans sheet tags the plans kept on this device and moves them in one go", async () => {
    const w = world({ local: true });
    const { r, f } = await mounted(w);
    syncAll(f);
    await deep();
    await tap(within(topBar()).getByRole("button", { name: "Plans" }));
    const sheet = (): HTMLElement => screen.getByRole("dialog", { name: "Plans" });
    const tagged = (cls: string): (string | null | undefined)[] =>
      [...sheet().querySelectorAll(`.entry-open .entry-tag.${cls}`)].map((t) => t.closest(".entry-open")?.querySelector(".entry-name")?.textContent);
    expect([tagged("tag-local"), tagged("tag-example")]).toEqual([["Alpha", "Mango"], ["Example: Website relaunch"]]);
    const line = sheet().querySelector(".local-line");
    if (!(line instanceof HTMLElement)) throw new Error("no local line in the Plans sheet");
    expect([line.querySelector("p")?.textContent, within(line).getByRole("button").textContent]).toEqual([
      "2 plans are on this device only. Move them to the space to see them on other devices.",
      "Move both",
    ]);
    const move = vi.spyOn(r, "movePlansToSpace");
    await tap(within(line).getByRole("button", { name: "Move both" }));
    expect(move.mock.calls).toEqual([[["L", "M"]]]);
    expect(toastTexts()).toEqual(["Moved 2 plans to the space"]);
    expect([sheet().querySelector(".local-line"), tagged("tag-local")]).toEqual([null, []]);
    await fresh();
    const off = world({ local: true });
    off.status = () => ({ space: null, revoked: false });
    await mounted(off);
    await tap(within(topBar()).getByRole("button", { name: "Plans" }));
    expect([sheet().querySelectorAll(".entry-tag").length, sheet().querySelector(".local-line")]).toEqual([0, null]);
  });

  describe("sync errors show on the phone", () => {
    it("a missing sync key", async () => {
      const w = world();
      w.ticket = fail({ code: "keychain.missing", message: NO_KEY });
      await mounted(w);
      expect(stripText().startsWith(NOT_IN_SPACE)).toBe(true);
      expect(strip().classList.contains("magenta")).toBe(true);
      const row = await syncRow(NOT_IN_SPACE);
      expect(messages(row)).toEqual([NO_KEY]);
      expect(names(row)).toEqual(["Open sync"]);
      await tap(within(row).getByRole("button", { name: "Open sync" }));
      expect(screen.queryByRole("dialog", { name: "Status" })).toBeNull();
      expect(messages(syncSheet())).toEqual([NO_KEY]);
    });

    it("a plan too large to sync", async () => {
      vi.mocked(exportFlow).mockResolvedValue(undefined);
      const w = world();
      const { r, f } = await mounted(w);
      syncAll(f);
      await deep();
      await openNamed("Launch");
      act(() => prov(f, "P").closeWith(4413, "Too large to sync"));
      await deep();
      expect(within(topBar()).getByRole("button", { name: "Too large to sync: Launch" })).toBe(compact());
      expect(stripText().startsWith("Too large to sync: Launch")).toBe(true);
      const row = await syncRow("Too large to sync: Launch");
      expect(messages(row)).toEqual([TOO_LARGE_HELD]);
      expect(names(row)).toEqual(["Export…", "Try again", "Open sync"]);
      await tap(within(row).getByRole("button", { name: "Export…" }));
      expect(vi.mocked(exportFlow).mock.calls).toEqual([[await r.session("P")]]);
    });

    it("a removed device whose state could not be saved", async () => {
      const message = "Could not save the sync state: Permission denied (os error 13)";
      const w = world({ answers: { sync_mark_revoked: fail({ code: "sync.io", message }) } });
      const { f } = await mounted(w);
      act(() => prov(f, IX).closeWith(4403, "Device removed"));
      await deep();
      expect(stripText().startsWith("Device removed")).toBe(true);
      const row = await syncRow("Device removed");
      expect(messages(row)).toEqual([message]);
      expect(names(row)).toEqual(["Open sync"]);
    });

    it("offline and receiving", async () => {
      const t = await made();
      const registry = await phoneRegistry(t);
      registries.push(registry);
      const lineTone = async (text: string): Promise<string[]> => {
        const row = await syncRow(text);
        return [...row.classList];
      };
      const sheetLines = (): (string | null)[] => [...statusSheet().querySelectorAll(".status-line > .status-text")].map((e) => e.textContent);
      for (const [waiting, text] of [
        [1, "Offline — 1 change waiting"],
        [3, "Offline — 3 changes waiting"],
      ] as const) {
        stubState({ kind: "offline", waiting });
        render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
        await deep();
        expect(await lineTone(text)).toContain("amber");
        expect(sheetLines()[sheetLines().length - 1]).toBe(text);
        expect(names(statusSheet(), ["Export…", "Reset sync", "Try again", "Open sync"])).toEqual([]);
        cleanup();
        vi.mocked(SyncManager.prototype.state).mockRestore();
      }
      stubState({ kind: "receiving" });
      render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
      await deep();
      expect(await lineTone("Receiving…")).toContain("cyan");
      expect(sheetLines()[sheetLines().length - 1]).toBe("Receiving…");
      expect(names(statusSheet(), ["Export…", "Reset sync", "Try again", "Open sync"])).toEqual([]);
      cleanup();
      const v = t.session.view();
      vi.spyOn(t.session, "view").mockReturnValue({ ...v, pending: 2 });
      render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
      await deep();
      await tap(strip());
      expect(sheetLines()).toContain("Receiving… · 2 changes waiting");
      expect(sheetLines()).not.toContain("Receiving…");
    });

    it("refused changes", async () => {
      vi.mocked(exportFlow).mockResolvedValue(undefined);
      const w = world();
      const { r, f } = await mounted(w);
      syncAll(f);
      await deep();
      await openNamed("Launch");
      act(() => prov(f, "P").closeWith(1007, "Malformed update"));
      await deep();
      const line = "The server refused a change from this device — export this plan and check for an update";
      expect(stripText().startsWith(line)).toBe(true);
      const row = await syncRow(line);
      expect(messages(row)).toEqual(["The server refused a change to “Launch” from this device. Update WebBoard, then try again."]);
      expect(names(row)).toEqual(["Export…", "Try again", "Open sync"]);
      await tap(within(row).getByRole("button", { name: "Export…" }));
      expect(vi.mocked(exportFlow).mock.calls).toEqual([[await r.session("P")]]);
      await fresh();
      const v = world();
      const second = await mounted(v);
      syncAll(second.f);
      await deep();
      act(() => prov(second.f, IX).closeWith(1007, "Malformed update"));
      await deep();
      const ixLine = "The server refused a change to the plan list — update WebBoard";
      expect(stripText().startsWith(ixLine)).toBe(true);
      const ixRow = await syncRow(ixLine);
      expect(messages(ixRow)).toEqual([REJECTED]);
      expect(names(ixRow)).toEqual(["Try again", "Open sync"]);
    });

    it("a plan list too large to sync", async () => {
      const w = world();
      const { f } = await mounted(w);
      syncAll(f);
      await deep();
      act(() => prov(f, IX).closeWith(4413, "Too large to sync"));
      await deep();
      expect(stripText().startsWith("The plan list is too large to sync")).toBe(true);
      const row = await syncRow("The plan list is too large to sync");
      expect(messages(row)).toEqual(["The plan list is too large to sync. Plans keep working on this device."]);
      expect(names(row)).toEqual(["Try again", "Open sync"]);
    });

    it("a store failure on a plan, and Try again reconnects once", async () => {
      const w = world();
      const { f } = await mounted(w);
      syncAll(f);
      await deep();
      await openNamed("Launch");
      act(() => prov(f, "P").closeWith(4500, "Store failed"));
      await deep();
      const line = "Server could not store changes to “Launch” since 14:02";
      expect(stripText().startsWith(line)).toBe(true);
      const row = await syncRow(line);
      expect(messages(row)).toEqual(["The server could not store a change to “Launch”. Try again; if it repeats, export it."]);
      expect(names(row)).toEqual(["Export…", "Try again", "Open sync"]);
      const connects = (): number => f.all.filter((p) => p.doc === "P").reduce((n, p) => n + p.connects(), 0);
      const before = connects();
      await tap(within(row).getByRole("button", { name: "Try again" }));
      expect(connects()).toBe(before + 1);
    });

    it.each([
      [4413, "Too large to sync: a plan", TOO_LARGE_MISSING],
      [1007, "The server refused a change from this device — update WebBoard", REJECTED],
    ])("a plan that never arrived offers no export (%s)", async (code, line, message) => {
      const w = syncWorld({ names: NAMES, platform: IPHONE });
      seedIndex(w.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("l-L", ["l-n"], [ip("L", false)])]);
      seedPlan(w.mem, "L", "Alpha");
      seedIndex(w.mem, IX, [ixAct("s-S", [], [ip("S", false)], "dev-B")]);
      const { f } = await mounted(w);
      act(() => prov(f, "S").closeWith(code, "closed"));
      await deep();
      expect(stripText().startsWith(line)).toBe(true);
      const row = await syncRow(line);
      expect(messages(row)).toEqual([message]);
      expect(names(row)).toEqual(["Try again", "Open sync"]);
    });

    it("synced shows no sync line", async () => {
      const w = world();
      const { f } = await mounted(w);
      syncAll(f);
      await deep();
      expect(compact().getAttribute("aria-label")).toBe("Synced");
      expect(stripText()).toBe(NO_REGION);
    });
  });

  it("a plan that will not arrive says why on the phone", async () => {
    const w = syncWorld({ names: { L: "Alpha" }, platform: IPHONE });
    seedIndex(w.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("l-L", ["l-n"], [ip("L", false)])]);
    seedPlan(w.mem, "L", "Alpha");
    seedIndex(w.mem, IX, [ixAct("s-S", [], [ip("S", false)], "dev-B")]);
    const { r, f } = await mounted(w);
    const real = r.session.bind(r);
    vi.spyOn(r, "session").mockImplementation((id) => (id === "S" ? Promise.reject(new AppError("plan.incomplete", INCOMPLETE)) : real(id)));
    await tap(within(topBar()).getByRole("button", { name: "Plans" }));
    await tap(within(screen.getByRole("dialog", { name: "Plans" })).getByRole("button", { name: "Loading…" }));
    expect(within(mainArea()).getByText(INCOMPLETE)).toBeTruthy();
    act(() => prov(f, "S").closeWith(4413, "Too large to sync"));
    await deep();
    const stopped = (): HTMLElement => {
      const el = mainArea().querySelector(".plan-stopped");
      if (!(el instanceof HTMLElement)) throw new Error("no stopped plan view");
      return el;
    };
    expect(messages(stopped())).toEqual([TOO_LARGE_MISSING]);
    expect(names(stopped())).toEqual(["Try again", "Open sync"]);
    expect(within(mainArea()).queryByText(INCOMPLETE)).toBeNull();
    expect(document.querySelector(".phone-list")).toBeNull();
    const restart = vi.spyOn(SyncManager.prototype, "restart");
    w.status = () => ({ space: SPACE, revoked: true });
    await tap(within(stopped()).getByRole("button", { name: "Try again" }));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(messages(stopped())).toEqual(["Device removed"]);
    expect(names(stopped())).toEqual(["Open sync"]);
    await tap(within(stopped()).getByRole("button", { name: "Open sync" }));
    expect(syncSheet()).toBeTruthy();
    await fresh();
    const io = syncWorld({ names: { L: "Alpha" }, platform: IPHONE });
    seedIndex(io.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("l-L", ["l-n"], [ip("L", false)])]);
    seedPlan(io.mem, "L", "Alpha");
    seedIndex(io.mem, IX, [ixAct("s-S", [], [ip("S", false)], "dev-B")]);
    io.status = fail({ code: "sync.io", message: "Could not read the sync state: invalid JSON" });
    await mounted(io);
    await tap(within(topBar()).getByRole("button", { name: "Plans" }));
    await tap(within(screen.getByRole("dialog", { name: "Plans" })).getByRole("button", { name: "Loading…" }));
    expect(messages(stopped())).toEqual(["Could not read the sync state: invalid JSON" + RESET_HINT]);
    expect(names(stopped())).toEqual(["Reset sync", "Try again", "Open sync"]);
    await tap(within(stopped()).getByRole("button", { name: "Open sync" }));
    expect(within(syncSheet()).getByRole("tab", { selected: true }).textContent).toBe("Join with a code");
  });

  it("an unmapped failure shows on the phone", async () => {
    const w = world();
    w.ticket = (doc) => {
      if (doc === IX) throw { code: "ipc.failed", message: "sync_ticket: channel closed" };
      return { ticket: "tk", expiresAt: 0 };
    };
    await mounted(w);
    expect(stripText().startsWith("Sync stopped: sync_ticket: channel closed")).toBe(true);
    const row = await syncRow("Sync stopped: sync_ticket: channel closed");
    expect(messages(row)).toEqual(["sync_ticket: channel closed"]);
    expect(names(row)).toEqual(["Try again", "Open sync"]);
    const restart = vi.spyOn(SyncManager.prototype, "restart");
    await tap(within(row).getByRole("button", { name: "Try again" }));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("the device name is checked on the phone", async () => {
    const w = syncWorld({ platform: IPHONE, answers: { sync_pair_join: () => SPACE } });
    w.status = () => ({ space: null, revoked: false });
    await mounted(w);
    await tap(within(topBar()).getByRole("button", { name: "Plans" }));
    await tap(within(screen.getByRole("dialog", { name: "Plans" })).getByRole("button", { name: "Set up sync" }));
    const setup = screen.getByRole("tabpanel", { name: "Set up sync" });
    act(() => {
      fireEvent.change(within(setup).getByLabelText("Device name"), { target: { value: "   " } });
    });
    await tap(within(setup).getByRole("button", { name: "Create or join space" }));
    expect([...setup.querySelectorAll(".sync-error.bad")].map((e) => e.textContent)).toEqual([EMPTY_NAME]);
    expect(tauri.calls.filter((c) => c.cmd === "sync_setup")).toHaveLength(0);
    await tap(within(syncSheet()).getByRole("tab", { name: "Join with a code" }));
    const join = screen.getByRole("tabpanel", { name: "Join with a code" });
    act(() => {
      fireEvent.change(within(join).getByLabelText("Device name"), { target: { value: "  iPad\t2 " } });
    });
    await tap(within(join).getByRole("button", { name: "Join space" }));
    expect(tauri.calls.filter((c) => c.cmd === "sync_pair_join").map((c) => argsOf(c).deviceName)).toEqual(["iPad 2"]);
  });

  it("read-only on the phone", async () => {
    const managers: SyncManager[] = [];
    const start = SyncManager.prototype.start;
    vi.spyOn(SyncManager.prototype, "start").mockImplementation(function (this: SyncManager) {
      managers.push(this);
      return start.call(this);
    });
    const w = world();
    const { f } = await mounted(w);
    syncAll(f);
    await deep();
    await openNamed("Launch");
    const plus = (): HTMLElement => within(topBar()).getByRole("button", { name: "+" });
    expect(plus().hasAttribute("disabled")).toBe(false);
    const m = managers[managers.length - 1];
    await act(async () => m.markRevoked());
    await deep();
    expect(plus().hasAttribute("disabled")).toBe(true);
  });

  it("the empty state shows sync", async () => {
    const w = syncWorld({ platform: IPHONE });
    w.ticket = fail({ code: "keychain.missing", message: NO_KEY });
    await mounted(w);
    const empty = emptyState();
    if (empty === null) throw new Error("no empty state");
    expect(within(empty).getAllByRole("button").map((b) => b.textContent)).toEqual(["New plan", "Show an example plan", "Import plan…", "Join with a code", "Set up sync"]);
    expect(within(topBar()).getByRole("button", { name: "Plans" })).toBeTruthy();
    expect(within(topBar()).getByRole("button", { name: NOT_IN_SPACE })).toBe(compact());
    expect(stripText().startsWith(NOT_IN_SPACE)).toBe(true);
    const row = await syncRow(NOT_IN_SPACE);
    await tap(within(row).getByRole("button", { name: "Open sync" }));
    expect(syncSheet()).toBeTruthy();
  });

  it("the top bar survives a space index reload", async () => {
    const w = world();
    const { r, f } = await mounted(w);
    syncAll(f);
    await deep();
    await openNamed("Launch");
    await damageIndex(w, r, f);
    await act(async () => r.reloadFromServer(IX));
    await deep();
    listShows("Alpha");
    const real = r.plans.bind(r);
    vi.spyOn(r, "plans").mockImplementation(() => real().filter((l) => l.id !== "L"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => setUiNow({ view: "board" })).toThrow(new Error("Plan L is not listed"));
  });

  it("a space index reload that drops the only plan reaches the empty state", async () => {
    const w = syncWorld({ names: { P: "Launch" }, platform: IPHONE });
    seedIndex(w.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device")]);
    seedIndex(w.mem, IX, [ixAct("s-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("s-P", ["s-n"], [ip("P", false)])]);
    seedPlan(w.mem, "P", "Launch");
    const { r, f } = await mounted(w);
    syncAll(f);
    await deep();
    listShows("Launch");
    expect(r.plans().map((l) => [l.id, l.space])).toEqual([["P", "sp000000000"]]);
    await damageIndex(w, r, f);
    await act(async () => r.reloadFromServer(IX));
    await deep();
    expect(r.plans()).toEqual([]);
    expect(emptyState()).not.toBeNull();
    expect(topBar().querySelector(".phone-plan-name")).toBeNull();
  });
});

describe("the settings sheet on the phone", () => {
  const themeRow = (sheet: HTMLElement): HTMLElement => {
    const row = sheet.querySelector("button.plans-settings-row");
    if (!(row instanceof HTMLElement)) throw new Error("no Settings… row");
    expect(row.textContent).toBe("Settings…");
    expect(sheet.querySelector("button.theme-row, button.about-row")).toBeNull();
    return row;
  };
  const dialogs = (): (string | null)[] => screen.queryAllByRole("dialog").map((d) => d.getAttribute("aria-label"));

  const groups = (sheet: HTMLElement): (string | undefined)[] => [...sheet.querySelectorAll<HTMLElement>("div.settings-root button.settings-root-row")].map((g) => g.dataset["section"]);

  const pushPage = (sheet: HTMLElement, id: string): HTMLElement => {
    const row = sheet.querySelector<HTMLElement>(`div.settings-root button.settings-root-row[data-section="${id}"]`);
    if (row === null) throw new Error(`no ${id} row on the Settings root`);
    fireEvent.click(row);
    const page = sheet.querySelector<HTMLElement>(`section.settings-page[data-section="${id}"]:not([hidden])`);
    if (page === null) throw new Error(`no ${id} page shown`);
    return page;
  };

  it("opens the Settings sheet on its root from the Plans sheet, General saved by default, closing it", async () => {
    await shown(await made());
    fireEvent.click(themeRow(openPlans()));
    expect(dialogs()).toEqual(["Settings"]);
    expect([lastUi().settings, lastUi().settingsRoot]).toEqual(["general", true]);
    const sheet = screen.getByRole("dialog", { name: "Settings" });
    expect([...sheet.querySelectorAll('[role="tab"]')].filter((tab) => tab.closest(".sync-tabs") === null)).toEqual([]);
    expect(groups(sheet)).toEqual(["general", "theme", "sync", "files", "overview", "people", "workflow", "working-time", "defaults", "baselines", "danger"]);
    expect([...sheet.querySelectorAll("div.settings-root .settings-root-name")].map((h) => h.textContent)).toEqual(["General", "Theme", "Sync", "Import & export", "Overview", "People", "Workflow", "Working time", "Defaults", "Baselines", "Danger zone"]);
    fireEvent.click(within(sheet).getAllByRole("button", { name: "Close" })[0]);
    expect(dialogs()).toEqual([]);
    expect([lastUi().settings, lastUi().settingsRoot]).toEqual([null, false]);
  });

  it("shows the sync panes on the Settings sheet's Sync page, never a second sheet", async () => {
    await shown(await made());
    fireEvent.click(themeRow(openPlans()));
    const sheet = screen.getByRole("dialog", { name: "Settings" });
    const group = pushPage(sheet, "sync");
    expect(within(group).getByRole("tab", { name: "Set up sync" }).getAttribute("aria-selected")).toBe("true");
    act(() => {
      fireEvent.click(within(group).getByRole("tab", { name: "Join with a code" }));
    });
    expect([lastUi().settings, lastUi().settingsRoot, lastUi().syncPane, lastUi().dialog]).toEqual(["sync", false, "join", null]);
    expect(within(group).getByRole("tabpanel", { name: "Join with a code" })).toBeTruthy();
    expect(dialogs()).toEqual(["Settings"]);
  });

  it("opens Settings from the Plans sheet in the empty state", async () => {
    await showIndex(await emptyIndex());
    fireEvent.click(themeRow(openPlans()));
    expect(dialogs()).toEqual(["Settings"]);
  });

  it("opens Settings from the ⋯ Plan sheet, closing it", async () => {
    await shown(await planSheetMade());
    fireEvent.click(themeRow(openPlanSheet()));
    expect(dialogs()).toEqual(["Settings"]);
    expect(lastUi().settings).toBe("general");
    expect(groups(screen.getByRole("dialog", { name: "Settings" }))).toEqual(["general", "theme", "sync", "files", "overview", "people", "workflow", "working-time", "defaults", "baselines", "danger"]);
  });

  it("hides a selected item's sheet while Settings is open, and the item sheet returns after Close", async () => {
    const t = await made();
    await shown(t);
    const review = [...t.session.view().plan.items].find(([, it]) => it.name === "Review")?.[0];
    if (review === undefined) throw new Error("no Review item");
    setUiNow({ selected: review });
    expect(dialogs()).toEqual(["Review"]);
    setUiNow({ settings: "theme" });
    expect(dialogs()).toEqual(["Settings"]);
    expect(lastUi().selected).toBe(review);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Settings" })).getAllByRole("button", { name: "Close" })[0]);
    expect(dialogs()).toEqual(["Review"]);
  });

  const shellOn = async (platform: Platform): Promise<void> => {
    const t = await made();
    tauri.answers.device_info = () => ({ deviceId: "mac", platform: platform.os });
    setPlatform(platform);
    const registry = await phoneRegistry(t);
    registries.push(registry);
    vi.mocked(paintNative).mockClear();
    render(withSync(<Shell registry={registry} clock={t.clock} />));
    await settle();
    expect(document.documentElement.dataset.form).toBe("phone");
    fireEvent.click(themeRow(openPlans()));
    await settle();
  };

  const choosePaper = async (): Promise<void> => {
    const page = pushPage(screen.getByRole("dialog", { name: "Settings" }), "theme");
    fireEvent.click(within(page).getByRole("button", { name: /^Paper/ }));
    await settle();
  };

  const groundOf = (id: string): string => {
    const preset = PRESETS.find((x) => x.id === id);
    if (preset === undefined) throw new Error(`no ${id} preset`);
    return tokensOf(preset).void;
  };

  it("does not paint a native background through Shell on iOS, even after choosing a theme", async () => {
    await shellOn(IPHONE);
    expect(dialogs()).toEqual(["Settings"]);
    await choosePaper();
    expect(document.documentElement.style.getPropertyValue("--void")).toBe(groundOf("paper"));
    expect(paintNative).not.toHaveBeenCalled();
  });

  it("paints the native background through the same Shell harness on macOS, and again after choosing a theme", async () => {
    await shellOn(MAC);
    expect(dialogs()).toEqual(["Settings"]);
    expect(vi.mocked(paintNative).mock.calls).toEqual([[groundOf("cyberdeck")]]);
    await choosePaper();
    expect(vi.mocked(paintNative).mock.calls).toEqual([[groundOf("cyberdeck")], [groundOf("paper")]]);
  });
});
