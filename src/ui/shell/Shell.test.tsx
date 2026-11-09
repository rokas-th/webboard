import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { RegionRef } from "../../domain/calendar";
import type { PlanId } from "../../domain/model";
import { sideText } from "../../plan/choices";
import { fixedClock } from "../../services/clock";
import { AppError } from "../../services/ipc";
import { decodeAction, encodeAction } from "../../store/doc";
import { IndexDoc } from "../../store/index-doc";
import type { PersistedDoc } from "../../store/persist";
import { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { memoryStore } from "../../test/fixtures/store";
import { MESA_SEED, memoryDoc, testSession, type SeedItem, type TestSession } from "../../test/session";
import { seededStore as store, shellFor } from "../../test/shell";
import { hold, resetTauri, tauri, type Call } from "../../test/tauriMock";
import { orderedSides } from "../choices/order";
import { clearToasts } from "../common/Toast";
import { PLACE_KEY, PLACE_UNREADABLE, pickPlan, useUi, type UiState } from "../state";
import { PlanHead } from "./PlanHead";
import { Shell } from "./Shell";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const ZH: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const FILES_STAY = "The plan’s files stay on this device.";
const RELOAD = "Load again from the server";
const RELOAD_TEXT = "Changes this device had not sent to the server are not loaded again; the damaged files stay on this device.";
const INCOMPLETE = "This plan has not arrived yet; it opens once it syncs.";

const sessions: PlanSession[] = [];
const registries: Registry[] = [];

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
});

afterEach(async () => {
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
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const made = async (...a: Parameters<typeof testSession>): Promise<TestSession> => {
  const t = await testSession(...a);
  sessions.push(t.session);
  return t;
};

const toastTexts = (): (string | null)[] => screen.queryAllByRole("status").map((e) => e.textContent);

const toastNodes = (): HTMLElement[] => screen.queryAllByRole("status");

const slot = (name: string): Element | null => document.querySelector(`[data-slot="${name}"]`);

const expectTimeline = (): void => {
  const at = slot("timeline");
  expect(at).not.toBeNull();
  expect(at?.querySelector(".tl-scroll")).not.toBeNull();
  expect(document.querySelectorAll(".tl-scroll")).toHaveLength(1);
};

const expectNoTimeline = (): void => {
  expect(slot("timeline")).toBeNull();
  expect(document.querySelector(".tl-scroll")).toBeNull();
};

const lastUi = () => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value[0];
};

const entry = (name: string): HTMLElement => {
  const nav = screen.getByRole("navigation", { name: "Plans" });
  return within(nav).getByText(name).closest("li") ?? (() => { throw new Error("no entry " + name); })();
};

const currentName = (): string | null => {
  const nav = screen.getByRole("navigation", { name: "Plans" });
  return nav.querySelector('[aria-current="page"]')?.textContent ?? null;
};

const newPlanIn = (nav: HTMLElement): HTMLElement => {
  const box = nav.querySelector(".sidebar-new");
  if (!(box instanceof HTMLElement)) throw new Error("no sidebar New plan");
  return within(box).getByRole("button");
};

const trashSection = (): HTMLElement | null => screen.queryByRole("region", { name: "Trash" });

const xdoc = (c: Call): string | null => new Headers(c.options?.headers).get("x-doc");
const xseq = (c: Call): string | null => new Headers(c.options?.headers).get("x-seq");

async function opened(): Promise<Registry> {
  const r = await Registry.open({ clock: fixedClock("2026-11-09") });
  registries.push(r);
  return r;
}

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

const shellOn = (r: Registry) => <Shell registry={r} clock={fixedClock("2026-11-09")} />;

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  const settlers: { resolve(v: T): void; reject(e: unknown): void }[] = [];
  const promise = new Promise<T>((resolve, reject) => {
    settlers.push({ resolve, reject });
  });
  const [s] = settlers;
  return { promise, resolve: s.resolve, reject: s.reject };
}

