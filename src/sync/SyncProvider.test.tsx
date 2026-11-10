import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import App from "../App";
import { PlanDoc } from "../store/doc";
import { Registry } from "../store/registry";
import { fakeFactory, type FakeFactory, type FakeProvider } from "../test/fakeProvider";
import {
  appendedWrites,
  argsOf,
  fail,
  IX,
  itemNamed,
  ixAct,
  NOW,
  own,
  ip,
  remoteIndex,
  remotePlan,
  RESET_HINT,
  seedIndex,
  seedPlan,
  SP,
  SPACE,
  syncWorld,
  type SyncWorld,
} from "../test/syncWorld";
import { setScreen } from "../test/setup";
import { requestWindowClose, tauri } from "../test/tauriMock";
import { clearToasts } from "../ui/common/Toast";
import { useUi, type UiState } from "../ui/state";
import { SyncManager } from "./manager";
import type { ProviderFactory } from "./provider";
import { stopSync, syncPending, SyncProvider, useSyncState } from "./SyncProvider";
import { fixedClock } from "../services/clock";

const fake = vi.hoisted(() => ({ factory: null as ProviderFactory | null }));

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/api/window", () => import("../test/tauriMock"));
vi.mock("../services/updates", () => ({
  check: vi.fn(async () => null),
  restart: vi.fn(async () => undefined),
}));
vi.mock("./provider", async (importOriginal) => {
  const m = await importOriginal<typeof import("./provider")>();
  const yProviderFactory: ProviderFactory = (host, doc, ydoc, params) => {
    if (fake.factory === null) throw new Error("no fake provider factory");
    return fake.factory(host, doc, ydoc, params);
  };
  return { ...m, yProviderFactory };
});
vi.mock("../ui/state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../ui/state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const INCOMPLETE = "This plan has not arrived yet; it opens once it syncs.";
const REMOVED = "This device was removed from the space. Its plans are read-only. Export saves changes the server never received.";

let f: FakeFactory = fakeFactory();
const opened: Promise<Registry>[] = [];

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  f = fakeFactory();
  fake.factory = f;
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  await Promise.all(opened.splice(0).map(async (p) => (await p).close()));
  vi.useRealTimers();
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const click = async (el: Element): Promise<void> => {
  act(() => {
    fireEvent.click(el);
  });
  await settle();
};

function spyOpen(): () => Promise<Registry> {
  const real = Registry.open.bind(Registry);
  vi.spyOn(Registry, "open").mockImplementation((o) => {
    const p = real(o);
    opened.push(p);
    return p;
  });
  return () => {
    const p = opened[opened.length - 1];
    if (p === undefined) throw new Error("Registry.open was not called");
    return p;
  };
}

const calls = (cmd: string): number => tauri.calls.filter((c) => c.cmd === cmd).length;
const chip = (): HTMLElement => {
  const el = document.querySelector("header.toolbar .sync-chip");
  if (!(el instanceof HTMLElement)) throw new Error("no sync chip");
  return el;
};
const root = (): Element | null => document.querySelector(".app");
const sidebar = (): HTMLElement => screen.getByRole("navigation", { name: "Plans" });
const current = (): string | null => sidebar().querySelector('[aria-current="page"]')?.textContent ?? null;
const dialog = (): HTMLElement => screen.getByRole("dialog", { name: "Sync" });
const pane = (name: string): HTMLElement => screen.getByRole("tabpanel", { name });
const field = (rootEl: HTMLElement, label: string): HTMLInputElement => {
  const el = within(rootEl).getByLabelText(label);
  if (!(el instanceof HTMLInputElement)) throw new Error(label + " is not an input");
  return el;
};
const banner = (): HTMLElement | null => screen.queryByText(REMOVED)?.closest(".banner") ?? null;
const toasts = (): (string | null)[] => screen.queryAllByRole("status").map((e) => e.textContent);
const prov = (doc: string): FakeProvider => {
  const p = f.providers.get(doc);
  if (p === undefined) throw new Error("no provider for " + doc);
  return p;
};
const uiNow = (): [UiState, (patch: Partial<UiState>) => void] => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value;
};

