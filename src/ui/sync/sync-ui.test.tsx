import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Refused } from "../../actions/intents";
import { fixedClock } from "../../services/clock";
import { AppError } from "../../services/ipc";
import { exportPlan } from "../../store/file";
import { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { chipText, SyncManager, type SyncState } from "../../sync/manager";
import { docName, SyncProvider } from "../../sync/SyncProvider";
import { fakeFactory, type FakeFactory, type FakeProvider } from "../../test/fakeProvider";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { shellFor } from "../../test/shell";
import { IX, itemNamed, ixAct, NOW, own, ip, RESET_HINT, seedIndex, seedPlan, seedSpace, SP, SPACE, syncWorld, TODAY, fail, argsOf, remoteIndex, type SyncWorld } from "../../test/syncWorld";
import { tauri, type Answer } from "../../test/tauriMock";
import { setScreen } from "../../test/setup";
import { IPAD, IPHONE } from "../../test/platform";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { exportFlow } from "../shell/fileFlows";
import { Shell } from "../shell/Shell";
import { SyncChip } from "../shell/SyncChip";
import { PLACE_KEY, UiContext, useUi, type UiState } from "../state";
import { RemovedBanner } from "./RemovedBanner";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../../store/file", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../store/file")>();
  return { ...m, exportPlan: vi.fn(async () => null) };
});
vi.mock("../shell/fileFlows", async (importOriginal) => {
  const m = await importOriginal<typeof import("../shell/fileFlows")>();
  return { ...m, exportFlow: vi.fn(m.exportFlow), importFlow: vi.fn(m.importFlow) };
});
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const RELOAD = "Load again from the server";
const NEEDS = "Needs a connection to the server.";
const INCOMPLETE = "This plan has not arrived yet; it opens once it syncs.";
const NO_KEY = "This device has no sync key. Join the space again with a pairing code.";
const NOT_CONFIGURED = "Sync is not set up on the server: its owner runs wrangler secret put SETUP_SECRET.";
const TOO_LARGE_HELD = "This plan is too large to sync. It keeps working on this device; export it to keep a copy.";
const TOO_LARGE_MISSING = "This plan is too large to send to this device. Export it on a device that has it.";
const REJECTED = "The server refused a change from this device. Update WebBoard, then try again.";
const STORE = "The server could not store a change from this device. Try again.";
const REMOVED = "This device was removed from the space. Its plans are read-only. Export saves changes the server never received.";
const NAMES = { P: "Launch", L: "Alpha", P2: "Pod" };

const registries: Registry[] = [];
const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  vi.mocked(exportFlow).mockClear();
  vi.mocked(exportPlan).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(registries.splice(0).map((r) => r.close()));
  vi.useRealTimers();
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const click = async (el: Element): Promise<void> => {
  act(() => {
    fireEvent.click(el);
  });
  await settle();
};

const calls = (cmd: string): number => tauri.calls.filter((c) => c.cmd === cmd).length;

const uiNow = (): [UiState, (patch: Partial<UiState>) => void] => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value;
};

const toolbar = (): HTMLElement => {
  const bar = document.querySelector("header.toolbar");
  if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
  return bar;
};

const chip = (): HTMLElement => {
  const el = toolbar().querySelector(".sync-chip");
  if (!(el instanceof HTMLElement)) throw new Error("no sync chip");
  return el;
};

const dialog = (): HTMLElement => screen.getByRole("dialog", { name: "Sync" });
const inDialog = () => within(dialog());
const pane = (name: string): HTMLElement => screen.getByRole("tabpanel", { name });
const field = (root: HTMLElement, label: string): HTMLInputElement => {
  const el = within(root).getByLabelText(label);
  if (!(el instanceof HTMLInputElement)) throw new Error(label + " is not an input");
  return el;
};
const type = (el: HTMLInputElement, value: string): void => {
  act(() => {
    fireEvent.change(el, { target: { value } });
  });
};
const toasts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);
const badToasts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).filter((e) => e.classList.contains("bad")).map((e) => e.textContent);
const errorText = (root: HTMLElement): (string | null)[] => [...root.querySelectorAll(".sync-error.bad")].map((e) => e.textContent);
const messageText = (): (string | null)[] => [...dialog().querySelectorAll(".sync-message.bad")].map((e) => e.textContent);
const buttonNames = (root: HTMLElement, names: readonly string[]): string[] =>
  within(root)
    .queryAllByRole("button")
    .map((b) => b.textContent ?? "")
    .filter((n) => names.includes(n));
const ACTION_NAMES = ["Export…", "Reset sync", "Try again", RELOAD, "Open sync"];

const sidebar = (): HTMLElement => screen.getByRole("navigation", { name: "Plans" });
const entry = (name: string): HTMLElement => {
  const li = within(sidebar()).getByText(name).closest("li");
  if (li === null) throw new Error("no entry " + name);
  return li;
};
const mainArea = (): HTMLElement => {
  const el = document.querySelector("main.main");
  if (!(el instanceof HTMLElement)) throw new Error("no main");
  return el;
};

const place = (plan: string): void => window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan, view: "timeline", zoom: "W", collapsed: [] }));

const syncAll = (f: FakeFactory): void => {
  act(() => {
    [...f.providers.values()].forEach((p) => {
      p.emitStatus("connected");
      p.emitSynced(true);
    });
  });
};

const prov = (f: FakeFactory, doc: string): FakeProvider => {
  const p = f.providers.get(doc);
  if (p === undefined) throw new Error("no provider for " + doc);
  return p;
};

async function mounted(w: SyncWorld, o: { factory?: FakeFactory } = {}): Promise<{ r: Registry; f: FakeFactory }> {
  const r = await Registry.open({ clock: fixedClock(TODAY, NOW) });
  registries.push(r);
  const f = o.factory ?? fakeFactory();
  const el = withSync(<Shell registry={r} clock={fixedClock(TODAY, NOW)} />, { factory: f });
  tauri.answers.sync_status = () => w.status();
  render(el);
  await settle();
  return { r, f };
}

async function spaceWorld(o: Parameters<typeof seedSpace>[1] & { answers?: Record<string, Answer> } = {}): Promise<SyncWorld> {
  const w = syncWorld({ names: NAMES, answers: o.answers });
  seedSpace(w, o);
  return w;
}

const fresh = async (): Promise<void> => {
  cleanup();
  vi.restoreAllMocks();
  await Promise.all(registries.splice(0).map((r) => r.close()));
};

const openChip = async (): Promise<void> => {
  await click(chip());
};

const stubState = (s: SyncState): void => {
  vi.spyOn(SyncManager.prototype, "state").mockReturnValue(s);
};

const errorState = (code: Extract<SyncState, { kind: "error" }>["code"], o: Partial<Extract<SyncState, { kind: "error" }>> = {}): SyncState => ({
  kind: "error",
  code,
  since: NOW,
  doc: null,
  waiting: 0,
  message: null,
  cause: null,
  op: null,
  ...o,
});

async function stubShell(over: Parameters<typeof shellFor>[1] = {}): Promise<{ t: TestSession; registry: ReturnType<typeof shellFor>["registry"] }> {
  const t = await testSession(MESA_SEED);
  sessions.push(t.session);
  tauri.answers.sync_devices = () => [];
  const { ui, registry } = shellFor(t, over);
  render(withSync(ui));
  await settle();
  return { t, registry };
}

describe("the sync chip", () => {
  it("the chip is a button in every state", async () => {
    const states: [SyncState, string, boolean][] = [
      [{ kind: "off" }, "chip-cyan", false],
      [{ kind: "synced" }, "chip-cyan", true],
      [{ kind: "syncing" }, "chip-cyan", false],
      [{ kind: "receiving" }, "chip-cyan", false],
      [{ kind: "offline", waiting: 0 }, "chip-amber", false],
      [{ kind: "offline", waiting: 3 }, "chip-amber", false],
      [errorState("revoked"), "chip-magenta", false],
      [errorState("unauthorized"), "chip-magenta", false],
      [errorState("keychain"), "chip-magenta", false],
      [errorState("not-configured"), "chip-magenta", false],
      [errorState("failed", { message: "sync_ticket: channel closed" }), "chip-magenta", false],
      [errorState("limited"), "chip-magenta", false],
      [errorState("unreachable"), "chip-magenta", false],
      [errorState("too-large", { doc: IX }), "chip-magenta", false],
      [errorState("local-failed"), "chip-magenta", false],
    ];
    for (const [s, tone, live] of states) {
      stubState(s);
      const { registry } = await stubShell();
      const name = chipText(s, docName(registry));
      const button = within(toolbar()).getByRole("button", { name });
      expect([name, button.classList.contains(tone), button.querySelector(".dot-live") !== null]).toEqual([name, true, live]);
      await fresh();
    }
    stubState({ kind: "off" });
    await stubShell();
    await openChip();
    expect(uiNow()[0].dialog).toEqual({ t: "sync", pane: null });
    expect(pane("Set up sync")).toBeTruthy();
    await fresh();
    vi.restoreAllMocks();
    stubState({ kind: "synced" });
    await stubShell();
    await openChip();
    expect(pane("Devices")).toBeTruthy();
  });

  it("the chip opens Join when this device is out of the space", async () => {
    const w = await spaceWorld();
    w.ticket = fail({ code: "keychain.missing", message: NO_KEY });
    await mounted(w);
    expect(chip().textContent).toBe("Not in the space — set up sync again");
    await openChip();
    expect(pane("Join with a code")).toBeTruthy();
    expect(messageText()).toEqual([NO_KEY]);
    expect(calls("sync_devices")).toBe(0);
    await fresh();
    const v = await spaceWorld();
    v.status = () => ({ space: SPACE, revoked: true });
    await mounted(v);
    expect(chip().textContent).toBe("Device removed");
    await openChip();
    expect(pane("Join with a code")).toBeTruthy();
    expect(calls("sync_devices")).toBe(0);
  });

  it("useSyncState needs a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<SyncChip />)).toThrow(new Error("useSyncState needs a SyncProvider."));
  });
});