describe("Shell on testSession(MESA_SEED)", () => {
  it("renders the toolbar", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(ui);
    await settle();
    const bar = document.querySelector("header.toolbar[data-tauri-drag-region]");
    if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
    expect(bar.querySelector(".wordmark")?.textContent).toBe("WebBoard");
    expect(within(bar).getByText("Plan")).toBeTruthy();
    const tabs = within(bar).getAllByRole("tab");
    expect(tabs.map((b) => [b.textContent, b.getAttribute("aria-selected")])).toEqual([
      ["Timeline", "true"],
      ["Now · Next · Later", "false"],
      ["List", "false"],
    ]);
    expect(["W", "M", "Q"].map((z) => within(bar).getByRole("button", { name: z }).getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(within(bar).getByRole("button", { name: "⌘K" })).toBeTruthy();
    const chip = within(bar).getByText("Local only");
    expect(chip.tagName).not.toBe("BUTTON");
    expect(chip.closest("button")).toBeNull();
    const undo = within(bar).getByRole("button", { name: "Undo" });
    const redo = within(bar).getByRole("button", { name: "Redo" });
    expect([undo.hasAttribute("disabled"), redo.hasAttribute("disabled")]).toEqual([true, true]);
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    expect([undo.hasAttribute("disabled"), redo.hasAttribute("disabled")]).toEqual([false, true]);
    fireEvent.click(undo);
    expect([undo.hasAttribute("disabled"), redo.hasAttribute("disabled")]).toEqual([true, false]);
    act(() => t.session.setReadOnly(true));
    expect([undo.hasAttribute("disabled"), redo.hasAttribute("disabled")]).toEqual([true, true]);
  });

  it("reads Ctrl K off macOS", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t, { device: { deviceId: "mac", name: "Linux", platform: "linux" } });
    render(ui);
    await settle();
    expect(screen.getByRole("button", { name: "Ctrl K" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "⌘K" })).toBeNull();
  });

  it("mounts the slots for the view", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(ui);
    await settle();
    expectTimeline();
    expect(slot("panel")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    expect(slot("list")).not.toBeNull();
    expect(slot("list")?.querySelector(".list-wrap table.list")).not.toBeNull();
    expectNoTimeline();
    expect(screen.getByRole("tab", { name: "List" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Now · Next · Later" }));
    expect(slot("board")).not.toBeNull();
    expect(slot("board")?.querySelectorAll(".nnl [data-col]")).toHaveLength(3);
    expect(slot("list")).toBeNull();
    expect(document.querySelector(".list-wrap")).toBeNull();
  });

  it("lists cached names, Loading… for a missing one, and marks the selected plan", async () => {
    const t = await made(MESA_SEED);
    const id = t.session.view().plan.id;
    const { ui } = shellFor(t, {
      plans: () => [
        { id, name: "Plan", trashed: false, loaded: true, space: null },
        { id: "other000000", name: null, trashed: false, loaded: false, space: null },
      ],
    });
    render(ui);
    await settle();
    expect(within(screen.getByRole("navigation", { name: "Plans" })).getByText("Loading…")).toBeTruthy();
    expect(currentName()).toBe("Plan");
  });

  it("shows the tray count and legend", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(ui);
    await settle();
    expect(screen.getByText("Unscheduled · 5")).toBeTruthy();
    expect(document.querySelector(".legend")?.textContent).toBe("taskmilestonelateconflictheld");
  });

  it("toasts the session's repair notice once", async () => {
    const t = await made(MESA_SEED);
    const take = vi.spyOn(t.session, "takeRepairNotice").mockReturnValueOnce("The last change before WebBoard stopped was cut off while saving and was not kept.").mockReturnValue(null);
    const { ui } = shellFor(t);
    render(ui);
    await settle();
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    expect(toastTexts().filter((x) => x === "The last change before WebBoard stopped was cut off while saving and was not kept.")).toHaveLength(1);
    expect(take.mock.calls.length).toBeGreaterThan(1);
  });

  it("puts a store error in one banner, and Try again retries it", async () => {
    const t = await made(MESA_SEED);
    const { ui, registry } = shellFor(t);
    render(ui);
    await settle();
    const real = tauri.answers.store_append;
    const fails: { code: string; message: string }[] = [{ code: "store.io", message: "Disk full." }];
    tauri.answers.store_append = (args, options) => {
      const e = fails.shift();
      if (e !== undefined) throw e;
      return real(args, options);
    };
    const from = tauri.calls.length;
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    await settle();
    expect(screen.getAllByText("Disk full.")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    const retryPlan = vi.spyOn(registry, "retryPlan");
    const retry = vi.spyOn(t.doc, "retry");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(retryPlan.mock.calls).toEqual([[t.session.view().plan.id]]);
    expect(retry).toHaveBeenCalledTimes(1);
    const appends = tauri.calls.slice(from).filter((c) => c.cmd === "store_append" && xdoc(c) === t.session.view().plan.id);
    expect(appends).toHaveLength(2);
    expect(xseq(appends[1])).toBe(xseq(appends[0]));
    expect(appends[1].args).toEqual(appends[0].args);
    expect(screen.queryByText("Disk full.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps the banner when the retry fails too", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(ui);
    await settle();
    const real = tauri.answers.store_append;
    const fails: { code: string; message: string }[] = [{ code: "store.io", message: "Disk full." }];
    tauri.answers.store_append = (args, options) => {
      const e = fails.shift();
      if (e !== undefined) throw e;
      return real(args, options);
    };
    act(() => {
      t.session.apply({ t: "move", items: ["t3"], days: 1 });
    });
    await settle();
    fails.push({ code: "store.io", message: "Disk still full." });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.getAllByText("Disk still full.")).toHaveLength(1);
    expect(screen.queryByText("Disk full.")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("toasts a window error and an unhandled rejection until unmounted", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    const view = render(ui);
    await settle();
    act(() => {
      window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("Holiday warm for plan p failed: boom") }));
    });
    expect(toastNodes().map((n) => [n.textContent, n.className])).toEqual([["Holiday warm for plan p failed: boom", "toast bad"]]);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "plain reason" }));
    });
    expect(toastTexts()).toEqual(["Holiday warm for plan p failed: boom", "plain reason"]);
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("thrown in a handler"), message: "Uncaught Error: thrown in a handler" }));
    });
    expect(toastTexts()).toEqual(["Holiday warm for plan p failed: boom", "plain reason", "thrown in a handler"]);
    view.unmount();
    clearToasts();
    const probe = render(<div />);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("after unmount") }));
    });
    expect(toastTexts()).toEqual([]);
    probe.unmount();
  });

  it("toasts only error events that carry an error", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(ui);
    await settle();
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
      window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    });
    expect(toastTexts()).toEqual([]);
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("thrown in a handler"), message: "Uncaught Error: thrown in a handler" }));
    });
    expect(toastNodes().map((n) => [n.textContent, n.className])).toEqual([["thrown in a handler", "toast bad"]]);
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { error: "thrown string", message: "Uncaught thrown string" }));
    });
    expect(toastTexts()).toEqual(["thrown in a handler", "thrown string"]);
  });

  it("resets an unreadable webboard.place with one toast", async () => {
    window.localStorage.setItem(PLACE_KEY, "{");
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(ui);
    await settle();
    expect(toastTexts().filter((x) => x === PLACE_UNREADABLE)).toHaveLength(1);
    expect(toastNodes().find((n) => n.textContent === PLACE_UNREADABLE)?.className).toBe("toast bad");
    expect(screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "W" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    const saved: unknown = JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "null");
    expect(saved).toEqual({ plan: t.session.view().plan.id, view: "list", zoom: "W", collapsed: [] });
  });

  it("does not toast a missing webboard.place", async () => {
    const t = await made(MESA_SEED);
    const { ui } = shellFor(t);
    render(ui);
    await settle();
    expect(toastTexts()).toEqual([]);
  });
});

