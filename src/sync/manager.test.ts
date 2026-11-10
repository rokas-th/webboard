import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { buildAction, initialAction } from "../actions/build";
import { Refused } from "../actions/intents";
import type { Calendar } from "../domain/calendar";
import type { ItemId } from "../domain/model";
import { LogState } from "../log/state";
import type { Action, ActionId, DeviceId, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { fixedClock } from "../services/clock";
import { AppError } from "../services/ipc";
import { decodeAction, encodeAction, PlanDoc } from "../store/doc";
import { readActions } from "../store/read-actions";
import { Registry } from "../store/registry";
import { act } from "../test/act";
import { fakeFactory, type FakeFactory, type FakeProvider } from "../test/fakeProvider";
import { memoryStore, type MemoryStore } from "../test/fixtures/store";
import { ctxOf } from "../test/planCtx";
import { commandsWith, hold, offeredSettings, resetTauri, tauri, type Call } from "../test/tauriMock";
import { chipText, holdsPlan, SyncManager, type SyncState } from "./manager";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const SP = "sp000000000";
const IX = "ix-" + SP;
const TODAY = "2026-11-08";
const NOW = new Date(2026, 10, 8, 14, 2).getTime();
const SPACE = { server: "https://webboard.rokass.org", spaceId: SP, deviceId: "dev-A", deviceName: "Mac" };
const READ_ONLY = "This device was removed from the space; its plans are read-only.";
const PLAIN: Calendar = { region: null, workdays: [1, 2, 3, 4, 5], closures: new Map(), tuning: new Map(), holidays: new Map() };
const DEVICES: ReadonlyMap<DeviceId, string> = new Map([
  ["dev-A", "Mac"],
  ["dev-B", "iPhone"],
]);
const NAME = (r: Registry) => (doc: string): string | null => r.plans().find((p) => p.id === doc)?.name ?? null;

type Err = { code: string; message: string };

interface World {
  mem: MemoryStore;
  settings: { value: unknown };
  status: () => unknown;
  ticket: (doc: string) => unknown;
  mark: () => unknown;
  net: { online: boolean; cbs: Set<() => void>; removed: number };
  issued: number;
}

const fail = (e: Err) => (): never => {
  throw { ...e };
};

const argsOf = (c: Call): Record<string, unknown> =>
  c.args !== undefined && !(c.args instanceof Uint8Array) && !(c.args instanceof ArrayBuffer) && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {};

function world(): World {
  const mem = memoryStore();
  const w: World = {
    mem,
    settings: { value: offeredSettings() },
    status: () => ({ space: SPACE, revoked: false }),
    ticket: () => {
      w.issued += 1;
      return { ticket: "tk_" + w.issued, expiresAt: 0 };
    },
    mark: () => null,
    net: { online: true, cbs: new Set(), removed: 0 },
    issued: 0,
  };
  resetTauri({
    ...mem.answers,
    settings_read: () => w.settings.value,
    settings_write: (args) => {
      w.settings.value = argsOf({ cmd: "settings_write", args, options: undefined }).settings;
      return null;
    },
    device_info: () => ({ deviceId: "dev-A", platform: "macos" }),
    holidays_year: fail({ code: "holidays.offline", message: "No connection to the holiday source." }),
    sync_status: () => w.status(),
    sync_ticket: (args) => {
      const doc = argsOf({ cmd: "sync_ticket", args, options: undefined }).doc;
      if (typeof doc !== "string") throw new Error("sync_ticket without a doc");
      return w.ticket(doc);
    },
    sync_mark_revoked: () => w.mark(),
  });
  return w;
}

const own = (u: string, v: unknown): Write => ({ u, v, c: "own" });
const ip = (plan: string, t: boolean): Write => own("ip:" + plan, { t });

function seedIndex(mem: MemoryStore | null, doc: string, entries: readonly (readonly [ActionId, unknown])[]): Y.Doc {
  const ydoc = new Y.Doc();
  const map = ydoc.getMap("actions");
  ydoc.transact(() => entries.forEach(([id, raw]) => map.set(id, raw)));
  if (mem !== null) mem.seed(doc, Y.encodeStateAsUpdate(ydoc));
  return ydoc;
}

const ixAct = (id: ActionId, par: readonly ActionId[], w: readonly Write[], dev: DeviceId = "dev-A", lbl = "Add plan"): readonly [ActionId, unknown] => [
  id,
  encodeAction(act(id, par, w, { dev, lbl })),
];

function seedPlan(mem: MemoryStore | null, id: string, name: string, o: { items?: readonly string[]; dev?: DeviceId; link?: boolean } = {}): Y.Doc {
  const ydoc = new Y.Doc();
  const pd = new PlanDoc(ydoc);
  const log = new LogState(planRules);
  const dev = o.dev ?? "dev-A";
  const root = initialAction({ dev, ses: "seed", now: 0, name, calendar: PLAIN });
  pd.append(root, []);
  log.add([root]);
  (o.items ?? []).forEach((item) => {
    const b = buildAction(ctxOf(log, dev, TODAY, DEVICES, { ses: "seed" }), { t: "create", kind: "task", name: item, parent: null, after: null, start: "2026-11-09", dur: 2 });
    pd.append(b.action, b.newNotes);
    log.add([b.action]);
  });
  if (o.link === true) {
    const items = [...ctxOf(log, dev, TODAY, DEVICES).view.plan.items.values()];
    const [a, b] = (o.items ?? []).map((n) => items.find((i) => i.name === n)?.id ?? "");
    const l = buildAction(ctxOf(log, dev, TODAY, DEVICES, { ses: "seed" }), { t: "link", from: a, to: b, type: "FS", lag: 0 });
    pd.append(l.action, l.newNotes);
    log.add([l.action]);
  }
  if (mem !== null) mem.seed(id, Y.encodeStateAsUpdate(ydoc));
  return ydoc;
}

const actionsOf = (ydoc: Y.Doc): Action[] => {
  const { ok, unreadable } = readActions(ydoc.getMap("actions").entries(), () => undefined);
  expect(unreadable).toEqual([]);
  return ok;
};

const headsOf = (ydoc: Y.Doc): ActionId[] => {
  const ok = actionsOf(ydoc);
  const parents = new Set(ok.flatMap((a) => [...a.par]));
  return ok.map((a) => a.id).filter((id) => !parents.has(id));
};

function remoteUpdate(base: Y.Doc, id: ActionId, raw: unknown): Uint8Array {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(base));
  other.getMap("actions").set(id, raw);
  return Y.encodeStateAsUpdate(other, Y.encodeStateVector(base));
}

const remoteIndex = (p: FakeProvider, id: ActionId, w: readonly Write[], dev: DeviceId = "dev-B"): void =>
  p.deliver(remoteUpdate(p.ydoc, id, encodeAction(act(id, headsOf(p.ydoc), w, { dev, lbl: "Add plan" }))));

const itemNamed = (ydoc: Y.Doc, name: string): ItemId => {
  const log = new LogState(planRules);
  log.add(new PlanDoc(ydoc).actions());
  const found = [...ctxOf(log, "dev-A", TODAY).view.plan.items.values()].find((i) => i.name === name);
  if (found === undefined) throw new Error(`no item ${name}`);
  return found.id;
};

function seedBase(w: World): { seeded: Y.Doc } {
  seedIndex(w.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("l-L", ["l-n"], [ip("L", false)])]);
  seedIndex(w.mem, IX, [ixAct("s-P", [], [ip("P", false)]), ixAct("s-P2", ["s-P"], [ip("P2", false)])]);
  const seeded = seedPlan(w.mem, "P", "Launch", { items: ["A"] });
  seedPlan(w.mem, "P2", "Pod");
  seedPlan(w.mem, "L", "Lone");
  return { seeded };
}

const registries: Registry[] = [];
const managers: SyncManager[] = [];

async function openRegistry(): Promise<Registry> {
  const r = await Registry.open({ clock: fixedClock(TODAY, NOW) });
  registries.push(r);
  return r;
}

function managerOf(w: World, r: Registry, f: FakeFactory): SyncManager {
  const m = new SyncManager({
    factory: f,
    registry: r,
    sessions: () => r.openSessions(),
    online: () => w.net.online,
    onlineChange: (cb) => {
      w.net.cbs.add(cb);
      return () => {
        w.net.cbs.delete(cb);
        w.net.removed += 1;
      };
    },
    now: () => NOW,
  });
  managers.push(m);
  return m;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
};

const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
};

async function started(o: { base?: boolean; f?: FakeFactory; before?: (w: World) => void } = {}) {
  const w = world();
  const base = o.base === false ? null : seedBase(w);
  o.before?.(w);
  const r = await openRegistry();
  const f = o.f ?? fakeFactory();
  const m = managerOf(w, r, f);
  await m.start();
  await settle();
  return { w, r, f, m, seeded: base?.seeded ?? null };
}

function syncAll(f: FakeFactory): void {
  [...f.providers.values()].forEach((p) => {
    p.emitStatus("connected");
    p.emitSynced(true);
  });
}