const localIndex = (...entries: (readonly [string, unknown])[]): (readonly [string, unknown])[] => [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ...entries];

function spaceStore(w: SyncWorld, plans: readonly (readonly [string, string])[], o: { local?: readonly string[] } = {}): void {
  seedIndex(w.mem, "local", localIndex(...(o.local ?? []).map((id, i) => ixAct(`l-${id}`, [i === 0 ? "l-n" : `l-${(o.local ?? [])[i - 1]}`], [ip(id, false)]))));
  seedIndex(
    w.mem,
    IX,
    plans.map(([id], i) => ixAct(`s-${id}`, i === 0 ? [] : [`s-${plans[i - 1][0]}`], [ip(id, false)])),
  );
  plans.forEach(([id, name]) => seedPlan(w.mem, id, name, { items: ["A"] }));
}

describe("SyncProvider", () => {
  it("the chip reads Local only without a space", async () => {
    const w = syncWorld();
    w.status = () => ({ space: null, revoked: false });
    const factory = vi.fn(f);
    fake.factory = factory;
    spyOpen();
    render(<App />);
    await settle();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Local only" })).toBe(chip());
    expect(factory).not.toHaveBeenCalled();
  });

  it("setting up sync attaches without a remount", async () => {
    const w = syncWorld({ answers: { sync_setup: () => SPACE } });
    w.status = () => ({ space: null, revoked: false });
    const registry = spyOpen();
    render(<App />);
    await settle();
    const r = await registry();
    const attach = vi.spyOn(r, "attachSpace");
    const before = root();
    expect(chip().textContent).toBe("Local only");
    await click(chip());
    w.status = () => ({ space: SPACE, revoked: false });
    await click(within(pane("Set up sync")).getByRole("button", { name: "Create or join space" }));
    expect(chip().textContent).toBe("Syncing");
    expect(attach.mock.calls).toEqual([[SP]]);
    expect(root()).toBe(before);
  });

  it("an empty desktop joins without a remount", async () => {
    const w = syncWorld({ answers: { sync_pair_join: () => SPACE } });
    w.status = () => ({ space: null, revoked: false });
    spyOpen();
    render(<App />);
    await settle();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getAllByRole("button").map((b) => b.textContent)).toEqual(["New plan", "Import plan…", "Join with a code", "Set up sync"]);
    expect(chip().textContent).toBe("Local only");
    const before = root();
    await click(within(main).getByRole("button", { name: "Join with a code" }));
    expect(pane("Join with a code")).toBeTruthy();
    w.status = () => ({ space: SPACE, revoked: false });
    await click(within(pane("Join with a code")).getByRole("button", { name: "Join space" }));
    act(() => uiNow()[1]({ dialog: null }));
    act(() => remoteIndex(prov(IX), "s-S", [ip("S", false)]));
    await settle();
    expect(current()).toBe("Loading…");
    expect(within(main).getByText(INCOMPLETE)).toBeTruthy();
    act(() => {
      const s = prov("S");
      s.deliver(Y.encodeStateAsUpdate(seedPlan(null, "S", "Site")));
      s.emitStatus("connected");
      s.emitSynced(true);
    });
    await settle();
    expect(current()).toBe("Site");
    expect(document.querySelector('[data-slot="timeline"]')).not.toBeNull();
    expect(root()).toBe(before);
  });

  it.each([
    ["Join with a code", "Join space", "sync_pair_join"],
    ["Set up sync", "Create or join space", "sync_setup"],
  ])("a removed device comes back through %s", async (label, button, cmd) => {
    const w = syncWorld({ names: { P: "Launch" }, answers: { [cmd]: () => SPACE } });
    spaceStore(w, [["P", "Launch"]]);
    w.status = () => ({ space: SPACE, revoked: true });
    const registry = spyOpen();
    render(<App />);
    await settle();
    const r = await registry();
    await click(within(sidebar()).getByRole("button", { name: "Launch" }));
    const p = await r.session("P");
    expect(p.readOnly).toBe(true);
    expect(chip().textContent).toBe("Device removed");
    const before = root();
    const b = banner();
    if (b === null) throw new Error("no removed banner");
    await click(within(b).getByRole("button", { name: label }));
    w.status = () => ({ space: SPACE, revoked: false });
    await click(within(pane(label)).getByRole("button", { name: button }));
    expect(chip().textContent).not.toBe("Device removed");
    expect(banner()).toBeNull();
    expect(p.readOnly).toBe(false);
    const a = itemNamed(p, "A");
    const toastOf: string[] = [];
    act(() => {
      toastOf.push(p.apply({ t: "rename", item: a, name: "Kickoff" }).toast);
    });
    expect(toastOf).toHaveLength(1);
    expect(p.view().plan.items.get(a)?.name).toBe("Kickoff");
    expect(root()).toBe(before);
  });

  it("joining renames this device", async () => {
    const w = syncWorld({ names: { P: "Plan" }, answers: { sync_pair_join: (args) => ({ ...SPACE, deviceName: String(argsOf({ args }).deviceName) }) } });
    w.status = () => ({ space: null, revoked: false });
    seedIndex(w.mem, "local", localIndex(ixAct("l-P", ["l-n"], [ip("P", false)])));
    seedPlan(w.mem, "P", "Plan", { items: ["A"] });
    const registry = spyOpen();
    const managers: SyncManager[] = [];
    const start = SyncManager.prototype.start;
    vi.spyOn(SyncManager.prototype, "start").mockImplementation(function (this: SyncManager) {
      managers.push(this);
      return start.call(this);
    });
    render(<App />);
    await settle();
    const r = await registry();
    const p = await r.session("P");
    await click(chip());
    await click(within(dialog()).getByRole("tab", { name: "Join with a code" }));
    act(() => {
      fireEvent.change(field(pane("Join with a code"), "Device name"), { target: { value: "  iPad\t2 " } });
    });
    w.status = () => ({ space: { ...SPACE, deviceName: "iPad 2" }, revoked: false });
    const from = tauri.calls.length;
    await click(within(pane("Join with a code")).getByRole("button", { name: "Join space" }));
    expect(tauri.calls.filter((c) => c.cmd === "sync_pair_join").map((c) => argsOf(c).deviceName)).toEqual(["iPad 2"]);
    expect([r.devices().get("dev-A"), r.device.name]).toEqual(["iPad 2", "iPad 2"]);
    expect(p.history().map((h) => h.device)).toContain("iPad 2");
    const dn = (): [string, unknown][] => appendedWrites(tauri.calls.slice(from)).filter(([, x]) => x.u === "dn:dev-A").map(([doc, x]) => [doc, x.v]);
    expect(dn()).toEqual([
      ["local", "iPad 2"],
      [IX, "iPad 2"],
    ]);
    const m = managers[managers.length - 1];
    await act(async () => m.restart());
    await settle();
    expect(dn()).toEqual([
      ["local", "iPad 2"],
      [IX, "iPad 2"],
    ]);
  });

  it("a plan trashed on a peer leaves the open plan", async () => {
    const w = syncWorld({ names: { P: "Plan P", R: "Plan R" } });
    spaceStore(w, [
      ["P", "Plan P"],
      ["R", "Plan R"],
    ]);
    spyOpen();
    render(<App />);
    await settle();
    expect(current()).toBe("Plan P");
    const appends = vi.spyOn(PlanDoc.prototype, "append");
    act(() => remoteIndex(prov(IX), "t-P", [ip("P", true)]));
    await settle();
    expect(current()).toBe("Plan R");
    expect(toasts()).toEqual(["“Plan P” was moved to the Trash on another device. Restore it from the Trash."]);
    expect(within(screen.getByRole("region", { name: "Trash" })).getByText("Plan P")).toBeTruthy();
    act(() => remoteIndex(prov(IX), "t-R", [ip("R", true)]));
    await settle();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    expect(within(main).getAllByRole("button").map((b) => b.textContent)).toEqual(["New plan", "Import plan…", "Join with a code", "Set up sync"]);
    expect(chip()).toBeTruthy();
    expect(toasts()).toEqual(["“Plan P” was moved to the Trash on another device. Restore it from the Trash.", "“Plan R” was moved to the Trash on another device. Restore it from the Trash."]);
    expect(appends).not.toHaveBeenCalled();
  });

  it("an item trashed on a peer lets go", async () => {
    const w = syncWorld({ names: { P: "Plan P" } });
    spaceStore(w, [["P", "Plan P"]]);
    const registry = spyOpen();
    render(<App />);
    await settle();
    const r = await registry();
    const p = await r.session("P");
    const a = itemNamed(prov("P").ydoc, "A");
    act(() => uiNow()[1]({ selected: a }));
    await settle();
    const itemPanel = (): (string | null)[] => [...document.querySelectorAll('[data-slot="panel"] .panel')].filter((e) => e.querySelector(".kind") !== null).map((e) => e.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value ?? null);
    expect(itemPanel()).toEqual(["A"]);
    act(() => remoteIndex(prov(IX), "n-B", [own("dn:dev-B", "iPhone")]));
    await settle();
    const appends = vi.spyOn(PlanDoc.prototype, "append");
    act(() => remotePlan(prov("P"), "x-B", [own("e:" + a, { k: "task", t: true })]));
    await settle();
    expect(p.authorOf("e:" + a)).toEqual({ dev: "dev-B", device: "iPhone" });
    expect(uiNow()[0].selected).toBeNull();
    expect(itemPanel()).toEqual([]);
    expect(toasts()).toEqual(["“A” was moved to the Trash on iPhone. Restore it from the Trash."]);
    expect(appends).not.toHaveBeenCalled();
  });

  it("resetting sync, then joining, re-attaches", async () => {
    const message = "Could not read the sync state: invalid JSON";
    const w = syncWorld({ names: { P: "Plan P" }, answers: { sync_reset: () => null, sync_pair_join: () => SPACE } });
    seedIndex(w.mem, "local", localIndex(ixAct("l-P", ["l-n"], [ip("P", false)]), ixAct("l-Pt", ["l-P"], [ip("P", true)], "dev-A", "Move plan to Trash")));
    seedIndex(w.mem, IX, [ixAct("s-P", [], [ip("P", false)])]);
    seedPlan(w.mem, "P", "Plan P");
    w.status = fail({ code: "sync.io", message });
    spyOpen();
    render(<App />);
    await settle();
    const before = root();
    expect(within(sidebar()).getByText("Plan P")).toBeTruthy();
    expect(chip().textContent).toBe("Sync state on this device could not be read");
    await click(chip());
    expect(pane("Join with a code")).toBeTruthy();
    expect([...dialog().querySelectorAll(".sync-message.bad")].map((e) => e.textContent)).toEqual([message + RESET_HINT]);
    expect(within(dialog()).getByRole("button", { name: "Reset sync" })).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Try again" })).toBeTruthy();
    w.status = () => ({ space: null, revoked: false });
    const statusBefore = calls("sync_status");
    await click(within(dialog()).getByRole("button", { name: "Reset sync" }));
    expect([calls("sync_reset"), calls("sync_status") - statusBefore]).toEqual([1, 1]);
    expect(chip().textContent).toBe("Local only");
    expect(pane("Join with a code")).toBeTruthy();
    expect(within(sidebar()).getByText("Plan P")).toBeTruthy();
    w.status = () => ({ space: SPACE, revoked: false });
    await click(within(pane("Join with a code")).getByRole("button", { name: "Join space" }));
    expect(prov(IX).calls).toContain("connect");
    expect(tauri.calls.filter((c) => c.cmd === "store_load" && argsOf(c).doc === IX)).toHaveLength(1);
    expect(within(sidebar()).getAllByText("Plan P")).toHaveLength(1);
    expect(root()).toBe(before);
  });

  it("shows a failed reset under Reset sync and does not restart", async () => {
    const w = syncWorld({ answers: { sync_reset: fail({ code: "sync.io", message: "Could not set the sync state aside: Permission denied (os error 13)" }) } });
    w.status = fail({ code: "sync.io", message: "Could not read the sync state: invalid JSON" });
    spyOpen();
    render(<App />);
    await settle();
    await click(chip());
    const before = calls("sync_status");
    await click(within(dialog()).getByRole("button", { name: "Reset sync" }));
    expect([...dialog().querySelectorAll(".sync-error.bad")].map((e) => e.textContent)).toEqual(["Could not set the sync state aside: Permission denied (os error 13)"]);
    expect(calls("sync_status")).toBe(before);
  });

  it("unmounting stops the manager", async () => {
    const w = syncWorld({ names: { P: "Plan P" } });
    spaceStore(w, [["P", "Plan P"]]);
    spyOpen();
    const { unmount } = render(<App />);
    await settle();
    expect(f.all.length).toBeGreaterThan(0);
    unmount();
    await settle();
    expect(f.all.every((p) => p.calls.includes("destroy") || p.calls.includes("disconnect"))).toBe(true);
    const tickets = calls("sync_ticket");
    await settle();
    expect(calls("sync_ticket")).toBe(tickets);
  });

  it("stopSync stops a running manager and skips only a registry whose sync has not started", async () => {
    syncWorld();
    const r = await Registry.open({ clock: fixedClock("2026-11-08", NOW) });
    opened.push(Promise.resolve(r));
    expect(() => stopSync(r)).toThrow(new Error("stopSync: no SyncManager runs for this registry"));
    syncPending(r);
    expect(() => stopSync(r)).not.toThrow();
    const stop = vi.spyOn(SyncManager.prototype, "stop");
    const { unmount } = render(
      <SyncProvider registry={r} factory={f}>
        <p>inside</p>
      </SyncProvider>,
    );
    await settle();
    stopSync(r);
    expect(stop).toHaveBeenCalledTimes(1);
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(() => stopSync(r)).not.toThrow();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("closing the window before sync starts closes the registry", async () => {
    const w = syncWorld({ names: { P: "Plan P" } });
    spaceStore(w, [["P", "Plan P"]]);
    const registry = spyOpen();
    const stop = vi.spyOn(SyncManager.prototype, "stop");
    const start = vi.spyOn(SyncManager.prototype, "start");
    render(<App />);
    const closes: string[] = [];
    await act(async () => {
      const r = await registry();
      const close = r.close.bind(r);
      vi.spyOn(r, "close").mockImplementation(() => {
        closes.push(start.mock.calls.length === 0 ? "before start" : "after start");
        return close();
      });
      await requestWindowClose();
    });
    expect([closes, stop.mock.calls.length, toasts()]).toEqual([["before start"], 0, []]);
  });

  it("subscribes to the manager once across renders", async () => {
    const w = syncWorld();
    w.status = () => ({ space: null, revoked: false });
    const r = await Registry.open({ clock: fixedClock("2026-11-08", NOW) });
    opened.push(Promise.resolve(r));
    const subscribe = vi.spyOn(SyncManager.prototype, "subscribe");
    const Probe = (p: { n: number }) => {
      const { state } = useSyncState();
      return <p>{`render ${p.n} ${state.kind}`}</p>;
    };
    const tree = (n: number) => (
      <SyncProvider registry={r} factory={f}>
        <Probe n={n} />
      </SyncProvider>
    );
    const { rerender } = render(tree(0));
    await settle();
    rerender(tree(1));
    rerender(tree(2));
    await settle();
    expect([screen.getByText(/^render /).textContent, subscribe.mock.calls.length]).toEqual(["render 2 off", 1]);
  });

  it("closing the window stops sync before the registry closes", async () => {
    const w = syncWorld({ names: { P: "Plan P" } });
    spaceStore(w, [["P", "Plan P"]]);
    const registry = spyOpen();
    render(<App />);
    await settle();
    const r = await registry();
    const order: string[] = [];
    const stop = SyncManager.prototype.stop;
    vi.spyOn(SyncManager.prototype, "stop").mockImplementation(function (this: SyncManager) {
      order.push("stop");
      stop.call(this);
    });
    const close = r.close.bind(r);
    vi.spyOn(r, "close").mockImplementation(() => {
      order.push("close");
      return close();
    });
    await act(async () => {
      await requestWindowClose();
    });
    expect(order.slice(0, 2)).toEqual(["stop", "close"]);
  });
});

describe("SyncProvider on the phone", () => {
  beforeEach(() => {
    setScreen(390, 844);
  });

  const topBar = (): HTMLElement => {
    const el = document.querySelector(".phone-head");
    if (!(el instanceof HTMLElement)) throw new Error("no phone top bar");
    return el;
  };
  const compactChip = (): HTMLElement => {
    const el = topBar().querySelector(".sync-chip.chip-compact");
    if (!(el instanceof HTMLElement)) throw new Error("no compact sync chip");
    return el;
  };
  const plansSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Plans" });
  const openPlans = async (): Promise<HTMLElement> => {
    await click(within(topBar()).getByRole("button", { name: "Plans" }));
    return plansSheet();
  };
  const closePlans = async (): Promise<void> => {
    await click(within(plansSheet()).getByRole("button", { name: "Close" }));
  };
  const rowNames = (): (string | null)[] => [...plansSheet().querySelectorAll(".entries:not(section .entries) .entry-name")].map((e) => e.textContent);
  const planName = (): string | null => topBar().querySelector(".phone-plan-name")?.textContent ?? null;
  const emptyState = (): HTMLElement => {
    const el = document.querySelector(".empty-state");
    if (!(el instanceof HTMLElement)) throw new Error("no empty state");
    return el;
  };
  const emptyButtons = (): (string | null)[] =>
    within(emptyState())
      .getAllByRole("button")
      .map((b) => b.textContent);
  const closeSync = async (): Promise<void> => {
    await click(within(dialog()).getByRole("button", { name: "Close" }));
  };
  const EMPTY = ["New plan", "Import plan…", "Join with a code", "Set up sync"];

  it("joining shows the space's plans without a remount", async () => {
    const w = syncWorld({ platform: "ios", names: { L: "Alpha" }, answers: { sync_pair_join: () => SPACE } });
    w.status = () => ({ space: null, revoked: false });
    seedIndex(w.mem, "local", localIndex(ixAct("l-L", ["l-n"], [ip("L", false)])));
    seedPlan(w.mem, "L", "Alpha");
    spyOpen();
    render(<App />);
    await settle();
    const before = root();
    await openPlans();
    expect(rowNames()).toEqual(["Alpha"]);
    await click(within(plansSheet()).getByRole("button", { name: "Join with a code" }));
    expect(pane("Join with a code")).toBeTruthy();
    w.status = () => ({ space: SPACE, revoked: false });
    await click(within(pane("Join with a code")).getByRole("button", { name: "Join space" }));
    await closeSync();
    act(() => remoteIndex(prov(IX), "s-S", [ip("S", false)]));
    await settle();
    await openPlans();
    expect(rowNames()).toEqual(["Alpha", "Loading…"]);
    act(() => {
      const s = prov("S");
      s.deliver(Y.encodeStateAsUpdate(seedPlan(null, "S", "Site")));
      s.emitStatus("connected");
      s.emitSynced(true);
    });
    await settle();
    expect(rowNames()).toEqual(["Alpha", "Site"]);
    expect(root()).toBe(before);
  });

  it("a fresh iPhone joins from the empty state", async () => {
    const w = syncWorld({ platform: "ios", answers: { sync_pair_join: () => SPACE } });
    w.status = () => ({ space: null, revoked: false });
    spyOpen();
    render(<App />);
    await settle();
    const before = root();
    expect(emptyButtons()).toEqual(EMPTY);
    await openPlans();
    expect(within(plansSheet()).queryByRole("button", { name: "Set up sync" })).not.toBeNull();
    expect(within(plansSheet()).queryByRole("button", { name: "Join with a code" })).not.toBeNull();
    await closePlans();
    await click(within(emptyState()).getByRole("button", { name: "Join with a code" }));
    expect(pane("Join with a code")).toBeTruthy();
    w.status = () => ({ space: SPACE, revoked: false });
    await click(within(pane("Join with a code")).getByRole("button", { name: "Join space" }));
    await closeSync();
    act(() => remoteIndex(prov(IX), "s-S", [ip("S", false)]));
    act(() => remoteIndex(prov(IX), "s-T", [ip("T", false)]));
    await settle();
    expect(document.querySelector(".empty-state")).toBeNull();
    expect(screen.getByText(INCOMPLETE)).toBeTruthy();
    expect(uiNow()[0].plan).toBe("S");
    await openPlans();
    expect(rowNames()).toEqual(["Loading…", "Loading…"]);
    await closePlans();
    act(() => {
      const s = prov("S");
      s.deliver(Y.encodeStateAsUpdate(seedPlan(null, "S", "Site")));
      s.emitStatus("connected");
      s.emitSynced(true);
    });
    await settle();
    expect(planName()).toBe("Site");
    act(() => [...f.providers.values()].forEach((p) => {
      p.emitStatus("connected");
      p.emitSynced(true);
    }));
    await settle();
    expect(compactChip().getAttribute("aria-label")).toBe("Synced");
    await openPlans();
    expect(within(plansSheet()).queryByRole("button", { name: "Set up sync" })).toBeNull();
    expect(within(plansSheet()).queryByRole("button", { name: "Join with a code" })).toBeNull();
    expect(root()).toBe(before);
  });

  it("a plan trashed on a peer leaves the open phone plan", async () => {
    const w = syncWorld({ platform: "ios", names: { P: "Plan P", R: "Plan R" } });
    spaceStore(w, [
      ["P", "Plan P"],
      ["R", "Plan R"],
    ]);
    spyOpen();
    render(<App />);
    await settle();
    expect(planName()).toBe("Plan P");
    const appends = vi.spyOn(PlanDoc.prototype, "append");
    act(() => remoteIndex(prov(IX), "t-P", [ip("P", true)]));
    await settle();
    expect(planName()).toBe("Plan R");
    expect(toasts()).toEqual(["“Plan P” was moved to the Trash on another device. Restore it from the Trash."]);
    await openPlans();
    expect(within(within(plansSheet()).getByRole("region", { name: "Trash" })).getByText("Plan P")).toBeTruthy();
    await closePlans();
    act(() => remoteIndex(prov(IX), "t-R", [ip("R", true)]));
    await settle();
    expect(emptyButtons()).toEqual(EMPTY);
    expect(toasts()).toEqual(["“Plan P” was moved to the Trash on another device. Restore it from the Trash.", "“Plan R” was moved to the Trash on another device. Restore it from the Trash."]);
    expect(appends).not.toHaveBeenCalled();
  });

  it("an item trashed on a peer closes the sheet", async () => {
    const w = syncWorld({ platform: "ios", names: { P: "Plan P" } });
    spaceStore(w, [["P", "Plan P"]]);
    const registry = spyOpen();
    render(<App />);
    await settle();
    const r = await registry();
    const p = await r.session("P");
    const a = itemNamed(prov("P").ydoc, "A");
    act(() => uiNow()[1]({ selected: a }));
    await settle();
    expect(screen.getByRole("dialog", { name: "A" })).toBeTruthy();
    act(() => remoteIndex(prov(IX), "n-B", [own("dn:dev-B", "iPhone")]));
    await settle();
    const appends = vi.spyOn(PlanDoc.prototype, "append");
    act(() => remotePlan(prov("P"), "x-B", [own("e:" + a, { k: "task", t: true })]));
    await settle();
    expect(p.authorOf("e:" + a)).toEqual({ dev: "dev-B", device: "iPhone" });
    expect(uiNow()[0].selected).toBeNull();
    expect(screen.queryByRole("dialog", { name: "A" })).toBeNull();
    expect(toasts()).toEqual(["“A” was moved to the Trash on iPhone. Restore it from the Trash."]);
    expect(appends).not.toHaveBeenCalled();
  });

  it("resetting sync, then joining, re-attaches on the phone", async () => {
    const message = "Could not read the sync state: invalid JSON";
    const w = syncWorld({ platform: "ios", names: { P: "Plan P" }, answers: { sync_reset: () => null, sync_pair_join: () => SPACE } });
    seedIndex(w.mem, "local", localIndex(ixAct("l-P", ["l-n"], [ip("P", false)]), ixAct("l-Pt", ["l-P"], [ip("P", true)], "dev-A", "Move plan to Trash")));
    seedIndex(w.mem, IX, [ixAct("s-P", [], [ip("P", false)])]);
    seedPlan(w.mem, "P", "Plan P");
    w.status = fail({ code: "sync.io", message });
    const registry = spyOpen();
    render(<App />);
    await settle();
    const r = await registry();
    const before = root();
    await openPlans();
    expect(rowNames()).toEqual(["Plan P"]);
    await closePlans();
    const strip = document.querySelector(".phone-status .status-strip");
    if (!(strip instanceof HTMLElement)) throw new Error("no status strip");
    expect(strip.querySelector(".status-text")?.textContent).toBe("Sync state on this device could not be read");
    await click(strip);
    const status = screen.getByRole("dialog", { name: "Status" });
    await click(within(status).getByRole("button", { name: "Open sync" }));
    expect(screen.queryByRole("dialog", { name: "Status" })).toBeNull();
    expect(pane("Join with a code")).toBeTruthy();
    expect([...dialog().querySelectorAll(".sync-message.bad")].map((e) => e.textContent)).toEqual([message + RESET_HINT]);
    expect(within(dialog()).getByRole("button", { name: "Reset sync" })).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Try again" })).toBeTruthy();
    w.status = () => ({ space: null, revoked: false });
    await click(within(dialog()).getByRole("button", { name: "Reset sync" }));
    expect(calls("sync_reset")).toBe(1);
    expect(compactChip().getAttribute("aria-label")).toBe("Local only");
    expect(pane("Join with a code")).toBeTruthy();
    w.status = () => ({ space: SPACE, revoked: false });
    await click(within(pane("Join with a code")).getByRole("button", { name: "Join space" }));
    expect(prov(IX).calls).toContain("connect");
    expect(tauri.calls.filter((c) => c.cmd === "store_load" && argsOf(c).doc === IX)).toHaveLength(1);
    await closeSync();
    await openPlans();
    expect(rowNames()).toEqual(["Plan P"]);
    expect(r.plans().filter((l) => l.id === "P").map((l) => l.space)).toEqual([SP]);
    expect(root()).toBe(before);
  });
});