describe("PlanHead", () => {
  const RAW_X1 = ["iphone", "s1", 0, [], "Bad", "not-writes"];
  const RAW_X3 = ["ipad7", "s2", 0, [], "Bad", "not-writes"];
  const child = (id: string, name: string) =>
    encodeAction({ id, dev: "iphone", ses: "s1", at: 0, par: ["x1"], lbl: "Rename", w: [{ u: "n:A", v: name, c: "own" }] });
  const thrown = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      if (e instanceof Error) return e.message;
    }
    throw new Error("expected a throw");
  };

  it("names unreadable changes and pending ones", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }], { raw: { x1: RAW_X1, x2: child("x2", "Renamed"), x3: RAW_X3 } });
    const m1 = thrown(() => decodeAction("x1", RAW_X1));
    const m3 = thrown(() => decodeAction("x3", RAW_X3));
    const messages = [
      "A change from iPhone could not be read: " + m1 + ". Update WebBoard on this device.",
      "A change from Device ipad could not be read: " + m3 + ". Update WebBoard on this device.",
    ];
    expect(t.session.view().unreadable).toEqual([
      { id: "x1", message: messages[0] },
      { id: "x3", message: messages[1] },
    ]);
    const view = render(<PlanHead session={t.session} local="Mac" onChoose={vi.fn()} />);
    const bad = (): (string | null)[] => [...view.container.querySelectorAll(".bad")].map((e) => e.textContent);
    expect(bad()).toEqual(messages);
    view.rerender(<PlanHead session={t.session} local="Mac" onChoose={vi.fn()} />);
    expect(bad()).toEqual(messages);
    expect(screen.getByText("Receiving… · 1 change waiting")).toBeTruthy();
  });

  it("counts several pending changes", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }], {
      raw: { x1: RAW_X1, x2: child("x2", "One"), x4: child("x4", "Two"), x5: child("x5", "Three") },
    });
    render(<PlanHead session={t.session} local="Mac" onChoose={vi.fn()} />);
    expect(screen.getByText("Receiving… · 3 changes waiting")).toBeTruthy();
  });

  const A = [{ name: "A", start: "2026-11-10", dur: 3 }];
  const NAME_CLASH = { unit: "n:A", mac: "North", iphone: "South" };
  const DAY_CLASH = { unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null };
  const chip = (): string | null => document.querySelector(".chip-amber")?.textContent ?? null;

  it("counts open choices", async () => {
    const one = await made(A, { clashes: [NAME_CLASH] });
    const first = render(<PlanHead session={one.session} local="Mac" onChoose={vi.fn()} />);
    expect(chip()).toBe("1 open choice · Choose…");
    first.unmount();
    const none = await made(A);
    const empty = render(<PlanHead session={none.session} local="Mac" onChoose={vi.fn()} />);
    expect(empty.container.textContent).not.toMatch(/open choice/);
    empty.unmount();
  });

  it("lists every choice, calendar ones included, and opens the picked one", async () => {
    const t = await made(A, { clashes: [NAME_CLASH, DAY_CLASH] });
    const onChoose = vi.fn();
    render(<PlanHead session={t.session} local="Mac" onChoose={onChoose} />);
    expect(chip()).toBe("2 open choices · Choose…");
    const chips = document.querySelector(".chips");
    if (!(chips instanceof HTMLElement)) throw new Error("no chips");
    fireEvent.click(within(chips).getByRole("button", { name: "Choose…" }));
    const view = t.session.view();
    expect(view.choices.map((c) => c.kind).sort()).toEqual(["calendar", "items"]);
    const rows = within(screen.getByRole("list", { name: "Open choices" })).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(view.choices.map((c) => orderedSides(c, "Mac").map((s) => sideText(c, s.key, view.plan)).join(" or ")));
    fireEvent.click(rows[1]);
    expect(onChoose.mock.calls).toEqual([[view.choices[1].id]]);
    expect(screen.queryByRole("list", { name: "Open choices" })).toBeNull();
  });

  it("lists this device's side first even when the iPhone's replays first", async () => {
    const t = await made(A);
    const p = await t.peer("iphone");
    t.session.apply({ t: "rename", item: "A", name: "Draft" });
    t.session.apply({ t: "rename", item: "A", name: "Alpha" });
    p.session.apply({ t: "rename", item: "A", name: "Beta" });
    p.sync();
    expect(t.session.view().choices.map((c) => c.sides.map((s) => s.label))).toEqual([["iPhone", "Mac"]]);
    render(<PlanHead session={t.session} local="Mac" onChoose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    const rows = within(screen.getByRole("list", { name: "Open choices" })).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(["Mac or iPhone"]);
    await p.session.close();
  });

  it("closes the list when the last choice is resolved", async () => {
    const t = await made(A, { clashes: [NAME_CLASH] });
    render(<PlanHead session={t.session} local="Mac" onChoose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    expect(screen.queryByRole("list", { name: "Open choices" })).not.toBeNull();
    act(() => {
      const c = t.session.view().choices[0];
      t.session.resolve(c.id, { side: c.sides[0].key }, { pushFromPredecessors: false, returnPushed: false });
    });
    expect(chip()).toBeNull();
    const p = await t.peer("iphone");
    act(() => {
      t.session.apply({ t: "rename", item: "A", name: "East" });
      p.session.apply({ t: "rename", item: "A", name: "West" });
      p.sync();
    });
    expect(chip()).toBe("1 open choice · Choose…");
    expect(screen.queryByRole("list", { name: "Open choices" })).toBeNull();
    await p.session.close();
  });

  it("opens the choice holding the held items", async () => {
    const t = await made(A, { clashes: [{ unit: "s:A", mac: ["2026-11-16", 3, "todo", 0, "now"], iphone: ["2026-11-18", 3, "todo", 0, "now"] }] });
    const onChoose = vi.fn();
    const view = render(<PlanHead session={t.session} local="Mac" onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: "1 held" }));
    expect(onChoose.mock.calls).toEqual([[t.session.view().choices[0].id]]);
    view.unmount();
    const { ui } = shellFor(t);
    render(ui);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "1 held" }));
    expect(lastUi().dialog).toEqual({ t: "choice", id: t.session.view().choices[0].id });
  });
});