const prov = (f: FakeFactory, doc: string): FakeProvider => {
  const p = f.providers.get(doc);
  if (p === undefined) throw new Error(`no provider for ${doc}`);
  return p;
};

const tickets = (from: number, doc: string): number => commandsWith(from, "sync_ticket", { doc });

const marks = (from: number): number => tauri.calls.slice(from).filter((c) => c.cmd === "sync_mark_revoked").length;

const errorOf = (s: SyncState) => {
  if (s.kind !== "error") throw new Error(`state is ${s.kind}, not an error`);
  return s;
};

const stopped = async (f: FakeFactory, doc: string): Promise<void> => {
  const p = prov(f, doc);
  expect(p.calls).toContain("disconnect");
  const from = tauri.calls.length;
  const connects = p.connects();
  await advance(60_000);
  expect(p.connects()).toBe(connects);
  expect(tickets(from, doc)).toBe(0);
};

const appendsTo = (from: number, doc: string): Call[] =>
  tauri.calls.slice(from).filter((c) => c.cmd === "store_append" && new Headers(c.options?.headers).get("x-doc") === doc);

const xdocWrites = (c: Call): Write[] => {
  if (!(c.args instanceof Uint8Array)) throw new Error("no bytes");
  return Y.decodeUpdate(c.args)
    .structs.filter((s): s is Y.Item => s instanceof Y.Item && s.parentSub !== null)
    .flatMap((s) => [...decodeAction(s.parentSub as string, s.content.getContent()[0]).w]);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(async () => {
  managers.splice(0).forEach((m) => m.stop());
  await settle();
  await Promise.all(registries.splice(0).map((r) => r.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SyncManager: connecting", () => {
  it("every connect takes a fresh ticket", async () => {
    const { w, f } = await started();
    const p = prov(f, "P");
    expect(p.host).toBe("webboard.rokass.org");
    const from = tauri.calls.length;
    const seen = [p.lastParams?.ticket];
    await p.connect();
    seen.push(p.lastParams?.ticket);
    await p.connect();
    seen.push(p.lastParams?.ticket);
    expect(tickets(0, "P")).toBe(3);
    expect(tickets(from, "P")).toBe(2);
    expect(new Set(seen).size).toBe(3);
    expect(w.issued).toBeGreaterThanOrEqual(3);
  });

  it("connects the space index and every plan it lists, never local ones", async () => {
    const { f, m } = await started();
    expect([...f.providers.keys()].sort()).toEqual([IX, "P", "P2"].sort());
    expect(f.all.every((p) => p.connects() === 1)).toBe(true);
    expect(m.state()).toMatchObject({ kind: "syncing" });
    syncAll(f);
    expect(m.state()).toEqual({ kind: "synced" });
    expect(chipText(m.state(), () => null)).toBe("Synced");
  });

  it("a failed ticket disconnects first and retries after 1 s, then 2 s", async () => {
    const { f, m } = await started({
      before: (w) => {
        const ok = w.ticket;
        w.ticket = (doc) => (doc === "P" ? fail({ code: "sync.http", message: "No network connection." })() : ok(doc));
      },
    });
    const p = prov(f, "P");
    expect(p.calls).toEqual(["connect", "disconnect"]);
    expect(errorOf(m.state())).toMatchObject({ code: "unreachable", doc: "P", since: NOW, message: "No network connection.", cause: "sync.http" });
    expect(chipText(m.state(), () => null)).toBe("Server unreachable since 14:02");
    await advance(999);
    expect(p.connects()).toBe(1);
    await advance(1);
    expect(p.connects()).toBe(2);
    await advance(1999);
    expect(p.connects()).toBe(2);
    await advance(1);
    expect(p.connects()).toBe(3);
    expect(marks(0)).toBe(0);
  });

  it("a stale 403 is only unreachable", async () => {
    const { f, m } = await started({
      before: (w) => {
        w.ticket = fail({ code: "sync.http", message: "Server answered 403 revoked: This device was removed from the space." });
      },
    });
    expect(errorOf(m.state()).code).toBe("unreachable");
    expect(marks(0)).toBe(0);
    expect(f.all.length).toBeGreaterThan(0);
  });

  it("a close before open shows unreachable, or offline without a network", async () => {
    const { w, f, m } = await started();
    prov(f, IX).closeWith(1006, "");
    expect(errorOf(m.state())).toMatchObject({ code: "unreachable", doc: IX, since: NOW });
    w.net.online = false;
    expect(m.state()).toEqual({ kind: "offline", waiting: 6 });
    expect(chipText(m.state(), () => null)).toBe("Offline — 6 changes waiting");
    w.net.online = true;
    prov(f, IX).emitStatus("connected");
    prov(f, IX).emitSynced(true);
    prov(f, "P").emitSynced(true);
    prov(f, "P2").emitSynced(true);
    expect(m.state()).toEqual({ kind: "synced" });
  });

  it("remote updates are persisted", async () => {
    const { f, seeded } = await started();
    if (seeded === null) throw new Error("no seed");
    const p = prov(f, "P");
    const from = tauri.calls.length;
    const a = itemNamed(seeded, "A");
    const log = new LogState(planRules);
    log.add(actionsOf(p.ydoc));
    const b = buildAction(ctxOf(log, "dev-B", TODAY, DEVICES), { t: "rename", item: a, name: "Remote" });
    p.deliver(remoteUpdate(p.ydoc, b.action.id, encodeAction(b.action)));
    await settle();
    expect(appendsTo(from, "P")).toHaveLength(1);
  });

  it("no space, no connect", async () => {
    const f = fakeFactory();
    const { m } = await started({ f, before: (w) => (w.status = () => ({ space: null, revoked: false })) });
    expect(m.state()).toEqual({ kind: "off" });
    expect(f.all).toHaveLength(0);
    expect(chipText({ kind: "off" }, () => null)).toBe("Local only");
  });

  it("with no space joined, the one space index on disk stays listed and openable", async () => {
    const f = fakeFactory();
    const { r, m } = await started({ f, before: (w) => (w.status = () => ({ space: null, revoked: false })) });
    expect(r.plans().filter((p) => p.space === SP).map((p) => p.id).sort()).toEqual(["P", "P2"]);
    const session = await r.session("P");
    expect(session.view().plan.name).toBe("Launch");
    expect(m.state()).toEqual({ kind: "off" });
    expect(f.all).toHaveLength(0);
  });

  it("with no space joined, a new plan goes into the local plan list, not the space index on disk", async () => {
    const { r } = await started({ before: (w) => (w.status = () => ({ space: null, revoked: false })) });
    expect(r.attachedSpace()).toBe(SP);
    const id = await r.createPlan("Fresh");
    expect(r.plans().find((p) => p.id === id)).toMatchObject({ space: null });
    expect(r.plans().filter((p) => p.space === SP).map((p) => p.id).sort()).toEqual(["P", "P2"]);
  });

  it("with no space joined and two space indexes on disk, nothing is attached and the error names both", async () => {
    const f = fakeFactory();
    const other = "sp111111111";
    const { r, m } = await started({
      f,
      before: (w) => {
        w.status = () => ({ space: null, revoked: false });
        seedIndex(w.mem, "ix-" + other, [ixAct("t-Q", [], [ip("Q", false)])]);
        seedPlan(w.mem, "Q", "Quay");
      },
    });
    expect(r.plans().some((p) => p.space !== null)).toBe(false);
    expect(errorOf(m.state())).toMatchObject({
      code: "failed",
      doc: null,
      message: `This device holds the plan lists of 2 spaces (${SP}, ${other}) and has joined none, so their plans are not listed. Join one of them with a code.`,
    });
    expect(f.all).toHaveLength(0);
  });

  it("a plan added to the space index on another device appears", async () => {
    const { r, f } = await started();
    syncAll(f);
    const spy = vi.spyOn(r, "session");
    const cb = vi.fn();
    r.subscribe(cb);
    remoteIndex(prov(f, IX), "s-S", [ip("S", false)]);
    await settle();
    expect(r.plans().filter((p) => p.id === "S")).toEqual([{ id: "S", name: null, trashed: false, loaded: false, space: SP, example: false }]);
    expect(cb).toHaveBeenCalled();
    const s = prov(f, "S");
    expect(s.connects()).toBe(1);
    cb.mockClear();
    s.deliver(Y.encodeStateAsUpdate(seedPlan(null, "S", "Bridge")));
    s.emitStatus("connected");
    s.emitSynced(true);
    await settle();
    expect(r.plans().find((p) => p.id === "S")?.name).toBe("Bridge");
    expect(cb).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("a plan created in the space syncs", async () => {
    const { r, f } = await started();
    const id = await r.createPlan("Alpha");
    await settle();
    const p = prov(f, id);
    expect(p.connects()).toBe(1);
    const fresh = new Y.Doc();
    p.sent.forEach((u) => Y.applyUpdate(fresh, u));
    const actions = actionsOf(fresh);
    expect(actions).toHaveLength(1);
    expect(actions[0].w.find((x) => x.u === "pn")?.v).toBe("Alpha");
  });

  it("names this device in the space index once", async () => {
    const { m } = await started();
    await settle();
    m.stop();
    await m.start();
    await settle();
    const dn = tauri.calls
      .filter((c) => c.cmd === "store_append" && new Headers(c.options?.headers).get("x-doc") === IX)
      .flatMap(xdocWrites)
      .filter((x) => x.u === "dn:dev-A");
    expect(dn).toEqual([own("dn:dev-A", "Mac")]);
  });

  it("remote actions never push", async () => {
    const w = world();
    seedIndex(w.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device")]);
    seedIndex(w.mem, IX, [ixAct("s-P", [], [ip("P", false)])]);
    const seeded = seedPlan(w.mem, "P", "Launch", { items: ["A", "B"], link: true });
    const r = await openRegistry();
    const f = fakeFactory();
    const m = managerOf(w, r, f);
    await m.start();
    await settle();
    syncAll(f);
    const session = await r.session("P");
    const a = itemNamed(seeded, "A");
    const b = itemNamed(seeded, "B");
    const p = prov(f, "P");
    const log = new LogState(planRules);
    log.add(actionsOf(p.ydoc));
    const sA = log.unit("s:" + a)?.value as unknown[];
    const sB = log.unit("s:" + b)?.value;
    const mine = actionsOf(p.ydoc).filter((x) => x.dev === "dev-A").length;
    p.deliver(remoteUpdate(p.ydoc, "rm-1", encodeAction(act("rm-1", headsOf(p.ydoc), [own("s:" + a, ["2026-11-20", ...sA.slice(1)])], { dev: "dev-B", lbl: "Move" }))));
    await settle();
    expect(actionsOf(p.ydoc).filter((x) => x.dev === "dev-A")).toHaveLength(mine);
    const after = new LogState(planRules);
    after.add(actionsOf(p.ydoc));
    expect(after.unit("s:" + b)?.value).toEqual(sB);
    expect(session.view().derived.conflicts.some((c) => c.kind === "early" && c.succ === b)).toBe(true);
  });

  it("an open session receiving out-of-order actions shows Receiving…", async () => {
    const { r, f, m } = await started();
    syncAll(f);
    await r.session("P");
    const p = prov(f, "P");
    p.deliver(remoteUpdate(p.ydoc, "orphan", encodeAction(act("orphan", ["missing-parent"], [own("pn", "Later")], { dev: "dev-B", lbl: "Rename plan" }))));
    await settle();
    expect(m.state()).toEqual({ kind: "receiving" });
    expect(chipText(m.state(), () => null)).toBe("Receiving…");
  });
});

describe("SyncManager: closes", () => {
  const syncedStart = async () => {
    const s = await started();
    syncAll(s.f);
    await settle();
    return s;
  };

  it("a 4413 close stops that doc only", async () => {
    const { r, f, m } = await syncedStart();
    prov(f, "P").closeWith(4413, "Too large to sync");
    expect(errorOf(m.state())).toMatchObject({
      code: "too-large",
      doc: "P",
      message: "This plan is too large to sync. It keeps working on this device; export it to keep a copy.",
    });
    expect(chipText(m.state(), NAME(r))).toBe("Too large to sync: Launch");
    await stopped(f, "P");
    expect(prov(f, IX).calls).not.toContain("disconnect");
    expect(prov(f, "P2").calls).not.toContain("disconnect");
  });

  it("a 1007 close shows rejected", async () => {
    const { r, f, m } = await syncedStart();
    prov(f, "P").closeWith(1007, "Malformed update");
    expect(errorOf(m.state())).toMatchObject({
      code: "rejected",
      doc: "P",
      message: "The server refused a change to “Launch” from this device. Update WebBoard, then try again.",
      cause: null,
    });
    expect(chipText(m.state(), NAME(r))).toBe("The server refused a change from this device — export this plan and check for an update");
    await stopped(f, "P");
    expect(prov(f, IX).calls).not.toContain("disconnect");
    expect(errorOf(m.state()).code).toBe("rejected");
  });

  it("a 1011 close is a server fault with Try again, before open and after", async () => {
    for (const start of [started, syncedStart]) {
      const { r, f, m } = await start();
      prov(f, "P").closeWith(1011, "Uncaught exception during session setup");
      expect(errorOf(m.state())).toMatchObject({
        code: "store-failed",
        doc: "P",
        since: NOW,
        message: "The server could not store a change to “Launch”. Try again; if it repeats, export it.",
        cause: null,
      });
      expect(chipText(m.state(), NAME(r))).toBe("Server could not store changes to “Launch” since 14:02");
      await stopped(f, "P");
      expect(prov(f, IX).calls).not.toContain("disconnect");
      const from = tauri.calls.length;
      await m.restart();
      await advance(60_000);
      expect(prov(f, "P").connects()).toBe(1);
      expect(tickets(from, "P")).toBe(1);
      syncAll(f);
      expect(m.state()).toEqual({ kind: "synced" });
      m.stop();
      await settle();
      await Promise.all(registries.splice(0).map((x) => x.close()));
    }
  });

  it("a 1007 on the plan list shows rejected", async () => {
    const { r, f, m } = await syncedStart();
    prov(f, IX).closeWith(1007, "Malformed update");
    expect(errorOf(m.state())).toMatchObject({
      code: "rejected",
      doc: IX,
      message: "The server refused a change from this device. Update WebBoard, then try again.",
    });
    expect(chipText(m.state(), NAME(r))).toBe("The server refused a change to the plan list — update WebBoard");
    await stopped(f, IX);
    const from = tauri.calls.length;
    await m.restart();
    await advance(60_000);
    expect(prov(f, IX).connects()).toBe(1);
    expect(tickets(from, IX)).toBe(1);
  });

  it("a 4413 on the plan list shows too-large", async () => {
    const { r, f, m } = await syncedStart();
    prov(f, IX).closeWith(4413, "Too large to sync");
    expect(errorOf(m.state())).toMatchObject({ code: "too-large", doc: IX, message: "The plan list is too large to sync. Plans keep working on this device." });
    expect(chipText(m.state(), NAME(r))).toBe("The plan list is too large to sync");
    await stopped(f, IX);
  });

  it("a 4500 close shows store-failed until that doc syncs again", async () => {
    const { r, f, m } = await syncedStart();
    prov(f, "P").closeWith(4500, "Server could not store the update");
    expect(errorOf(m.state())).toMatchObject({
      code: "store-failed",
      doc: "P",
      since: NOW,
      message: "The server could not store a change to “Launch”. Try again; if it repeats, export it.",
      cause: null,
    });
    expect(chipText(m.state(), NAME(r))).toBe("Server could not store changes to “Launch” since 14:02");
    await stopped(f, "P");
    expect(prov(f, IX).calls).not.toContain("disconnect");
    const from = tauri.calls.length;
    const old = prov(f, "P");
    await m.restart();
    await advance(60_000);
    const fresh = prov(f, "P");
    expect(fresh).not.toBe(old);
    expect(fresh.connects()).toBe(1);
    expect(commandsWith(from, "sync_ticket", { doc: "P" })).toBe(1);
    expect(errorOf(m.state()).code).toBe("store-failed");
    syncAll(f);
    expect(m.state()).toEqual({ kind: "synced" });
  });

  it("a 4500 close on the plan list", async () => {
    const { r, f, m } = await syncedStart();
    prov(f, IX).closeWith(4500, "Server could not store the update");
    expect(errorOf(m.state())).toMatchObject({ code: "store-failed", doc: IX, message: "The server could not store a change to the plan list. Try again." });
    expect(chipText(m.state(), NAME(r))).toBe("Server could not store changes since 14:02");
    await stopped(f, IX);
  });

  it("a close on a plan that never arrived says so", async () => {
    const cases: { code: number; reason: string; check(r: Registry, m: SyncManager): void }[] = [
      {
        code: 4413,
        reason: "Too large to sync",
        check: (r, m) => {
          expect(errorOf(m.state())).toMatchObject({ code: "too-large", doc: "S", message: "This plan is too large to send to this device. Export it on a device that has it." });
          expect(chipText(m.state(), NAME(r))).toBe("Too large to sync: a plan");
        },
      },
      {
        code: 1007,
        reason: "Malformed update",
        check: (r, m) => {
          expect(errorOf(m.state())).toMatchObject({ code: "rejected", doc: "S", message: "The server refused a change from this device. Update WebBoard, then try again." });
          expect(chipText(m.state(), NAME(r))).toBe("The server refused a change from this device — update WebBoard");
        },
      },
      {
        code: 4500,
        reason: "Server could not store the update",
        check: (r, m) => {
          expect(errorOf(m.state())).toMatchObject({ code: "store-failed", doc: "S", message: "The server could not store a change from this device. Try again." });
          expect(chipText(m.state(), NAME(r))).toBe("Server could not store changes since 14:02");
        },
      },
    ];
    for (const c of cases) {
      const { r, f, m } = await syncedStart();
      expect(holdsPlan(r, "P")).toBe(true);
      remoteIndex(prov(f, IX), "s-S", [ip("S", false)]);
      await settle();
      expect(holdsPlan(r, "S")).toBe(false);
      prov(f, "S").closeWith(c.code, c.reason);
      c.check(r, m);
      m.stop();
      await settle();
      await Promise.all(registries.splice(0).map((x) => x.close()));
    }
  });
});

describe("SyncManager: removal", () => {
  it("a restart while revoked stays removed", async () => {
    const f = fakeFactory();
    const { r, m } = await started({
      f,
      before: (w) => {
        w.status = () => ({ space: SPACE, revoked: true });
        w.ticket = fail({ code: "sync.http", message: "No network connection." });
      },
    });
    expect(m.state()).toEqual({ kind: "error", code: "revoked", since: NOW, doc: null, waiting: 0, message: null, cause: null, op: null });
    expect(chipText(m.state(), NAME(r))).toBe("Device removed");
    expect(f.all).toHaveLength(0);
    expect(tickets(0, IX) + tickets(0, "P")).toBe(0);
    const p = await r.session("P");
    expect(p.readOnly).toBe(true);
    const from = tauri.calls.length;
    const a = p.view().plan.items.keys().next().value as ItemId;
    expect(() => p.apply({ t: "rename", item: a, name: "Kickoff" })).toThrow(new Refused(READ_ONLY));
    await settle();
    expect(appendsTo(from, "P")).toHaveLength(0);
    expect((await r.session("L")).readOnly).toBe(false);
  });

  it("a revoked start with a damaged space index stays removed", async () => {
    const f = fakeFactory();
    const { r, m } = await started({
      f,
      before: (w) => {
        w.status = () => ({ space: SPACE, revoked: true });
        w.mem.fail("store_load", IX, { code: "store.corrupt", message: "Bad record in seg-0.log." });
      },
    });
    expect(errorOf(m.state()).code).toBe("revoked");
    expect(r.indexError()?.code).toBe("store.corrupt");
    expect(f.all).toHaveLength(0);
  });

  it("a session opened after a 4403 close is read-only", async () => {
    const { w, r, f, m } = await started();
    syncAll(f);
    const p = await r.session("P");
    const cb = vi.fn();
    p.subscribe(cb);
    expect(r.spaceReadOnly()).toBe(false);
    prov(f, IX).closeWith(4403, "Device removed");
    await settle();
    expect(marks(0)).toBe(1);
    expect(errorOf(m.state()).code).toBe("revoked");
    expect(f.all.every((x) => x.calls.includes("disconnect"))).toBe(true);
    expect(p.readOnly).toBe(true);
    expect(cb).toHaveBeenCalled();
    expect(r.spaceReadOnly()).toBe(true);
    expect((await r.session("P2")).readOnly).toBe(true);
    m.stop();
    w.status = () => ({ space: SPACE, revoked: true });
    w.ticket = fail({ code: "sync.http", message: "No network connection." });
    const made = f.all.length;
    await m.start();
    await settle();
    expect(errorOf(m.state()).code).toBe("revoked");
    expect(f.all).toHaveLength(made);
    await p.close();
    expect((await r.session("P")).readOnly).toBe(true);
  });

  it("a failed revoke save still shows removed", async () => {
    const { r, f, m } = await started({
      before: (w) => (w.mark = fail({ code: "sync.io", message: "Could not save the sync state: Permission denied (os error 13)" })),
    });
    syncAll(f);
    const p = await r.session("P");
    prov(f, IX).closeWith(4403, "Device removed");
    await settle();
    expect(errorOf(m.state())).toMatchObject({ code: "revoked", message: "Could not save the sync state: Permission denied (os error 13)" });
    expect(chipText(m.state(), NAME(r))).toBe("Device removed");
    expect(f.all.every((x) => x.calls.includes("disconnect"))).toBe(true);
    expect(p.readOnly).toBe(true);
  });

  it("a revoke on a device that left the space shows failed", async () => {
    const { r, f, m } = await started({
      before: (w) => (w.mark = fail({ code: "sync.not_joined", message: "This device is not in a space yet. Set up sync or join with a code." })),
    });
    syncAll(f);
    prov(f, IX).closeWith(4403, "Device removed");
    await settle();
    expect(errorOf(m.state())).toMatchObject({ code: "failed", doc: null, message: "This device is not in a space yet. Set up sync or join with a code.", cause: "sync.not_joined" });
    expect(f.all.every((x) => x.calls.includes("disconnect"))).toBe(true);
    expect(r.spaceReadOnly()).toBe(false);
  });

  it("joining again re-admits", async () => {
    const f = fakeFactory();
    const { w, r, m, seeded } = await started({ f, before: (x) => (x.status = () => ({ space: SPACE, revoked: true })) });
    if (seeded === null) throw new Error("no seed");
    const p = await r.session("P");
    expect(p.readOnly).toBe(true);
    const cb = vi.fn();
    p.subscribe(cb);
    w.status = () => ({ space: SPACE, revoked: false });
    m.stop();
    await m.start();
    await settle();
    expect(m.state()).toEqual({ kind: "syncing" });
    expect([...f.providers.keys()]).toEqual(expect.arrayContaining([IX, "P"]));
    expect(p.readOnly).toBe(false);
    expect(cb).toHaveBeenCalled();
    const from = tauri.calls.length;
    p.apply({ t: "rename", item: itemNamed(seeded, "A"), name: "Kickoff" });
    await settle();
    expect(appendsTo(from, "P")).toHaveLength(1);
    const before = marks(0);
    prov(f, IX).closeWith(4403, "Device removed");
    await settle();
    expect(marks(0)).toBe(before + 1);
  });

  it("sync.revoked from a command takes the revoked path", async () => {
    const { f, m } = await started({ before: (w) => (w.ticket = fail({ code: "sync.revoked", message: "This device was removed from the space." })) });
    expect(marks(0)).toBe(1);
    expect(errorOf(m.state()).code).toBe("revoked");
    for (const doc of f.providers.keys()) await stopped(f, doc);

    const second = await started();
    syncAll(second.f);
    const from = tauri.calls.length;
    await second.m.markRevoked();
    await settle();
    expect(marks(from)).toBe(1);
    expect(errorOf(second.m.state()).code).toBe("revoked");
    for (const doc of second.f.providers.keys()) await stopped(second.f, doc);
    await second.m.markRevoked();
    expect(marks(from)).toBe(1);
  });
});

describe("SyncManager: command errors", () => {
  const STOPPED_ALL = async (f: FakeFactory): Promise<void> => {
    for (const doc of f.providers.keys()) await stopped(f, doc);
  };

  it("the keychain failing shows keychain", async () => {
    const errors = [
      { code: "keychain.unavailable", message: "No Secret Service is running, so the device token cannot be stored. Start a Secret Service such as GNOME Keyring for this session, then set up sync again." },
      { code: "keychain.io", message: "The keychain refused access: errSecAuthFailed." },
    ];
    for (const e of errors) {
      const { r, f, m } = await started({ before: (w) => (w.ticket = fail(e)) });
      expect(errorOf(m.state())).toMatchObject({ code: "keychain", message: e.message, cause: e.code });
      expect(chipText(m.state(), NAME(r))).toBe("Keychain unavailable");
      await STOPPED_ALL(f);
      m.stop();
      await settle();
      await Promise.all(registries.splice(0).map((x) => x.close()));
    }
  });

  it("a missing sync key shows unauthorized", async () => {
    const message = "This device has no sync key. Join the space again with a pairing code.";
    const { r, f, m } = await started({ before: (w) => (w.ticket = fail({ code: "keychain.missing", message })) });
    expect(errorOf(m.state())).toMatchObject({ code: "unauthorized", message });
    expect(chipText(m.state(), NAME(r))).toBe("Not in the space — set up sync again");
    await STOPPED_ALL(f);
  });

  it("an unknown device shows unauthorized", async () => {
    const message = "This device is not known to the space. Set up sync again.";
    const { f, m } = await started({ before: (w) => (w.ticket = fail({ code: "sync.unauthorized", message })) });
    expect(errorOf(m.state())).toMatchObject({ code: "unauthorized", message });
    await STOPPED_ALL(f);
  });

  it("a failed sync_status shows the error", async () => {
    const f = fakeFactory();
    const { r, m } = await started({ f, before: (w) => (w.status = fail({ code: "sync.io", message: "Could not read the sync state: invalid JSON" })) });
    expect(m.state()).toEqual({
      kind: "error",
      code: "local-failed",
      since: NOW,
      doc: null,
      waiting: 0,
      message: "Could not read the sync state: invalid JSON Reset sync, then join with a code again.",
      cause: "sync.io",
      op: null,
    });
    expect(chipText(m.state(), NAME(r))).toBe("Sync state on this device could not be read");
    expect(f.all).toHaveLength(0);
  });

  it("a sync.io from a ticket reads as a broken sync state", async () => {
    const { r, f, m } = await started({ before: (w) => (w.ticket = fail({ code: "sync.io", message: "Could not read the sync state: invalid JSON" })) });
    expect(errorOf(m.state())).toMatchObject({
      code: "local-failed",
      doc: null,
      message: "Could not read the sync state: invalid JSON Reset sync, then join with a code again.",
      cause: "sync.io",
      op: null,
    });
    expect(chipText(m.state(), NAME(r))).toBe("Sync state on this device could not be read");
    await STOPPED_ALL(f);
  });

  it("a broken sync state keeps the one space index", async () => {
    const broken = fail({ code: "sync.io", message: "Could not read the sync state: invalid JSON" });
    const seedBroken = (w: World): void => {
      seedIndex(w.mem, "local", [
        ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"),
        ixAct("l-P", ["l-n"], [ip("P", false)]),
        ixAct("l-Pt", ["l-P"], [ip("P", true)], "dev-A", "Move plan to Trash"),
        ixAct("l-L", ["l-Pt"], [ip("L", false)]),
      ]);
      seedPlan(w.mem, "P", "Launch", { items: ["A"] });
      seedPlan(w.mem, "L", "Lone");
      w.status = broken;
    };
    const f = fakeFactory();
    const one = await started({
      f,
      base: false,
      before: (w) => {
        seedBroken(w);
        seedIndex(w.mem, IX, [ixAct("s-P", [], [ip("P", false)])]);
      },
    });
    const listedP = one.r.plans().filter((p) => p.id === "P");
    expect(listedP).toHaveLength(1);
    expect(listedP[0]).toMatchObject({ trashed: false, space: SP });
    expect(one.r.plans().find((p) => p.id === "L")?.space).toBeNull();
    const session = await one.r.session("P");
    expect(session.readOnly).toBe(false);
    const from = tauri.calls.length;
    session.apply({ t: "rename", item: session.view().plan.items.keys().next().value as ItemId, name: "Kickoff" });
    await settle();
    expect(appendsTo(from, "P")).toHaveLength(1);
    expect(errorOf(one.m.state())).toMatchObject({ code: "local-failed", doc: null, cause: "sync.io" });
    expect(f.all).toHaveLength(0);
    expect(tauri.calls.filter((c) => c.cmd === "sync_ticket")).toHaveLength(0);
    await one.m.start();
    await settle();
    expect(commandsWith(0, "store_load", { doc: IX })).toBe(1);
    one.m.stop();
    await settle();
    await Promise.all(registries.splice(0).map((x) => x.close()));

    const two = world();
    seedBroken(two);
    seedIndex(two.mem, IX, [ixAct("s-P", [], [ip("P", false)])]);
    seedIndex(two.mem, "ix-sp111111111", [ixAct("t-P", [], [ip("P", false)])]);
    const r2 = await openRegistry();
    const attach2 = vi.spyOn(r2, "attachSpace");
    const m2 = managerOf(two, r2, fakeFactory());
    await m2.start();
    await settle();
    expect(attach2).not.toHaveBeenCalled();
    expect(r2.plans().find((p) => p.id === "P")).toMatchObject({ trashed: true, space: null });
    expect(errorOf(m2.state())).toMatchObject({ code: "local-failed", doc: null, cause: "sync.io" });
    m2.stop();
    await settle();
    await Promise.all(registries.splice(0).map((x) => x.close()));

    const three = world();
    seedBroken(three);
    const r3 = await openRegistry();
    const attach3 = vi.spyOn(r3, "attachSpace");
    const m3 = managerOf(three, r3, fakeFactory());
    await m3.start();
    await settle();
    expect(attach3).not.toHaveBeenCalled();
    expect(errorOf(m3.state())).toMatchObject({ code: "local-failed", doc: null, cause: "sync.io" });
  });

  it("a failed space index never shows synced", async () => {
    const cases = [
      { e: { code: "store.corrupt", message: "Bad record in seg-0.log." }, chip: "The space’s plan list on this device is damaged" },
      { e: { code: "store.io", message: "Disk full." }, chip: "The space’s plan list on this device could not be read" },
      { e: { code: "store.locked", message: "The plan list is open in another WebBoard process; close it there first." }, chip: "The space’s plan list on this device could not be read" },
    ];
    for (const c of cases) {
      const f = fakeFactory();
      const { w, r, m } = await started({ f, before: (x) => x.mem.fail("store_load", IX, c.e) });
      expect(m.state()).toEqual({ kind: "error", code: "local-failed", since: NOW, doc: IX, waiting: 0, message: c.e.message, cause: c.e.code, op: "load" });
      expect(chipText(m.state(), NAME(r))).toBe(c.chip);
      expect(f.all).toHaveLength(0);
      w.mem.recover("store_load", IX);
      await r.retryIndex();
      await settle();
      expect(prov(f, IX).connects()).toBe(1);
      expect(m.state()).toEqual({ kind: "syncing" });
      m.stop();
      await settle();
      await Promise.all(registries.splice(0).map((x) => x.close()));
    }
  });

  it("a failed plan list save shows could not be saved", async () => {
    const { w, r, f, m } = await started();
    syncAll(f);
    await settle();
    w.mem.fail("store_append", IX, { code: "store.io", message: "Disk full." });
    remoteIndex(prov(f, IX), "s-S", [ip("S", false)]);
    await settle();
    expect(m.state()).toEqual({ kind: "error", code: "local-failed", since: NOW, doc: IX, waiting: 0, message: "Disk full.", cause: "store.io", op: "save" });
    expect(chipText(m.state(), NAME(r))).toBe("The space’s plan list on this device could not be saved");
    expect(f.all.some((p) => p.calls.includes("disconnect"))).toBe(false);
    prov(f, "S").emitStatus("connected");
    prov(f, "S").emitSynced(true);
    w.mem.recover("store_append", IX);
    await r.retryIndex();
    await settle();
    expect(m.state()).toEqual({ kind: "synced" });
  });

  it("a rate limit waits, then retries", async () => {
    const waits = [
      { message: "Try again in 2 minutes.", ms: 120_000 },
      { message: "Try again in 1 minute.", ms: 60_000 },
      { message: "Daily limit reached. Try again later.", ms: 300_000 },
    ];
    for (const x of waits) {
      let first = true;
      const { r, f, m } = await started({
        before: (w) => {
          const ok = w.ticket;
          w.ticket = (doc) => {
            if (doc === "P" && first) {
              first = false;
              return fail({ code: "sync.rate_limited", message: x.message })();
            }
            return ok(doc);
          };
        },
      });
      expect(errorOf(m.state())).toMatchObject({ code: "limited", message: x.message });
      expect(chipText(m.state(), NAME(r))).toBe("Server asked to wait — retrying");
      const p = prov(f, "P");
      expect(p.connects()).toBe(1);
      await advance(x.ms - 1000);
      expect(p.connects()).toBe(1);
      await advance(1000);
      expect(p.connects()).toBe(2);
      m.stop();
      await settle();
      await Promise.all(registries.splice(0).map((y) => y.close()));
    }
  });

  it("an unconfigured server stops", async () => {
    const message = "Sync is not set up on the server: its owner runs wrangler secret put SETUP_SECRET.";
    const { r, f, m } = await started({ before: (w) => (w.ticket = fail({ code: "sync.not_configured", message })) });
    expect(errorOf(m.state())).toMatchObject({ code: "not-configured", message });
    expect(chipText(m.state(), NAME(r))).toBe("Sync is not set up on the server");
    await STOPPED_ALL(f);
  });

  it("an unmapped rejection stops that doc", async () => {
    const errors = [
      { code: "ipc.failed", message: "sync_ticket: channel closed" },
      { code: "sync.not_joined", message: "This device is not in a space yet. Set up sync or join with a code." },
      { code: "sync.bad_code", message: "That pairing code is not valid." },
    ];
    for (const e of errors) {
      const { r, f, m } = await started({
        before: (w) => {
          const ok = w.ticket;
          w.ticket = (doc) => (doc === IX ? fail(e)() : ok(doc));
        },
      });
      expect(m.state()).toEqual({ kind: "error", code: "failed", since: NOW, doc: IX, waiting: 6, message: e.message, cause: e.code, op: null });
      expect(chipText(m.state(), NAME(r))).toBe(`Sync stopped: ${e.message}`);
      expect(prov(f, IX).calls).toContain("disconnect");
      const from = tauri.calls.length;
      await advance(300_000);
      expect(tickets(from, IX)).toBe(0);
      await m.restart();
      await advance(60_000);
      expect(tickets(from, IX)).toBe(1);
      m.stop();
      await settle();
      await Promise.all(registries.splice(0).map((y) => y.close()));
    }
    const f = fakeFactory();
    const { m } = await started({ f, before: (w) => (w.status = fail({ code: "ipc.failed", message: "sync_status: channel closed" })) });
    expect(m.state()).toEqual({ kind: "error", code: "failed", since: NOW, doc: null, waiting: 0, message: "sync_status: channel closed", cause: "ipc.failed", op: null });
    expect(f.all).toHaveLength(0);
  });

  it("a malformed sync_status answer shows failed", async () => {
    const f = fakeFactory();
    const { m } = await started({ f, before: (w) => (w.status = () => "not a status") });
    expect(errorOf(m.state())).toMatchObject({ code: "failed", doc: null, message: "sync_status answered an unexpected shape", cause: "ipc.shape" });
    expect(f.all).toHaveLength(0);
  });

  it("a programming error rejects start", async () => {
    const w = world();
    seedBase(w);
    const r = await openRegistry();
    vi.spyOn(r, "attachSpace").mockRejectedValue(new Error("boom"));
    const m = managerOf(w, r, fakeFactory());
    await expect(m.start()).rejects.toThrow("boom");
  });
});

describe("SyncManager: waiting and offline", () => {
  it("waiting changes survive a restart", async () => {
    const { w, r, f, m, seeded } = await started();
    if (seeded === null) throw new Error("no seed");
    syncAll(f);
    await settle();
    const heads = r.syncedHeads("P");
    expect(heads).toEqual(headsOf(prov(f, "P").ydoc));
    expect((w.settings.value as { syncedHeads: Record<string, unknown> }).syncedHeads.P).toEqual(heads);
    w.net.online = false;
    prov(f, "P").emitStatus("disconnected");
    const s = await r.session("P");
    const a = itemNamed(seeded, "A");
    s.apply({ t: "rename", item: a, name: "One" });
    s.apply({ t: "rename", item: a, name: "Two" });
    await settle();
    expect(chipText(m.state(), NAME(r))).toBe("Offline — 2 changes waiting");
    m.stop();
    await settle();
    await Promise.all(registries.splice(0).map((x) => x.close()));
    const r2 = await openRegistry();
    const f2 = fakeFactory();
    const m2 = managerOf(w, r2, f2);
    await m2.start();
    await settle();
    expect(chipText(m2.state(), NAME(r2))).toBe("Offline — 2 changes waiting");
    w.net.online = true;
    syncAll(f2);
    await settle();
    expect(chipText(m2.state(), NAME(r2))).toBe("Synced");
    expect(r2.syncedHeads("P")).toEqual(headsOf(prov(f2, "P").ydoc));
  });

  it("going offline shows Offline without a provider event", async () => {
    const { w, r, f, m, seeded } = await started();
    if (seeded === null) throw new Error("no seed");
    syncAll(f);
    await settle();
    w.net.online = false;
    [...w.net.cbs].forEach((cb) => cb());
    expect(chipText(m.state(), NAME(r))).toBe("Offline");
    const s = await r.session("P");
    s.apply({ t: "rename", item: itemNamed(seeded, "A"), name: "One" });
    await settle();
    expect(chipText(m.state(), NAME(r))).toBe("Offline — 1 change waiting");
    w.net.online = true;
    [...w.net.cbs].forEach((cb) => cb());
    expect(chipText(m.state(), NAME(r))).toBe("Synced");
    m.stop();
    expect(w.net.removed).toBe(1);
  });

  it("subscribers hear every change and the state is stable between changes", async () => {
    const { f, m } = await started();
    const cb = vi.fn();
    const off = m.subscribe(cb);
    expect(m.state()).toBe(m.state());
    syncAll(f);
    expect(cb).toHaveBeenCalled();
    off();
    cb.mockClear();
    prov(f, "P").emitSynced(false);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("SyncManager: loading again from the server", () => {
  it("a corrupt space plan loads again from the server", async () => {
    const remoteState = seedPlan(null, "P", "From server");
    const corrupt = { code: "store.corrupt", message: "P: a record is damaged" };
    const { w, r, f } = await started({ before: (x) => x.mem.fail("store_load", "P", corrupt) });
    expect(r.failures().get("P")?.code).toBe("store.corrupt");
    expect(f.providers.has("P")).toBe(false);
    w.mem.recover("store_load", "P");
    const from = tauri.calls.length;
    await r.reloadFromServer("P");
    await settle();
    expect(tauri.calls.slice(from).filter((c) => c.cmd === "store_set_aside").map((c) => c.args)).toEqual([{ doc: "P" }]);
    const p = prov(f, "P");
    expect(p.connects()).toBe(1);
    expect(p.ydoc).toBe((await r.doc("P")).ydoc);
    p.deliver(Y.encodeStateAsUpdate(remoteState));
    p.emitStatus("connected");
    p.emitSynced(true);
    await settle();
    expect((await r.session("P")).view().plan.name).toBe("From server");
    expect(appendsTo(from, IX)).toHaveLength(0);
    expect(appendsTo(from, "local")).toHaveLength(0);
  });

  it("a reloaded doc gets a new provider on its new ydoc", async () => {
    const { r, f } = await started();
    syncAll(f);
    const old = prov(f, "P");
    await r.reloadFromServer("P");
    await settle();
    expect(old.calls).toContain("destroy");
    const fresh = prov(f, "P");
    expect(fresh).not.toBe(old);
    expect(fresh.connects()).toBe(1);
    expect(fresh.ydoc).toBe((await r.doc("P")).ydoc);
    expect(fresh.ydoc).not.toBe(old.ydoc);
  });
});

describe("SyncManager: sent changes", () => {
  const renames = (s: { apply(i: { t: "rename"; item: ItemId; name: string }): unknown }, item: ItemId, names: readonly string[]): void =>
    names.forEach((name) => s.apply({ t: "rename", item, name }));

  const fire = (w: World, online: boolean): void => {
    w.net.online = online;
    [...w.net.cbs].forEach((cb) => cb());
  };

  it("a change made while connected and synced counts as sent", async () => {
    const { w, r, f, m, seeded } = await started();
    if (seeded === null) throw new Error("no seed");
    syncAll(f);
    await settle();
    const a = itemNamed(seeded, "A");
    renames(await r.session("P"), a, ["One", "Two", "Three"]);
    await settle();
    w.net.online = false;
    prov(f, "P").emitStatus("disconnected");
    expect(m.state()).toEqual({ kind: "offline", waiting: 0 });
    expect(chipText(m.state(), NAME(r))).toBe("Offline");
    expect(r.syncedHeads("P")).toEqual(headsOf(prov(f, "P").ydoc));
    m.stop();
    await settle();
    await Promise.all(registries.splice(0).map((x) => x.close()));

    const r2 = await openRegistry();
    const f2 = fakeFactory();
    const m2 = managerOf(w, r2, f2);
    await m2.start();
    await settle();
    expect(m2.state()).toEqual({ kind: "offline", waiting: 0 });
    renames(await r2.session("P"), a, ["Four", "Five", "Six"]);
    await settle();
    expect(chipText(m2.state(), NAME(r2))).toBe("Offline — 3 changes waiting");
  });

  it("a change made before the doc is synced waits until it is", async () => {
    const { w, r, f, m, seeded } = await started();
    if (seeded === null) throw new Error("no seed");
    syncAll(f);
    await settle();
    const p = prov(f, "P");
    p.emitStatus("disconnected");
    p.emitStatus("connected");
    renames(await r.session("P"), itemNamed(seeded, "A"), ["One", "Two", "Three"]);
    await settle();
    fire(w, false);
    expect(chipText(m.state(), NAME(r))).toBe("Offline — 3 changes waiting");
    fire(w, true);
    p.emitSynced(true);
    await settle();
    fire(w, false);
    expect(chipText(m.state(), NAME(r))).toBe("Offline");
  });

  it("an unreadable action by this device always waits", async () => {
    const { w, r, f, m } = await started();
    prov(f, "P").ydoc.getMap("actions").set("bad-1", ["dev-A", "s1", 0, [], 42, []]);
    syncAll(f);
    await settle();
    fire(w, false);
    expect(chipText(m.state(), NAME(r))).toBe("Offline — 1 change waiting");
  });
});

describe("SyncManager: loading the space index again", () => {
  it("the space index attaches again after a notify while it was released", async () => {
    const { w, r, f, m } = await started();
    syncAll(f);
    await settle();
    w.mem.fail("store_append", IX, { code: "store.io", message: "Disk full." });
    remoteIndex(prov(f, IX), "s-S", [ip("S", false)]);
    await settle();
    expect(errorOf(m.state())).toMatchObject({ code: "local-failed", doc: IX, op: "save" });
    w.mem.recover("store_append", IX);
    const old = prov(f, IX);
    const held = hold("store_set_aside");
    const reload = r.reloadFromServer(IX);
    await settle();
    await r.retrySettings();
    await settle();
    held.resolve(null);
    await reload;
    await settle();
    const fresh = prov(f, IX);
    expect(fresh).not.toBe(old);
    expect(fresh.connects()).toBe(1);
    expect(fresh.ydoc).toBe((await r.doc(IX)).ydoc);
    syncAll(f);
    await settle();
    expect(m.state()).toEqual({ kind: "synced" });
    remoteIndex(fresh, "s-T", [ip("T", false)]);
    await settle();
    expect(prov(f, "T").connects()).toBe(1);
  });

  it("a plan's old provider stops before the plan is released", async () => {
    const { r, f } = await started();
    syncAll(f);
    await settle();
    const old = prov(f, "P");
    const held = hold("store_set_aside");
    const reload = r.reloadFromServer("P");
    await settle();
    expect(old.calls).toContain("destroy");
    const from = tauri.calls.length;
    const late = remoteUpdate(old.ydoc, "late-1", encodeAction(act("late-1", headsOf(old.ydoc), [own("pn", "Late")], { dev: "dev-B", lbl: "Rename plan" })));
    expect(() => old.deliver(late)).not.toThrow();
    expect(old.ydoc.getMap("actions").has("late-1")).toBe(false);
    await settle();
    expect(appendsTo(from, "P")).toHaveLength(0);
    held.resolve(null);
    await reload;
    await settle();
    const fresh = prov(f, "P");
    expect(fresh).not.toBe(old);
    expect(fresh.connects()).toBe(1);
    expect(fresh.ydoc).toBe((await r.doc("P")).ydoc);
  });

  it("a reload destroys the old provider while its doc is still open", async () => {
    const { r, f } = await started();
    syncAll(f);
    await settle();
    const old = prov(f, "P");
    const d = await r.doc("P");
    const openAtDestroy: boolean[] = [];
    const destroy = old.destroy.bind(old);
    old.destroy = () => {
      try {
        d.ydoc.getMap("probe").set("k", 1);
        openAtDestroy.push(true);
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== "store.closed") throw e;
        openAtDestroy.push(false);
      }
      destroy();
    };
    const held = hold("store_set_aside");
    const reload = r.reloadFromServer("P");
    await settle();
    expect(openAtDestroy).toEqual([true]);
    held.resolve(null);
    await reload;
  });

  it("this space index's own error is shown when the local one fails too", async () => {
    const { w, r, f, m } = await started();
    syncAll(f);
    await settle();
    w.mem.fail("store_append", "local", { code: "store.io", message: "Local disk full." });
    r.trashPlan("L");
    await settle();
    expect(r.indexErrorDoc()).toBe("local");
    w.mem.fail("store_append", IX, { code: "store.io", message: "Disk full." });
    remoteIndex(prov(f, IX), "s-S", [ip("S", false)]);
    await settle();
    expect(errorOf(m.state())).toMatchObject({ code: "local-failed", doc: IX, message: "Disk full.", cause: "store.io", op: "save" });
    w.mem.recover("store_append", "local");
    w.mem.recover("store_append", IX);
    await r.retryIndex();
    await settle();
    expect(r.indexError()).toBeNull();
    m.stop();
    await settle();
    await Promise.all(registries.splice(0).map((x) => x.close()));

    const two = await started();
    syncAll(two.f);
    await settle();
    two.w.mem.fail("store_append", "local", { code: "store.io", message: "Local disk full." });
    two.r.trashPlan("L");
    await settle();
    two.w.mem.fail("store_load", IX, { code: "store.corrupt", message: "Bad record in seg-0.log." });
    await expect(two.r.reloadFromServer(IX)).rejects.toMatchObject({ code: "store.corrupt" });
    await settle();
    expect(errorOf(two.m.state())).toMatchObject({ code: "local-failed", doc: IX, message: "Bad record in seg-0.log.", cause: "store.corrupt", op: "load" });
    const old = prov(two.f, IX);
    two.w.mem.recover("store_append", "local");
    two.w.mem.recover("store_load", IX);
    await two.r.retryIndex();
    await settle();
    expect(two.r.indexError()).toBeNull();
    expect(prov(two.f, IX)).not.toBe(old);
    expect(prov(two.f, IX).connects()).toBe(1);
  });
});

describe("SyncManager: fault handling", () => {
  it("a rate limit with no readable wait stops that doc", async () => {
    const { r, f, m } = await started({
      before: (w) => {
        const ok = w.ticket;
        w.ticket = (doc) => (doc === "P" ? fail({ code: "sync.rate_limited", message: "Slow down." })() : ok(doc));
      },
    });
    expect(m.state()).toEqual({ kind: "error", code: "failed", since: NOW, doc: "P", waiting: 6, message: "Slow down.", cause: "sync.rate_limited", op: null });
    expect(chipText(m.state(), NAME(r))).toBe("Sync stopped: Slow down.");
    await stopped(f, "P");
  });

  it("a carried store failure outranks unreachable", async () => {
    const { w, r, f, m } = await started();
    syncAll(f);
    await settle();
    prov(f, "P").closeWith(4500, "Server could not store the update");
    w.ticket = fail({ code: "sync.http", message: "No network connection." });
    await m.restart();
    await settle();
    expect(errorOf(m.state())).toMatchObject({ code: "store-failed", doc: "P" });
    expect(chipText(m.state(), NAME(r))).toBe("Server could not store changes to “Launch” since 14:02");
  });

  it("the state reads removed while the mark is in flight", async () => {
    const { r, f, m } = await started();
    syncAll(f);
    await settle();
    const held = hold("sync_mark_revoked");
    const marking = m.markRevoked();
    expect(errorOf(m.state()).code).toBe("revoked");
    expect(chipText(m.state(), NAME(r))).toBe("Device removed");
    held.resolve(null);
    await marking;
    expect(errorOf(m.state())).toMatchObject({ code: "revoked", message: null });
  });

  it("a revoked ticket wins over a concurrent keychain failure", async () => {
    const later = (e: Err, ms: number): Promise<never> => new Promise((_, reject) => setTimeout(() => reject({ ...e }), ms));
    const { f, m } = await started({
      before: (w) => {
        w.ticket = (doc) =>
          doc === IX
            ? later({ code: "keychain.unavailable", message: "No Secret Service is running." }, 5)
            : later({ code: "sync.revoked", message: "This device was removed from the space." }, 10);
      },
    });
    expect([...f.providers.keys()].sort()).toEqual([IX, "P", "P2"].sort());
    await advance(5);
    expect(errorOf(m.state()).code).toBe("keychain");
    await advance(5);
    expect(marks(0)).toBe(1);
    expect(errorOf(m.state()).code).toBe("revoked");
  });

  it("a revoke marked after stop still makes the space read-only", async () => {
    const one = await started();
    syncAll(one.f);
    const failing = hold("sync_mark_revoked");
    const marking = one.m.markRevoked();
    one.m.stop();
    const saveFailed = { code: "sync.io", message: "Could not save the sync state: Permission denied (os error 13)" };
    failing.reject(saveFailed);
    await expect(marking).rejects.toMatchObject(saveFailed);
    expect(one.r.spaceReadOnly()).toBe(true);
    await settle();
    await Promise.all(registries.splice(0).map((x) => x.close()));

    const two = await started();
    syncAll(two.f);
    const ok = hold("sync_mark_revoked");
    const marked = two.m.markRevoked();
    two.m.stop();
    ok.resolve(null);
    await marked;
    expect(two.r.spaceReadOnly()).toBe(true);
  });

  it("a revoke that lands while start reads the status keeps the space read-only", async () => {
    const w = world();
    seedBase(w);
    const r = await openRegistry();
    const f = fakeFactory();
    const m = managerOf(w, r, f);
    const status = hold("sync_status");
    const starting = m.start();
    await settle();
    await m.markRevoked();
    expect(r.spaceReadOnly()).toBe(true);
    const from = tauri.calls.length;
    status.resolve({ space: SPACE, revoked: false });
    await starting;
    await settle();
    expect(r.spaceReadOnly()).toBe(true);
    expect(errorOf(m.state())).toMatchObject({ code: "revoked", message: null });
    expect(chipText(m.state(), NAME(r))).toBe("Device removed");
    expect(f.all).toHaveLength(0);
    expect(tickets(from, IX) + tickets(from, "P")).toBe(0);
    expect(appendsTo(from, IX)).toHaveLength(0);
    expect(r.plans().find((p) => p.id === "P")?.space).toBe(SP);
    const p = await r.session("P");
    expect(p.readOnly).toBe(true);
  });

  it("a revoke that lands while start attaches names nothing in the space", async () => {
    const w = world();
    seedBase(w);
    const r = await openRegistry();
    const m = managerOf(w, r, fakeFactory());
    const attach = r.attachSpace.bind(r);
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    vi.spyOn(r, "attachSpace").mockImplementation(async (spaceId) => {
      await gate;
      return attach(spaceId);
    });
    const starting = m.start();
    await settle();
    await m.markRevoked();
    const from = tauri.calls.length;
    open();
    await starting;
    await settle();
    expect(appendsTo(from, IX)).toHaveLength(0);
    expect(r.spaceReadOnly()).toBe(true);
    expect(errorOf(m.state()).code).toBe("revoked");
  });

  it("an attach error the registry did not record is not swallowed", async () => {
    const cases: ((w: World) => void)[] = [
      (w) => (w.status = () => ({ space: SPACE, revoked: true })),
      (w) => (w.status = fail({ code: "sync.io", message: "Could not read the sync state: invalid JSON" })),
    ];
    for (const set of cases) {
      const w = world();
      seedBase(w);
      set(w);
      const r = await openRegistry();
      const stray = new AppError("store.io", "Not recorded anywhere.");
      vi.spyOn(r, "attachSpace").mockRejectedValue(stray);
      const m = managerOf(w, r, fakeFactory());
      await expect(m.start()).rejects.toBe(stray);
      m.stop();
      await settle();
      await Promise.all(registries.splice(0).map((x) => x.close()));
    }
  });

  it("many plans syncing warm the registry at most twice", async () => {
    const { r, f } = await started({
      before: (w) => {
        seedIndex(w.mem, IX, [ixAct("s-P3", ["s-P2"], [ip("P3", false)]), ixAct("s-P4", ["s-P3"], [ip("P4", false)])]);
        seedPlan(w.mem, "P3", "Third");
        seedPlan(w.mem, "P4", "Fourth");
      },
    });
    expect([...f.providers.keys()].sort()).toEqual([IX, "P", "P2", "P3", "P4"].sort());
    const warm = vi.spyOn(r, "warm");
    syncAll(f);
    await settle();
    await advance(1000);
    expect(warm.mock.calls.length).toBeGreaterThan(0);
    expect(warm.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("chipText", () => {
  const err = (o: Partial<Extract<SyncState, { kind: "error" }>> & Pick<Extract<SyncState, { kind: "error" }>, "code">): SyncState => ({
    kind: "error",
    since: NOW,
    doc: null,
    waiting: 0,
    message: null,
    cause: null,
    op: null,
    ...o,
  });

  it("names every state", () => {
    const none = (): string | null => null;
    expect(chipText({ kind: "synced" }, none)).toBe("Synced");
    expect(chipText({ kind: "syncing" }, none)).toBe("Syncing");
    expect(chipText({ kind: "offline", waiting: 3 }, none)).toBe("Offline — 3 changes waiting");
    expect(chipText(err({ code: "failed", message: "sync_ticket: channel closed" }), none)).toBe("Sync stopped: sync_ticket: channel closed");
    expect(chipText(err({ code: "too-large", doc: "P" }), none)).toBe("Too large to sync: a plan");
    expect(chipText(err({ code: "rejected", doc: "P" }), () => "Launch")).toBe("The server refused a change from this device — export this plan and check for an update");
  });

  it("a failed state without a message is a programming error", () => {
    expect(() => chipText(err({ code: "failed" }), () => null)).toThrow("A failed sync state carries no message");
  });
});

describe("SyncManager: plan cap", () => {
  const CAP = "This device has joined 500 plans, the most one device may join.";

  it("a ticket refused for the plan cap stops that plan with the server's message and is not retried", async () => {
    const { r, f, m } = await started({
      before: (w) => {
        const ok = w.ticket;
        w.ticket = (doc) => (doc === "P2" ? fail({ code: "sync.too_many_plans", message: CAP })() : ok(doc));
      },
    });
    expect(errorOf(m.state())).toMatchObject({ code: "failed", doc: "P2", message: CAP, cause: "sync.too_many_plans" });
    expect(chipText(m.state(), NAME(r))).toBe(`Sync stopped: ${CAP}`);
    await stopped(f, "P2");
    expect(prov(f, "P").calls).not.toContain("disconnect");
  });

  it("names a plan stopped by the cap, and connects it again when asked after a slot was freed", async () => {
    let capped = true;
    const { f, m } = await started({
      before: (w) => {
        const ok = w.ticket;
        w.ticket = (doc) => (doc === "P2" && capped ? fail({ code: "sync.too_many_plans", message: CAP })() : ok(doc));
      },
    });
    expect([m.capRefused("P2"), m.capRefused("P")]).toEqual([true, false]);
    capped = false;
    const from = tauri.calls.length;
    m.retryCapped();
    await settle();
    expect(tickets(from, "P2")).toBe(1);
    expect(tickets(from, "P")).toBe(0);
    syncAll(f);
    expect(m.state()).toEqual({ kind: "synced" });
    expect(m.capRefused("P2")).toBe(false);
  });
});

describe("SyncManager: delete forever", () => {
  const GONE = "This plan was deleted forever on another device.";
  const deletes = (from: number): unknown[] => tauri.calls.slice(from).filter((c) => c.cmd === "store_delete").map((c) => argsOf(c).doc);

  it("a ticket refused as gone drops the link and erases the plan, with no error", async () => {
    const { r, f, m } = await started({
      before: (w) => {
        const ok = w.ticket;
        w.ticket = (doc) => (doc === "P" ? fail({ code: "sync.gone", message: GONE })() : ok(doc));
      },
    });
    await settle();
    expect(prov(f, "P").calls).toContain("destroy");
    expect(deletes(0)).toEqual(["P"]);
    expect(r.plans().map((p) => p.id)).not.toContain("P");
    expect(r.isGone("P")).toBe(true);
    expect(m.state().kind).toBe("syncing");
    syncAll(f);
    expect(m.state()).toEqual({ kind: "synced" });
    expect(r.takeGoneNotices()).toEqual([]);
    const from = tauri.calls.length;
    await advance(5_000);
    expect(r.takeGoneNotices().map((n) => n.text)).toEqual([
      "“Launch” was deleted forever on another device. It is erased from this device too, including changes that had not synced.",
    ]);
    await advance(60_000);
    expect(tickets(from, "P")).toBe(0);
  });

  it("a plan load in flight when this device deletes the plan forever ends quietly and loads nothing again", async () => {
    const { w, r, f } = await started();
    syncAll(f);
    tauri.answers.sync_purge_plan = () => null;
    const bytes = w.mem.answers.store_load({ doc: "P3" });
    const ix = prov(f, IX);
    const held = hold("store_load");
    remoteIndex(ix, "r-a", [ip("P3", false)]);
    await settle();
    remoteIndex(ix, "r-t", [ip("P3", true)]);
    await settle();
    await r.purgePlan("P3");
    await settle();
    expect(w.mem.docs.has("P3")).toBe(false);
    const from = tauri.calls.length;
    held.resolve(bytes);
    await settle();
    expect(commandsWith(from, "store_load", { doc: "P3" })).toBe(0);
    expect(w.mem.docs.has("P3")).toBe(false);
    expect(f.providers.has("P3")).toBe(false);
  });

  it("a 4410 close names the deleting device once its plan-list entry arrives", async () => {
    const { r, f } = await started();
    syncAll(f);
    const ix = prov(f, IX);
    ix.deliver(remoteUpdate(ix.ydoc, "r-n", encodeAction(act("r-n", headsOf(ix.ydoc), [own("dn:dev-B", "iPhone")], { dev: "dev-B", lbl: "Name device" }))));
    await settle();
    prov(f, "P").closeWith(4410, "Plan deleted");
    await settle();
    expect(r.takeGoneNotices()).toEqual([]);
    await advance(1);
    ix.deliver(remoteUpdate(ix.ydoc, "r-g", encodeAction(act("r-g", headsOf(ix.ydoc), [own("ip:P", { gone: true })], { dev: "dev-B", lbl: "Delete plan forever" }))));
    await settle();
    expect(r.takeGoneNotices().map((n) => n.text)).toEqual(["“Launch” was deleted forever on iPhone. It is erased from this device too."]);
    await advance(10_000);
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("a 4410 close drops the link and erases the plan, with no error", async () => {
    const { r, f, m } = await started();
    syncAll(f);
    const from = tauri.calls.length;
    prov(f, "P").closeWith(4410, "Plan deleted");
    await settle();
    expect(prov(f, "P").calls).toContain("destroy");
    expect(deletes(from)).toEqual(["P"]);
    expect(appendsTo(from, IX).flatMap(xdocWrites)).toEqual([own("ip:P", { gone: true })]);
    expect(r.isGone("P")).toBe(true);
    expect(m.state()).toEqual({ kind: "synced" });
    await advance(60_000);
    expect(tickets(from, "P")).toBe(0);
  });

  it("a ticket refused as gone for the plan list stops sync with that message and erases nothing", async () => {
    const { r, m } = await started({
      before: (w) => {
        const ok = w.ticket;
        w.ticket = (doc) => (doc === IX ? fail({ code: "sync.gone", message: GONE })() : ok(doc));
      },
    });
    expect(errorOf(m.state())).toMatchObject({ code: "failed", doc: null, message: GONE, cause: "sync.gone" });
    expect(deletes(0)).toEqual([]);
    expect(r.plans().map((p) => p.id)).toContain("P");
  });

  it("a 4410 close of the plan list stops sync and erases nothing", async () => {
    const { r, f, m } = await started();
    syncAll(f);
    const from = tauri.calls.length;
    prov(f, IX).closeWith(4410, "Plan deleted");
    await settle();
    expect(errorOf(m.state())).toMatchObject({ code: "failed", doc: null, message: "The server says this space’s plan list was deleted. Sync is stopped." });
    expect(deletes(from)).toEqual([]);
    expect(appendsTo(from, IX)).toEqual([]);
    expect(r.plans().map((p) => p.id)).toContain("P");
  });

  it("a 4410 close after the registry closed drops the link and asks the registry nothing", async () => {
    const { r, f } = await started();
    syncAll(f);
    await r.close();
    const from = tauri.calls.length;
    prov(f, "P").closeWith(4410, "Plan deleted");
    await settle();
    expect(prov(f, "P").calls).toContain("destroy");
    expect(tauri.calls.slice(from)).toEqual([]);
  });

  it("a tombstone from another device drops the plan's link", async () => {
    const { r, f, m } = await started();
    syncAll(f);
    const from = tauri.calls.length;
    remoteIndex(prov(f, IX), "r-g", [own("ip:P2", { gone: true })]);
    await settle();
    expect(prov(f, "P2").calls).toContain("destroy");
    expect(deletes(from)).toEqual(["P2"]);
    expect(r.plans().map((p) => p.id)).not.toContain("P2");
    expect(m.state()).toEqual({ kind: "synced" });
  });
});
