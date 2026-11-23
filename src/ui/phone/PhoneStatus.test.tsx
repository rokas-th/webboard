import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Preview } from "../../actions/intents";
import type { PlanId } from "../../domain/model";
import type { Calendar, RegionRef } from "../../domain/calendar";
import type { Action } from "../../log/types";
import { fixedClock, type Clock } from "../../services/clock";
import { noticeText, type HolidayNotice, type HolidayService } from "../../services/holidays";
import { AppError } from "../../services/ipc";
import { encodeAction } from "../../store/doc";
import { Registry } from "../../store/registry";
import { NEWER_PLAN, type PlanSession } from "../../store/session";
import { CH_ZH, holidayDay, holidayYear } from "../../test/fixtures/calendars";
import { phoneRegistry } from "../../test/phone";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { setScreen } from "../../test/setup";
import { seededStore, type SeededStore } from "../../test/shell";
import { hold, tauri, type Answer } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { CALENDAR_BANNER } from "../choices/CalendarBanner";
import { CHOICE_TITLE } from "../choices/pick";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { clearToasts } from "../common/Toast";
import { RELOAD_LABEL, RELOAD_TEXT } from "../shell/ReloadConfirm";
import { OpenChoice } from "../run";
import { UiContext, useUi, type UiState } from "../state";
import { PhoneShell } from "./PhoneShell";
import { NO_REGION, PhoneStatus } from "./PhoneStatus";
import { IPHONE, MAC, setPlatform } from "../../test/platform";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
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

const ZH: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const pending: Answer = () => new Promise(() => undefined);
const SEED: readonly SeedItem[] = [{ name: "Review", start: "2026-11-10", dur: 2 }];
const CONFLICT_SEED: readonly SeedItem[] = [
  { name: "A", start: "2026-11-16", dur: 3 },
  { name: "B", start: "2026-11-17", dur: 1, deps: [fs("A")] },
];
const AWAY = { unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null };
const DEFAULTS = { pushFromPredecessors: true, returnPushed: true };
const AT = new Date(2026, 10, 8, 14, 5).getTime();
const UNREADABLE_INDEX = "A change to the plan list from iPhone could not be read: Action x9 has a malformed lbl. Update WebBoard on this device.";
const CORRUPT_SPACE = "The space plan list is damaged at record 4.";

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
};

const shown = async (t: TestSession, opts?: { holidays?: HolidayService; device?: "mac" | "iphone" }): Promise<Registry> => {
  tauri.answers.device_info = () => (opts?.device === "iphone" ? { deviceId: "iphone", platform: "ios" } : { deviceId: "mac", platform: "macos" });
  setPlatform(opts?.device === "iphone" ? IPHONE : MAC);
  const registry = await phoneRegistry(t, { holidays: opts?.holidays });
  registries.push(registry);
  render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
  await settle();
  return registry;
};

const indexShown = async (names: readonly string[]): Promise<{ s: SeededStore; registry: Registry; clock: Clock; ids: PlanId[] }> => {
  const s = await seededStore([], { lastRegion: ZH });
  const clock = fixedClock("2026-11-09");
  const registry = await Registry.open({ clock });
  registries.push(registry);
  const ids: PlanId[] = [];
  for (const n of names) ids.push(await registry.createPlan(n));
  return { s, registry, clock, ids };
};

const renderIndex = async (r: { registry: Registry; clock: Clock }, connected = false): Promise<void> => {
  render(withSync(<PhoneShell registry={r.registry} clock={r.clock} />, { connected }));
  await settle();
};

const lastUi = (): UiState => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value[0];
};

const strip = (): HTMLElement => {
  const el = document.querySelector(".phone-status .status-strip");
  if (!(el instanceof HTMLElement)) throw new Error("no status strip");
  return el;
};

const statusSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Status" });

const openStatus = (): HTMLElement => {
  fireEvent.click(strip());
  return statusSheet();
};

const lineTexts = (): (string | null)[] => [...statusSheet().querySelectorAll(".status-line > .status-text")].map((e) => e.textContent);

const lineOf = (text: string): HTMLElement => {
  const hit = [...statusSheet().querySelectorAll(".status-line")].find((li) => li.querySelector(".status-text")?.textContent === text);
  if (!(hit instanceof HTMLElement)) throw new Error("no status line " + text);
  return hit;
};

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

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

type When = (...call: Parameters<Answer>) => boolean;

const failOnce = (cmd: string, e: { code: string; message: string }, when: When = () => true): (() => void) => {
  const real = tauri.answers[cmd];
  if (real === undefined) throw new Error("no answer for " + cmd);
  let failing = true;
  tauri.answers[cmd] = (args, options) => {
    if (failing && when(args, options)) throw e;
    return real(args, options);
  };
  return () => {
    failing = false;
  };
};

const xdocIs =
  (doc: string): When =>
  (_args, options) =>
    new Headers(options?.headers).get("x-doc") === doc;