describe("Shell banners on a stub registry", () => {
  it("shows an index error with Try again, and drops it on notify", async () => {
    const t = await made(MESA_SEED);
    let error: AppError | null = new AppError("store.io", "Could not save the plan list: disk full.");
    const retryIndex = vi.fn(async () => undefined);
    const { ui, registry } = shellFor(t, { indexError: () => error, indexErrorDoc: () => (error === null ? null : "local"), retryIndex });
    render(ui);
    await settle();
    expect(screen.getByText("Could not save the plan list: disk full.").closest(".banner")?.classList.contains("bad")).toBe(true);
    expect(screen.queryByRole("button", { name: RELOAD })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retryIndex).toHaveBeenCalledTimes(1);
    error = null;
    act(() => registry.notify());
    expect(screen.queryByText("Could not save the plan list: disk full.")).toBeNull();
  });

  it("offers Load again from the server for a damaged space index", async () => {
    const t = await made(MESA_SEED);
    const reloadFromServer = vi.fn(async () => undefined);
    const { ui } = shellFor(t, {
      indexError: () => new AppError("store.corrupt", "The space plan list is damaged at record 4."),
      indexErrorDoc: () => "ix-sp000000000",
      retryIndex: vi.fn(async () => undefined),
      reloadFromServer,
    });
    render(ui);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: RELOAD }));
    const dialog = screen.getByRole("dialog", { name: RELOAD });
    expect(within(dialog).getByText(RELOAD_TEXT)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reloadFromServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: RELOAD }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Load again" }));
    await settle();
    expect(reloadFromServer.mock.calls).toEqual([["ix-sp000000000"]]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts one reload per press until it settles", async () => {
    const t = await made(MESA_SEED);
    const held = deferred<void>();
    const reloadFromServer = vi.fn<(docId: string) => Promise<void>>().mockReturnValueOnce(held.promise).mockResolvedValue(undefined);
    const { ui } = shellFor(t, {
      indexError: () => new AppError("store.corrupt", "The space plan list is damaged at record 4."),
      indexErrorDoc: () => "ix-sp000000000",
      retryIndex: vi.fn(async () => undefined),
      reloadFromServer,
    });
    render(ui);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: RELOAD }));
    const load = within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Load again" });
    fireEvent.click(load);
    fireEvent.click(load);
    expect(reloadFromServer).toHaveBeenCalledTimes(1);
    expect(load.hasAttribute("disabled")).toBe(true);
    await act(async () => held.reject(new AppError("store.io", "Could not set the plan aside: disk full.")));
    await settle();
    expect(toastTexts()).toEqual(["Could not set the plan aside: disk full."]);
    expect(load.hasAttribute("disabled")).toBe(false);
    fireEvent.click(load);
    await settle();
    expect(reloadFromServer).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the files of a damaged space index while read-only", async () => {
    const t = await made(MESA_SEED);
    const reloadFromServer = vi.fn(async () => undefined);
    const { ui } = shellFor(t, {
      indexError: () => new AppError("store.corrupt", "The space plan list is damaged at record 4."),
      indexErrorDoc: () => "ix-sp000000000",
      spaceReadOnly: () => true,
      reloadFromServer,
    });
    render(ui);
    await settle();
    expect(screen.getByText("The space plan list is damaged at record 4.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(FILES_STAY)).toBeTruthy();
    expect(screen.queryByRole("button", { name: RELOAD })).toBeNull();
    expect(reloadFromServer).not.toHaveBeenCalled();
  });

  it("shows each unreadable plan-list change as its own line", async () => {
    const t = await made(MESA_SEED);
    const line = "A change to the plan list from iPhone could not be read: Action x9 has a malformed w. Update WebBoard on this device.";
    let lines: string[] = [line];
    const { ui, registry } = shellFor(t, { indexUnreadable: () => lines });
    render(ui);
    await settle();
    const el = screen.getByText(line);
    expect(el.classList.contains("bad")).toBe(true);
    expect(el.textContent).toBe(line);
    expect(el.querySelector("button")).toBeNull();
    lines = [];
    act(() => registry.notify());
    expect(screen.queryByText(line)).toBeNull();
  });

  it("shows a settings error with its own Try again", async () => {
    const t = await made(MESA_SEED);
    let error: AppError | null = new AppError("settings.io", "Could not save settings: disk full.");
    const retrySettings = vi.fn(async () => undefined);
    const retryIndex = vi.fn(async () => undefined);
    const { ui, registry } = shellFor(t, { settingsError: () => error, retrySettings, retryIndex });
    render(ui);
    await settle();
    expect(screen.getByText("Could not save settings: disk full.").closest(".banner")?.classList.contains("bad")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retrySettings).toHaveBeenCalledTimes(1);
    expect(retryIndex).not.toHaveBeenCalled();
    error = null;
    act(() => registry.notify());
    expect(screen.queryByText("Could not save settings: disk full.")).toBeNull();
  });

  it("toasts the index repair notice once", async () => {
    const t = await made(MESA_SEED);
    const text = "The last change to the plan list before WebBoard closed was not saved.";
    const take = vi.fn<() => string | null>().mockReturnValueOnce(text).mockReturnValue(null);
    const { ui, registry } = shellFor(t, { takeIndexRepairNotice: take });
    const view = render(ui);
    await settle();
    expect(toastTexts().filter((x) => x === text)).toHaveLength(1);
    view.rerender(ui);
    act(() => registry.notify());
    expect(take).toHaveBeenCalledTimes(2);
    expect(toastTexts().filter((x) => x === text)).toHaveLength(1);
  });

  it("toasts a later index repair notice once", async () => {
    const t = await made(MESA_SEED);
    const text = "The last change to the plan list before WebBoard closed was not saved.";
    const take = vi.fn<() => string | null>().mockReturnValueOnce(null).mockReturnValueOnce(text).mockReturnValue(null);
    const { ui, registry } = shellFor(t, { takeIndexRepairNotice: take });
    render(ui);
    await settle();
    expect(toastTexts()).toEqual([]);
    act(() => registry.notify());
    act(() => registry.notify());
    expect(toastTexts().filter((x) => x === text)).toHaveLength(1);
    expect(take).toHaveBeenCalledTimes(3);
  });

  it("waits for a plan that has not arrived", async () => {
    const t = await made(MESA_SEED);
    const id = t.session.view().plan.id;
    const session = vi
      .fn<(x: string) => Promise<PlanSession>>()
      .mockRejectedValueOnce(new AppError("plan.incomplete", INCOMPLETE))
      .mockResolvedValue(t.session);
    const { ui, registry } = shellFor(t, {
      plans: () => [{ id, name: "Beta", trashed: false, loaded: false, space: null }],
      session,
    });
    render(ui);
    await settle();
    expect(currentName()).toBe("Beta");
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    expectNoTimeline();
    expect(document.querySelector(".plan-failed")).toBeNull();
    act(() => registry.notify());
    await settle();
    expect(session).toHaveBeenCalledTimes(2);
    expectTimeline();
    expect(screen.queryByText(INCOMPLETE)).toBeNull();
  });

  it("keeps the not-arrived message while its retry runs", async () => {
    const t = await made(MESA_SEED);
    const id = t.session.view().plan.id;
    const held = deferred<PlanSession>();
    const session = vi
      .fn<(x: string) => Promise<PlanSession>>()
      .mockRejectedValueOnce(new AppError("plan.incomplete", INCOMPLETE))
      .mockReturnValue(held.promise);
    const { ui, registry } = shellFor(t, {
      plans: () => [{ id, name: "Beta", trashed: false, loaded: false, space: null }],
      session,
    });
    render(ui);
    await settle();
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    act(() => registry.notify());
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    act(() => registry.notify());
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    await settle();
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    expect(session).toHaveBeenCalledTimes(3);
    await act(async () => held.resolve(t.session));
    await settle();
    expectTimeline();
    expect(screen.queryByText(INCOMPLETE)).toBeNull();
  });

  it("shows a failed session open with Try again, and still rethrows it", async () => {
    const t = await made(MESA_SEED);
    const boom = new Error("boom");
    const rethrown: Promise<unknown>[] = [];
    const failing = (): Promise<PlanSession> => {
      const p = Promise.reject(boom);
      const then = p.then.bind(p);
      vi.spyOn(p, "then").mockImplementation((ok, bad) => {
        const next = then(ok, bad);
        rethrown.push(next.then(() => null, (e: unknown) => e));
        return next;
      });
      return p;
    };
    const calls: string[] = [];
    const session = (x: string): Promise<PlanSession> => {
      calls.push(x);
      return calls.length === 1 ? failing() : Promise.resolve(t.session);
    };
    const { ui } = shellFor(t, { session });
    render(ui);
    await settle();
    expect(screen.getByText("boom").closest(".banner")?.classList.contains("bad")).toBe(true);
    expectNoTimeline();
    expect(await Promise.all(rethrown)).toEqual([boom]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(calls).toEqual([t.session.view().plan.id, t.session.view().plan.id]);
    expectTimeline();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("shows a recorded failure of a loaded plan that did not open", async () => {
    const t = await made(MESA_SEED);
    const id = t.session.view().plan.id;
    const failure = new AppError("store.io", "Could not read the plan: disk error.");
    const retryPlan = vi.fn(async () => undefined);
    const { ui } = shellFor(t, { failures: () => new Map([[id, failure]]), session: () => Promise.reject(failure), retryPlan });
    render(ui);
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).getByText("Could not read the plan: disk error.")).toBeTruthy();
    expectNoTimeline();
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(retryPlan.mock.calls).toEqual([[id]]);
  });
});

