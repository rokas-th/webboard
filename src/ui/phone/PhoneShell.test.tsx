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
import { phoneRegistry } from "../../test/phone";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { seededStore, shellFor, type SeededStore } from "../../test/shell";
import { resetTauri, tauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { exportFlow, importFlow } from "../shell/fileFlows";
import { PLACE_KEY, useUi, type UiState } from "../state";
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

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
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

beforeEach(() => {
  window.localStorage.clear();
  setScreen(390, 844);
});

afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  clearToasts();
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

const shown = async (t: TestSession): Promise<void> => {
  const registry = await phoneRegistry(t);
  registries.push(registry);
  render(<PhoneShell registry={registry} clock={t.clock} />);
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
  it("opens on the List and switches to a read-only Timeline", async () => {
    const t = await made();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
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

  it("open choice context: the sheet's useRun finds the provider, and a child opens a choice", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(rowOf("Review"));
    const sheet = screen.getByRole("dialog", { name: "Review" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Duration +1" }));
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

const toastTexts = (): (string | null)[] => screen.queryAllByRole("status").map((e) => e.textContent);

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

const showIndex = async (r: { registry: Registry; clock: Clock }): Promise<void> => {
  render(<PhoneShell registry={r.registry} clock={r.clock} />);
  await settle();
};

const emptyIndex = async (): Promise<{ registry: Registry; clock: Clock }> => {
  resetTauri({ ...memoryStore().answers, settings_read: () => null, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: "ios" }) });
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
    vi.mocked(importPlan).mockImplementationOnce(async (reg) => reg.createPlan("MESA 2027"));
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
    expect(screen.queryAllByRole("status").map((e) => [e.textContent, e.className])).toEqual([["Disk full.", "toast bad"]]);
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
    expect(screen.queryAllByRole("status").map((e) => [e.textContent, e.className])).toEqual([["Disk full.", "toast bad"]]);
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
  const failing = async (code = "store.locked", message = "Locked by another process."): Promise<{ s: SeededStore; registry: Registry }> => {
    const s = await seededStore(["Alpha", "Beta", "Gamma"]);
    s.mem.fail("store_load", s.ids[1], { code, message });
    s.mem.fail("store_load", s.ids[2], { code: "store.corrupt", message: "Bad record in seg-0.log." });
    const r = await indexOpen();
    await r.registry.warm();
    await showIndex(r);
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
    const { s, registry } = await failing();
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
    expect(screen.queryAllByRole("status").map((n) => [n.textContent, n.className])).toEqual([["Permission denied (os error 13)", "toast bad"]]);
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
    const { s, registry } = await failing();
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
    const { s, registry } = await failing();
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
  });

  it("Load again stays disabled while the registry reloads the plan", async () => {
    const { s, registry } = await failing();
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
    expect(within(topBar()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Plans"]);
    expect(screen.queryByRole("button", { name: "+" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    await settle();
    expect(createPlan.mock.calls).toEqual([["New plan"]]);
    listShows("New plan");
    expect(emptyState()).toBeNull();
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
    vi.mocked(importPlan).mockImplementationOnce(async (reg) => reg.createPlan("MESA 2027"));
    await showIndex(r);
    const state = emptyState();
    if (state === null) throw new Error("no empty state");
    expect(within(state).getAllByRole("button").map((b) => b.textContent)).toEqual(["New plan", "Import plan…"]);
    fireEvent.click(within(state).getByRole("button", { name: "Import plan…" }));
    await settle();
    expect(importPlan).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual(["Imported “MESA 2027”"]);
    listShows("MESA 2027");
    expect(emptyState()).toBeNull();
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
    fireEvent.click(within(topBar()).getByRole("button", { name: "+" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["New task", "New milestone", "New group"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: label }));
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
    fireEvent.click(within(topBar()).getByRole("button", { name: "+" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "New task" }));
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
    expect(sheet.querySelector(".isheet")?.firstElementChild?.classList.contains("choice-banner")).toBe(true);
    expect(toastTexts()).toEqual([]);
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
  const EDITS = ["Group", "Unschedule", "Move up", "Move down", "Move to Trash"];

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
      .filter((b) => b.textContent !== "Close")
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
    fireEvent.click(within(screen.getByRole("dialog", { name: "Revert this action" })).getByRole("button", { name: "Cancel" }));
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
      .forEach((e) => expect(within(historyRow(e.id)).getAllByRole("button").map((b) => b.textContent)).toEqual([e.active ? "Revert this action" : "Bring this action back"]));
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

  it("shows the calendar summary and opens the calendar in a sheet", async () => {
    const t = await planSheetMade();
    await shown(t);
    openPlanSheet();
    expect(within(planSheet()).getByText(calendarSummary(t.session.view().plan.calendar))).toBeTruthy();
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Change calendar…" }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Calendar"]);
    expect(screen.getByRole("dialog", { name: "Calendar" }).querySelector(".cal-body")).not.toBeNull();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Calendar" })).getByRole("button", { name: "Cancel" }));
    expect(planSheet()).toBeTruthy();
  });

  it("exports and imports from File", async () => {
    const t = await planSheetMade();
    vi.mocked(exportFlow).mockResolvedValueOnce(undefined);
    vi.mocked(importFlow).mockResolvedValueOnce(undefined);
    const registry = await phoneRegistry(t);
    registries.push(registry);
    render(<PhoneShell registry={registry} clock={t.clock} />);
    await settle();
    openPlanSheet();
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Export plan…" }));
    expect(vi.mocked(exportFlow).mock.calls).toEqual([[t.session]]);
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Import plan…" }));
    expect(vi.mocked(importFlow).mock.calls).toHaveLength(1);
    expect(vi.mocked(importFlow).mock.calls[0][0]).toBe(registry);
    await settle();
  });

  it("about", async () => {
    const t = await planSheetMade();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    openPlanSheet();
    fireEvent.click(within(planSheet()).getByRole("button", { name: "About WebBoard" }));
    const about = screen.getByRole("dialog", { name: "About WebBoard" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(about.textContent).toContain(`WebBoard ${version}`);
    expect(about.textContent).toContain(HOLIDAY_ATTRIBUTION);
    expect(HOLIDAY_ATTRIBUTION).toBe("Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.");
    fireEvent.click(within(about).getAllByRole("button", { name: "Close" })[0]);
    expect(lastUi().dialog).toBeNull();
    expect(planSheet()).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
  });

  it("about from the empty state's Plans", async () => {
    await showIndex(await emptyIndex());
    openPlans();
    fireEvent.click(within(plansSheet()).getByRole("button", { name: "About WebBoard" }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["About WebBoard"]);
    expect(screen.getByRole("dialog", { name: "About WebBoard" }).textContent).toContain(`WebBoard ${version}`);
  });

  it("an open plan's Plans has no About row", async () => {
    const t = await planSheetMade();
    await shown(t);
    openPlans();
    expect(within(plansSheet()).queryByRole("button", { name: "About WebBoard" })).toBeNull();
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
    render(<PhoneShell registry={registry} clock={t.clock} />);
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
    const calendar = screen.getByRole("dialog", { name: "Calendar" });
    expect(within(calendar).queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.click(within(calendar).getByRole("button", { name: "Cancel" }));
    expect(apply).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(restorePlan).not.toHaveBeenCalled();
    act(() => t.session.setReadOnly(false));
    expect(nameField().value).toBe("MESA 1.0");
  });
});