const unreadableRaw = (): Record<string, unknown> => {
  const x2: Action = { id: "x2", dev: "iphone", ses: "s1", at: 0, par: ["x1"], lbl: "Renamed “Review” to “Review 2”", w: [{ u: "n:Review", v: "Review 2", c: "own" }] };
  return { x1: ["iphone", "s1", 0, [], 42, []], x2: encodeAction(x2) };
};

const NO_CHANGE: Preview = { itemsChanged: 0, endsChanged: 0, movedLater: 0, stopped: [], conflictsAfter: 0, kept: [] };

describe("PhoneStatus without sync (Task 6.7)", () => {
  it("without sync there is no sync line", async () => {
    const t = await made(SEED);
    const registry = await phoneRegistry(t);
    registries.push(registry);
    vi.spyOn(registry, "indexError").mockReturnValue(new AppError("store.corrupt", CORRUPT_SPACE));
    vi.spyOn(registry, "indexErrorDoc").mockReturnValue("ix-sp000000000");
    function Host() {
      const [ui, setUi] = useUi("timeline");
      return (
        <UiContext.Provider value={{ ui, setUi }}>
          <OpenChoice.Provider value={vi.fn()}>
            <PhoneStatus session={null} registry={registry} clock={t.clock} onOpenItem={vi.fn()} />
          </OpenChoice.Provider>
        </UiContext.Provider>
      );
    }
    render(<Host />);
    await settle();
    expect(within(strip()).queryByRole("button", { name: "Open sync" })).toBeNull();
    expect(strip().textContent).toBe(CORRUPT_SPACE);
    openStatus();
    expect(within(statusSheet()).queryByRole("button", { name: "Open sync" })).toBeNull();
    const load = within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL });
    expect(load.hasAttribute("disabled")).toBe(false);
    expect(within(statusSheet()).queryByText("Needs a connection to the server.")).toBeNull();
  });
});