describe("Shell on Registry.open", () => {
  it("renders a failed plan with Try again until it loads", async () => {
    const s = await store(["Alpha", "Beta"]);
    s.mem.fail("store_load", s.ids[1], { code: "store.io", message: "Could not read the plan: disk error." });
    const registry = await opened();
    await registry.warm();
    render(shellOn(registry));
    await settle();
    const beta = entry("Beta");
    expect(within(beta).getByText("Could not read the plan: disk error.").className).toBe("entry-bad");
    expect(within(beta).queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(within(beta).getByRole("button", { name: "Beta" }));
    await settle();
    expectNoTimeline();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).getByText("Could not read the plan: disk error.").classList.contains("bad")).toBe(true);
    const retryPlan = vi.spyOn(registry, "retryPlan");
    s.mem.recover("store_load", s.ids[1]);
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await settle();
    expect(retryPlan.mock.calls).toEqual([[s.ids[1]]]);
    expectTimeline();
    expect(document.querySelector(".plan-failed")).toBeNull();
  });

  it.each([
    ["store.locked", "This plan is open in another WebBoard process; close it there first."],
    ["ipc.shape", "store_load: expected raw bytes."],
  ])("offers Try again for %s", async (code, message) => {
    const s = await store(["Alpha", "Beta"]);
    s.mem.fail("store_load", s.ids[1], { code, message });
    const registry = await opened();
    await registry.warm();
    render(shellOn(registry));
    await settle();
    fireEvent.click(within(entry("Beta")).getByRole("button", { name: "Beta" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).getByText(message)).toBeTruthy();
    const retryPlan = vi.spyOn(registry, "retryPlan").mockResolvedValue(undefined);
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(retryPlan.mock.calls).toEqual([[s.ids[1]]]);
    expect(within(failed).queryByRole("button", { name: "Move to Trash" })).toBeNull();
    expect(within(failed).queryByRole("button", { name: RELOAD })).toBeNull();
  });

  it("offers Move to Trash for a damaged local plan", async () => {
    const s = await store(["Alpha", "Beta"]);
    s.mem.fail("store_load", s.ids[1], { code: "store.corrupt", message: "The plan file is damaged at record 12." });
    const registry = await opened();
    await registry.warm();
    render(shellOn(registry));
    await settle();
    fireEvent.click(within(entry("Beta")).getByRole("button", { name: "Beta" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(failed).queryByRole("button", { name: RELOAD })).toBeNull();
    expect(within(failed).getByText(FILES_STAY)).toBeTruthy();
    const trashPlan = vi.spyOn(registry, "trashPlan");
    fireEvent.click(within(failed).getByRole("button", { name: "Move to Trash" }));
    expect(trashPlan.mock.calls).toEqual([[s.ids[1]]]);
    expect(toastTexts()).toEqual(["Moved “Beta” to the Trash. Restore it from the Trash."]);
  });

  it("offers Load again from the server for a damaged space plan", async () => {
    const s = await store(["Alpha", "Beta", "Gamma"]);
    const p3 = s.ids[2];
    s.mem.fail("store_load", p3, { code: "store.corrupt", message: "The plan file is damaged at record 12." });
    const registry = await opened();
    await registry.warm();
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().map((l) => (l.id === p3 ? { ...l, space: "sp000000000" } : l)));
    const reload = vi.spyOn(registry, "reloadFromServer").mockResolvedValue(undefined);
    const trashPlan = vi.spyOn(registry, "trashPlan");
    render(shellOn(registry));
    await settle();
    fireEvent.click(within(entry("Gamma")).getByRole("button", { name: "Gamma" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).queryByRole("button", { name: "Move to Trash" })).toBeNull();
    fireEvent.click(within(failed).getByRole("button", { name: RELOAD }));
    const dialog = screen.getByRole("dialog", { name: RELOAD });
    expect(within(dialog).getByText(RELOAD_TEXT)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(within(failed).getByRole("button", { name: RELOAD }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Load again" }));
    await settle();
    expect(reload.mock.calls).toEqual([[p3]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trashPlan).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when Load again fails", async () => {
    const s = await store(["Alpha", "Gamma"]);
    const p3 = s.ids[1];
    s.mem.fail("store_load", p3, { code: "store.corrupt", message: "The plan file is damaged at record 12." });
    const registry = await opened();
    await registry.warm();
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().map((l) => (l.id === p3 ? { ...l, space: "sp000000000" } : l)));
    const reload = vi
      .spyOn(registry, "reloadFromServer")
      .mockRejectedValueOnce(new AppError("store.io", "Could not set the plan aside: disk full."))
      .mockResolvedValue(undefined);
    render(shellOn(registry));
    await settle();
    fireEvent.click(within(entry("Gamma")).getByRole("button", { name: "Gamma" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    fireEvent.click(within(failed).getByRole("button", { name: RELOAD }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Load again" }));
    await settle();
    expect(toastNodes().map((n) => [n.textContent, n.className])).toEqual([["Could not set the plan aside: disk full.", "toast bad"]]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.querySelector(".plan-failed")).not.toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Load again" }));
    await settle();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a damaged space plan's files while read-only", async () => {
    const s = await store(["Alpha", "Gamma"]);
    const p3 = s.ids[1];
    s.mem.fail("store_load", p3, { code: "store.corrupt", message: "The plan file is damaged at record 12." });
    const registry = await opened();
    await registry.warm();
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().map((l) => (l.id === p3 ? { ...l, space: "sp000000000" } : l)));
    vi.spyOn(registry, "spaceReadOnly").mockReturnValue(true);
    const reload = vi.spyOn(registry, "reloadFromServer");
    const trashPlan = vi.spyOn(registry, "trashPlan");
    render(shellOn(registry));
    await settle();
    fireEvent.click(within(entry("Gamma")).getByRole("button", { name: "Gamma" }));
    await settle();
    const failed = document.querySelector(".plan-failed");
    if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
    expect(within(failed).getByText("The plan file is damaged at record 12.")).toBeTruthy();
    expect(within(failed).getByText(FILES_STAY)).toBeTruthy();
    expect(within(failed).queryByRole("button")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(trashPlan).not.toHaveBeenCalled();
  });

  it("disables trash and restore of space plans while read-only", async () => {
    const s = await store(["Alpha", "Gamma", "Delta"], { trash: [2] });
    const [p1, p3, p4] = s.ids;
    const registry = await opened();
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().map((l) => (l.id === p3 || l.id === p4 ? { ...l, space: "sp000000000" } : l)));
    vi.spyOn(registry, "spaceReadOnly").mockReturnValue(true);
    const trashPlan = vi.spyOn(registry, "trashPlan");
    render(shellOn(registry));
    await settle();
    const gamma = within(entry("Gamma")).getByRole("button", { name: "Move to Trash" });
    expect(gamma.hasAttribute("disabled")).toBe(true);
    fireEvent.click(gamma);
    expect(trashPlan).not.toHaveBeenCalled();
    expect(within(entry("Alpha")).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(false);
    const section = trashSection();
    if (section === null) throw new Error("no Trash section");
    expect(within(section).getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(true);
    expect(p1).not.toBe(p4);
  });

  it("puts a loaded plan's store error in the banner once it is selected", async () => {
    const s = await store(["Alpha", "Beta"]);
    const [p1, p2] = s.ids;
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: p2 }));
    const registry = await opened();
    await registry.session(p1);
    let failures: ReadonlyMap<PlanId, AppError> = new Map([[p1, new AppError("store.io", "Could not save the plan: disk full.")]]);
    vi.spyOn(registry, "failures").mockImplementation(() => failures);
    const retryPlan = vi.spyOn(registry, "retryPlan").mockResolvedValue(undefined);
    const notify = notifier(registry);
    render(shellOn(registry));
    await settle();
    expect(currentName()).toBe("Beta");
    const alpha = entry("Alpha");
    expect(within(alpha).getByText("Could not save the plan: disk full.").className).toBe("entry-bad");
    fireEvent.click(within(alpha).getByRole("button", { name: "Try again" }));
    expect(retryPlan.mock.calls).toEqual([[p1]]);
    fireEvent.click(within(alpha).getByRole("button", { name: "Alpha" }));
    await settle();
    expectTimeline();
    expect(document.querySelector(".plan-failed")).toBeNull();
    expect(screen.getAllByText("Could not save the plan: disk full.")).toHaveLength(1);
    expect(screen.getByText("Could not save the plan: disk full.").closest(".banner")).not.toBeNull();
    failures = new Map();
    act(() => notify());
    expect(screen.queryByText("Could not save the plan: disk full.")).toBeNull();
  });

  it("starts empty with New plan, then creates and opens one", async () => {
    resetTauri({ ...memoryStore().answers, settings_read: () => null, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: "macos" }) });
    const registry = await opened();
    const createPlan = vi.spyOn(registry, "createPlan");
    render(shellOn(registry));
    await settle();
    expectNoTimeline();
    expect(screen.queryAllByRole("tab")).toEqual([]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    const bar = document.querySelector("header.toolbar");
    if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
    expect(within(bar).getByRole("button", { name: "⌘K" })).toBeTruthy();
    expect(within(bar).getByText("Local only")).toBeTruthy();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    fireEvent.click(within(main).getByRole("button", { name: "New plan" }));
    await settle();
    expect(createPlan.mock.calls).toEqual([["New plan"]]);
    expect(tauri.calls.filter((c) => c.cmd === "holidays_year")).toEqual([]);
    expect(currentName()).toBe("New plan");
    expectTimeline();
    expect(slot("timeline")?.textContent).toBe("No items yet. Add one with + Task.");
  });

  it.each(["empty state", "sidebar"])("shows Creating… while a plan is created from the %s", async (from) => {
    await store(from === "sidebar" ? ["Alpha"] : [], { lastRegion: ZH });
    const registry = await opened();
    const createPlan = vi.spyOn(registry, "createPlan");
    render(shellOn(registry));
    await settle();
    const held = hold("holidays_year");
    const nav = screen.getByRole("navigation", { name: "Plans" });
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    fireEvent.click(from === "sidebar" ? newPlanIn(nav) : within(main).getByRole("button", { name: "New plan" }));
    await settle();
    const creating = screen.getAllByRole("button", { name: "Creating…" });
    expect(creating).toHaveLength(from === "sidebar" ? 1 : 2);
    creating.forEach((b) => {
      expect(b.hasAttribute("disabled")).toBe(true);
      expect(b.querySelector(".dim")?.textContent).toBe("Creating…");
    });
    creating.forEach((b) => fireEvent.click(b));
    expect(createPlan).toHaveBeenCalledTimes(1);
    await act(async () => {
      held.resolve({ days: [], fetchedAt: "2026-11-09T08:00:00Z", fromCache: false, coverage: [2020, 2030] });
    });
    await settle();
    expect(screen.queryAllByRole("button", { name: "Creating…" })).toEqual([]);
    expect(currentName()).toBe("New plan");
  });

  it("creates, trashes and restores plans", async () => {
    const s = await store(["Alpha", "Beta"], { lastRegion: ZH });
    const registry = await opened();
    const from = tauri.calls.length;
    render(shellOn(registry));
    await settle();
    expect(currentName()).toBe("Alpha");
    const nav = screen.getByRole("navigation", { name: "Plans" });
    fireEvent.click(newPlanIn(nav));
    await settle();
    await settle();
    const localAppends = tauri.calls.slice(from).filter((c) => c.cmd === "store_append" && xdoc(c) === "local");
    expect(localAppends).toHaveLength(1);
    expect(currentName()).toBe("New plan");
    const created = registry.plans().find((l) => !s.ids.includes(l.id));
    if (created === undefined) throw new Error("no new plan");
    const session = await registry.session(created.id);
    expect(session.view().plan.calendar.region).toEqual(ZH);

    fireEvent.click(within(entry("Alpha")).getByRole("button", { name: "Alpha" }));
    await settle();
    vi.spyOn(registry, "createPlan").mockRejectedValueOnce(new AppError("store.io", "Could not save the plan: disk full."));
    fireEvent.click(newPlanIn(nav));
    await settle();
    expect(toastNodes().filter((n) => n.textContent === "Could not save the plan: disk full.").map((n) => n.className)).toEqual(["toast bad"]);
    expect(registry.plans()).toHaveLength(3);
    expect(currentName()).toBe("Alpha");

    clearToasts();
    const trashPlan = vi.spyOn(registry, "trashPlan");
    const restorePlan = vi.spyOn(registry, "restorePlan");
    fireEvent.click(within(entry("Alpha")).getByRole("button", { name: "Move to Trash" }));
    expect(trashPlan.mock.calls).toEqual([[s.ids[0]]]);
    expect(toastTexts()).toEqual(["Moved “Alpha” to the Trash. Restore it from the Trash."]);
    const section = trashSection();
    if (section === null) throw new Error("no Trash section");
    expect(within(section).getByText("Alpha")).toBeTruthy();
    await settle();
    expect(currentName()).toBe("Beta");
    clearToasts();
    fireEvent.click(within(section).getByRole("button", { name: "Restore" }));
    expect(restorePlan.mock.calls).toEqual([[s.ids[0]]]);
    expect(toastTexts()).toEqual(["Restored “Alpha” from the Trash."]);
    expect(trashSection()).toBeNull();
    expect(within(nav).getByText("Alpha")).toBeTruthy();
  });

  it("falls to the empty state when the last plan is trashed", async () => {
    await store(["Alpha"]);
    const registry = await opened();
    render(shellOn(registry));
    await settle();
    fireEvent.click(within(entry("Alpha")).getByRole("button", { name: "Move to Trash" }));
    await settle();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getByRole("button", { name: "New plan" })).toBeTruthy();
    expect(screen.getByText("Local only")).toBeTruthy();
    expectNoTimeline();
    expect(slot("panel")).toBeNull();
  });

  async function remoteTrash(names: readonly string[]): Promise<{ registry: Registry; trashPlan: ReturnType<typeof vi.spyOn> }> {
    const s = await store(names);
    const registry = await opened();
    const trashPlan = vi.spyOn(registry, "trashPlan");
    render(shellOn(registry));
    await settle();
    expect(currentName()).toBe("Alpha");
    const local = await registry.doc("local");
    const r = new Y.Doc();
    Y.applyUpdate(r, Y.encodeStateAsUpdate(local.ydoc));
    const persist = async (id: string): Promise<PersistedDoc> => memoryDoc(id, r);
    const ix = await IndexDoc.open("local", "iphone", persist);
    ix.trashPlan(s.ids[0]);
    act(() => {
      Y.applyUpdate(local.ydoc, Y.encodeStateAsUpdate(r, Y.encodeStateVector(local.ydoc)));
    });
    await settle();
    await ix.close();
    return { registry, trashPlan };
  }

  it("follows a trash from another device", async () => {
    const { trashPlan } = await remoteTrash(["Alpha", "Beta"]);
    expect(currentName()).toBe("Beta");
    const section = trashSection();
    if (section === null) throw new Error("no Trash section");
    expect(within(section).getByText("Alpha")).toBeTruthy();
    expect(toastTexts()).toEqual(["“Alpha” was moved to the Trash on another device. Restore it from the Trash."]);
    expect(trashPlan).not.toHaveBeenCalled();
  });

  it("falls to the empty state when another device trashes the only plan", async () => {
    await remoteTrash(["Alpha"]);
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getByRole("button", { name: "New plan" })).toBeTruthy();
    expect(screen.getByText("Local only")).toBeTruthy();
    expectNoTimeline();
  });

  it("toasts only its own message for a local trash", async () => {
    await store(["Alpha", "Beta"]);
    const registry = await opened();
    render(shellOn(registry));
    await settle();
    fireEvent.click(within(entry("Alpha")).getByRole("button", { name: "Move to Trash" }));
    await settle();
    expect(toastTexts()).toEqual(["Moved “Alpha” to the Trash. Restore it from the Trash."]);
  });
});

describe("selection rule", () => {
  const listing = (id: string, trashed: boolean) => ({ id, name: id, trashed, loaded: false, space: null });

  it("picks a listed untrashed plan", () => {
    const plans = [listing("p1", true), listing("p2", false), listing("p3", false)];
    expect(pickPlan(plans, null)).toBe("p2");
    expect(pickPlan(plans, "zz000000000")).toBe("p2");
    expect(pickPlan(plans, "p1")).toBe("p2");
    expect(pickPlan(plans, "p3")).toBe("p3");
    expect(pickPlan([listing("p1", true), listing("p2", true), listing("p3", true)], "p2")).toBeNull();
  });

  it.each([{ view: "list" }, { view: "list", plan: "zz000000000" }, { view: "list", plan: "first" }])("opens Beta from %o", async (place) => {
    const s = await store(["Alpha", "Beta", "Gamma"], { trash: [0] });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place.plan === "first" ? { ...place, plan: s.ids[0] } : place));
    const registry = await opened();
    render(shellOn(registry));
    await settle();
    expect(currentName()).toBe("Beta");
    expect(slot("list")).not.toBeNull();
  });

  it("opens nothing when every plan is trashed", async () => {
    const s = await store(["Alpha", "Beta", "Gamma"], { trash: [0, 1, 2] });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: s.ids[1] }));
    const registry = await opened();
    const session = vi.spyOn(registry, "session");
    render(shellOn(registry));
    await settle();
    expect(session).not.toHaveBeenCalled();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getByRole("button", { name: "New plan" })).toBeTruthy();
  });

  it("moves on when the selected plan leaves the list", async () => {
    const s = await store(["Alpha", "Beta", "Gamma"], { trash: [0] });
    const registry = await opened();
    const notify = notifier(registry);
    render(shellOn(registry));
    await settle();
    expect(currentName()).toBe("Beta");
    const real = registry.plans.bind(registry);
    vi.spyOn(registry, "plans").mockImplementation(() => real().filter((l) => l.id !== s.ids[1]));
    act(() => notify());
    await settle();
    expect(currentName()).toBe("Gamma");
  });

  it("keeps a plan that is still arriving", async () => {
    const s = await store(["Alpha", "Beta", "Gamma"], { trash: [0] });
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: s.ids[1] }));
    const registry = await opened();
    vi.spyOn(registry, "session").mockRejectedValue(new AppError("plan.incomplete", INCOMPLETE));
    const notify = notifier(registry);
    render(shellOn(registry));
    await settle();
    act(() => notify());
    await settle();
    act(() => notify());
    await settle();
    expect(currentName()).toBe("Beta");
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
  });
});