describe("the sync dialog's status", () => {
  it("a failed sync_status shows in the dialog", async () => {
    const w = syncWorld({ names: NAMES });
    const message = "Could not read the sync state: invalid JSON";
    w.status = fail({ code: "sync.io", message });
    await mounted(w);
    expect(within(toolbar()).getByRole("button", { name: "Sync state on this device could not be read" })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual([message + RESET_HINT]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Reset sync", "Try again"]);
    const before = calls("sync_status");
    await click(inDialog().getByRole("button", { name: "Try again" }));
    expect(calls("sync_status")).toBe(before + 1);
    await settle();
    expect(badToasts()).toEqual([]);
  });

  it("shows a keychain error with Try again, which restarts once", async () => {
    const w = await spaceWorld();
    const message = "The keychain refused access: errSecAuthFailed.";
    w.ticket = fail({ code: "keychain.io", message });
    await mounted(w);
    await openChip();
    expect(messageText()).toEqual([message]);
    const restart = vi.spyOn(SyncManager.prototype, "restart");
    await click(inDialog().getByRole("button", { name: "Try again" }));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("revoke save failure shows", async () => {
    const message = "Could not save the sync state: Permission denied (os error 13)";
    const w = await spaceWorld({ answers: { sync_mark_revoked: fail({ code: "sync.io", message }) } });
    const { f } = await mounted(w);
    act(() => prov(f, IX).closeWith(4403, "Device removed"));
    await settle();
    expect(chip().textContent).toBe("Device removed");
    await openChip();
    expect(messageText()).toEqual([message]);
    expect(dialog().querySelector(".sync-message.bad")?.compareDocumentPosition(dialog().querySelector('[role="tablist"]') as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("an unconfigured server names the fix", async () => {
    const w = await spaceWorld();
    w.ticket = fail({ code: "sync.not_configured", message: NOT_CONFIGURED });
    await mounted(w);
    expect(within(toolbar()).getByRole("button", { name: "Sync is not set up on the server" })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual([NOT_CONFIGURED]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Try again"]);
  });

  it("an unmapped failure offers retry", async () => {
    const w = await spaceWorld();
    w.ticket = (doc) => {
      if (doc === IX) throw { code: "ipc.failed", message: "sync_ticket: channel closed" };
      return { ticket: "tk", expiresAt: 0 };
    };
    await mounted(w);
    expect(within(toolbar()).getByRole("button", { name: "Sync stopped: sync_ticket: channel closed" })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual(["sync_ticket: channel closed"]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Try again"]);
    const restart = vi.spyOn(SyncManager.prototype, "restart");
    await click(inDialog().getByRole("button", { name: "Try again" }));
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe("the sync panes", () => {
  const offWorld = (answers: Record<string, Answer> = {}): SyncWorld => {
    const w = syncWorld({ names: NAMES, answers });
    w.status = () => ({ space: null, revoked: false });
    seedIndex(w.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("l-L", ["l-n"], [ip("L", false)])]);
    seedPlan(w.mem, "L", "Alpha");
    return w;
  };
  const openPane = async (name: string): Promise<HTMLElement> => {
    await openChip();
    const tab = within(dialog()).getByRole("tab", { name });
    if (tab.getAttribute("aria-selected") !== "true") await click(tab);
    return pane(name);
  };
  const button = (root: HTMLElement, name: string): HTMLElement => within(root).getByRole("button", { name });

  it("after setup the secret input is empty and is never stored", async () => {
    const w = offWorld({ sync_setup: () => SPACE });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await mounted(w);
    const setup = await openPane("Set up sync");
    type(field(setup, "Setup secret"), "s3cr3t");
    expect(field(setup, "Setup secret").type).toBe("password");
    expect(field(setup, "Setup secret").getAttribute("autocomplete")).toBe("off");
    w.status = () => ({ space: SPACE, revoked: false });
    await click(button(setup, "Create or join space"));
    expect(field(pane("Set up sync"), "Setup secret").value).toBe("");
    expect(tauri.calls.filter((c) => c.cmd === "sync_setup").map(argsOf)).toEqual([{ server: "https://webboard.rokass.org", secret: "s3cr3t", deviceName: "Mac" }]);
    const stored = [...setItem.mock.calls.map((c) => JSON.stringify(c)), ...tauri.calls.filter((c) => c.cmd === "settings_write").map((c) => JSON.stringify(c.args))];
    expect(stored.filter((s) => s.includes("s3cr3t"))).toEqual([]);
  });

  it.each([
    ["Join with a code", "Join space", "sync_pair_join", { code: "sync.bad_code", message: "The pairing code is wrong, used or expired. Show a new code on a device in the space." }],
    ["Join with a code", "Join space", "sync_pair_join", { code: "sync.rate_limited", message: "Try again in 10 minutes." }],
    ["Add a device", "Show pairing code", "sync_pair_code", { code: "sync.rate_limited", message: "Three pairing codes are already live. Use one or wait until one expires. Try again in 10 minutes." }],
    ["Set up sync", "Create or join space", "sync_setup", { code: "sync.unauthorized", message: "The setup secret is not correct." }],
  ])("the %s pane shows a rejected %s inline", async (name, label, cmd, e) => {
    const w = offWorld({ [cmd]: fail(e) });
    await mounted(w);
    const p = await openPane(name);
    if (name === "Set up sync") type(field(p, "Setup secret"), "s3cr3t");
    await click(button(p, label));
    expect(errorText(pane(name))).toEqual([e.message]);
    expect(button(pane(name), label).hasAttribute("disabled")).toBe(false);
    if (name === "Set up sync") expect(field(pane(name), "Setup secret").value).toBe("s3cr3t");
  });

  it("a revoked Devices answer marks this device removed", async () => {
    const w = await spaceWorld({ answers: { sync_devices: fail({ code: "sync.revoked", message: "This device was removed from the space." }) } });
    const { f } = await mounted(w);
    syncAll(f);
    const mark = vi.spyOn(SyncManager.prototype, "markRevoked");
    const p = await openPane("Devices");
    expect(errorText(p)).toEqual(["This device was removed from the space."]);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(calls("sync_mark_revoked")).toBe(1);
    expect(chip().textContent).toBe("Device removed");
    expect(screen.getByText(REMOVED)).toBeTruthy();
  });

  it("the device name is checked before any request", async () => {
    const w = offWorld({ sync_setup: () => SPACE, sync_pair_join: () => SPACE });
    await mounted(w);
    const setup = await openPane("Set up sync");
    type(field(setup, "Device name"), "   ");
    await click(button(setup, "Create or join space"));
    expect(errorText(pane("Set up sync"))).toEqual(["The name is empty. Type at least one character."]);
    expect(button(pane("Set up sync"), "Create or join space").hasAttribute("disabled")).toBe(false);
    expect(calls("sync_setup")).toBe(0);
    await click(within(dialog()).getByRole("tab", { name: "Join with a code" }));
    const join = pane("Join with a code");
    type(field(join, "Device name"), "   ");
    await click(button(join, "Join space"));
    expect(errorText(pane("Join with a code"))).toEqual(["The name is empty. Type at least one character."]);
    expect(calls("sync_pair_join")).toBe(0);
    type(field(pane("Join with a code"), "Device name"), "  iPad\t2 ");
    await click(button(pane("Join with a code"), "Join space"));
    expect(tauri.calls.filter((c) => c.cmd === "sync_pair_join").map((c) => argsOf(c).deviceName)).toEqual(["iPad 2"]);
  });

  it("the server address is prefilled and checked", async () => {
    const w = offWorld({ sync_setup: fail({ code: "sync.host", message: "This build syncs only with webboard.rokass.org." }) });
    await mounted(w);
    const setup = await openPane("Set up sync");
    expect(field(setup, "Server address").value).toBe("https://webboard.rokass.org");
    await click(within(dialog()).getByRole("tab", { name: "Join with a code" }));
    expect(field(pane("Join with a code"), "Server address").value).toBe("https://webboard.rokass.org");
    await click(within(dialog()).getByRole("tab", { name: "Set up sync" }));
    type(field(pane("Set up sync"), "Server address"), "https://example.org");
    await click(button(pane("Set up sync"), "Create or join space"));
    expect(errorText(pane("Set up sync"))).toEqual(["This build syncs only with webboard.rokass.org."]);
    expect(button(pane("Set up sync"), "Create or join space").hasAttribute("disabled")).toBe(false);
    expect(field(pane("Set up sync"), "Server address").value).toBe("https://example.org");
  });

  it("the device name is prefilled", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "screen");
    const setScreen = (width: number, height: number): void => {
      Object.defineProperty(window, "screen", { configurable: true, value: { width, height } });
    };
    try {
      for (const [w0, h0, want, platform] of [
        [430, 932, "iPhone", IPHONE],
        [744, 1133, "iPad", IPAD],
      ] as const) {
        const w = syncWorld({ platform });
        w.status = () => ({ space: null, revoked: false });
        setScreen(w0, h0);
        const r = await Registry.open({ clock: fixedClock(TODAY, NOW) });
        registries.push(r);
        setScreen(1440, 900);
        const el = withSync(<Shell registry={r} clock={fixedClock(TODAY, NOW)} />, { factory: fakeFactory() });
        render(el);
        await settle();
        const join = await openPane("Join with a code");
        expect(field(join, "Device name").value).toBe(want);
        await click(within(dialog()).getByRole("tab", { name: "Set up sync" }));
        expect(field(pane("Set up sync"), "Device name").value).toBe(want);
        await fresh();
      }
    } finally {
      if (original !== undefined) Object.defineProperty(window, "screen", original);
    }
  });

  it("removing a device refreshes the list", async () => {
    let list = [
      { id: "dev-A", name: "Mac", createdAt: 0, lastSeenAt: NOW, current: true },
      { id: "dev-I", name: "iPad", createdAt: 0, lastSeenAt: NOW, current: false },
    ];
    const w = await spaceWorld({
      answers: {
        sync_devices: () => list,
        sync_remove_device: () => {
          list = list.filter((d) => d.id !== "dev-I");
          return null;
        },
      },
    });
    const { f } = await mounted(w);
    syncAll(f);
    const p = await openPane("Devices");
    await click(within(p).getByRole("button", { name: "Remove" }));
    await click(within(pane("Devices")).getByRole("button", { name: "Remove device" }));
    expect(tauri.calls.filter((c) => c.cmd === "sync_remove_device").map(argsOf)).toEqual([{ id: "dev-I" }]);
    expect(calls("sync_devices")).toBe(2);
    expect(within(pane("Devices")).queryByText("iPad")).toBeNull();
    expect(toasts()).toEqual(["iPad removed"]);
  });

  it("a failed removal closes the question, refreshes the list and keeps the error", async () => {
    const internal = "Server answered 500 internal: The device was removed, but 1 plan was not told to close its connections. The server tries again in a minute, then less often, at least once an hour; until then the device keeps syncing that plan while it stays connected.";
    let list = [
      { id: "dev-A", name: "Mac", createdAt: 0, lastSeenAt: NOW, current: true },
      { id: "dev-I", name: "iPad", createdAt: 0, lastSeenAt: NOW, current: false },
    ];
    const w = await spaceWorld({
      answers: {
        sync_devices: () => list,
        sync_remove_device: () => {
          list = list.filter((d) => d.id !== "dev-I");
          throw { code: "sync.http", message: internal };
        },
      },
    });
    const { f } = await mounted(w);
    syncAll(f);
    const p = await openPane("Devices");
    await click(within(p).getByRole("button", { name: "Remove" }));
    await click(within(pane("Devices")).getByRole("button", { name: "Remove device" }));
    expect(calls("sync_remove_device")).toBe(1);
    expect(calls("sync_devices")).toBe(2);
    expect(within(pane("Devices")).queryByText("iPad")).toBeNull();
    expect(within(pane("Devices")).queryByRole("button", { name: "Remove device" })).toBeNull();
    expect(errorText(pane("Devices"))).toEqual([internal]);
    expect(toasts()).toEqual([]);
  });

  it("a failed removal whose refresh fails too shows both errors, the removal's first", async () => {
    const internal = "Server answered 500 internal: The device was removed, but 1 plan was not told to close its connections. The server tries again in a minute, then less often, at least once an hour; until then the device keeps syncing that plan while it stays connected.";
    const unreachable = "Could not reach https://webboard.rokass.org: connection reset.";
    const list = [
      { id: "dev-A", name: "Mac", createdAt: 0, lastSeenAt: NOW, current: true },
      { id: "dev-I", name: "iPad", createdAt: 0, lastSeenAt: NOW, current: false },
    ];
    let listed = 0;
    const w = await spaceWorld({
      answers: {
        sync_devices: () => {
          listed += 1;
          if (listed > 1) throw { code: "sync.unreachable", message: unreachable };
          return list;
        },
        sync_remove_device: () => {
          throw { code: "sync.http", message: internal };
        },
      },
    });
    const { f } = await mounted(w);
    syncAll(f);
    const p = await openPane("Devices");
    await click(within(p).getByRole("button", { name: "Remove" }));
    await click(within(pane("Devices")).getByRole("button", { name: "Remove device" }));
    expect(calls("sync_remove_device")).toBe(1);
    expect(calls("sync_devices")).toBe(2);
    expect(within(pane("Devices")).queryByRole("button", { name: "Remove device" })).toBeNull();
    expect(errorText(pane("Devices"))).toEqual([internal, unreachable]);
    expect(toasts()).toEqual([]);
  });

  it("removing asks first", async () => {
    const w = await spaceWorld({
      answers: {
        sync_devices: () => [
          { id: "dev-A", name: "Mac", createdAt: 0, lastSeenAt: NOW, current: true },
          { id: "dev-I", name: "iPad", createdAt: 0, lastSeenAt: NOW, current: false },
        ],
      },
    });
    const { f } = await mounted(w);
    syncAll(f);
    const p = await openPane("Devices");
    await click(within(p).getByRole("button", { name: "Remove" }));
    expect(within(pane("Devices")).getByText("Remove iPad? It stops syncing at once and keeps its plans read-only.")).toBeTruthy();
    expect(within(pane("Devices")).getByRole("button", { name: "Remove device" })).toBeTruthy();
    await click(within(pane("Devices")).getByRole("button", { name: "Cancel" }));
    expect(calls("sync_remove_device")).toBe(0);
    expect(within(pane("Devices")).getByText("iPad")).toBeTruthy();
  });

  it("the devices list marks this device and last seen", async () => {
    const w = await spaceWorld({
      answers: {
        sync_devices: () => [
          { id: "dev-A", name: "Mac", createdAt: 0, lastSeenAt: NOW, current: true },
          { id: "dev-I", name: "iPad", createdAt: 0, lastSeenAt: NOW, current: false },
        ],
      },
    });
    const { f } = await mounted(w);
    syncAll(f);
    const p = await openPane("Devices");
    const rows = [...p.querySelectorAll(".sync-device")].map((li) => [li.textContent, li.querySelector(".sync-remove.danger") !== null]);
    expect(rows).toEqual([
      ["MacThis device", false],
      ["iPadLast seen 8 Nov 14:02Remove", true],
    ]);
  });

  it("a device not in a space says so", async () => {
    const notJoined = { code: "sync.not_joined", message: "This device is not in a space yet. Set up sync or join with a code." };
    const w = offWorld({ sync_devices: fail(notJoined), sync_pair_code: fail(notJoined) });
    await mounted(w);
    const devices = await openPane("Devices");
    expect(errorText(devices)).toEqual([notJoined.message]);
    await click(within(dialog()).getByRole("tab", { name: "Add a device" }));
    await click(button(pane("Add a device"), "Show pairing code"));
    expect(errorText(pane("Add a device"))).toEqual([notJoined.message]);
    expect(button(pane("Add a device"), "Show pairing code").hasAttribute("disabled")).toBe(false);
    expect(calls("sync_ticket")).toBe(0);
  });

  it("the pairing pane shows the code and its expiry", async () => {
    const expiresAt = new Date(2026, 10, 8, 14, 12).getTime();
    const w = await spaceWorld({ answers: { sync_pair_code: () => ({ code: "ABCD-EFGH", expiresAt }) } });
    const { f } = await mounted(w);
    syncAll(f);
    const p = await openPane("Add a device");
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: NOW });
    act(() => {
      fireEvent.click(button(p, "Show pairing code"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const shown = pane("Add a device");
    expect(["ABCD-EFGH", "Expires at 14:12", "Single use. Enter it on the new device."].map((t) => within(shown).queryByText(t) !== null)).toEqual([true, true, true]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(expiresAt - NOW);
    });
    expect(within(pane("Add a device")).getByText("Code expired")).toBeTruthy();
    act(() => {
      fireEvent.click(button(pane("Add a device"), "Show a new code"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls("sync_pair_code")).toBe(2);
    vi.useRealTimers();
  });

  it("setting up and joining toast", async () => {
    const w = offWorld({ sync_setup: () => SPACE, sync_pair_join: () => SPACE });
    await mounted(w);
    const restart = vi.spyOn(SyncManager.prototype, "restart");
    const setup = await openPane("Set up sync");
    await click(button(setup, "Create or join space"));
    expect(toasts()).toEqual(["Sync set up"]);
    expect(restart).toHaveBeenCalledTimes(1);
    clearToasts();
    await click(within(dialog()).getByRole("tab", { name: "Join with a code" }));
    await click(button(pane("Join with a code"), "Join space"));
    expect(toasts()).toEqual(["Joined the space"]);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Set up sync", "Create or join space", "sync_setup"],
    ["Join with a code", "Join space", "sync_pair_join"],
  ])("the %s pane restarts sync after a join that failed once sync.json named the new space", async (name, label, cmd) => {
    const message = "Joined space sp000000000, but the device token of space sp111111111 could not be removed: errSecAuthFailed.";
    const w = offWorld({
      [cmd]: () => {
        w.status = () => ({ space: SPACE, revoked: false });
        throw { code: "keychain.io", message };
      },
    });
    await mounted(w);
    const restart = vi.spyOn(SyncManager.prototype, "restart");
    const p = await openPane(name);
    await click(button(p, label));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(errorText(pane(name))).toEqual([message]);
    expect(toasts()).toEqual([]);
  });

  it("palette joins with no plan open", async () => {
    const w = syncWorld();
    w.status = () => ({ space: null, revoked: false });
    await mounted(w);
    expect(document.querySelector(".empty-state")).not.toBeNull();
    act(() => {
      fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    });
    const palette = screen.getByRole("dialog");
    act(() => {
      fireEvent.change(within(palette).getByRole("textbox", { name: "Command" }), { target: { value: "Join with" } });
    });
    act(() => {
      fireEvent.keyDown(within(palette).getByRole("textbox", { name: "Command" }), { key: "Enter" });
    });
    await settle();
    expect(pane("Join with a code")).toBeTruthy();
  });
});

describe("removal and the space", () => {
  const select = (id: string | null): void => act(() => uiNow()[1]({ selected: id }));
  const panel = (): HTMLElement => {
    const el = document.querySelector('[data-slot="panel"]');
    if (!(el instanceof HTMLElement)) throw new Error("no panel slot");
    return el;
  };

  it("read-only after removal", async () => {
    const w = await spaceWorld({ link: true });
    const { r, f } = await mounted(w);
    syncAll(f);
    await settle();
    await click(within(entry("Launch")).getByRole("button", { name: "Launch" }));
    const s = await r.session("P");
    const a = itemNamed(s, "A");
    select(a);
    await settle();
    expect(document.querySelectorAll(".nub").length).toBeGreaterThan(0);
    expect(panel().querySelector("input")).not.toBeNull();
    act(() => prov(f, "P").closeWith(4403, "Device removed"));
    await settle();
    expect(document.querySelectorAll(".nub")).toHaveLength(0);
    expect(panel().querySelectorAll("input, select")).toHaveLength(0);
    expect(panel().textContent).toContain("A");
    expect(within(panel()).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(toolbar()).getByRole("button", { name: "+ New" }).hasAttribute("disabled")).toBe(true);
  });

  it("removed device offers joining", async () => {
    const w = await spaceWorld();
    w.status = () => ({ space: SPACE, revoked: true });
    await mounted(w);
    const banner = (): HTMLElement => {
      const el = screen.getByText(REMOVED).closest(".banner");
      if (!(el instanceof HTMLElement)) throw new Error("no removed banner");
      return el;
    };
    await click(within(banner()).getByRole("button", { name: "Join with a code" }));
    expect(within(dialog()).getByRole("tab", { name: "Join with a code" }).getAttribute("aria-selected")).toBe("true");
    act(() => uiNow()[1]({ dialog: null }));
    await click(within(banner()).getByRole("button", { name: "Set up sync" }));
    expect(within(dialog()).getByRole("tab", { name: "Set up sync" }).getAttribute("aria-selected")).toBe("true");
  });

  it("the removed banner exports the open space plan", async () => {
    const w = await spaceWorld();
    w.status = () => ({ space: SPACE, revoked: true });
    place("P");
    const { r } = await mounted(w);
    const banner = (): HTMLElement => {
      const el = screen.getByText(REMOVED).closest(".banner");
      if (!(el instanceof HTMLElement)) throw new Error("no removed banner");
      return el;
    };
    await click(within(entry("Launch")).getByRole("button", { name: "Launch" }));
    await click(within(banner()).getByRole("button", { name: "Export…" }));
    expect(vi.mocked(exportFlow).mock.calls).toEqual([[await r.session("P")]]);
    await click(within(entry("Alpha")).getByRole("button", { name: "Alpha" }));
    expect(buttonNames(banner(), ["Export…", "Join with a code", "Set up sync"])).toEqual(["Join with a code", "Set up sync"]);
    await fresh();
    const v = syncWorld();
    v.status = () => ({ space: SPACE, revoked: true });
    await mounted(v);
    expect(document.querySelector(".empty-state")).not.toBeNull();
    expect(buttonNames(banner(), ["Export…", "Join with a code", "Set up sync"])).toEqual(["Join with a code", "Set up sync"]);
  });

  it("a failed banner export toasts once", async () => {
    const w = await spaceWorld();
    w.status = () => ({ space: SPACE, revoked: true });
    place("P");
    const { r } = await mounted(w);
    await click(within(entry("Launch")).getByRole("button", { name: "Launch" }));
    vi.mocked(exportPlan).mockRejectedValueOnce(new AppError("file.io", "Could not write the file: disk full."));
    const banner = screen.getByText(REMOVED).closest(".banner");
    if (!(banner instanceof HTMLElement)) throw new Error("no removed banner");
    await click(within(banner).getByRole("button", { name: "Export…" }));
    expect(vi.mocked(exportPlan).mock.calls).toEqual([[await r.session("P")]]);
    expect(toasts()).toEqual(["Could not write the file: disk full."]);
    expect(badToasts()).toEqual(["Could not write the file: disk full."]);
  });

  it("the removed banner refuses an open plan with no listing", async () => {
    const t = await testSession(MESA_SEED);
    sessions.push(t.session);
    stubState(errorState("revoked"));
    const { registry } = shellFor(t, { plans: () => [] });
    const Host = () => {
      const [ui, setUi] = useUi();
      return (
        <UiContext.Provider value={{ ui, setUi }}>
          <RemovedBanner session={t.session} />
        </UiContext.Provider>
      );
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(withSync(<Host />, { registry }))).toThrow(new Error(`Plan ${t.session.view().plan.id} is not listed`));
  });

  it("no Move to space while removed", async () => {
    const w = await spaceWorld({ trashedP2: true });
    w.status = () => ({ space: SPACE, revoked: true });
    await mounted(w);
    expect(within(entry("Alpha")).queryByRole("button", { name: "Move to space" })).toBeNull();
    expect(within(entry("Launch")).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(true);
    expect(within(entry("Pod")).getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(true);
    expect(within(entry("Alpha")).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(false);
  });

  it("no Move to space without an attached space", async () => {
    const w = await spaceWorld();
    w.status = fail({ code: "ipc.failed", message: "sync_status: channel closed" });
    await mounted(w);
    expect(within(entry("Alpha")).queryByRole("button", { name: "Move to space" })).toBeNull();
  });

  it("Move to space on the desktop", async () => {
    const w = await spaceWorld();
    const { r, f } = await mounted(w);
    syncAll(f);
    await settle();
    expect(r.attachedSpace()).toBe(SP);
    expect(within(entry("Launch")).queryByRole("button", { name: "Move to space" })).toBeNull();
    const move = vi.spyOn(r, "movePlanToSpace");
    await click(within(entry("Alpha")).getByRole("button", { name: "Move to space" }));
    expect(move.mock.calls).toEqual([["L"]]);
    expect(toasts()).toEqual(["Moved to the space"]);
    expect(within(entry("Alpha")).queryByRole("button", { name: "Move to space" })).toBeNull();
    clearToasts();
    await fresh();
    const v = await spaceWorld();
    const second = await mounted(v);
    syncAll(second.f);
    vi.spyOn(second.r, "movePlanToSpace").mockImplementation(() => {
      throw new Refused("This device was removed from the space. Join again to move plans there.");
    });
    await click(within(entry("Alpha")).getByRole("button", { name: "Move to space" }));
    expect(badToasts()).toEqual(["This device was removed from the space. Join again to move plans there."]);
    await fresh();
    const ro = await spaceWorld();
    const third = await mounted(ro);
    syncAll(third.f);
    vi.spyOn(third.r, "spaceReadOnly").mockReturnValue(true);
    act(() => uiNow()[1]({ view: "board" }));
    await settle();
    expect(within(entry("Alpha")).queryByRole("button", { name: "Move to space" })).toBeNull();
  });

  describe("plans that live only on this device", () => {
    const LINE_TWO = "2 plans are on this device only. Move them to the space to see them on other devices.";
    const tagged = (cls: string): (string | null | undefined)[] =>
      [...sidebar().querySelectorAll(`.entry-open .entry-tag.${cls}`)].map((t) => t.closest(".entry-open")?.querySelector(".entry-name")?.textContent);
    const line = (): HTMLElement | null => sidebar().querySelector(".local-line");

    it("tags each one, says how many, and moves them all with one button", async () => {
      const w = await spaceWorld({ local: true, trashedP2: true });
      const { r, f } = await mounted(w);
      syncAll(f);
      await settle();
      expect(r.plans().filter((l) => l.example).map((l) => l.id)).toEqual(["E"]);
      expect([tagged("tag-local"), tagged("tag-example")]).toEqual([["Alpha", "Mango"], ["Example: Website relaunch"]]);
      expect([...sidebar().querySelectorAll(".entry-tag")].map((t) => t.textContent)).toEqual(["this device only", "this device only", "example"]);
      const shown = line();
      if (shown === null) throw new Error("no local line");
      expect([shown.querySelector("p")?.textContent, within(shown).getByRole("button").textContent]).toEqual([LINE_TWO, "Move both"]);
      const trash = within(sidebar()).getByRole("region", { name: "Trash" });
      expect(shown.compareDocumentPosition(trash) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      const move = vi.spyOn(r, "movePlansToSpace");
      await click(within(shown).getByRole("button", { name: "Move both" }));
      expect(move.mock.calls).toEqual([[["L", "M"]]]);
      expect(toasts()).toEqual(["Moved 2 plans to the space"]);
      expect([line(), tagged("tag-local"), tagged("tag-example")]).toEqual([null, [], ["Example: Website relaunch"]]);
      expect(r.plans().filter((l) => !l.trashed && l.space === SP).map((l) => l.id).sort()).toEqual(["L", "M", "P"]);
    });

    it("says it in the singular for one plan and moves it", async () => {
      const w = await spaceWorld();
      const { r, f } = await mounted(w);
      syncAll(f);
      await settle();
      const shown = line();
      if (shown === null) throw new Error("no local line");
      expect([shown.querySelector("p")?.textContent, within(shown).getByRole("button").textContent]).toEqual([
        "1 plan is on this device only. Move it to the space to see it on other devices.",
        "Move it",
      ]);
      const move = vi.spyOn(r, "movePlansToSpace");
      await click(within(shown).getByRole("button", { name: "Move it" }));
      expect(move.mock.calls).toEqual([[["L"]]]);
      expect(toasts()).toEqual(["Moved to the space"]);
      expect([line(), tagged("tag-local")]).toEqual([null, []]);
    });

    it("toasts a move that stopped half-way, and the line stays", async () => {
      const w = await spaceWorld({ local: true });
      const { r, f } = await mounted(w);
      syncAll(f);
      await settle();
      const cause = new Error("Disk full");
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(r, "movePlansToSpace").mockImplementation(() => {
        throw new AppError("move.partial", "Moved 1 of 2 plans to the space. Mango: Disk full", cause);
      });
      const shown = line();
      if (shown === null) throw new Error("no local line");
      await click(within(shown).getByRole("button", { name: "Move both" }));
      expect(badToasts()).toEqual(["Moved 1 of 2 plans to the space. Mango: Disk full"]);
      expect(logged.mock.calls).toEqual([[cause]]);
      expect(line()).not.toBeNull();
    });

    it("leaves a local plan that failed to load untagged and out of the count", async () => {
      const w = await spaceWorld({ local: true });
      w.mem.fail("store_load", "M", { code: "store.corrupt", message: "The plan file is damaged at record 12." });
      const { r, f } = await mounted(w);
      syncAll(f);
      await settle();
      expect(r.failures().has("M")).toBe(true);
      expect(tagged("tag-local")).toEqual(["Alpha"]);
      const shown = line();
      if (shown === null) throw new Error("no local line");
      expect([shown.querySelector("p")?.textContent, within(shown).getByRole("button").textContent]).toEqual([
        "1 plan is on this device only. Move it to the space to see it on other devices.",
        "Move it",
      ]);
    });

    it("shows no tags and no line while sync is off", async () => {
      const w = await spaceWorld({ local: true });
      w.status = () => ({ space: null, revoked: false });
      await mounted(w);
      expect(chip().textContent).toBe("Local only");
      expect([sidebar().querySelectorAll(".entry-tag").length, line()]).toEqual([0, null]);
    });
  });

  it("no Move to space after Reset sync", async () => {
    const w = await spaceWorld({ answers: { sync_reset: () => null } });
    w.status = fail({ code: "sync.io", message: "Could not read the sync state: invalid JSON" });
    const { r } = await mounted(w);
    expect(r.attachedSpace()).toBe(SP);
    await openChip();
    w.status = () => ({ space: null, revoked: false });
    await click(inDialog().getByRole("button", { name: "Reset sync" }));
    expect(chip().textContent).toBe("Local only");
    expect(r.attachedSpace()).toBe(SP);
    expect(within(entry("Alpha")).queryByRole("button", { name: "Move to space" })).toBeNull();
  });

  it("a remote plan shows in the lists", async () => {
    const w = await spaceWorld();
    const { f } = await mounted(w);
    syncAll(f);
    act(() => remoteIndex(prov(f, IX), "s-S", [ip("S", false)]));
    await settle();
    const s = prov(f, "S");
    act(() => {
      s.deliver(Y.encodeStateAsUpdate(seedPlan(null, "S", "Bridge")));
      s.emitStatus("connected");
      s.emitSynced(true);
    });
    await settle();
    expect(within(sidebar()).getByText("Bridge")).toBeTruthy();
  });
});

describe("plan errors in the dialog", () => {
  it("too large offers export and retry", async () => {
    const w = await spaceWorld();
    place("P");
    const { r, f } = await mounted(w);
    syncAll(f);
    await settle();
    act(() => prov(f, "P").closeWith(4413, "Too large to sync"));
    await settle();
    await openChip();
    expect(messageText()).toEqual([TOO_LARGE_HELD]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Export…", "Try again"]);
    await click(inDialog().getByRole("button", { name: "Export…" }));
    expect(vi.mocked(exportFlow).mock.calls).toEqual([[await r.session("P")]]);
    const before = calls("sync_status");
    await click(inDialog().getByRole("button", { name: "Try again" }));
    expect(calls("sync_status")).toBe(before + 1);
  });

  it("a too-large plan list offers retry only", async () => {
    const w = await spaceWorld();
    const { f } = await mounted(w);
    syncAll(f);
    act(() => prov(f, IX).closeWith(4413, "Too large to sync"));
    await settle();
    expect(within(toolbar()).getByRole("button", { name: "The plan list is too large to sync" })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual(["The plan list is too large to sync. Plans keep working on this device."]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Try again"]);
  });

  it("a refused change offers export and retry", async () => {
    const w = await spaceWorld();
    place("P");
    const { r, f } = await mounted(w);
    syncAll(f);
    await settle();
    act(() => prov(f, "P").closeWith(1007, "Malformed update"));
    await settle();
    expect(within(toolbar()).getByRole("button", { name: "The server refused a change from this device — export this plan and check for an update" })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual(["The server refused a change to “Launch” from this device. Update WebBoard, then try again."]);
    await click(inDialog().getByRole("button", { name: "Export…" }));
    expect(vi.mocked(exportFlow).mock.calls).toEqual([[await r.session("P")]]);
    const before = calls("sync_status");
    const first = prov(f, "P");
    await click(inDialog().getByRole("button", { name: "Try again" }));
    expect(calls("sync_status")).toBe(before + 1);
    expect(prov(f, "P")).not.toBe(first);
    expect(prov(f, "P").calls).toContain("connect");
    await fresh();
    const v = await spaceWorld();
    const second = await mounted(v);
    syncAll(second.f);
    act(() => prov(second.f, IX).closeWith(1007, "Malformed update"));
    await settle();
    expect(within(toolbar()).getByRole("button", { name: "The server refused a change to the plan list — update WebBoard" })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual([REJECTED]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Try again"]);
  });

  it("a store failure offers retry", async () => {
    const w = await spaceWorld();
    place("P");
    const { f } = await mounted(w);
    syncAll(f);
    await settle();
    act(() => prov(f, "P").closeWith(4500, "Store failed"));
    await settle();
    expect(within(toolbar()).getByRole("button", { name: "Server could not store changes to “Launch” since 14:02" })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual(["The server could not store a change to “Launch”. Try again; if it repeats, export it."]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Export…", "Try again"]);
    const restart = vi.spyOn(SyncManager.prototype, "restart");
    const before = f.all.filter((p) => p.doc === "P").reduce((n, p) => n + p.connects(), 0);
    await click(inDialog().getByRole("button", { name: "Try again" }));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(f.all.filter((p) => p.doc === "P").reduce((n, p) => n + p.connects(), 0)).toBe(before + 1);
    await fresh();
    const v = await spaceWorld();
    const second = await mounted(v);
    syncAll(second.f);
    act(() => prov(second.f, IX).closeWith(4500, "Store failed"));
    await settle();
    expect(within(toolbar()).getByRole("button", { name: "Server could not store changes since 14:02" })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual(["The server could not store a change to the plan list. Try again."]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Try again"]);
  });

  it.each([
    [4413, "Too large to sync: a plan", TOO_LARGE_MISSING],
    [1007, "The server refused a change from this device — update WebBoard", REJECTED],
    [4500, "Server could not store changes since 14:02", STORE],
  ])("a plan that never arrived offers no export (%s)", async (code, chipName, message) => {
    const w = syncWorld();
    seedIndex(w.mem, IX, [ixAct("s-S", [], [ip("S", false)], "dev-B")]);
    const { f } = await mounted(w);
    act(() => prov(f, "S").closeWith(code, "closed"));
    await settle();
    expect(within(toolbar()).getByRole("button", { name: chipName })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual([message]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Try again"]);
  });

  it("a failed export shows its message", async () => {
    const w = await spaceWorld();
    place("P");
    const { f } = await mounted(w);
    syncAll(f);
    await settle();
    act(() => prov(f, "P").closeWith(4413, "Too large to sync"));
    await settle();
    vi.mocked(exportPlan).mockRejectedValueOnce(new AppError("file.io", "Could not write the file: disk full."));
    await openChip();
    await click(inDialog().getByRole("button", { name: "Export…" }));
    expect(vi.mocked(exportPlan)).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual(["Could not write the file: disk full."]);
    expect(badToasts()).toEqual(["Could not write the file: disk full."]);
    expect(messageText()).toEqual([TOO_LARGE_HELD]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Export…", "Try again"]);
  });
});

describe("loading again from the server", () => {
  const onLine = (on: boolean): void => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(on);
  };

  it("loading again needs a connection", async () => {
    for (const on of [false, true]) {
      const w = await spaceWorld();
      w.mem.fail("store_load", "P", { code: "store.corrupt", message: "The plan file is damaged at record 12." });
      onLine(on);
      const { r, f } = await mounted(w);
      syncAll(f);
      await settle();
      await click(within(entry("Launch")).getByRole("button", { name: "Launch" }));
      expect(r.failures().get("P")?.code).toBe("store.corrupt");
      const reload = vi.spyOn(r, "reloadFromServer").mockResolvedValue(undefined);
      const failed = document.querySelector(".plan-failed");
      if (!(failed instanceof HTMLElement)) throw new Error("no PlanFailed");
      const button = within(failed).getByRole("button", { name: RELOAD });
      expect([chip().textContent, button.hasAttribute("disabled"), within(failed).queryByText(NEEDS) !== null]).toEqual([on ? "Synced" : "Offline", !on, !on]);
      await click(button);
      expect(screen.queryByRole("dialog", { name: RELOAD }) !== null).toBe(on);
      expect(reload).not.toHaveBeenCalled();
      await fresh();
    }
    for (const s of [{ kind: "offline", waiting: 0 }, { kind: "synced" }] as const) {
      stubState(s);
      await stubShell({
        indexError: () => new AppError("store.corrupt", "The space plan list is damaged at record 4."),
        indexErrorDoc: () => IX,
        retryIndex: vi.fn(async () => undefined),
      });
      const banner = screen.getByText("The space plan list is damaged at record 4.").closest(".banner");
      if (!(banner instanceof HTMLElement)) throw new Error("no index banner");
      const button = within(banner).getByRole("button", { name: RELOAD });
      const on = s.kind === "synced";
      expect([button.hasAttribute("disabled"), within(banner).queryByText(NEEDS) !== null]).toEqual([!on, !on]);
      await click(button);
      expect(screen.queryByRole("dialog", { name: RELOAD }) !== null).toBe(on);
      await fresh();
    }
  });

  it("the damaged space index offers retry", async () => {
    const w = await spaceWorld();
    w.mem.fail("store_load", IX, { code: "store.corrupt", message: "Bad record in seg-0.log." });
    const { r } = await mounted(w);
    expect(r.indexErrorDoc()).toBe(IX);
    expect(within(toolbar()).getByRole("button", { name: "The space’s plan list on this device is damaged" })).toBe(chip());
    const retryIndex = vi.spyOn(r, "retryIndex").mockResolvedValue(undefined);
    const reload = vi.spyOn(r, "reloadFromServer").mockResolvedValue(undefined);
    await openChip();
    expect(messageText()).toEqual(["Bad record in seg-0.log."]);
    await click(inDialog().getByRole("button", { name: "Try again" }));
    expect(retryIndex).toHaveBeenCalledTimes(1);
    const load = inDialog().getByRole("button", { name: RELOAD });
    expect([load.hasAttribute("disabled"), inDialog().queryByText(NEEDS)]).toEqual([false, null]);
    await click(load);
    await click(within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Load again" }));
    expect(reload.mock.calls).toEqual([[IX]]);
    vi.spyOn(r, "spaceReadOnly").mockReturnValue(true);
    act(() => uiNow()[1]({ dialog: null }));
    await openChip();
    expect(inDialog().queryByRole("button", { name: RELOAD })).toBeNull();
  });

  it("the index reload confirmation keeps the Sync dialog and its opener", async () => {
    const w = await spaceWorld();
    w.mem.fail("store_load", IX, { code: "store.corrupt", message: "Bad record in seg-0.log." });
    const { r } = await mounted(w);
    const reload = vi.spyOn(r, "reloadFromServer").mockResolvedValue(undefined);
    const opener = chip();
    const escape = async (): Promise<void> => {
      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      });
      await settle();
    };
    act(() => opener.focus());
    await openChip();
    const frame = dialog();
    const load = within(frame).getByRole("button", { name: RELOAD });
    act(() => load.focus());
    await click(load);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const confirmation = screen.getByRole("dialog", { name: RELOAD });
    expect(confirmation.contains(document.activeElement)).toBe(true);
    await click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: RELOAD }));
    expect(screen.getAllByRole("dialog")).toEqual([frame]);
    await click(within(frame).getByRole("button", { name: RELOAD }));
    expect(screen.getAllByRole("dialog")).toEqual([frame]);
    expect(frame.getAttribute("aria-label")).toBe(RELOAD);
    await escape();
    expect(screen.getAllByRole("dialog")).toEqual([frame]);
    expect(frame.getAttribute("aria-label")).toBe("Sync");
    expect(document.activeElement).toBe(within(frame).getByRole("button", { name: RELOAD }));
    await escape();
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.activeElement).toBe(opener);
    expect(opener.isConnected).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ["store.io", "Disk full."],
    ["store.locked", "The plan list is open in another WebBoard process; close it there first."],
  ])("a space index that cannot be read (%s) offers Try again only", async (code, message) => {
    const w = await spaceWorld();
    w.mem.fail("store_load", IX, { code, message });
    await mounted(w);
    expect(within(toolbar()).getByRole("button", { name: "The space’s plan list on this device could not be read" })).toBe(chip());
    await openChip();
    expect(messageText()).toEqual([message]);
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Try again"]);
  });

  it("a space index that cannot be saved offers Try again", async () => {
    const w = syncWorld({ names: NAMES });
    seedIndex(w.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("l-L", ["l-n"], [ip("L", false)])]);
    seedIndex(w.mem, IX, [ixAct("s-P", [], [ip("P", false)])]);
    seedPlan(w.mem, "P", "Launch");
    seedPlan(w.mem, "L", "Alpha");
    w.mem.fail("store_append", IX, { code: "store.io", message: "Disk full." });
    const { r } = await mounted(w);
    expect(within(toolbar()).getByRole("button", { name: "The space’s plan list on this device could not be saved" })).toBe(chip());
    const retryIndex = vi.spyOn(r, "retryIndex").mockResolvedValue(undefined);
    await openChip();
    expect(messageText()).toEqual(["Disk full."]);
    await click(inDialog().getByRole("button", { name: "Try again" }));
    expect(retryIndex).toHaveBeenCalledTimes(1);
    expect(inDialog().queryByRole("button", { name: RELOAD })).toBeNull();
    w.mem.recover("store_append", IX);
    retryIndex.mockRestore();
    await act(async () => r.retryIndex());
  });

  it("a successful index retry leaves local-failed", async () => {
    const w = await spaceWorld();
    w.mem.fail("store_load", IX, { code: "store.io", message: "Disk full." });
    const { f } = await mounted(w);
    expect(chip().textContent).toBe("The space’s plan list on this device could not be read");
    await openChip();
    expect(messageText()).toEqual(["Disk full."]);
    w.mem.recover("store_load", IX);
    await click(inDialog().getByRole("button", { name: "Try again" }));
    syncAll(f);
    await settle();
    expect(chip().textContent).toBe("Synced");
    expect([messageText(), buttonNames(dialog(), ACTION_NAMES)]).toEqual([[], []]);
    await fresh();
    const v = syncWorld({ names: NAMES });
    seedIndex(v.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("l-L", ["l-n"], [ip("L", false)])]);
    seedIndex(v.mem, IX, [ixAct("s-P", [], [ip("P", false)])]);
    seedPlan(v.mem, "P", "Launch");
    seedPlan(v.mem, "L", "Alpha");
    v.mem.fail("store_append", IX, { code: "store.io", message: "Disk full." });
    const second = await mounted(v);
    expect(chip().textContent).toBe("The space’s plan list on this device could not be saved");
    await openChip();
    expect(messageText()).toEqual(["Disk full."]);
    v.mem.recover("store_append", IX);
    await click(inDialog().getByRole("button", { name: "Try again" }));
    syncAll(second.f);
    await settle();
    expect(chip().textContent).toBe("Synced");
    expect([messageText(), buttonNames(dialog(), ACTION_NAMES)]).toEqual([[], []]);
  });

  it("an unreadable sync state offers Reset sync, then Try again", async () => {
    const w = await spaceWorld();
    w.status = fail({ code: "sync.io", message: "Could not read the sync state: invalid JSON" });
    await mounted(w);
    expect(within(toolbar()).getByRole("button", { name: "Sync state on this device could not be read" })).toBe(chip());
    await openChip();
    expect(buttonNames(dialog(), ACTION_NAMES)).toEqual(["Reset sync", "Try again"]);
    const before = calls("sync_status");
    await click(inDialog().getByRole("button", { name: "Try again" }));
    expect(calls("sync_status")).toBe(before + 1);
  });
});

describe("a plan that will not arrive", () => {
  type Row = [string, (w: SyncWorld) => void, ((f: FakeFactory) => void) | null, string, readonly string[], boolean];
  const KEYCHAIN = "The keychain refused access: errSecAuthFailed.";
  const failS = (e: { code: string; message: string }) => (w: SyncWorld) => {
    w.ticket = (doc) => {
      if (doc === "S") throw { ...e };
      return { ticket: "tk", expiresAt: 0 };
    };
  };
  const rows: Row[] = [
    ["4413", () => undefined, (f) => prov(f, "S").closeWith(4413, "Too large to sync"), TOO_LARGE_MISSING, ["Try again", "Open sync"], false],
    ["1007", () => undefined, (f) => prov(f, "S").closeWith(1007, "Malformed"), REJECTED, ["Try again", "Open sync"], false],
    ["4500", () => undefined, (f) => prov(f, "S").closeWith(4500, "Store failed"), STORE, ["Try again", "Open sync"], false],
    ["ipc.failed", failS({ code: "ipc.failed", message: "sync_ticket: channel closed" }), null, "sync_ticket: channel closed", ["Try again", "Open sync"], false],
    ["revoked", (w) => {
      w.status = () => ({ space: SPACE, revoked: true });
    }, null, "Device removed", ["Open sync"], true],
    ["keychain.missing", (w) => {
      w.ticket = fail({ code: "keychain.missing", message: NO_KEY });
    }, null, NO_KEY, ["Open sync"], true],
    ["sync.not_configured", failS({ code: "sync.not_configured", message: NOT_CONFIGURED }), null, NOT_CONFIGURED, ["Try again", "Open sync"], false],
    ["keychain.io", failS({ code: "keychain.io", message: KEYCHAIN }), null, KEYCHAIN, ["Try again", "Open sync"], false],
    ["sync.io", (w) => {
      w.status = fail({ code: "sync.io", message: "Could not read the sync state: invalid JSON" });
    }, null, "Could not read the sync state: invalid JSON" + RESET_HINT, ["Reset sync", "Try again", "Open sync"], true],
  ];

  async function selectedS(prepare: (w: SyncWorld) => void): Promise<{ r: Registry; f: FakeFactory }> {
    const w = syncWorld({ names: { L: "Alpha" } });
    seedIndex(w.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("l-L", ["l-n"], [ip("L", false)])]);
    seedPlan(w.mem, "L", "Alpha");
    seedPlan(w.mem, "P", "Launch");
    seedIndex(w.mem, IX, [ixAct("s-S", [], [ip("S", false)], "dev-B"), ixAct("s-P", ["s-S"], [ip("P", false)], "dev-B")]);
    w.settings.value = { v: 1, lastRegion: null, names: { L: "Alpha", P: "Launch" } };
    prepare(w);
    const out = await mounted(w);
    await click(within(sidebar()).getByRole("button", { name: "Loading…" }));
    return out;
  }

  it.each(rows)("says why for %s", async (_name, prepare, trigger, text, buttons, join) => {
    const { f } = await selectedS(prepare);
    if (trigger !== null) {
      act(() => trigger(f));
      await settle();
    }
    expect(mainArea().querySelector(".sync-message.bad")?.textContent).toBe(text);
    expect(buttonNames(mainArea(), ACTION_NAMES)).toEqual(buttons);
    expect(within(sidebar()).getByRole("button", { name: "Loading…" }).getAttribute("aria-current")).toBe("page");
    expect(within(mainArea()).queryByText(INCOMPLETE)).toBeNull();
    await click(within(mainArea()).getByRole("button", { name: "Open sync" }));
    if (join) expect(within(dialog()).getByRole("tab", { name: "Join with a code" }).getAttribute("aria-selected")).toBe("true");
    else expect(dialog()).toBeTruthy();
    act(() => uiNow()[1]({ dialog: null }));
    if (buttons.includes("Try again")) {
      const restart = vi.spyOn(SyncManager.prototype, "restart");
      await click(within(mainArea()).getByRole("button", { name: "Try again" }));
      expect(restart).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the sentence for a stop on another plan and for offline", async () => {
    const { f } = await selectedS(() => undefined);
    syncAll(f);
    act(() => prov(f, "P").closeWith(4413, "Too large to sync"));
    await settle();
    expect(within(mainArea()).getByText(INCOMPLETE)).toBeTruthy();
    await fresh();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await selectedS(() => undefined);
    expect(chip().textContent?.startsWith("Offline")).toBe(true);
    expect(within(mainArea()).getByText(INCOMPLETE)).toBeTruthy();
  });
});

describe("the sync test helpers", () => {
  it("throw on a missing item", async () => {
    expect(() => seedPlan(null, "X", "Solo", { items: ["A"], link: true })).toThrow(new Error("seedPlan: a link needs two items"));
    const t = await testSession(MESA_SEED);
    sessions.push(t.session);
    expect(() => itemNamed(t.session, "Nowhere")).toThrow(new Error("no item Nowhere"));
  });
});

describe("the sync provider outside the shell", () => {
  it("renders through SyncProvider with a registry", async () => {
    const t = await testSession(MESA_SEED);
    sessions.push(t.session);
    const { registry } = shellFor(t);
    expect(() => withSync(<div />)).toThrow(new Error("withSync needs a registry."));
    render(
      <SyncProvider registry={registry} factory={fakeFactory()}>
        <p>inside</p>
      </SyncProvider>,
    );
    await settle();
    expect(screen.getByText("inside")).toBeTruthy();
  });
});

describe("sync on the phone", () => {
  beforeEach(() => {
    setScreen(390, 844);
  });

  const topBar = (): HTMLElement => {
    const el = document.querySelector(".phone-head");
    if (!(el instanceof HTMLElement)) throw new Error("no phone top bar");
    return el;
  };
  const plansSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Plans" });
  const openPlans = async (): Promise<HTMLElement> => {
    await click(within(topBar()).getByRole("button", { name: "Plans" }));
    return plansSheet();
  };
  const planRow = (name: string): HTMLElement => {
    const li = within(plansSheet()).getByText(name).closest("li");
    if (!(li instanceof HTMLElement)) throw new Error("no Plans row " + name);
    return li;
  };
  const planSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Plan" });
  const syncSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Sync" });
  const selectedTab = (): string | null => within(syncSheet()).getByRole("tab", { selected: true }).textContent;
  const strip = (): HTMLElement => {
    const el = document.querySelector(".phone-status .status-strip");
    if (!(el instanceof HTMLElement)) throw new Error("no status strip");
    return el;
  };
  const statusSheet = (): HTMLElement => screen.getByRole("dialog", { name: "Status" });
  const lineOf = (text: string): HTMLElement => {
    const hit = [...statusSheet().querySelectorAll(".status-line")].find((li) => li.querySelector(".status-text")?.textContent === text);
    if (!(hit instanceof HTMLElement)) throw new Error("no status line " + text);
    return hit;
  };

  it("the phone sheet's Sync row opens the dialog", async () => {
    const w = await spaceWorld();
    place("P");
    const { f } = await mounted(w);
    syncAll(f);
    await settle();
    await click(within(topBar()).getByRole("button", { name: "Plan" }));
    const row = within(planSheet()).getByRole("button", { name: "Sync Synced" });
    expect(row.querySelector(".sync-row-state")?.textContent).toBe(chipText({ kind: "synced" }, () => null));
    await click(row);
    expect(uiNow()[0].dialog).toEqual({ t: "sync", pane: null });
    expect(syncSheet().classList.contains("sheet")).toBe(true);
    expect(selectedTab()).toBe("Devices");
    expect(within(syncSheet()).getAllByRole("button", { name: "Close" })).toHaveLength(1);
    await click(within(syncSheet()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Sync" })).toBeNull();
    expect(uiNow()[0].dialog).toBeNull();
  });

  it("removed device offers joining on the phone", async () => {
    const w = await spaceWorld();
    w.status = () => ({ space: SPACE, revoked: true });
    await mounted(w);
    await openPlans();
    await click(within(plansSheet()).getByRole("button", { name: "Join with a code" }));
    expect(screen.queryByRole("dialog", { name: "Plans" })).toBeNull();
    expect(selectedTab()).toBe("Join with a code");
    await click(within(syncSheet()).getByRole("button", { name: "Close" }));
    await openPlans();
    await click(within(plansSheet()).getByRole("button", { name: "Set up sync" }));
    expect(selectedTab()).toBe("Set up sync");
  });

  it("no Move to Trash for space plans while removed on the phone", async () => {
    const w = await spaceWorld({ trashedP2: true });
    w.status = () => ({ space: SPACE, revoked: true });
    await mounted(w);
    await openPlans();
    expect(within(planRow("Launch")).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(true);
    expect(within(planRow("Pod")).getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(true);
    expect(within(planRow("Alpha")).getByRole("button", { name: "Move to Trash" }).hasAttribute("disabled")).toBe(false);
  });

  it("loading again needs a connection on the phone", async () => {
    for (const on of [false, true]) {
      const w = await spaceWorld();
      w.mem.fail("store_load", "P", { code: "store.corrupt", message: "The plan file is damaged at record 12." });
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(on);
      const { r, f } = await mounted(w);
      syncAll(f);
      await settle();
      await act(async () => r.warm());
      await settle();
      expect(r.failures().get("P")?.code).toBe("store.corrupt");
      const reload = vi.spyOn(r, "reloadFromServer").mockResolvedValue(undefined);
      expect(within(topBar()).getByRole("button", { name: on ? "Synced" : "Offline" }).classList.contains("chip-compact")).toBe(true);
      await openPlans();
      const button = within(planRow("Launch")).getByRole("button", { name: RELOAD });
      expect([button.hasAttribute("disabled"), within(planRow("Launch")).queryByText(NEEDS) !== null]).toEqual([!on, !on]);
      if (!on) expect(within(planRow("Launch")).getByText(NEEDS).classList.contains("dim")).toBe(true);
      await click(button);
      expect(screen.queryByRole("dialog", { name: RELOAD }) !== null).toBe(on);
      expect(reload).not.toHaveBeenCalled();
      if (on) {
        await click(within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Load again" }));
        expect(reload.mock.calls).toEqual([["P"]]);
      }
      await fresh();
    }
    for (const s of [{ kind: "offline", waiting: 0 }, { kind: "synced" }] as const) {
      stubState(s);
      const reload = vi.fn(async () => undefined);
      await stubShell({
        indexError: () => new AppError("store.corrupt", "The space plan list is damaged at record 4."),
        indexErrorDoc: () => IX,
        retryIndex: vi.fn(async () => undefined),
        reloadFromServer: reload,
      });
      await click(strip());
      const line = lineOf("The space plan list is damaged at record 4.");
      const button = within(line).getByRole("button", { name: RELOAD });
      const on = s.kind === "synced";
      expect([button.hasAttribute("disabled"), within(line).queryByText(NEEDS) !== null]).toEqual([!on, !on]);
      if (!on) expect(within(line).getByText(NEEDS).classList.contains("dim")).toBe(true);
      await click(button);
      expect(screen.queryByRole("dialog", { name: RELOAD }) !== null).toBe(on);
      expect(reload).not.toHaveBeenCalled();
      if (on) {
        await click(within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Load again" }));
        expect(reload.mock.calls).toEqual([[IX]]);
      }
      await fresh();
    }
  });

  it("the index reload confirmation takes the Sync sheet's place on the phone", async () => {
    const w = await spaceWorld();
    w.mem.fail("store_load", IX, { code: "store.corrupt", message: "Bad record in seg-0.log." });
    const { r } = await mounted(w);
    expect(r.indexErrorDoc()).toBe(IX);
    const reload = vi.spyOn(r, "reloadFromServer").mockResolvedValue(undefined);
    const dialogs = (): (string | null)[] => screen.queryAllByRole("dialog").map((d) => d.getAttribute("aria-label"));
    await click(within(topBar()).getByRole("button", { name: "The space’s plan list on this device is damaged" }));
    expect(dialogs()).toEqual(["Sync"]);
    await click(within(syncSheet()).getByRole("button", { name: RELOAD }));
    expect(dialogs()).toEqual([RELOAD]);
    await click(within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Cancel" }));
    expect(dialogs()).toEqual(["Sync"]);
    expect(within(syncSheet()).getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    await click(within(syncSheet()).getByRole("button", { name: RELOAD }));
    expect(dialogs()).toEqual([RELOAD]);
    await click(within(screen.getByRole("dialog", { name: RELOAD })).getByRole("button", { name: "Load again" }));
    expect(reload.mock.calls).toEqual([[IX]]);
  });

  it("the index reload confirmation keeps the Sync sheet and its opener on the phone", async () => {
    const w = await spaceWorld();
    w.mem.fail("store_load", IX, { code: "store.corrupt", message: "Bad record in seg-0.log." });
    const { r } = await mounted(w);
    const reload = vi.spyOn(r, "reloadFromServer").mockResolvedValue(undefined);
    const opener = within(topBar()).getByRole("button", { name: "The space’s plan list on this device is damaged" });
    act(() => opener.focus());
    await click(opener);
    const frame = syncSheet();
    const load = within(frame).getByRole("button", { name: RELOAD });
    act(() => load.focus());
    await click(load);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const confirmation = screen.getByRole("dialog", { name: RELOAD });
    expect(confirmation.contains(document.activeElement)).toBe(true);
    await click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(within(syncSheet()).getByRole("button", { name: RELOAD }));
    expect(screen.getAllByRole("dialog")).toEqual([frame]);
    await click(within(frame).getByRole("button", { name: "Close" }));
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.activeElement).toBe(opener);
    expect(opener.isConnected).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("a remote plan shows in the phone list", async () => {
    const w = await spaceWorld();
    const { f } = await mounted(w);
    syncAll(f);
    act(() => remoteIndex(prov(f, IX), "s-S", [ip("S", false)]));
    await settle();
    const s = prov(f, "S");
    act(() => {
      s.deliver(Y.encodeStateAsUpdate(seedPlan(null, "S", "Bridge")));
      s.emitStatus("connected");
      s.emitSynced(true);
    });
    await settle();
    await openPlans();
    expect(within(plansSheet()).getByText("Bridge")).toBeTruthy();
  });
});