describe("PhoneStatus lines (Step 1)", () => {
  it("a store error offers Try again, which retries the plan's document once", async () => {
    const r = await indexShown(["Alpha"]);
    await renderIndex(r);
    const alpha = r.ids[0];
    const session = await r.registry.session(alpha);
    r.s.mem.fail("store_append", alpha, { code: "store.io", message: "Disk full." });
    act(() => {
      session.apply({ t: "create", kind: "task", name: "Task", parent: null, after: null, start: null });
    });
    await settle();
    expect(session.storeError()?.message).toBe("Disk full.");
    expect(strip().textContent).toBe("Disk full.");
    expect(strip().classList.contains("bad")).toBe(true);
    openStatus();
    expect(lineOf("Disk full.").classList.contains("bad")).toBe(true);
    const retry = vi.spyOn(await r.registry.doc(alpha), "retry");
    r.s.mem.recover("store_append", alpha);
    fireEvent.click(within(lineOf("Disk full.")).getByRole("button", { name: "Try again" }));
    await settle();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(session.storeError()).toBeNull();
    expect(document.querySelector(".phone-status")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Status" })).toBeNull();
  });

  it("an index store error offers Try again and no Load again from the server", async () => {
    const r = await indexShown(["Alpha", "Beta"]);
    await renderIndex(r);
    const recover = failOnce("store_append", { code: "store.io", message: "Index disk full." }, xdocIs("local"));
    act(() => r.registry.trashPlan(r.ids[1]));
    await settle();
    expect(r.registry.indexError()?.message).toBe("Index disk full.");
    expect(strip().textContent).toBe("Index disk full.");
    openStatus();
    const line = lineOf("Index disk full.");
    expect(line.classList.contains("bad")).toBe(true);
    expect(within(line).queryByRole("button", { name: RELOAD_LABEL })).toBeNull();
    const retryIndex = vi.spyOn(r.registry, "retryIndex");
    recover();
    fireEvent.click(within(line).getByRole("button", { name: "Try again" }));
    await settle();
    expect(retryIndex).toHaveBeenCalledTimes(1);
    expect(r.registry.indexError()).toBeNull();
    expect(document.querySelector(".phone-status")).toBeNull();
  });

  const corruptSpace = (registry: Registry, readOnly = false) => {
    vi.spyOn(registry, "indexError").mockReturnValue(new AppError("store.corrupt", CORRUPT_SPACE));
    vi.spyOn(registry, "indexErrorDoc").mockReturnValue("ix-sp000000000");
    vi.spyOn(registry, "spaceReadOnly").mockReturnValue(readOnly);
    return vi.spyOn(registry, "reloadFromServer").mockResolvedValue(undefined);
  };

  it("a damaged space index offers Load again from the server through its confirmation", async () => {
    const r = await indexShown(["Alpha"]);
    const reload = corruptSpace(r.registry);
    await renderIndex(r, true);
    openStatus();
    expect(lineOf(CORRUPT_SPACE).classList.contains("bad")).toBe(true);
    expect(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    const confirm = screen.getByRole("dialog", { name: RELOAD_LABEL });
    expect(within(confirm).getByText(RELOAD_TEXT)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: RELOAD_LABEL })).toBeNull();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    fireEvent.click(within(screen.getByRole("dialog", { name: RELOAD_LABEL })).getByRole("button", { name: "Load again" }));
    await settle();
    expect(reload.mock.calls).toEqual([["ix-sp000000000"]]);
    expect(screen.queryByRole("dialog", { name: RELOAD_LABEL })).toBeNull();
  });

  const onIphone = (): void => {
    setPlatform(IPHONE);
    tauri.answers.device_info = () => ({ deviceId: "iphone", platform: "ios" });
  };

  const alertAsks = (): unknown[] => tauri.calls.filter((c) => c.cmd === "alert_ask").map((c) => c.args);

  const RELOAD_NATIVE = { ask: { title: RELOAD_LABEL, message: RELOAD_TEXT, confirm: { label: "Load again", destructive: false }, cancel: "Cancel" } };

  it("on iOS a damaged space index asks Load again through the native alert, and confirming reloads once", async () => {
    const r = await indexShown(["Alpha"]);
    onIphone();
    tauri.answers.alert_ask = () => "confirm";
    const reload = corruptSpace(r.registry);
    await renderIndex(r, true);
    openStatus();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    await settle();
    expect(alertAsks()).toEqual([RELOAD_NATIVE]);
    expect(screen.queryByRole("dialog", { name: RELOAD_LABEL })).toBeNull();
    expect(reload.mock.calls).toEqual([["ix-sp000000000"]]);
  });

  it("on iOS Cancel in the native alert reloads nothing", async () => {
    const r = await indexShown(["Alpha"]);
    onIphone();
    tauri.answers.alert_ask = () => "cancel";
    const reload = corruptSpace(r.registry);
    await renderIndex(r, true);
    openStatus();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    await settle();
    expect(alertAsks()).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
    expect(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL })).toHaveProperty("disabled", false);
  });

  it("on iOS a failed native alert shows its error and reloads nothing", async () => {
    const r = await indexShown(["Alpha"]);
    onIphone();
    tauri.answers.alert_ask = () => {
      throw { code: "alert.no_controller", message: "The alert cannot be shown: the window has no view controller to present it from." };
    };
    const reload = corruptSpace(r.registry);
    await renderIndex(r, true);
    openStatus();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual(["The alert cannot be shown: the window has no view controller to present it from."]);
  });

  it("on iOS the Load again button stays disabled while the native alert is up", async () => {
    const r = await indexShown(["Alpha"]);
    onIphone();
    const alert = hold("alert_ask");
    const reload = corruptSpace(r.registry);
    await renderIndex(r, true);
    openStatus();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    await settle();
    const button = within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    await settle();
    expect(alertAsks()).toHaveLength(1);
    act(() => alert.resolve("confirm"));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("on iOS the native alert is asked once even when the status lines empty while it is up", async () => {
    const r = await indexShown(["Alpha"]);
    onIphone();
    const alert = hold("alert_ask");
    const reload = corruptSpace(r.registry);
    const notify: (() => void)[] = [];
    const subscribe = r.registry.subscribe.bind(r.registry);
    vi.spyOn(r.registry, "subscribe").mockImplementation((cb) => {
      notify.push(cb);
      return subscribe(cb);
    });
    await renderIndex(r, true);
    openStatus();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    await settle();
    expect(alertAsks()).toHaveLength(1);
    vi.mocked(r.registry.indexError).mockReturnValue(null);
    act(() => notify.forEach((cb) => cb()));
    await settle();
    expect(screen.queryByText(CORRUPT_SPACE)).toBeNull();
    expect(alertAsks()).toHaveLength(1);
    expect(toastTexts()).toEqual([]);
    act(() => alert.resolve("confirm"));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([STALE_CONFIRM]);
  });

  it("on iOS a confirm while the space index is still damaged reloads it once", async () => {
    const r = await indexShown(["Alpha"]);
    onIphone();
    const alert = hold("alert_ask");
    const reload = corruptSpace(r.registry);
    const notify = notifier(r.registry);
    await renderIndex(r, true);
    openStatus();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    await settle();
    act(() => notify());
    await settle();
    expect(lineOf(CORRUPT_SPACE)).toBeTruthy();
    act(() => alert.resolve("confirm"));
    await settle();
    expect(alertAsks()).toHaveLength(1);
    expect(reload.mock.calls).toEqual([["ix-sp000000000"]]);
    expect(toastTexts()).toEqual([]);
  });

  it("on iOS Try again is disabled while a reload confirmed through the native alert runs, and enabled after", async () => {
    const r = await indexShown(["Alpha"]);
    onIphone();
    tauri.answers.alert_ask = () => "confirm";
    const reload = corruptSpace(r.registry);
    let inFlight = false;
    let finish: () => void = () => {
      throw new Error("the reload never started");
    };
    vi.spyOn(r.registry, "reloading").mockImplementation(() => inFlight);
    reload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          inFlight = true;
          finish = () => {
            inFlight = false;
            resolve();
          };
        }),
    );
    await renderIndex(r, true);
    openStatus();
    expect(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: "Try again" })).toHaveProperty("disabled", false);
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: "Try again" })).toHaveProperty("disabled", true);
    act(() => finish());
    await settle();
    expect(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: "Try again" })).toHaveProperty("disabled", false);
  });

  it("on macOS Try again stays enabled while a reload runs", async () => {
    const r = await indexShown(["Alpha"]);
    vi.spyOn(r.registry, "reloading").mockReturnValue(true);
    corruptSpace(r.registry);
    await renderIndex(r, true);
    openStatus();
    expect(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: "Try again" })).toHaveProperty("disabled", false);
  });

  it("on iOS a reload that fails after confirming shows its message", async () => {
    const r = await indexShown(["Alpha"]);
    onIphone();
    tauri.answers.alert_ask = () => "confirm";
    const reload = corruptSpace(r.registry);
    reload.mockRejectedValue(new AppError("sync.offline", "The server could not be reached."));
    await renderIndex(r, true);
    openStatus();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual(["The server could not be reached."]);
    expect(screen.queryByRole("dialog", { name: RELOAD_LABEL })).toBeNull();
  });

  it("on macOS Load again keeps its HTML confirmation and never calls alert_ask", async () => {
    const r = await indexShown(["Alpha"]);
    tauri.answers.alert_ask = () => "confirm";
    corruptSpace(r.registry);
    await renderIndex(r, true);
    openStatus();
    fireEvent.click(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL }));
    expect(screen.getByRole("dialog", { name: RELOAD_LABEL })).toBeTruthy();
    expect(alertAsks()).toEqual([]);
  });

  it("a damaged space index while read-only offers no Load again from the server", async () => {
    const r = await indexShown(["Alpha"]);
    const reload = corruptSpace(r.registry, true);
    await renderIndex(r);
    openStatus();
    expect(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(lineOf(CORRUPT_SPACE)).queryByRole("button", { name: RELOAD_LABEL })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("a damaged space index shows with no plan open", async () => {
    const r = await indexShown([]);
    corruptSpace(r.registry);
    await renderIndex(r);
    expect(document.querySelector(".empty-state")).not.toBeNull();
    expect(strip().textContent).toBe(CORRUPT_SPACE);
    openStatus();
    expect(within(lineOf(CORRUPT_SPACE)).getByRole("button", { name: RELOAD_LABEL })).toBeTruthy();
  });

  it("a settings error offers Try again, and the line goes once settings save", async () => {
    const r = await indexShown(["Alpha"]);
    await renderIndex(r);
    const session = await r.registry.session(r.ids[0]);
    const recover = failOnce("settings_write", { code: "settings.io", message: "Settings disk full." });
    act(() => {
      session.apply({ t: "planName", name: "Renamed" });
    });
    await settle();
    expect(r.registry.settingsError()?.message).toBe("Settings disk full.");
    openStatus();
    expect(lineOf("Settings disk full.").classList.contains("bad")).toBe(true);
    const retrySettings = vi.spyOn(r.registry, "retrySettings");
    recover();
    fireEvent.click(within(lineOf("Settings disk full.")).getByRole("button", { name: "Try again" }));
    await settle();
    expect(retrySettings).toHaveBeenCalledTimes(1);
    expect(r.registry.settingsError()).toBeNull();
    expect(document.querySelector(".phone-status")).toBeNull();
  });

  it("a settings error shows with no plan open", async () => {
    const r = await indexShown([]);
    vi.spyOn(r.registry, "settingsError").mockReturnValue(new AppError("settings.io", "Settings disk full."));
    await renderIndex(r);
    expect(strip().textContent).toBe("Settings disk full.");
    openStatus();
    expect(within(lineOf("Settings disk full.")).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("unreadable plan-list changes stay", async () => {
    const r = await indexShown(["Alpha"]);
    const unreadable = vi.spyOn(r.registry, "indexUnreadable").mockReturnValue([UNREADABLE_INDEX]);
    const notify = notifier(r.registry);
    await renderIndex(r);
    vi.useFakeTimers();
    openStatus();
    expect(lineTexts()).toEqual([UNREADABLE_INDEX]);
    const line = lineOf(UNREADABLE_INDEX);
    expect(line.classList.contains("bad")).toBe(true);
    expect(within(line).queryAllByRole("button")).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    act(() => notify());
    expect(lineTexts()).toEqual([UNREADABLE_INDEX]);
    const second = "A change to the plan list from Mac could not be read: Action x8 has a malformed w. Update WebBoard on this device.";
    unreadable.mockReturnValue([UNREADABLE_INDEX, second]);
    act(() => notify());
    expect(lineTexts()).toEqual([UNREADABLE_INDEX, second]);
  });

  it("unreadable plan-list changes show with no plan open", async () => {
    const r = await indexShown([]);
    vi.spyOn(r.registry, "indexUnreadable").mockReturnValue([UNREADABLE_INDEX]);
    await renderIndex(r);
    expect(strip().textContent).toBe(UNREADABLE_INDEX);
    openStatus();
    expect(lineTexts()).toEqual([UNREADABLE_INDEX]);
  });

  it("an unreadable change stays, and the changes waiting on it count", async () => {
    const t = await made(SEED, { raw: unreadableRaw() });
    await shown(t);
    vi.useFakeTimers();
    const view = t.session.view();
    expect(view.unreadable).toHaveLength(1);
    openStatus();
    const message = view.unreadable[0].message;
    expect(message.startsWith("A change from iPhone could not be read: ")).toBe(true);
    expect(message.endsWith(". Update WebBoard on this device.")).toBe(true);
    expect(lineTexts().slice(0, 3)).toEqual([NEWER_PLAN, message, "Receiving… · 1 change waiting"]);
    expect(lineOf(message).classList.contains("bad")).toBe(true);
    expect(within(lineOf(message)).queryAllByRole("button")).toEqual([]);
    expect(lineOf("Receiving… · 1 change waiting").classList.contains("cyan")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(lineOf(message)).toBeTruthy();
    const x3: Action = { id: "x3", dev: "iphone", ses: "s1", at: 0, par: ["x2"], lbl: "Renamed “Review 2” to “Review 3”", w: [{ u: "n:Review", v: "Review 3", c: "own" }] };
    act(() => {
      t.doc.ydoc.getMap("actions").set("x3", encodeAction(x3));
    });
    expect(lineTexts().slice(0, 3)).toEqual([NEWER_PLAN, message, "Receiving… · 2 changes waiting"]);
  });

  it("a newer plan leads with the update line", async () => {
    const t = await made(SEED, { calendar: { ...CH_ZH }, answers: { holidays_year: pending }, raw: unreadableRaw() });
    await shown(t);
    expect(t.session.readOnlyReason).toBe(NEWER_PLAN);
    expect(strip().textContent).toBe(`${NEWER_PLAN} · +2 more`);
    expect(strip().classList.contains("warn")).toBe(true);
    openStatus();
    const message = t.session.view().unreadable[0].message;
    expect(lineTexts()).toEqual([NEWER_PLAN, message, "Receiving… · 1 change waiting"]);
    expect(lineOf(NEWER_PLAN).classList.contains("warn")).toBe(true);
    expect(within(lineOf(NEWER_PLAN)).queryAllByRole("button")).toEqual([]);
  });

  it("no holiday region offers Choose region, which opens Settings at Working time", async () => {
    const t = await made(SEED, { calendar: { region: null } });
    await shown(t);
    expect(strip().textContent).toBe(NO_REGION);
    openStatus();
    fireEvent.click(within(lineOf(NO_REGION)).getByRole("button", { name: "Choose region" }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Settings"]);
    expect([lastUi().settings, lastUi().dialog]).toEqual(["working-time", null]);
    expect(screen.getByRole("dialog", { name: "Settings" }).querySelector('section.settings-group[data-section="working-time"] .cal-body')).not.toBeNull();
  });

  const withNotices = async (notices: HolidayNotice[]) => {
    const t = await made(SEED);
    vi.spyOn(t.holidays, "notices").mockReturnValue(notices);
    const load = vi.spyOn(t.holidays, "load").mockResolvedValue(undefined);
    await shown(t, { holidays: t.holidays });
    return { t, load };
  };

  it("a failed refresh offers Try again, which loads once", async () => {
    const n: HolidayNotice = { k: "refreshFailed", year: 2027, error: new AppError("holidays.offline", "No network connection."), at: AT, fetchedAt: "2026-10-01T08:00:00Z" };
    const { t, load } = await withNotices([n]);
    openStatus();
    const text = "Holidays for 2027 not checked — retry";
    expect(noticeText(n).text).toBe(text);
    expect(lineOf(text).querySelector(".status-detail")?.textContent).toBe(noticeText(n).detail);
    fireEvent.click(within(lineOf(text)).getByRole("button", { name: "Try again" }));
    expect(load.mock.calls).toEqual([[t.session.view().plan.id, t.session, 2027]]);
  });

  it("a failed load reads not loaded — retry", async () => {
    const n: HolidayNotice = { k: "failed", year: 2028, error: new AppError("holidays.offline", "No network connection."), coverage: null, at: AT };
    await withNotices([n]);
    openStatus();
    expect(within(lineOf("Holidays for 2028 not loaded — retry")).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("out of range offers Settings at Working time", async () => {
    const n: HolidayNotice = {
      k: "failed",
      year: 2031,
      error: new AppError("holidays.out_of_range", "OpenHolidays has CH holidays for 2020–2030, not 2031"),
      coverage: { from: 2020, to: 2030 },
      at: AT,
    };
    const { load } = await withNotices([n]);
    openStatus();
    const t = noticeText(n);
    const line = lineOf(t.text);
    expect(line.querySelector(".status-detail")?.textContent).toBe(t.detail);
    expect(within(line).queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(within(line).getByRole("button", { name: "Change calendar…" }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Settings"]);
    expect(lastUi().settings).toBe("working-time");
    expect(load).not.toHaveBeenCalled();
  });

  it("a review that changes nothing dismisses", async () => {
    const cal: Partial<Calendar> = { ...CH_ZH };
    const t = await made(SEED, { calendar: cal, answers: { holidays_year: pending } });
    const now = t.session.view().plan.calendar;
    expect(now.holidays.has(2027)).toBe(true);
    const base: Calendar = { ...now, holidays: new Map([...now.holidays].filter(([y]) => y !== 2027)) };
    const n: HolidayNotice = { k: "ready", year: 2027, count: 1, intent: { t: "calendar", next: now, base }, preview: NO_CHANGE };
    vi.spyOn(t.holidays, "notices").mockReturnValue([n]);
    const dismiss = vi.spyOn(t.holidays, "dismiss");
    await shown(t, { holidays: t.holidays });
    openStatus();
    fireEvent.click(within(lineOf("Holidays for 2027 ready — review")).getByRole("button", { name: "Review" }));
    const sheet = screen.getByRole("dialog", { name: "Calendar" });
    expect(screen.queryByRole("dialog", { name: "Status" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Apply" }));
    await settle();
    expect(toastTexts()).toEqual([]);
    expect(dismiss.mock.calls).toEqual([[t.session.view().plan.id, 2027]]);
    expect(screen.queryByRole("dialog", { name: "Calendar" })).toBeNull();
  });

  it("a remote ch:2028 clears not loaded", async () => {
    const t = await made([...SEED, { name: "Late", start: "2028-03-06", dur: 2 }], { calendar: { region: ZH }, answers: { holidays_year: pending } });
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    await shown(t, { holidays: t.holidays });
    openStatus();
    expect(lineTexts()).toContain("Holidays for 2028 not loaded — load");
    const from = tauri.calls.length;
    const pc = peer.session.view().plan.calendar;
    const next: Calendar = { ...pc, holidays: new Map([...pc.holidays, [2028, holidayYear("oh:CH:CH-ZH", 2028, [holidayDay("2028-01-01", "Neujahr", "public")])]]) };
    act(() => {
      peer.session.apply({ t: "calendar", next });
    });
    act(() => peer.sync());
    await settle();
    expect(lineTexts().filter((x) => x !== null && /Holidays for 2028/.test(x))).toEqual([]);
    expect(t.holidays.notices(t.session.view().plan.id).filter((x) => x.year === 2028)).toEqual([]);
    expect(tauri.calls.slice(from).filter((c) => c.cmd === "holidays_year")).toEqual([]);
  });

  it("a conflict goes to its successor's sheet, whose Fix pushes it", async () => {
    const t = await made(CONFLICT_SEED);
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    openStatus();
    const line = lineOf("1 conflict");
    expect(line.classList.contains("magenta")).toBe(true);
    fireEvent.click(within(line).getByRole("button", { name: "Go to first conflict" }));
    expect(screen.queryByRole("dialog", { name: "Status" })).toBeNull();
    const sheet = screen.getByRole("dialog", { name: "B" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Push “B” to Thu 19 Nov" }));
    expect(apply.mock.calls).toHaveLength(1);
    expect(apply.mock.calls.filter((c) => c[0].t === "fix")).toHaveLength(1);
    const intent = apply.mock.calls[0][0];
    if (intent.t !== "fix") throw new Error("not a fix");
    expect(intent.how).toBe("push");
    const conflict = intent.conflict;
    if (conflict.kind !== "early") throw new Error("not an early conflict");
    expect(conflict.succ).toBe("B");
  });

  it("a calendar choice shows the open-choices line and its banner, whose Choose… opens it", async () => {
    const t = await made(SEED, { clashes: [AWAY] });
    await shown(t);
    const choice = t.session.view().choices[0];
    openStatus();
    expect(lineOf("1 open choice · Choose…").classList.contains("amber")).toBe(true);
    const banner = lineOf(CALENDAR_BANNER);
    fireEvent.click(within(banner).getByRole("button", { name: "Choose…" }));
    expect(lastUi().dialog).toEqual({ t: "choice", id: choice.id });
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual([CHOICE_TITLE]);
  });

  it("orders one line of each kind, the strip naming the first", async () => {
    const t = await made(CONFLICT_SEED, { clashes: [AWAY] });
    await shown(t);
    failOnce("store_append", { code: "store.io", message: "Disk full." });
    act(() => {
      t.session.apply({ t: "rename", item: "A", name: "A2" });
    });
    await settle();
    act(() => {
      const actions = t.doc.ydoc.getMap("actions");
      Object.entries(unreadableRaw()).forEach(([id, raw]) => actions.set(id, raw));
    });
    const message = t.session.view().unreadable[0].message;
    expect(strip().textContent).toBe("Disk full. · +7 more");
    openStatus();
    expect(lineTexts()).toEqual(["Disk full.", NEWER_PLAN, message, "Receiving… · 1 change waiting", NO_REGION, "1 conflict", "1 open choice · Choose…", CALENDAR_BANNER]);
  });

  it("shows nothing when there is nothing to say", async () => {
    const t = await made(SEED, { calendar: { ...CH_ZH }, answers: { holidays_year: pending } });
    await shown(t);
    expect(document.querySelector(".phone-list")).not.toBeNull();
    expect(document.querySelector(".phone-status")).toBeNull();
  });
});

describe("every open choice is reachable (Step 2)", () => {
  it("a rename clash is settled from the status line", async () => {
    const t = await made(SEED, { calendar: { ...CH_ZH }, answers: { holidays_year: pending }, clashes: [{ unit: "n:Review", mac: "Review A", iphone: "Review B" }] });
    const resolve = vi.spyOn(t.session, "resolve");
    await shown(t);
    const view = t.session.view();
    expect(view.held.size).toBe(0);
    expect(screen.queryByRole("button", { name: /held/ })).toBeNull();
    expect(strip().textContent).toBe("1 open choice · Choose…");
    openStatus();
    fireEvent.click(within(statusSheet()).getByRole("button", { name: "1 open choice · Choose…" }));
    const list = screen.getByRole("dialog", { name: "Open choices" });
    const rows = within(list).getAllByRole("button").filter((b) => b.classList.contains("choice-row"));
    expect(rows.map((b) => b.textContent)).toEqual(["Mac or iPhone"]);
    fireEvent.click(rows[0]);
    const choice = view.choices[0];
    expect(lastUi().dialog).toEqual({ t: "choice", id: choice.id });
    const sheet = screen.getByRole("dialog", { name: CHOICE_TITLE });
    fireEvent.click(within(sheet).getByRole("radio", { name: "iPhone" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Apply" }));
    const iphone = choice.sides.find((s) => s.label === "iPhone");
    if (iphone === undefined) throw new Error("no iPhone side");
    expect(resolve.mock.calls).toEqual([[choice.id, { side: iphone.key }, DEFAULTS]]);
    const r = resolve.mock.results[0];
    if (r === undefined || r.type !== "return") throw new Error("resolve did not return");
    expect(toastTexts()).toContain(r.value.toast);
    expect(t.session.view().choices).toEqual([]);
    expect(document.querySelector(".phone-status")).toBeNull();
    expect(document.querySelector(".phone-list")?.textContent).toContain("Review B");
  });

  it("a calendar choice opens from the status line", async () => {
    const t = await made(SEED, { clashes: [AWAY] });
    await shown(t);
    const choice = t.session.view().choices[0];
    expect(choice.kind).toBe("calendar");
    openStatus();
    fireEvent.click(within(statusSheet()).getByRole("button", { name: "1 open choice · Choose…" }));
    const list = screen.getByRole("dialog", { name: "Open choices" });
    fireEvent.click(within(list).getByRole("button", { name: "Mac or iPhone" }));
    expect(lastUi().dialog).toEqual({ t: "choice", id: choice.id });
    expect(screen.getByRole("dialog", { name: CHOICE_TITLE })).toBeTruthy();
  });

  it("lists every open choice by its sides in view.choices order", async () => {
    const t = await made(SEED, { clashes: [AWAY, { unit: "n:Review", mac: "Review A", iphone: "Review B" }] });
    await shown(t);
    const view = t.session.view();
    openStatus();
    fireEvent.click(within(statusSheet()).getByRole("button", { name: "2 open choices · Choose…" }));
    const list = screen.getByRole("dialog", { name: "Open choices" });
    const rows = within(list).getAllByRole("button").filter((b) => b.classList.contains("choice-row"));
    expect(view.choices.map((c) => c.kind).sort()).toEqual(["calendar", "items"]);
    expect(rows.map((b) => b.textContent)).toEqual(["Mac or iPhone", "Mac or iPhone"]);
    fireEvent.click(rows[1]);
    expect(lastUi().dialog).toEqual({ t: "choice", id: view.choices[1].id });
  });

  it("on the iPhone a choice row names the iPhone first", async () => {
    const t = await made(SEED, { clashes: [{ unit: "n:Review", mac: "Review A", iphone: "Review B" }] });
    const registry = await shown(t, { device: "iphone" });
    expect(registry.device.name).toBe("iPhone");
    openStatus();
    fireEvent.click(within(statusSheet()).getByRole("button", { name: "1 open choice · Choose…" }));
    const list = screen.getByRole("dialog", { name: "Open choices" });
    const rows = within(list).getAllByRole("button").filter((b) => b.classList.contains("choice-row"));
    expect(rows.map((b) => b.textContent)).toEqual(["iPhone or Mac"]);
  });

  const settledElsewhere = async (seedOpts: TestSessionOpts) => {
    const t = await made(SEED, { ...seedOpts, clashes: [{ unit: "n:Review", mac: "Review A", iphone: "Review B" }] });
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    await shown(t);
    openStatus();
    fireEvent.click(within(statusSheet()).getByRole("button", { name: "1 open choice · Choose…" }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Open choices"]);
    const choice = peer.session.view().choices[0];
    const iphone = choice.sides.find((s) => s.label === "iPhone");
    if (iphone === undefined) throw new Error("no iPhone side");
    act(() => {
      peer.session.resolve(choice.id, { side: iphone.key }, DEFAULTS);
    });
    act(() => peer.sync());
    await settle();
    expect(t.session.view().choices).toEqual([]);
    expect(screen.queryByRole("dialog", { name: "Open choices" })).toBeNull();
    return t;
  };

  it("a choice settled elsewhere while Open choices is open shows the Status sheet again", async () => {
    await settledElsewhere({});
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Status"]);
    expect(lineTexts()).toEqual([NO_REGION]);
    fireEvent.click(within(statusSheet()).getByRole("button", { name: "Close" }));
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    fireEvent.click(strip());
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Status"]);
  });

  it("a choice settled elsewhere that leaves no lines closes the Status sheet, and a later line opens it", async () => {
    const t = await settledElsewhere({ calendar: { ...CH_ZH }, answers: { holidays_year: pending } });
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.querySelector(".phone-status")).toBeNull();
    act(() => {
      t.session.apply({ t: "calendar", next: { ...t.session.view().plan.calendar, region: null } });
    });
    expect(strip().textContent).toBe(NO_REGION);
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    fireEvent.click(strip());
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Status"]);
  });
});

describe("chained sheets give focus back to what opened the first (m25)", () => {
  const press = (el: HTMLElement): void => {
    act(() => el.focus());
    fireEvent.click(el);
  };
  const closeOf = (sheet: HTMLElement): HTMLElement => {
    const el = sheet.querySelector(".sheet-head button");
    if (!(el instanceof HTMLElement)) throw new Error("no sheet Close button");
    return el;
  };

  it("Status → Choose region → Settings → Close focuses the strip", async () => {
    const t = await made(SEED, { calendar: { region: null } });
    await shown(t);
    press(strip());
    press(within(lineOf(NO_REGION)).getByRole("button", { name: "Choose region" }));
    press(closeOf(screen.getByRole("dialog", { name: "Settings" })));
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.activeElement).toBe(strip());
  });

  it("Status → Go to first conflict → item sheet → Close focuses the strip", async () => {
    const t = await made(CONFLICT_SEED);
    await shown(t);
    press(strip());
    press(within(lineOf("1 conflict")).getByRole("button", { name: "Go to first conflict" }));
    press(closeOf(screen.getByRole("dialog", { name: "B" })));
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.activeElement).toBe(strip());
  });

  it("Status → a calendar choice's Choose… → choice sheet → Close focuses the strip", async () => {
    const t = await made(SEED, { clashes: [AWAY] });
    await shown(t);
    press(strip());
    press(within(lineOf(CALENDAR_BANNER)).getByRole("button", { name: "Choose…" }));
    press(closeOf(screen.getByRole("dialog", { name: CHOICE_TITLE })));
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.activeElement).toBe(strip());
  });

  it("Status → Open choices → a choice → choice sheet → Close focuses the strip", async () => {
    const t = await made(SEED, { clashes: [AWAY] });
    await shown(t);
    press(strip());
    press(within(statusSheet()).getByRole("button", { name: "1 open choice · Choose…" }));
    press(within(screen.getByRole("dialog", { name: "Open choices" })).getByRole("button", { name: "Mac or iPhone" }));
    press(closeOf(screen.getByRole("dialog", { name: CHOICE_TITLE })));
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.activeElement).toBe(strip());
  });

  it("Status → Open choices → Close shows Status again, whose Close focuses the strip", async () => {
    const t = await made(SEED, { clashes: [AWAY] });
    await shown(t);
    press(strip());
    press(within(statusSheet()).getByRole("button", { name: "1 open choice · Choose…" }));
    press(closeOf(screen.getByRole("dialog", { name: "Open choices" })));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Status"]);
    expect(statusSheet().contains(document.activeElement)).toBe(true);
    press(closeOf(statusSheet()));
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.activeElement).toBe(strip());
  });

  it("⋯ → Change calendar… → Settings, which closes the Plan sheet → Close focuses ⋯", async () => {
    const t = await made(SEED);
    await shown(t);
    const more = screen.getByRole("button", { name: "Plan" });
    press(more);
    press(within(screen.getByRole("dialog", { name: "Plan" })).getByRole("button", { name: "Change calendar…" }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Settings"]);
    press(closeOf(screen.getByRole("dialog", { name: "Settings" })));
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.activeElement).toBe(more);
  });
});