describe("the panel slot", () => {
  const shown = async (t: TestSession): Promise<void> => {
    render(shellFor(t).ui);
    await settle();
  };
  const uiNow = (): [UiState, (patch: Partial<UiState>) => void] => {
    const results = vi.mocked(useUi).mock.results;
    const r = results[results.length - 1];
    if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
    return r.value;
  };
  const select = (id: string | null): void => act(() => uiNow()[1]({ selected: id }));
  const panel = (): HTMLElement => {
    const el = slot("panel");
    if (!(el instanceof HTMLElement)) throw new Error("no panel slot");
    return el;
  };
  const inPanel = () => within(panel());
  const input = (label: string): HTMLInputElement => {
    const el = inPanel().getByLabelText(label);
    if (!(el instanceof HTMLInputElement)) throw new Error(label + " is not an input");
    return el;
  };
  const button = (name: string): HTMLElement => inPanel().getByRole("button", { name });
  const click = (el: Element): void => {
    act(() => {
      fireEvent.click(el);
    });
  };

  it("drops nubs, handles and panel fields when the session turns read-only, and brings the nubs back", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    select("t3");
    expect(document.querySelectorAll(".nub").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".h").length).toBeGreaterThan(0);
    expect(panel().querySelectorAll("input, select").length).toBeGreaterThan(0);
    act(() => t.session.setReadOnly(true));
    expect(document.querySelectorAll(".nub")).toHaveLength(0);
    expect(document.querySelectorAll(".h")).toHaveLength(0);
    expect(panel().querySelectorAll("input, select")).toHaveLength(0);
    act(() => t.session.setReadOnly(false));
    expect(document.querySelectorAll(".nub").length).toBeGreaterThan(0);
  });

  describe("stale selection", () => {
    const SEED: SeedItem[] = [{ name: "A", start: "2026-11-10", dur: 3 }];

    it("lets go of a selected item the open plan no longer holds, and shows the plan", async () => {
      const t = await made(SEED);
      await shown(t);
      act(() => {
        t.session.apply({ t: "create", kind: "task", name: "New", parent: null, after: "A", start: "2026-11-12", dur: 1 });
      });
      const created = [...t.session.view().plan.items.keys()].find((id) => id !== "A");
      if (created === undefined) throw new Error("create added no item");
      select(created);
      expect(input("Name").value).toBe("New");
      clearToasts();
      act(() => {
        t.session.undo();
      });
      expect(t.session.view().plan.items.has(created)).toBe(false);
      expect(uiNow()[0].selected).toBeNull();
      expect(input("Plan name").value).toBe("Plan");
      expect(toastTexts().filter((x) => x !== null && /Trash/.test(x))).toEqual([]);
    });

    it("lets go of a selection that names no item of the open plan, without a toast", async () => {
      const t = await made(SEED);
      await shown(t);
      select("A");
      select("gone");
      expect(uiNow()[0].selected).toBeNull();
      expect(input("Plan name").value).toBe("Plan");
      expect(toastTexts()).toEqual([]);
    });

    it("keeps the selection when the open plan is picked again and drops it on a switch to another plan", async () => {
      const t = await made(SEED);
      const id = t.session.view().plan.id;
      const plans = () => [
        { id, name: "Plan", trashed: false, loaded: true, space: null },
        { id: "other", name: "Other", trashed: false, loaded: true, space: null },
      ];
      const session = (x: string): Promise<PlanSession> => (x === id ? Promise.resolve(t.session) : new Promise<PlanSession>(() => undefined));
      render(shellFor(t, { plans, session }).ui);
      await settle();
      expect(uiNow()[0].plan).toBe(id);
      select("A");
      click(within(entry("Plan")).getByRole("button", { name: "Plan" }));
      await settle();
      expect(uiNow()[0].plan).toBe(id);
      expect(uiNow()[0].selected).toBe("A");
      expect(input("Name").value).toBe("A");
      click(within(entry("Other")).getByRole("button", { name: "Other" }));
      expect(uiNow()[0].plan).toBe("other");
      expect(uiNow()[0].selected).toBeNull();
    });
  });

  describe("trashed selection (refinement 41)", () => {
    const SEED: SeedItem[] = [
      { name: "A", start: "2026-11-10", dur: 3 },
      { name: "B", start: "2026-11-16", dur: 2 },
    ];
    const remote = /was moved to the Trash on/;

    it("lets go of an item this device trashed, with only the trash's toast", async () => {
      const t = await made(SEED);
      await shown(t);
      select("A");
      const apply = vi.spyOn(t.session, "apply");
      click(button("Delete"));
      expect(t.session.authorOf("e:A")).toEqual({ dev: "mac", device: "Mac" });
      expect(uiNow()[0].selected).toBeNull();
      expect(input("Plan name").value).toBe("Plan");
      const done = apply.mock.results[0];
      if (done === undefined || done.type !== "return") throw new Error("Delete did not apply");
      expect(toastTexts()).toEqual([done.value.toast]);
      expect(toastTexts().filter((x) => x !== null && remote.test(x))).toEqual([]);
    });

    it("lets go of an item another device trashed, and says so", async () => {
      const t = await made(SEED);
      await shown(t);
      select("A");
      const p = await t.peer("iphone");
      sessions.push(p.session);
      act(() => {
        p.session.apply({ t: "trash", items: ["A"] });
        p.sync();
      });
      expect(t.session.authorOf("e:A")).toEqual({ dev: "iphone", device: "iPhone" });
      expect(uiNow()[0].selected).toBeNull();
      expect(toastTexts()).toEqual(["“A” was moved to the Trash on iPhone. Restore it from the Trash."]);
    });

    it("names the group another device trashed when a selected item inside it goes", async () => {
      const t = await made([
        { name: "G", kind: "group" },
        { name: "A", parent: "G", start: "2026-11-10", dur: 3 },
      ]);
      await shown(t);
      select("A");
      const p = await t.peer("iphone");
      sessions.push(p.session);
      act(() => {
        p.session.apply({ t: "trash", items: ["G"] });
        p.sync();
      });
      expect(uiNow()[0].selected).toBeNull();
      expect(toastTexts()).toEqual(["“G” was moved to the Trash on iPhone. Restore it from the Trash."]);
    });

    it("keeps the ghost row of an open delete choice selected", async () => {
      const { t, p } = await deleteClash();
      sessions.push(t.session, p.session);
      await shown(t);
      click(screen.getByRole("tab", { name: "List" }));
      const row = document.querySelector('[data-lrow="A"]');
      if (row === null) throw new Error("no ghost row for A");
      expect(row.classList.contains("ghost-row")).toBe(true);
      const at = { clientX: 10, clientY: 10, button: 0, pointerId: 1, pointerType: "mouse" };
      act(() => {
        fireEvent.pointerDown(row, at);
      });
      act(() => {
        fireEvent.pointerUp(row, { ...at, clientX: 11 });
      });
      expect(uiNow()[0].selected).toBe("A");
      expect(inPanel().getByLabelText("Name").textContent).toBe("Renamed");
      act(() => {
        p.session.apply({ t: "rename", item: "B", name: "Other" });
        p.sync();
      });
      expect(uiNow()[0].selected).toBe("A");
      expect(toastTexts().filter((x) => x !== null && remote.test(x))).toEqual([]);
    });
  });
});

describe("calendar dialog in the shell", () => {
  const calendarDialogs = (): HTMLElement[] => screen.queryAllByRole("dialog", { name: "Calendar · Plan" });

  it("opens from PlanPanel's Change calendar… and closes with Esc", async () => {
    const t = await made(MESA_SEED);
    render(shellFor(t).ui);
    await settle();
    const panel = slot("panel");
    if (!(panel instanceof HTMLElement)) throw new Error("no panel");
    fireEvent.click(within(panel).getByRole("button", { name: "Change calendar…" }));
    await settle();
    expect(lastUi().dialog).toEqual({ t: "calendar" });
    expect(calendarDialogs()).toHaveLength(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(calendarDialogs()[0], { key: "Escape" });
    await settle();
    expect(lastUi().dialog).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the same dialog from Choose region on a plan with no region", async () => {
    const t = await made(MESA_SEED);
    expect(t.session.view().plan.calendar.region).toBeNull();
    render(shellFor(t).ui);
    await settle();
    const head = document.querySelector(".plan-head");
    if (!(head instanceof HTMLElement)) throw new Error("no plan head");
    fireEvent.click(within(head).getByRole("button", { name: "Choose region" }));
    await settle();
    expect(lastUi().dialog).toEqual({ t: "calendar" });
    expect(calendarDialogs()).toHaveLength(1);
  });
});
