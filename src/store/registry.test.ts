import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { buildAction, initialAction } from "../actions/build";
import { Refused, type Intent } from "../actions/intents";
import type { Calendar, RegionRef } from "../domain/calendar";
import { localToday } from "../domain/dates";
import type { ItemId } from "../domain/model";
import { LogState } from "../log/state";
import type { Action, ActionId, DeviceId, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { fixedClock } from "../services/clock";
import { noticeText } from "../services/holidays";
import { AppError } from "../services/ipc";
import { act } from "../test/act";
import { CH_ZH_2026, CH_ZH_2027, FETCHED_AT } from "../test/fixtures/calendars";
import { encodeLoad, memoryStore, type MemoryStore } from "../test/fixtures/store";
import { ctxOf } from "../test/planCtx";
import { hold, resetTauri, tauri, type Answer, type Call } from "../test/tauriMock";
import { VALID_WEBBOARD } from "../test/fixtures/webboard";
import { decodeAction, encodeAction, PlanDoc } from "./doc";
import { buildImport } from "./file";
import { readActions } from "./read-actions";
import { IndexDoc } from "./index-doc";
import { openPersisted, type PersistedDoc } from "./persist";
import { defaultDeviceName, Registry, RegistryClosed } from "./registry";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("./persist", async (importOriginal) => {
  const m = await importOriginal<typeof import("./persist")>();
  return { ...m, openPersisted: vi.fn(m.openPersisted) };
});

const TODAY = "2026-11-09";
const ZH: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const RK = "oh:CH:CH-ZH";
const PLAIN: Calendar = { region: null, workdays: [1, 2, 3, 4, 5], closures: new Map(), tuning: new Map(), holidays: new Map() };
const READ_ONLY = "This device was removed from the space; its plans are read-only.";
const INCOMPLETE = "This plan has not arrived yet; it opens once it syncs.";
const DEVICES: ReadonlyMap<DeviceId, string> = new Map([
  ["dev-A", "Mac"],
  ["dev-B", "iPhone"],
]);

type Err = { code: string; message: string };

const offline: Answer = () => {
  throw { code: "holidays.offline", message: "No connection to the holiday source." };
};

const yearArg = (args: Call["args"]): number => {
  const year = args !== undefined && !(args instanceof Uint8Array) && !(args instanceof ArrayBuffer) && !Array.isArray(args) ? args.year : undefined;
  if (typeof year !== "number") throw new Error("holidays_year without a year");
  return year;
};

const serving: Answer = (args) => {
  const year = yearArg(args);
  return { days: year === 2026 ? CH_ZH_2026.days : year === 2027 ? CH_ZH_2027.days : [], fetchedAt: FETCHED_AT, fromCache: false, coverage: [2020, 2030] };
};

interface Env {
  mem: MemoryStore;
  state: { settings: unknown; writeFail: Err | null };
}

function env(o: { settings?: unknown; platform?: "macos" | "linux" | "ios"; holidays?: Answer; answers?: Record<string, Answer>; mem?: MemoryStore } = {}): Env {
  const mem = o.mem ?? memoryStore();
  const state: Env["state"] = { settings: o.settings ?? null, writeFail: null };
  resetTauri({
    ...mem.answers,
    settings_read: () => state.settings,
    settings_write: (args) => {
      if (state.writeFail !== null) throw { ...state.writeFail };
      state.settings = settingsOf({ cmd: "settings_write", args, options: undefined });
      return null;
    },
    device_info: () => ({ deviceId: "dev-A", platform: o.platform ?? "macos" }),
    holidays_year: o.holidays ?? offline,
    ...o.answers,
  });
  return { mem, state };
}

const opened: Registry[] = [];

async function open(o?: Parameters<typeof Registry.open>[0]): Promise<Registry> {
  const r = await Registry.open(o);
  opened.push(r);
  return r;
}

const closeAll = async (): Promise<void> => {
  await Promise.all(opened.splice(0).map((r) => r.close()));
};

const forget = (r: Registry): void => {
  const at = opened.indexOf(r);
  if (at === -1) throw new Error("forget: this registry was not opened by open()");
  opened.splice(at, 1);
};

afterEach(closeAll);

afterEach(() => {
  Reflect.deleteProperty(window.screen, "width");
  Reflect.deleteProperty(window.screen, "height");
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetTauri({});
  vi.mocked(openPersisted).mockClear();
});

const persistedOf = async (doc: string): Promise<PersistedDoc[]> =>
  Promise.all(vi.mocked(openPersisted).mock.calls.flatMap(([id], i) => (id === doc ? [vi.mocked(openPersisted).mock.results[i].value] : [])));

const isClosed = async (d: PersistedDoc): Promise<boolean> =>
  d.compact().then(
    () => false,
    (e: unknown) => e instanceof AppError && e.code === "store.closed",
  );

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

const xdoc = (c: Call): string | null => new Headers(c.options?.headers).get("x-doc");

const appendsTo = (from: number, doc: string): Call[] => tauri.calls.slice(from).filter((c) => c.cmd === "store_append" && xdoc(c) === doc);

const callsOf = (from: number, cmd: string): Call[] => tauri.calls.slice(from).filter((c) => c.cmd === cmd);

const docOfArgs = (c: Call): unknown => (c.args !== undefined && !(c.args instanceof Uint8Array) && !(c.args instanceof ArrayBuffer) && !Array.isArray(c.args) ? c.args.doc : undefined);

const loadsOf = (from: number, doc: string): number => callsOf(from, "store_load").filter((c) => docOfArgs(c) === doc).length;

function bodyActions(c: Call): Action[] {
  if (!(c.args instanceof Uint8Array)) throw new Error(`${c.cmd} carried no bytes`);
  return Y.decodeUpdate(c.args)
    .structs.filter((s): s is Y.Item => s instanceof Y.Item && s.parentSub !== null)
    .map((s) => decodeAction(s.parentSub as string, s.content.getContent()[0]));
}

const writesOf = (c: Call): Write[] => bodyActions(c).flatMap((a) => [...a.w]);

function settingsOf(c: Call): { v: number; lastRegion: unknown; names: Record<string, string>; syncedHeads?: unknown } {
  const s = c.args !== undefined && !(c.args instanceof Uint8Array) && !(c.args instanceof ArrayBuffer) && !Array.isArray(c.args) ? c.args.settings : undefined;
  if (typeof s !== "object" || s === null) throw new Error("settings_write without settings");
  return s as { v: number; lastRegion: unknown; names: Record<string, string> };
}

const settingsWrites = (from: number) => callsOf(from, "settings_write").map(settingsOf);

const own = (u: string, v: unknown): Write => ({ u, v, c: "own" });

const ip = (plan: string, t: boolean): Write => own("ip:" + plan, { t });

function seedIndex(mem: MemoryStore, doc: string, entries: readonly (readonly [ActionId, unknown])[]): Y.Doc {
  const ydoc = new Y.Doc();
  const map = ydoc.getMap("actions");
  ydoc.transact(() => entries.forEach(([id, raw]) => map.set(id, raw)));
  mem.seed(doc, Y.encodeStateAsUpdate(ydoc));
  return ydoc;
}

const ixAct = (id: ActionId, par: readonly ActionId[], w: readonly Write[], dev: DeviceId = "dev-A", lbl = "Add plan"): readonly [ActionId, unknown] => [
  id,
  encodeAction(act(id, par, w, { dev, lbl })),
];

const listing = (...plans: readonly string[]): (readonly [ActionId, unknown])[] => {
  const named = ixAct("ix-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device");
  return plans.reduce<(readonly [ActionId, unknown])[]>((acc, p, i) => [...acc, ixAct(`ix-${i}`, [acc[acc.length - 1][0]], [ip(p, false)])], [named]);
};

function seedPlan(mem: MemoryStore | null, id: string, name: string, o: { items?: readonly string[]; dev?: DeviceId; calendar?: Calendar } = {}): Y.Doc {
  const ydoc = new Y.Doc();
  const pd = new PlanDoc(ydoc);
  const log = new LogState(planRules);
  const root = initialAction({ dev: o.dev ?? "dev-A", ses: "seed", now: 0, name, calendar: o.calendar ?? PLAIN });
  pd.append(root, []);
  log.add([root]);
  (o.items ?? []).forEach((item) => {
    const b = buildAction(ctxOf(log, o.dev ?? "dev-A", TODAY, DEVICES, { ses: "seed" }), { t: "create", kind: "task", name: item, parent: null, after: null, start: TODAY, dur: 2 });
    pd.append(b.action, b.newNotes);
    log.add([b.action]);
  });
  if (mem !== null) mem.seed(id, Y.encodeStateAsUpdate(ydoc));
  return ydoc;
}

function remote(local: Y.Doc, intent: (r: Y.Doc, log: LogState) => Intent, dev: DeviceId = "dev-B"): ActionId {
  const r = new Y.Doc();
  Y.applyUpdate(r, Y.encodeStateAsUpdate(local));
  const pd = new PlanDoc(r);
  const log = new LogState(planRules);
  log.add(pd.actions());
  const b = buildAction(ctxOf(log, dev, TODAY, DEVICES), intent(r, log));
  pd.append(b.action, b.newNotes);
  Y.applyUpdate(local, Y.encodeStateAsUpdate(r, Y.encodeStateVector(local)));
  return b.action.id;
}

function remoteRaw(local: Y.Doc, id: ActionId, raw: unknown): void {
  const r = new Y.Doc();
  Y.applyUpdate(r, Y.encodeStateAsUpdate(local));
  r.getMap("actions").set(id, raw);
  Y.applyUpdate(local, Y.encodeStateAsUpdate(r, Y.encodeStateVector(local)));
}

const headsOf = (ydoc: Y.Doc, unreadableIds: readonly ActionId[] = []): ActionId[] => {
  const log = new LogState({ same: (_u, a, b) => JSON.stringify(a) === JSON.stringify(b), mergeDerived: (u) => { throw new Error(u); } });
  const { ok, unreadable } = readActions(ydoc.getMap("actions").entries(), () => undefined);
  expect(unreadable.map((u) => u.id)).toEqual(unreadableIds);
  log.add(ok);
  return [...log.heads];
};

const itemNamed = (ydoc: Y.Doc, name: string): ItemId => {
  const log = new LogState(planRules);
  log.add(new PlanDoc(ydoc).actions());
  const found = [...ctxOf(log, "dev-A", TODAY).view.plan.items.values()].find((i) => i.name === name);
  if (found === undefined) throw new Error(`no item ${name}`);
  return found.id;
};

const planOf = (r: Registry, id: string) => {
  const p = r.plans().find((x) => x.id === id);
  if (p === undefined) throw new Error(`plan ${id} is not listed`);
  return p;
};

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

function codeOf(e: unknown): string {
  if (!(e instanceof AppError)) throw new Error(`not an AppError: ${String(e)}`);
  return e.code;
}

const setScreen = (width: number, height: number): void => {
  Object.defineProperty(window.screen, "width", { value: width, configurable: true });
  Object.defineProperty(window.screen, "height", { value: height, configurable: true });
};

describe("Registry: creating plans", () => {
  it("createPlan", async () => {
    env({ settings: { v: 1, lastRegion: ZH, names: {} } });
    const r = await open({ clock: fixedClock(TODAY) });
    const from = tauri.calls.length;
    const id = await r.createPlan("Beta");
    await flush();
    const local = appendsTo(from, "local");
    expect(local).toHaveLength(1);
    expect(writesOf(local[0])).toEqual([ip(id, false)]);
    const actions = [...new PlanDoc((await r.doc(id)).ydoc).actions()];
    expect(actions).toHaveLength(1);
    expect(actions[0].par).toEqual([]);
    const w = new Map(actions[0].w.map((x) => [x.u, x.v]));
    expect(w.get("pn")).toBe("Beta");
    expect(w.get("cw")).toEqual([1, 2, 3, 4, 5]);
    expect(w.get("cr")).toEqual(ZH);
    expect(r.openSessions()).toHaveLength(1);
    expect(r.openSessions()[0].view().plan.name).toBe("Beta");
    const writes = settingsWrites(from);
    expect(writes[writes.length - 1].names[id]).toBe("Beta");
    expect(planOf(r, id)).toEqual({ id, name: "Beta", trashed: false, loaded: true, space: null });
  });

  it("createPlan warms holidays", async () => {
    env({ settings: { v: 1, lastRegion: ZH, names: {} }, holidays: serving });
    const r = await open({ clock: fixedClock(TODAY) });
    const from = tauri.calls.length;
    const id = await r.createPlan("Beta");
    const calls = tauri.calls.slice(from);
    const firstAppend = calls.findIndex((c) => c.cmd === "store_append" && xdoc(c) === id);
    const years = calls.slice(0, firstAppend).filter((c) => c.cmd === "holidays_year").map((c) => yearArg(c.args));
    expect([...years].sort()).toEqual([2026, 2027]);
    const [first] = [...new PlanDoc((await r.doc(id)).ydoc).actions()];
    const w = new Map(first.w.map((x) => [x.u, x.v]));
    expect(w.get("ch:2026")).toMatchObject({ region: RK, days: CH_ZH_2026.days });
    expect(w.get("ch:2027")).toMatchObject({ region: RK, days: CH_ZH_2027.days });
  });

  it("createPlan offline", async () => {
    env({ settings: { v: 1, lastRegion: ZH, names: {} } });
    const r = await open({ clock: fixedClock(TODAY) });
    const id = await r.createPlan("Beta");
    await flush();
    const actions = [...new PlanDoc((await r.doc(id)).ydoc).actions()];
    expect(actions).toHaveLength(1);
    expect(actions[0].w.some((x) => x.u.startsWith("ch:"))).toBe(false);
    expect(r.holidays.notices(id).map((n) => noticeText(n).text)).toContain("Holidays for 2026 not loaded — retry");
  });

  it("createPlan without region", async () => {
    env();
    const r = await open({ clock: fixedClock(TODAY) });
    const from = tauri.calls.length;
    const id = await r.createPlan("Beta");
    await flush();
    expect(callsOf(from, "holidays_year")).toHaveLength(0);
    const actions = [...new PlanDoc((await r.doc(id)).ydoc).actions()];
    expect(actions[0].w.some((x) => x.u.startsWith("ch:"))).toBe(false);
    expect(new Map(actions[0].w.map((x) => [x.u, x.v])).get("cr")).toBeNull();
  });

  it("createPlan rejects", async () => {
    const e = env();
    tauri.answers.store_load = (args, o) => {
      if (docOfArgs({ cmd: "store_load", args, options: o }) !== "local") throw { code: "store.io", message: "Disk full." };
      return e.mem.answers.store_load(args, o);
    };
    const r = await open();
    const before = r.plans();
    const from = tauri.calls.length;
    const err = await rejection(r.createPlan("Beta"));
    expect(err).toBeInstanceOf(AppError);
    expect(codeOf(err)).toBe("store.io");
    expect((err as AppError).message).toBe("Disk full.");
    await flush();
    expect(appendsTo(from, "local")).toHaveLength(0);
    expect(r.plans()).toEqual(before);
    expect(r.failures().size).toBe(0);
  });

  it("setLastRegion", async () => {
    env();
    const r = await open({ clock: fixedClock(TODAY) });
    expect(r.settingsError()).toBeNull();
    const a = await r.createPlan("A");
    expect(new Map([...new PlanDoc((await r.doc(a)).ydoc).actions()][0].w.map((x) => [x.u, x.v])).get("cr")).toBeNull();
    await flush();
    const from = tauri.calls.length;
    await r.setLastRegion(ZH);
    const writes = settingsWrites(from);
    expect(writes).toHaveLength(1);
    expect(writes[0].lastRegion).toEqual(ZH);
    const b = await r.createPlan("B");
    expect(new Map([...new PlanDoc((await r.doc(b)).ydoc).actions()][0].w.map((x) => [x.u, x.v])).get("cr")).toEqual(ZH);
  });

  it("setLastRegion fails", async () => {
    const e = env();
    const r = await open();
    e.state.writeFail = { code: "settings.io", message: "Could not save settings.json: disk full" };
    const err = await rejection(r.setLastRegion(ZH));
    expect(codeOf(err)).toBe("settings.io");
    expect(r.settingsError()).toBeNull();
  });

  it("settings error", async () => {
    const e = env();
    const r = await open();
    const cb = vi.fn();
    r.subscribe(cb);
    e.state.writeFail = { code: "settings.io", message: "Could not save settings.json: disk full" };
    const id = await r.createPlan("Beta");
    await flush();
    expect(planOf(r, id).name).toBe("Beta");
    expect([...new PlanDoc((await r.doc(id)).ydoc).actions()]).toHaveLength(1);
    expect(r.settingsError()?.code).toBe("settings.io");
    expect(cb).toHaveBeenCalled();
    e.state.writeFail = null;
    cb.mockClear();
    const from = tauri.calls.length;
    await r.retrySettings();
    const writes = settingsWrites(from);
    expect(writes).toHaveLength(1);
    expect(writes[0].names[id]).toBe("Beta");
    expect(r.settingsError()).toBeNull();
    expect(cb).toHaveBeenCalled();
  });

  it("rename settings error", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    const s = await r.session("P");
    await flush();
    e.state.writeFail = { code: "settings.io", message: "first" };
    s.apply({ t: "planName", name: "Bridge" });
    await flush();
    expect(s.view().plan.name).toBe("Bridge");
    expect(planOf(r, "P").name).toBe("Bridge");
    expect(r.settingsError()?.code).toBe("settings.io");
    e.state.writeFail = { code: "settings.io", message: "second" };
    const cb = vi.fn();
    r.subscribe(cb);
    await r.retrySettings();
    expect(r.settingsError()?.message).toBe("second");
    expect(cb).toHaveBeenCalled();
    e.state.writeFail = null;
    const from = tauri.calls.length;
    await r.retrySettings();
    expect(settingsWrites(from)[0].names.P).toBe("Bridge");
    expect(r.settingsError()).toBeNull();
  });

  it("rename caches", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    const s = await r.session("P");
    await flush();
    const from = tauri.calls.length;
    s.apply({ t: "planName", name: "Bridge" });
    await flush();
    expect(planOf(r, "P").name).toBe("Bridge");
    const writes = settingsWrites(from);
    expect(writes).toHaveLength(1);
    expect(writes[0].names.P).toBe("Bridge");
    expect(r.settingsError()).toBeNull();
  });

  it("synced heads kept", async () => {
    env({ settings: { v: 1, lastRegion: null, names: {}, syncedHeads: { P: ["a1", "a2"] } } });
    const r = await open();
    const from = tauri.calls.length;
    const id = await r.createPlan("Beta");
    await flush();
    const writes = settingsWrites(from);
    expect(writes.length).toBeGreaterThan(0);
    const last = writes[writes.length - 1];
    expect(last.syncedHeads).toEqual({ P: ["a1", "a2"] });
    expect(last.names[id]).toBe("Beta");
  });

  it("clock option", async () => {
    env({ settings: { v: 1, lastRegion: ZH, names: {} } });
    const r = await open({ clock: fixedClock(TODAY, new Date(2026, 10, 9, 14, 5).getTime()) });
    const id = await r.createPlan("Beta");
    await flush();
    const s = await r.session(id);
    expect(s.view().today).toBe(TODAY);
    const failed = r.holidays.notices(id).map(noticeText).find((n) => n.text === "Holidays for 2026 not loaded — retry");
    expect(failed?.detail?.endsWith("Tried 2026-11-09 14:05.")).toBe(true);
    await closeAll();
    const e2 = env();
    seedIndex(e2.mem, "local", listing("P"));
    seedPlan(e2.mem, "P", "Alpha");
    const r2 = await open();
    expect((await r2.session("P")).view().today).toBe(localToday());
  });
});

describe("Registry: sessions and devices", () => {
  it("openSessions", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("A", "B"));
    seedPlan(e.mem, "A", "Alpha");
    seedPlan(e.mem, "B", "Beta");
    const r = await open();
    const a = await r.session("A");
    const b = await r.session("B");
    expect(r.openSessions()).toHaveLength(2);
    expect(r.openSessions()).toContain(a);
    expect(r.openSessions()).toContain(b);
    await a.close();
    expect(r.openSessions()).toHaveLength(1);
    expect(r.openSessions()[0]).toBe(b);
  });

  it("devices", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha", { dev: "dev-B" });
    const r = await open();
    const s = await r.session("P");
    const local = (await r.doc("local")).ydoc;
    const cb = vi.fn();
    r.subscribe(cb);
    const sessionCb = vi.fn();
    s.subscribe(sessionCb);
    remoteRaw(local, "dn-B", encodeAction(act("dn-B", headsOf(local), [own("dn:dev-B", "iPhone")], { dev: "dev-B", lbl: "Name device" })));
    expect(r.devices().get("dev-B")).toBe("iPhone");
    expect(cb).toHaveBeenCalled();
    expect(sessionCb).toHaveBeenCalledTimes(1);
    expect(s.history()[0].device).toBe("iPhone");
    await s.close();
    sessionCb.mockClear();
    remoteRaw(local, "dn-B2", encodeAction(act("dn-B2", headsOf(local), [own("dn:dev-B", "iPhone 2")], { dev: "dev-B", lbl: "Name device" })));
    expect(r.devices().get("dev-B")).toBe("iPhone 2");
    expect(sessionCb).not.toHaveBeenCalled();
  });

  it("device name", async () => {
    const e = env({ platform: "ios" });
    setScreen(430, 932);
    const r = await open();
    expect(r.device).toEqual({ deviceId: "dev-A", name: "iPhone", platform: "ios" });
    await flush();
    const local = appendsTo(0, "local");
    expect(local).toHaveLength(1);
    expect(writesOf(local[0])).toEqual([own("dn:dev-A", "iPhone")]);
    await r.close();
    setScreen(1024, 1366);
    const from = tauri.calls.length;
    const again = await open();
    await flush();
    expect(appendsTo(from, "local")).toHaveLength(0);
    expect(again.device.name).toBe("iPhone");
    expect(e.mem.docs.has("local")).toBe(true);
    await closeAll();
    env({ platform: "ios" });
    const pad = await open();
    expect(pad.device.name).toBe("iPad");
  });

  it("defaultDeviceName", () => {
    expect(defaultDeviceName("ios", 430)).toBe("iPhone");
    expect(defaultDeviceName("ios", 599)).toBe("iPhone");
    expect(defaultDeviceName("ios", 600)).toBe("iPad");
    expect(defaultDeviceName("ios", 744)).toBe("iPad");
    expect(defaultDeviceName("ios", 1024)).toBe("iPad");
    expect(defaultDeviceName("macos", 0)).toBe("Mac");
    expect(defaultDeviceName("linux", 0)).toBe("Linux");
  });

  it("doc shared", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    const seeded = seedPlan(e.mem, "P", "Alpha", { items: ["A"] });
    const r = await open();
    const from = tauri.calls.length;
    const d1 = r.doc("P");
    const d2 = r.doc("P");
    expect(d2).toBe(d1);
    const s = await r.session("P");
    expect(s.note(itemNamed(seeded, "A")).doc).toBe((await r.doc("P")).ydoc);
    expect(loadsOf(from, "P")).toBe(1);
  });

  it("index repair notice", async () => {
    const e = env();
    tauri.answers.store_load = (args, o) => {
      if (docOfArgs({ cmd: "store_load", args, options: o }) === "local") return encodeLoad({ torn: true, lastSeq: 0 });
      return e.mem.answers.store_load(args, o);
    };
    const r = await open();
    expect(r.takeIndexRepairNotice()).toBe("The last change to the plan list before WebBoard closed was not saved.");
    expect(r.takeIndexRepairNotice()).toBeNull();
    await closeAll();
    env();
    const clean = await open();
    expect(clean.takeIndexRepairNotice()).toBeNull();
  });
});

describe("IndexDoc", () => {
  it("index doc", async () => {
    env();
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    const labels: string[][] = [];
    const step = async (f: () => void): Promise<void> => {
      const from = tauri.calls.length;
      f();
      await flush();
      const sent = appendsTo(from, "local");
      expect(sent).toHaveLength(1);
      labels.push(bodyActions(sent[0]).map((a) => a.lbl));
    };
    await step(() => ix.addPlan("P"));
    await step(() => ix.addPlan("Q"));
    await step(() => ix.trashPlan("P"));
    await step(() => ix.restorePlan("P"));
    await step(() => ix.trashPlan("Q"));
    await step(() => ix.nameDevice("dev-B", "iPhone"));
    expect(labels).toEqual([["Add plan"], ["Add plan"], ["Move plan to Trash"], ["Restore plan"], ["Move plan to Trash"], ["Name device"]]);
    expect(ix.plans()).toEqual([
      { id: "P", trashed: false },
      { id: "Q", trashed: true },
    ]);
    expect(ix.devices().get("dev-B")).toBe("iPhone");
    await ix.close();
    const again = await IndexDoc.open("local", "dev-A", openPersisted);
    expect(again.plans()).toEqual(ix.plans());
    expect(again.devices()).toEqual(ix.devices());
    await again.close();
  });

  it("device name normalised", async () => {
    env();
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    const cb = vi.fn();
    ix.subscribe(cb);
    const from = tauri.calls.length;
    let thrown: unknown = null;
    try {
      ix.nameDevice("dev-B", "   ");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Refused);
    expect((thrown as Refused).message).toBe("The name is empty. Type at least one character.");
    await flush();
    expect(callsOf(from, "store_append")).toHaveLength(0);
    expect(ix.devices().has("dev-B")).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    ix.nameDevice("dev-B", "iPad\n2");
    await flush();
    const sent = callsOf(from, "store_append");
    expect(sent).toHaveLength(1);
    expect(writesOf(sent[0])).toEqual([own("dn:dev-B", "iPad 2")]);
    expect(ix.devices().get("dev-B")).toBe("iPad 2");
    await ix.close();
  });

  it("a plan trashed and restored apart settles by replay order", async () => {
    const e = env();
    const common = [ixAct("c1", [], [ip("P", false)]), ixAct("c2", ["c1"], [ip("P", true)], "dev-A", "Move plan to Trash")] as const;
    e.mem.seed("ix-B", Y.encodeStateAsUpdate(seedIndex(e.mem, "local", common)));
    const docs = new Map<string, PersistedDoc>();
    const persist = async (id: string): Promise<PersistedDoc> => {
      const d = await openPersisted(id);
      docs.set(id, d);
      return d;
    };
    const a = await IndexDoc.open("local", "dev-A", persist);
    const b = await IndexDoc.open("ix-B", "dev-B", persist);
    a.restorePlan("P");
    a.trashPlan("P");
    b.restorePlan("P");
    const ya = docs.get("local")?.ydoc;
    const yb = docs.get("ix-B")?.ydoc;
    if (ya === undefined || yb === undefined) throw new Error("docs not opened");
    const toB = Y.encodeStateAsUpdate(ya, Y.encodeStateVector(yb));
    const toA = Y.encodeStateAsUpdate(yb, Y.encodeStateVector(ya));
    Y.applyUpdate(yb, toB);
    Y.applyUpdate(ya, toA);
    expect(a.plans()).toEqual([{ id: "P", trashed: true }]);
    expect(b.plans()).toEqual([{ id: "P", trashed: true }]);
    expect(ya.getMap("actions").size).toBe(5);
    expect(yb.getMap("actions").size).toBe(5);
    await a.close();
    await b.close();
    const r = await open();
    expect(r.plans()).toEqual([{ id: "P", name: null, trashed: true, loaded: false, space: null }]);
    expect(r.failures().size).toBe(0);
    expect(r.indexError()).toBeNull();
  });

  it("unreadable index action", async () => {
    const e = env();
    const base = [
      ixAct("a1", [], [ip("P", false)]),
      ixAct("a2", ["a1"], [ip("Q", false)]),
      ixAct("n1", ["a2"], [own("dn:dev-B", "iPhone")], "dev-B", "Name device"),
    ];
    const m = encodeAction(act("id-M", ["n1"], [ip("X", false)], { dev: "dev-B" }));
    m[4] = 5;
    seedIndex(e.mem, "local", [
      ...base,
      ["id-M", m],
      ixAct("id-X", ["id-M"], [ip("X", false)], "dev-B"),
      ixAct("id-Z", ["n1"], [own("zz:1", { t: false })], "dev-B"),
    ]);
    const expected = [
      { id: "id-M", message: "A change to the plan list from iPhone could not be read: Action id-M has a malformed lbl. Update WebBoard on this device." },
      { id: "id-Z", message: "A change to the plan list from iPhone could not be read: Unknown unit key “zz:1”. Update WebBoard on this device." },
    ];
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    expect(ix.plans().map((p) => p.id)).toEqual(["P", "Q"]);
    expect(ix.unreadable()).toEqual(expected);
    await ix.close();
    const r = await open();
    expect(r.indexUnreadable()).toEqual(expected.map((x) => x.message));
    expect(r.failures().size).toBe(0);
    expect(r.indexError()).toBeNull();
    const cb = vi.fn();
    r.subscribe(cb);
    const local = (await r.doc("local")).ydoc;
    remoteRaw(local, "id-W", encodeAction(act("id-W", headsOf(local, ["id-M"]), [own("ip:P", 5)], { dev: "dev-B" })));
    expect(cb).toHaveBeenCalled();
    expect(r.indexUnreadable()).toEqual([
      expected[0].message,
      "A change to the plan list from iPhone could not be read: Malformed value for “ip:P”. Update WebBoard on this device.",
      expected[1].message,
    ]);
    expect(planOf(r, "P").trashed).toBe(false);
  });

  it("trash raises no choice", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha", { items: ["A"] });
    const r = await open();
    const s = await r.session("P");
    const ydoc = (await r.doc("P")).ydoc;
    await flush();
    const from = tauri.calls.length;
    remote(ydoc, () => ({ t: "rename", item: itemNamed(ydoc, "A"), name: "North" }));
    r.trashPlan("P");
    await flush();
    expect(appendsTo(from, "local")).toHaveLength(1);
    expect(planOf(r, "P").trashed).toBe(true);
    expect(s.view().choices).toHaveLength(0);
    r.restorePlan("P");
    await flush();
    expect(appendsTo(from, "local")).toHaveLength(2);
    expect(planOf(r, "P").trashed).toBe(false);
    expect([...s.view().plan.items.values()].map((i) => i.name)).toEqual(["North"]);
  });
});

describe("Registry: listing and loading", () => {
  it("cached names", async () => {
    const e = env({ settings: { v: 1, lastRegion: null, names: { P: "Alpha" } } });
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    expect(r.plans()).toEqual([{ id: "P", name: "Alpha", trashed: false, loaded: false, space: null }]);
    expect(callsOf(0, "store_load").map(docOfArgs)).toEqual(["local"]);
  });

  it("warm", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("alpha", "beta"));
    seedPlan(e.mem, "alpha", "Alpha");
    seedPlan(e.mem, "beta", "Beta");
    e.mem.fail("store_load", "beta", { code: "store.corrupt", message: "beta: a record is damaged" });
    const r = await open();
    const from = tauri.calls.length;
    await r.warm();
    expect(callsOf(from, "store_load").map(docOfArgs)).toEqual(["alpha", "beta"]);
    expect(r.failures().get("beta")?.code).toBe("store.corrupt");
    expect(planOf(r, "alpha")).toEqual({ id: "alpha", name: "Alpha", trashed: false, loaded: true, space: null });
  });

  it("warm is idempotent", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("alpha", "beta", "gamma"));
    seedPlan(e.mem, "alpha", "Alpha");
    seedPlan(e.mem, "beta", "Beta");
    e.mem.fail("store_load", "beta", { code: "store.corrupt", message: "beta: a record is damaged" });
    const r = await open();
    await r.warm();
    expect(planOf(r, "gamma")).toEqual({ id: "gamma", name: null, trashed: false, loaded: false, space: null });
    expect(r.failures().has("gamma")).toBe(false);
    const plans = r.plans();
    const failures = new Map(r.failures());
    const from = tauri.calls.length;
    await r.warm();
    expect(callsOf(from, "store_load")).toHaveLength(0);
    expect(r.plans()).toEqual(plans);
    expect(new Map(r.failures())).toEqual(failures);
  });

  it("warm store error", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha", { items: ["A"] });
    const r = await open();
    await r.warm();
    await flush();
    const cb = vi.fn();
    r.subscribe(cb);
    e.mem.fail("store_append", "P", { code: "store.io", message: "Disk full." });
    const ydoc = (await r.doc("P")).ydoc;
    const sent = remote(ydoc, () => ({ t: "rename", item: itemNamed(ydoc, "A"), name: "North" }));
    await flush();
    expect(r.failures().get("P")?.code).toBe("store.io");
    expect(cb).toHaveBeenCalled();
    e.mem.recover("store_append", "P");
    const from = tauri.calls.length;
    await r.retryPlan("P");
    expect(r.failures().has("P")).toBe(false);
    const next = appendsTo(from, "P");
    expect(next.length).toBeGreaterThan(0);
    expect(bodyActions(next[0]).map((a) => a.id)).toEqual([sent]);
  });

  it("incomplete plan", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    const full = seedPlan(null, "P", "Alpha");
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(full));
    const rootUpdate = Y.encodeStateAsUpdate(full);
    const log = new LogState(planRules);
    log.add(new PlanDoc(other).actions());
    const child = buildAction(ctxOf(log, "dev-B", TODAY, DEVICES), { t: "create", kind: "task", name: "A", parent: null, after: null, start: TODAY, dur: 2 });
    new PlanDoc(other).append(child.action, child.newNotes);
    e.mem.seed("P", Y.encodeStateAsUpdate(other, Y.encodeStateVector(full)));
    const r = await open();
    const err = await rejection(r.session("P"));
    expect(err).toBeInstanceOf(AppError);
    expect(codeOf(err)).toBe("plan.incomplete");
    expect((err as AppError).message).toBe(INCOMPLETE);
    expect(r.failures().has("P")).toBe(false);
    const first = await r.doc("P");
    expect(await r.doc("P")).toBe(first);
    const cb = vi.fn();
    r.subscribe(cb);
    Y.applyUpdate(first.ydoc, rootUpdate);
    expect(cb).toHaveBeenCalled();
    const s = await r.session("P");
    expect(s.view().plan.items.size).toBe(1);
    expect(planOf(r, "P").name).toBe("Alpha");
  });

  it("remote rename caches", async () => {
    const e = env({ settings: { v: 1, lastRegion: null, names: { S: "Bridge" } } });
    seedIndex(e.mem, "local", listing("S"));
    seedPlan(e.mem, "S", "Bridge", { items: ["A"] });
    const r = await open();
    await r.warm();
    await flush();
    const cb = vi.fn();
    r.subscribe(cb);
    const ydoc = (await r.doc("S")).ydoc;
    const from = tauri.calls.length;
    remote(ydoc, () => ({ t: "planName", name: "Harbour" }));
    await flush();
    expect(planOf(r, "S").name).toBe("Harbour");
    expect(cb).toHaveBeenCalled();
    const writes = settingsWrites(from);
    expect(writes).toHaveLength(1);
    expect(writes[0].names.S).toBe("Harbour");
    const from2 = tauri.calls.length;
    remote(ydoc, () => ({ t: "rename", item: itemNamed(ydoc, "A"), name: "North" }));
    await flush();
    expect(settingsWrites(from2)).toHaveLength(0);
    e.state.writeFail = { code: "settings.io", message: "Could not save settings.json: disk full" };
    remote(ydoc, () => ({ t: "planName", name: "Quay" }));
    await flush();
    expect(planOf(r, "S").name).toBe("Quay");
    expect(r.settingsError()?.code).toBe("settings.io");
  });

  it("orphan plans listed", async () => {
    const e = env();
    seedIndex(e.mem, "local", [ixAct("l1", [], [ip("P", false)])]);
    seedPlan(e.mem, "P", "Pea");
    seedPlan(e.mem, "Q", "Queue");
    seedIndex(e.mem, "ix-S1", [ixAct("s1", [], [ip("R", false)])]);
    seedPlan(e.mem, "R", "Arr");
    seedPlan(e.mem, "probe", "Probe");
    expect(await Promise.resolve(e.mem.answers.store_list(undefined))).toEqual(["local", "P", "Q", "ix-S1", "R", "probe"]);
    const r = await open();
    await flush();
    expect(r.plans().map((p) => p.id)).toEqual(["P", "Q"]);
    expect(r.plans().every((p) => p.space === null)).toBe(true);
    const sent = appendsTo(0, "local").flatMap(bodyActions);
    expect(sent).toHaveLength(2);
    expect(sent.map((a) => a.lbl).sort()).toEqual(["Add plan", "Name device"]);
    expect(sent.find((a) => a.lbl === "Add plan")?.w).toEqual([ip("Q", false)]);
    expect(sent.find((a) => a.lbl === "Name device")?.w).toEqual([own("dn:dev-A", "Mac")]);
    await r.close();
    const from = tauri.calls.length;
    const again = await open();
    await flush();
    expect(appendsTo(from, "local")).toHaveLength(0);
    expect(again.plans().map((p) => p.id)).toEqual(["P", "Q"]);
    await closeAll();

    const f = env();
    seedIndex(f.mem, "local", [ixAct("l1", [], [ip("P", false)])]);
    seedPlan(f.mem, "P", "Pea");
    seedPlan(f.mem, "Q", "Queue");
    seedIndex(f.mem, "ix-S1", [ixAct("s1", [], [ip("R", false)])]);
    f.mem.fail("store_load", "ix-S1", { code: "store.io", message: "Disk full." });
    const failing = await open();
    await flush();
    const only = appendsTo(0, "local").flatMap(bodyActions);
    expect(only.map((a) => a.lbl)).toEqual(["Name device"]);
    expect(failing.plans().map((p) => p.id)).toEqual(["P"]);
    expect(failing.indexError()?.code).toBe("store.io");
  });

  it("localSpaces", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing());
    seedPlan(e.mem, "P", "Pea");
    seedIndex(e.mem, "ix-sp000000000", [ixAct("s1", [], [ip("P", false)])]);
    expect((await open()).localSpaces()).toEqual(["sp000000000"]);
    await closeAll();
    const f = env();
    seedIndex(f.mem, "local", listing());
    seedPlan(f.mem, "P", "Pea");
    expect((await open()).localSpaces()).toEqual([]);
    await closeAll();
    const g = env();
    seedIndex(g.mem, "local", listing());
    seedIndex(g.mem, "ix-sp000000000", [ixAct("s1", [], [ip("P", false)])]);
    g.mem.fail("store_load", "ix-sp000000000", { code: "store.corrupt", message: "bad" });
    const r = await open();
    expect(r.localSpaces()).toEqual(["sp000000000"]);
    expect(r.indexErrorDoc()).toBe("ix-sp000000000");
  });

  it("open fails loudly", async () => {
    env({ answers: { settings_read: () => { throw { code: "settings.corrupt", message: "settings.json is not valid JSON: EOF" }; } } });
    const a = await rejection(Registry.open());
    expect(codeOf(a)).toBe("settings.corrupt");
    const e = env();
    e.mem.fail("store_load", "local", { code: "store.corrupt", message: "local: a record is damaged" });
    const b = await rejection(Registry.open());
    expect(codeOf(b)).toBe("store.corrupt");
    expect((b as AppError).message).toBe("local: a record is damaged");
  });

  it("retryPlan", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    e.mem.fail("store_load", "P", { code: "store.locked", message: "This plan is open in another WebBoard process; close it there first." });
    const r = await open();
    await r.warm();
    expect(r.failures().get("P")?.code).toBe("store.locked");
    e.mem.fail("store_load", "P", { code: "store.corrupt", message: "P: a record is damaged" });
    await r.retryPlan("P");
    expect(r.failures().get("P")?.code).toBe("store.corrupt");
    expect([...r.failures().keys()].filter((k) => k === "P")).toHaveLength(1);
    e.mem.recover("store_load", "P");
    const cb = vi.fn();
    r.subscribe(cb);
    await r.retryPlan("P");
    expect(r.failures().has("P")).toBe(false);
    expect(cb).toHaveBeenCalled();
    expect((await r.session("P")).view().plan.name).toBe("Alpha");
  });

  it("index error", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    const r = await open();
    await flush();
    expect(r.indexError()).toBeNull();
    expect(r.indexErrorDoc()).toBeNull();
    expect(r.spaceReadOnly()).toBe(false);
    const cb = vi.fn();
    r.subscribe(cb);
    e.mem.fail("store_append", "local", { code: "store.io", message: "Disk full." });
    r.trashPlan("P");
    await flush();
    expect(r.indexError()?.code).toBe("store.io");
    expect(r.indexErrorDoc()).toBe("local");
    expect(cb).toHaveBeenCalled();
    e.mem.recover("store_append", "local");
    const from = tauri.calls.length;
    await r.retryIndex();
    expect(r.indexError()).toBeNull();
    expect(r.indexErrorDoc()).toBeNull();
    const sent = appendsTo(from, "local");
    expect(sent).toHaveLength(1);
    expect(writesOf(sent[0])).toEqual([ip("P", true)]);
  });
});

describe("Registry: reloadFromServer", () => {
  function corruptPlan(): Env {
    const e = env();
    seedIndex(e.mem, "local", listing());
    seedIndex(e.mem, "ix-S1", [ixAct("s1", [], [ip("P", false)])]);
    seedPlan(e.mem, "P", "Alpha");
    e.mem.fail("store_load", "P", { code: "store.corrupt", message: "P: a record is damaged" });
    return e;
  }

  function corruptIndex(): Env {
    const e = env();
    seedIndex(e.mem, "local", listing());
    seedIndex(e.mem, "ix-S1", [ixAct("s1", [], [ip("P", false)])]);
    e.mem.fail("store_load", "ix-S1", { code: "store.corrupt", message: "ix-S1: a record is damaged" });
    return e;
  }

  it("reloadFromServer", async () => {
    const e = corruptPlan();
    expect(await Promise.resolve(e.mem.answers.store_list(undefined))).toEqual(["local", "ix-S1", "P"]);
    const r = await open();
    expect(codeOf(await rejection(r.doc("P")))).toBe("store.corrupt");
    expect(r.failures().get("P")?.code).toBe("store.corrupt");
    e.mem.recover("store_load", "P");
    const cb = vi.fn();
    r.subscribe(cb);
    const from = tauri.calls.length;
    await r.reloadFromServer("P");
    const aside = callsOf(from, "store_set_aside");
    expect(aside.map((c) => c.args)).toEqual([{ doc: "P" }]);
    await flush();
    expect(appendsTo(from, "local")).toHaveLength(0);
    expect(appendsTo(from, "ix-S1")).toHaveLength(0);
    expect(r.failures().has("P")).toBe(false);
    expect(cb).toHaveBeenCalled();
    const d = await r.doc("P");
    expect(d.ydoc.getMap("actions").size).toBe(0);
    expect(codeOf(await rejection(r.session("P")))).toBe("plan.incomplete");
    Y.applyUpdate(d.ydoc, Y.encodeStateAsUpdate(seedPlan(null, "P", "Alpha")));
    expect((await r.session("P")).view().plan.name).toBe("Alpha");
  });

  it("reloadFromServer an index", async () => {
    const e = corruptIndex();
    const r = await open();
    expect(r.indexError()?.code).toBe("store.corrupt");
    expect(r.indexErrorDoc()).toBe("ix-S1");
    e.mem.recover("store_load", "ix-S1");
    const from = tauri.calls.length;
    await r.reloadFromServer("ix-S1");
    await flush();
    expect(callsOf(from, "store_set_aside").map((c) => c.args)).toEqual([{ doc: "ix-S1" }]);
    expect(callsOf(from, "store_append")).toHaveLength(0);
    expect(r.indexError()).toBeNull();
    expect(r.indexErrorDoc()).toBeNull();
  });

  it("reload refused while read-only", async () => {
    corruptPlan();
    const r = await open();
    await rejection(r.doc("P"));
    vi.spyOn(r, "spaceReadOnly").mockReturnValue(true);
    const cb = vi.fn();
    r.subscribe(cb);
    const from = tauri.calls.length;
    const err = await rejection(r.reloadFromServer("P"));
    expect(err).toBeInstanceOf(Refused);
    expect((err as Refused).message).toBe(READ_ONLY);
    expect(callsOf(from, "store_set_aside")).toHaveLength(0);
    expect(r.failures().get("P")?.code).toBe("store.corrupt");
    expect(cb).not.toHaveBeenCalled();
  });

  it("reload set-aside fails", async () => {
    const e = corruptPlan();
    const r = await open();
    await rejection(r.doc("P"));
    const locked = { code: "store.locked", message: "This plan is open in another WebBoard process; close it there first." };
    e.mem.fail("store_set_aside", "P", locked);
    const cb = vi.fn();
    r.subscribe(cb);
    const from = tauri.calls.length;
    const err = await rejection(r.reloadFromServer("P"));
    expect(err).toBeInstanceOf(AppError);
    expect({ code: codeOf(err), message: (err as AppError).message }).toEqual(locked);
    expect(r.failures().get("P")?.code).toBe("store.locked");
    expect([...r.failures().keys()]).toEqual(["P"]);
    expect(cb).toHaveBeenCalled();
    expect(loadsOf(from, "P")).toBe(0);
    expect(codeOf(await rejection(r.doc("P")))).toBe("store.corrupt");
    expect(loadsOf(from, "P")).toBe(1);
    await closeAll();

    const f = corruptIndex();
    const ri = await open();
    const ixLocked = { code: "store.locked", message: "The plan list is open in another WebBoard process; close it there first." };
    f.mem.fail("store_set_aside", "ix-S1", ixLocked);
    const from2 = tauri.calls.length;
    const err2 = await rejection(ri.reloadFromServer("ix-S1"));
    expect({ code: codeOf(err2), message: (err2 as AppError).message }).toEqual(ixLocked);
    const ie = ri.indexError();
    expect(ie === null ? null : { code: ie.code, message: ie.message }).toEqual(ixLocked);
    expect(ri.indexErrorDoc()).toBe("ix-S1");
    await flush();
    expect(callsOf(from2, "store_append")).toHaveLength(0);
  });
});

describe("Registry: lifecycle and failures", () => {
  const REPAIRED = "The last change to the plan list before WebBoard closed was not saved.";

  it("index repair notice from a space index", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing());
    seedIndex(e.mem, "ix-S1", [ixAct("s1", [], [ip("R", false)])]);
    tauri.answers.store_load = (args, o) => {
      if (docOfArgs({ cmd: "store_load", args, options: o }) === "ix-S1") return encodeLoad({ torn: true, lastSeq: 0 });
      return e.mem.answers.store_load(args, o);
    };
    const r = await open();
    expect(r.indexError()).toBeNull();
    expect(r.takeIndexRepairNotice()).toBe(REPAIRED);
    expect(r.takeIndexRepairNotice()).toBeNull();
    await closeAll();

    const f = env();
    seedIndex(f.mem, "local", listing());
    seedIndex(f.mem, "ix-S1", [ixAct("s1", [], [ip("R", false)])]);
    f.mem.fail("store_load", "ix-S1", { code: "store.io", message: "Disk full." });
    const g = await open();
    expect(g.indexErrorDoc()).toBe("ix-S1");
    expect(g.takeIndexRepairNotice()).toBeNull();
    tauri.answers.store_load = (args, o) => {
      if (docOfArgs({ cmd: "store_load", args, options: o }) === "ix-S1") return encodeLoad({ torn: true, lastSeq: 0 });
      return f.mem.answers.store_load(args, o);
    };
    await g.retryIndex();
    expect(g.indexError()).toBeNull();
    expect(g.takeIndexRepairNotice()).toBe(REPAIRED);
    expect(g.takeIndexRepairNotice()).toBeNull();
  });

  it("close reports a failed final compact", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    await r.warm();
    e.mem.fail("store_compact", "P", { code: "store.io", message: "Disk full." });
    const err = await rejection(r.close());
    forget(r);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "store.io", message: "Disk full." });
  });

  it("reloadFromServer discards a doc that failed to save", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha", { items: ["A"] });
    const r = await open();
    await r.warm();
    await flush();
    e.mem.fail("store_append", "P", { code: "store.corrupt", message: "P: a record is damaged" });
    const ydoc = (await r.doc("P")).ydoc;
    remote(ydoc, () => ({ t: "rename", item: itemNamed(ydoc, "A"), name: "North" }));
    await flush();
    expect(r.failures().get("P")?.code).toBe("store.corrupt");
    await r.reloadFromServer("P");
    expect(r.failures().has("P")).toBe(false);
    expect((await r.doc("P")).ydoc.getMap("actions").size).toBe(0);
  });

  it("reloadFromServer reports a failure that first happens while discarding", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    await r.warm();
    e.mem.fail("store_compact", "P", { code: "store.io", message: "Disk full." });
    const from = tauri.calls.length;
    const err = await rejection(r.reloadFromServer("P"));
    expect(codeOf(err)).toBe("store.io");
    expect(callsOf(from, "store_set_aside")).toHaveLength(0);
  });

  it("close closes every document when a session close fails", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    const s = await r.session("P");
    const broke = new Error("session broke");
    vi.spyOn(s, "close").mockRejectedValue(broke);
    const from = tauri.calls.length;
    const err = await rejection(r.close());
    forget(r);
    expect(err).toBe(broke);
    await flush();
    expect(callsOf(from, "store_compact").map(xdoc).sort()).toEqual(["P", "local"]);
    const docs = [...(await persistedOf("local")), ...(await persistedOf("P"))];
    expect(docs).toHaveLength(2);
    expect(await Promise.all(docs.map(isClosed))).toEqual([true, true]);
    expect(await rejection(r.close())).toBe(broke);
  });

  it("close collects every failure", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    await r.warm();
    e.mem.fail("store_compact", "local", { code: "store.io", message: "Local disk full." });
    e.mem.fail("store_compact", "P", { code: "store.io", message: "Plan disk full." });
    const err = await rejection(r.close());
    forget(r);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ message: "2 documents failed to close; the first: Local disk full." });
    expect(err).toHaveProperty("cause.code", "store.io");
  });

  it("index close keeps its failure", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    e.mem.fail("store_compact", "local", { code: "store.io", message: "Disk full." });
    const first = await rejection(ix.close());
    expect(codeOf(first)).toBe("store.io");
    expect(await rejection(ix.close())).toBe(first);
  });

  it("a load that settles after reloadFromServer is closed", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    const plan = seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    const held = hold("store_load");
    const stale = r.doc("P");
    await flush();
    await r.reloadFromServer("P");
    const current = await r.doc("P");
    expect(current.ydoc.getMap("actions").size).toBe(0);
    const from = tauri.calls.length;
    held.resolve(encodeLoad({ snapshot: Y.encodeStateAsUpdate(plan), lastSeq: 1 }));
    expect(await stale).toBe(current);
    await flush();
    expect(planOf(r, "P").loaded).toBe(false);
    const docs = await persistedOf("P");
    expect(docs).toHaveLength(2);
    const old = docs.filter((d) => d !== current);
    expect(old).toHaveLength(1);
    expect(await isClosed(old[0])).toBe(true);
    expect(appendsTo(from, "P")).toHaveLength(0);
    expect(r.failures().has("P")).toBe(false);
  });

  it("a dirty load that settles after reloadFromServer writes nothing", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    const plan = seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    const held = hold("store_load");
    const stale = r.doc("P");
    await flush();
    await r.reloadFromServer("P");
    const current = await r.doc("P");
    const from = tauri.calls.length;
    held.resolve(encodeLoad({ records: [Y.encodeStateAsUpdate(plan)], lastSeq: 1 }));
    expect(await stale).toBe(current);
    await flush();
    expect(appendsTo(from, "P")).toHaveLength(0);
    expect(callsOf(from, "store_compact").filter((c) => xdoc(c) === "P")).toHaveLength(0);
    const old = (await persistedOf("P")).filter((d) => d !== current);
    expect(old).toHaveLength(1);
    expect(await isClosed(old[0])).toBe(true);
    expect(r.failures().has("P")).toBe(false);
    expect(current.ydoc.getMap("actions").size).toBe(0);
  });

  it("no load starts while reloadFromServer waits for the set-aside", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    const heldLoad = hold("store_load");
    const stale = r.doc("P");
    await flush();
    const from = tauri.calls.length;
    const heldAside = hold("store_set_aside");
    const reloading = r.reloadFromServer("P");
    await flush();
    expect(callsOf(from, "store_set_aside").map((c) => c.args)).toEqual([{ doc: "P" }]);
    heldLoad.resolve(e.mem.answers.store_load({ doc: "P" }));
    const joined = r.doc("P");
    await flush();
    expect(loadsOf(from, "P")).toBe(0);
    heldAside.resolve(e.mem.answers.store_set_aside({ doc: "P" }));
    await reloading;
    expect(loadsOf(from, "P")).toBe(1);
    const current = await r.doc("P");
    expect(await stale).toBe(current);
    expect(await joined).toBe(current);
    expect(current.ydoc.getMap("actions").size).toBe(0);
    await flush();
    expect(loadsOf(from, "P")).toBe(1);
    expect(appendsTo(from, "P")).toHaveLength(0);
    expect(callsOf(from, "store_compact").filter((c) => xdoc(c) === "P")).toHaveLength(0);
  });

  it("a second reload of the same doc joins the one in flight", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    await r.doc("P");
    const from = tauri.calls.length;
    const heldAside = hold("store_set_aside");
    const first = r.reloadFromServer("P");
    await flush();
    const second = r.reloadFromServer("P");
    await flush();
    expect(r.reloading("P")).toBe(true);
    heldAside.resolve(e.mem.answers.store_set_aside({ doc: "P" }));
    await first;
    expect(r.reloading("P")).toBe(false);
    await second;
    expect(callsOf(from, "store_set_aside")).toHaveLength(1);
    expect(loadsOf(from, "P")).toBe(1);
  });

  it("a reload whose set-aside ends after close loads nothing", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    await r.doc("P");
    const from = tauri.calls.length;
    const heldAside = hold("store_set_aside");
    const reloading = r.reloadFromServer("P");
    await flush();
    const closing = r.close();
    heldAside.resolve(e.mem.answers.store_set_aside({ doc: "P" }));
    await expect(reloading).rejects.toBeInstanceOf(RegistryClosed);
    await closing;
    expect(loadsOf(from, "P")).toBe(0);
  });

  it("an index retry replaces its recorded failure only with the new outcome", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedIndex(e.mem, "ix-S1", [ixAct("s1", [], [ip("R", false)])]);
    e.mem.fail("store_load", "ix-S1", { code: "store.io", message: "Space disk full." });
    const r = await open();
    await flush();
    expect(r.indexErrorDoc()).toBe("ix-S1");
    e.mem.fail("store_load", "ix-S1", { code: "store.io", message: "Space disk still full." });
    await r.retryIndex();
    expect(r.indexErrorDoc()).toBe("ix-S1");
    expect(r.indexError()?.message).toBe("Space disk still full.");
    e.mem.recover("store_load", "ix-S1");
    const broke = new Error("index broke");
    vi.spyOn(IndexDoc, "open").mockRejectedValueOnce(broke);
    expect(await rejection(r.retryIndex())).toBe(broke);
    expect(r.indexErrorDoc()).toBe("ix-S1");
    expect(r.indexError()?.message).toBe("Space disk still full.");
    await r.retryIndex();
    expect(r.indexError()).toBeNull();
    expect(r.indexErrorDoc()).toBeNull();
  });

  it("close during a held warm load", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    const from = tauri.calls.length;
    const held = hold("store_load");
    const warming = r.warm();
    await flush();
    expect(loadsOf(from, "P")).toBe(1);
    await r.close();
    held.resolve(e.mem.answers.store_load({ doc: "P" }));
    await warming;
    const docs = await persistedOf("P");
    expect(docs).toHaveLength(1);
    expect(await isClosed(docs[0])).toBe(true);
    expect(() => r.doc("P")).toThrow("The registry is closed");
    expect(RegistryClosed.prototype).toBeInstanceOf(Error);
    expect(new RegistryClosed("P").message).toBe("The registry closed while P was loading");
  });

  it("a load whose attach throws leaves nothing attached", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Alpha");
    const r = await open();
    const boom = new Error("subscriber broke");
    const cb = vi.fn(() => {
      throw boom;
    });
    const off = r.subscribe(cb);
    const err = await rejection(r.doc("P"));
    off();
    expect(err).toBe(boom);
    expect(cb).toHaveBeenCalled();
    expect(planOf(r, "P").loaded).toBe(false);
    const [first] = await persistedOf("P");
    expect(await isClosed(first)).toBe(true);
    const from = tauri.calls.length;
    const again = await r.doc("P");
    expect(loadsOf(from, "P")).toBe(1);
    expect(again).not.toBe(first);
    expect(planOf(r, "P").loaded).toBe(true);
  });

  it("retryIndex rejects only with a fault it could not record", async () => {
    const e = env();
    seedIndex(e.mem, "local", listing("P"));
    seedIndex(e.mem, "ix-S1", [ixAct("s1", [], [ip("R", false)])]);
    e.mem.fail("store_load", "ix-S1", { code: "store.io", message: "Space disk full." });
    const r = await open();
    await flush();
    e.mem.fail("store_append", "local", { code: "store.io", message: "Local disk full." });
    r.trashPlan("P");
    await flush();
    expect(r.indexErrorDoc()).toBe("local");
    const cb = vi.fn();
    r.subscribe(cb);
    await r.retryIndex();
    expect(r.indexError()?.message).toBe("Local disk full.");
    expect(cb).toHaveBeenCalled();
    e.mem.recover("store_load", "ix-S1");
    const broke = new Error("index broke");
    vi.spyOn(IndexDoc, "open").mockRejectedValueOnce(broke);
    cb.mockClear();
    const err = await rejection(r.retryIndex());
    expect(err).toBe(broke);
    expect(r.indexError()?.message).toBe("Local disk full.");
    expect(r.indexErrorDoc()).toBe("local");
    expect(cb).toHaveBeenCalled();
    const held = r.indexError();
    forget(r);
    expect(await rejection(r.close())).toBe(held);
  });

  it("setLastRegion rolls back when its write fails", async () => {
    const e = env();
    const r = await open({ clock: fixedClock(TODAY) });
    e.state.writeFail = { code: "settings.io", message: "Could not save settings.json: disk full" };
    expect(codeOf(await rejection(r.setLastRegion(ZH)))).toBe("settings.io");
    expect(r.settingsError()).toBeNull();
    e.state.writeFail = null;
    const from = tauri.calls.length;
    const id = await r.createPlan("A");
    expect(callsOf(from, "holidays_year")).toHaveLength(0);
    expect(new Map([...new PlanDoc((await r.doc(id)).ydoc).actions()][0].w.map((x) => [x.u, x.v])).get("cr")).toBeNull();
  });

  it("a successful settings write clears the settings error", async () => {
    const e = env();
    const r = await open({ clock: fixedClock(TODAY) });
    e.state.writeFail = { code: "settings.io", message: "Could not save settings.json: disk full" };
    await r.createPlan("Beta");
    await flush();
    expect(r.settingsError()?.code).toBe("settings.io");
    e.state.writeFail = null;
    const cb = vi.fn();
    r.subscribe(cb);
    await r.setLastRegion(ZH);
    expect(r.settingsError()).toBeNull();
    expect(cb).toHaveBeenCalled();
  });

  it("a remote device name must be normalised", async () => {
    const e = env();
    seedIndex(e.mem, "local", [
      ixAct("a1", [], [ip("P", false)]),
      ixAct("id-S", ["a1"], [own("dn:dev-B", "  ")], "dev-B", "Name device"),
      ixAct("id-T", ["a1"], [own("dn:dev-B", "a\nb")], "dev-B", "Name device"),
    ]);
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    const bad = (id: string) => ({ id, message: "A change to the plan list from Device dev- could not be read: Malformed value for “dn:dev-B”. Update WebBoard on this device." });
    expect(ix.unreadable()).toEqual([bad("id-S"), bad("id-T")]);
    expect(ix.devices()).toEqual(new Map());
    expect(ix.plans()).toEqual([{ id: "P", trashed: false }]);
    await ix.close();
  });
});

describe("Registry: spaces", () => {
  const SP = "sp000000000";
  const IX = "ix-" + SP;
  const SPACE_SETTINGS = { v: 1, lastRegion: null, names: {} };

  const spaceEnv = (o: Parameters<typeof env>[0] = {}): Env => env({ settings: SPACE_SETTINGS, ...o });

  const ipWrites = (calls: readonly Call[], plan: string): Write[] => calls.flatMap(writesOf).filter((w) => w.u === "ip:" + plan);

  async function peer(mine: Registry, update: Uint8Array): Promise<Registry> {
    await flush();
    forget(mine);
    await mine.close();
    const p = env({ settings: SPACE_SETTINGS, answers: { device_info: () => ({ deviceId: "dev-B", platform: "linux" }) } });
    p.mem.seed(IX, update);
    const r = await open();
    await r.attachSpace(SP);
    return r;
  }

  async function reopenMine(theirs: Registry, mine: Env): Promise<Registry> {
    await flush();
    const update = Y.encodeStateAsUpdate((await theirs.doc(IX)).ydoc);
    forget(theirs);
    await theirs.close();
    env({ settings: mine.state.settings, mem: mine.mem });
    mine.mem.seed(IX, update);
    const r = await open();
    await r.attachSpace(SP);
    return r;
  }

  it("attachSpace merges the space index", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing("P", "Q"));
    seedIndex(e.mem, IX, [ixAct("s1", [], [ip("P", false)])]);
    seedPlan(e.mem, "P", "Pea");
    seedPlan(e.mem, "Q", "Queue");
    const r = await open();
    expect(r.attachedSpace()).toBeNull();
    expect(r.plans().map((p) => p.space)).toEqual([null, null]);
    const ix = await r.attachSpace(SP);
    expect(await r.attachSpace(SP)).toBe(ix);
    expect(r.attachedSpace()).toBe(SP);
    expect(loadsOf(0, IX)).toBe(1);
    expect(r.plans().filter((p) => p.id === "P")).toEqual([{ id: "P", name: null, trashed: false, loaded: false, space: SP }]);
    expect(planOf(r, "Q").space).toBeNull();
    await closeAll();

    const f = spaceEnv();
    seedIndex(f.mem, "local", listing());
    const fresh = await open();
    const [a, b] = await Promise.all([fresh.attachSpace(SP), fresh.attachSpace(SP)]);
    expect(a).toBe(b);
    expect(loadsOf(0, IX)).toBe(1);
  });

  it("createPlan goes to the attached space", async () => {
    spaceEnv();
    const r = await open({ clock: fixedClock(TODAY) });
    await r.attachSpace(SP);
    await flush();
    const from = tauri.calls.length;
    const id = await r.createPlan("Alpha");
    await flush();
    const space = appendsTo(from, IX);
    expect(space).toHaveLength(1);
    expect(writesOf(space[0])).toEqual([ip(id, false)]);
    expect(ipWrites(appendsTo(from, "local"), id)).toEqual([]);
    expect(planOf(r, id).space).toBe(SP);
  });

  it("createPlanFrom goes to the attached space", async () => {
    spaceEnv();
    const r = await open({ clock: fixedClock(TODAY) });
    await r.attachSpace(SP);
    await flush();
    const from = tauri.calls.length;
    const id = await r.createPlanFrom(buildImport(VALID_WEBBOARD.bytes, "valid.webboard", r.device.deviceId, "s1", 1000));
    await flush();
    const space = appendsTo(from, IX);
    expect(space).toHaveLength(1);
    expect(writesOf(space[0])).toEqual([ip(id, false)]);
    expect(ipWrites(appendsTo(from, "local"), id)).toEqual([]);
    expect(planOf(r, id).space).toBe(SP);
  });

  it("trashing and restoring a space plan writes the space index", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing("P"));
    seedIndex(e.mem, IX, [ixAct("s1", [], [ip("P", false)])]);
    seedPlan(e.mem, "P", "Pea");
    const r = await open();
    await r.attachSpace(SP);
    await flush();
    const ixDoc = (await r.doc(IX)).ydoc;
    const from = tauri.calls.length;
    r.trashPlan("P");
    await flush();
    const trashed = appendsTo(from, IX);
    expect(trashed).toHaveLength(1);
    expect(writesOf(trashed[0])).toEqual([ip("P", true)]);
    expect(appendsTo(from, "local")).toHaveLength(0);
    expect(planOf(r, "P").trashed).toBe(true);
    const seen = await peer(r, Y.encodeStateAsUpdate(ixDoc));
    expect(planOf(seen, "P")).toMatchObject({ trashed: true, space: SP });
    seen.restorePlan("P");
    const mine = await reopenMine(seen, e);
    expect(planOf(mine, "P")).toMatchObject({ trashed: false, space: SP });
    forget(mine);
    await mine.close();

    const back = spaceEnv();
    seedIndex(back.mem, "local", listing("P"));
    seedIndex(back.mem, IX, [ixAct("s1", [], [ip("P", false)]), ixAct("s2", ["s1"], [ip("P", true)], "dev-A", "Move plan to Trash")]);
    seedPlan(back.mem, "P", "Pea");
    const r2 = await open();
    await r2.attachSpace(SP);
    await flush();
    const ixDoc2 = (await r2.doc(IX)).ydoc;
    const from2 = tauri.calls.length;
    r2.restorePlan("P");
    await flush();
    const restored = appendsTo(from2, IX);
    expect(restored).toHaveLength(1);
    expect(writesOf(restored[0])).toEqual([ip("P", false)]);
    expect(appendsTo(from2, "local")).toHaveLength(0);
    const seen2 = await peer(r2, Y.encodeStateAsUpdate(ixDoc2));
    expect(planOf(seen2, "P")).toMatchObject({ trashed: false, space: SP });
  });

  it("a local-only plan still trashes in local", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing("Q"));
    seedIndex(e.mem, IX, [ixAct("s1", [], [ip("P", false)])]);
    const r = await open();
    await r.attachSpace(SP);
    await flush();
    const from = tauri.calls.length;
    r.trashPlan("Q");
    await flush();
    const local = appendsTo(from, "local");
    expect(local).toHaveLength(1);
    expect(writesOf(local[0])).toEqual([ip("Q", true)]);
    expect(appendsTo(from, IX)).toHaveLength(0);
  });

  it("the space index names devices", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing("P"));
    seedIndex(e.mem, IX, [ixAct("s1", [], [ip("P", false)])]);
    const seeded = seedPlan(e.mem, "P", "Pea", { items: ["A"] });
    const a = itemNamed(seeded, "A");
    const r = await open({ clock: fixedClock(TODAY) });
    await r.attachSpace(SP);
    const s = await r.session("P");
    const base = new Y.Doc();
    Y.applyUpdate(base, Y.encodeStateAsUpdate(seeded));
    s.apply({ t: "rename", item: a, name: "Local" });
    const theirs = remote(base, () => ({ t: "rename", item: a, name: "Remote" }));
    const planDoc = (await r.doc("P")).ydoc;
    Y.applyUpdate(planDoc, Y.encodeStateAsUpdate(base, Y.encodeStateVector(planDoc)));
    const sideOf = (): string | undefined => s.view().choices[0]?.sides.find((x) => x.actions.includes(theirs))?.label;
    expect(s.history().find((h) => h.id === theirs)?.device).toBe("Device dev-");
    expect(sideOf()).toBe("Device dev-");
    const cb = vi.fn();
    r.subscribe(cb);
    const sessionCb = vi.fn();
    s.subscribe(sessionCb);
    const ixDoc = (await r.doc(IX)).ydoc;
    remoteRaw(ixDoc, "dn-B", encodeAction(act("dn-B", headsOf(ixDoc), [own("dn:dev-B", "iPhone")], { dev: "dev-B", lbl: "Name device" })));
    expect(r.devices().get("dev-B")).toBe("iPhone");
    expect(r.devices().get("dev-A")).toBe("Mac");
    expect(cb).toHaveBeenCalled();
    expect(sessionCb).toHaveBeenCalled();
    expect(s.history().find((h) => h.id === theirs)?.device).toBe("iPhone");
    expect(sideOf()).toBe("iPhone");
  });

  it("the space index's name for a device wins", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", [...listing(), ixAct("l-B", ["ix-n"], [own("dn:dev-B", "Old phone")], "dev-B", "Name device")]);
    seedIndex(e.mem, IX, [ixAct("s1", [], [own("dn:dev-B", "iPhone")], "dev-B", "Name device")]);
    const r = await open();
    expect(r.devices().get("dev-B")).toBe("Old phone");
    await r.attachSpace(SP);
    expect(r.devices().get("dev-B")).toBe("iPhone");
  });

  it("naming this device is checked", async () => {
    spaceEnv();
    const r = await open();
    await r.attachSpace(SP);
    await flush();
    const from = tauri.calls.length;
    expect(() => r.nameThisDevice("   ")).toThrow(new Refused("The name is empty. Type at least one character."));
    await flush();
    expect(appendsTo(from, "local")).toHaveLength(0);
    expect(appendsTo(from, IX)).toHaveLength(0);
    expect(r.device.name).toBe("Mac");
    r.nameThisDevice("iPad\n2");
    await flush();
    const local = appendsTo(from, "local");
    const space = appendsTo(from, IX);
    expect(local).toHaveLength(1);
    expect(space).toHaveLength(1);
    expect(writesOf(local[0])).toEqual([own("dn:dev-A", "iPad 2")]);
    expect(writesOf(space[0])).toEqual([own("dn:dev-A", "iPad 2")]);
    expect(r.device.name).toBe("iPad 2");
    const again = tauri.calls.length;
    r.nameThisDevice("iPad 2");
    await flush();
    expect(appendsTo(again, "local")).toHaveLength(0);
    expect(appendsTo(again, IX)).toHaveLength(0);
  });

  it("revoked plans go to the local index", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing());
    seedIndex(e.mem, IX, [ixAct("s1", [], [ip("P", false)]), ixAct("s2", ["s1"], [ip("P2", false)])]);
    seedPlan(e.mem, "P", "Pea");
    seedPlan(e.mem, "P2", "Pod");
    const r = await open({ clock: fixedClock(TODAY) });
    await r.attachSpace(SP);
    const p = await r.session("P");
    const pCb = vi.fn();
    p.subscribe(pCb);
    expect(r.spaceReadOnly()).toBe(false);
    r.setSpaceReadOnly(true);
    expect(r.spaceReadOnly()).toBe(true);
    expect(p.readOnly).toBe(true);
    expect(pCb).toHaveBeenCalledTimes(1);
    r.setSpaceReadOnly(true);
    expect(pCb).toHaveBeenCalledTimes(1);
    await flush();
    const from = tauri.calls.length;
    const x = await r.createPlan("X");
    await flush();
    expect(ipWrites(appendsTo(from, "local"), x)).toEqual([ip(x, false)]);
    expect(appendsTo(from, IX)).toHaveLength(0);
    expect(planOf(r, x).space).toBeNull();
    expect((await r.session(x)).readOnly).toBe(false);
    const from2 = tauri.calls.length;
    const imported = await r.createPlanFrom(buildImport(VALID_WEBBOARD.bytes, "valid.webboard", r.device.deviceId, "s1", 1000));
    await flush();
    expect(ipWrites(appendsTo(from2, "local"), imported)).toEqual([ip(imported, false)]);
    expect(appendsTo(from2, IX)).toHaveLength(0);
    expect((await r.session("P2")).readOnly).toBe(true);
  });

  it("a space plan open before the attach turns read-only when the space attaches read-only", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing("L"));
    seedIndex(e.mem, IX, [ixAct("s1", [], [ip("P", false)])]);
    seedPlan(e.mem, "P", "Pea");
    seedPlan(e.mem, "L", "Lone");
    const r = await open();
    const p = await r.session("P");
    const l = await r.session("L");
    r.setSpaceReadOnly(true);
    expect(p.readOnly).toBe(false);
    await r.attachSpace(SP);
    expect(p.readOnly).toBe(true);
    expect(l.readOnly).toBe(false);
  });

  it("a moved plan stays listed while read-only", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", [
      ...listing("P"),
      ixAct("l-t", ["ix-0"], [ip("P", true)], "dev-A", "Move plan to Trash"),
      ixAct("l-L", ["l-t"], [ip("L", false)]),
    ]);
    seedIndex(e.mem, IX, [ixAct("s1", [], [ip("P", false)])]);
    seedPlan(e.mem, "P", "Pea");
    seedPlan(e.mem, "L", "Lone");
    const r = await open();
    await r.attachSpace(SP);
    r.setSpaceReadOnly(true);
    expect(r.plans().filter((p) => p.id === "P")).toEqual([{ id: "P", name: null, trashed: false, loaded: false, space: SP }]);
    expect((await r.session("P")).readOnly).toBe(true);
    await flush();
    const from = tauri.calls.length;
    expect(() => r.trashPlan("P")).toThrow(new Refused(READ_ONLY));
    expect(() => r.restorePlan("P")).toThrow(new Refused(READ_ONLY));
    await flush();
    expect(callsOf(from, "store_append")).toHaveLength(0);
    r.trashPlan("L");
    await flush();
    const local = appendsTo(from, "local");
    expect(local).toHaveLength(1);
    expect(writesOf(local[0])).toEqual([ip("L", true)]);
  });

  it("a failed space index is retried", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing());
    seedIndex(e.mem, IX, [ixAct("s1", [], [ip("P", false)])]);
    e.mem.fail("store_load", IX, { code: "store.corrupt", message: "Bad record in seg-0.log." });
    const r = await open();
    const err = await rejection(r.attachSpace(SP));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toBe("Bad record in seg-0.log.");
    expect(r.indexError()?.code).toBe("store.corrupt");
    expect(r.attachedSpace()).toBeNull();
    expect(r.plans().filter((p) => p.space !== null)).toEqual([]);
    e.mem.recover("store_load", IX);
    const cb = vi.fn();
    r.subscribe(cb);
    await r.retryIndex();
    expect(r.indexError()).toBeNull();
    expect(planOf(r, "P").space).toBe(SP);
    expect(r.attachedSpace()).toBe(SP);
    expect(cb).toHaveBeenCalled();
  });

  it("the space index's unreadable changes are listed", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing("P"));
    seedIndex(e.mem, IX, [ixAct("s0", [], [own("dn:dev-B", "iPhone")], "dev-B", "Name device"), ixAct("s1", ["s0"], [ip("P", false)])]);
    const r = await open();
    await r.attachSpace(SP);
    const before = r.plans();
    const cb = vi.fn();
    r.subscribe(cb);
    const ixDoc = (await r.doc(IX)).ydoc;
    remoteRaw(ixDoc, "z1", encodeAction(act("z1", ["s1"], [own("zz:1", 1)], { dev: "dev-B" })));
    const spaceLine = "A change to the plan list from iPhone could not be read: Unknown unit key “zz:1”. Update WebBoard on this device.";
    expect(r.indexUnreadable()).toEqual([spaceLine]);
    expect(cb).toHaveBeenCalled();
    expect(r.plans()).toEqual(before);
    const localDoc = (await r.doc("local")).ydoc;
    remoteRaw(localDoc, "z2", encodeAction(act("z2", headsOf(localDoc), [own("zz:2", 1)], { dev: "dev-B" })));
    expect(r.indexUnreadable()).toEqual([
      "A change to the plan list from Device dev- could not be read: Unknown unit key “zz:2”. Update WebBoard on this device.",
      spaceLine,
    ]);
  });

  it("a malformed action in the space index is listed", async () => {
    const line = "A change to the plan list from iPhone could not be read: Action x1 has a malformed lbl. Update WebBoard on this device.";
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing());
    seedIndex(e.mem, IX, [ixAct("s0", [], [own("dn:dev-B", "iPhone")], "dev-B", "Name device")]);
    const r = await open();
    await r.attachSpace(SP);
    const cb = vi.fn();
    r.subscribe(cb);
    const before = r.plans();
    remoteRaw((await r.doc(IX)).ydoc, "x1", ["dev-B", "s1", 0, [], 42, []]);
    expect(r.indexUnreadable()).toEqual([line]);
    expect(cb).toHaveBeenCalled();
    expect(r.plans()).toEqual(before);
    await closeAll();

    const f = spaceEnv();
    seedIndex(f.mem, "local", listing());
    seedIndex(f.mem, IX, [ixAct("s0", [], [own("dn:dev-B", "iPhone")], "dev-B", "Name device"), ["x1", ["dev-B", "s1", 0, [], 42, []]]]);
    const r2 = await open();
    expect(r2.indexUnreadable()).toEqual([]);
    await r2.attachSpace(SP);
    expect(r2.indexUnreadable()).toEqual([line]);
  });

  it("a repaired space index notifies once", async () => {
    const e = spaceEnv();
    tauri.answers.store_load = (args, o) => {
      if (docOfArgs({ cmd: "store_load", args, options: o }) === IX) return encodeLoad({ torn: true, lastSeq: 0 });
      return e.mem.answers.store_load(args, o);
    };
    const r = await open();
    expect(r.takeIndexRepairNotice()).toBeNull();
    await r.attachSpace(SP);
    expect(r.takeIndexRepairNotice()).toBe("The last change to the plan list before WebBoard closed was not saved.");
    expect(r.takeIndexRepairNotice()).toBeNull();
  });

  it("loading again from the server is refused while read-only", async () => {
    const corrupt = { code: "store.corrupt", message: "Bad record in seg-0.log." };
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing());
    seedIndex(e.mem, IX, [ixAct("s1", [], [ip("P", false)])]);
    seedPlan(e.mem, "P", "Pea");
    e.mem.fail("store_load", "P", corrupt);
    const r = await open();
    await r.attachSpace(SP);
    await rejection(r.doc("P"));
    expect(r.failures().get("P")?.code).toBe("store.corrupt");
    r.setSpaceReadOnly(true);
    const from = tauri.calls.length;
    const err = await rejection(r.reloadFromServer("P"));
    expect(err).toBeInstanceOf(Refused);
    expect((err as Refused).message).toBe(READ_ONLY);
    expect(callsOf(from, "store_set_aside")).toHaveLength(0);
    expect(r.failures().get("P")?.message).toBe("Bad record in seg-0.log.");
    await closeAll();

    const f = spaceEnv();
    seedIndex(f.mem, "local", listing());
    seedIndex(f.mem, IX, [ixAct("s1", [], [ip("P", false)])]);
    f.mem.fail("store_load", IX, corrupt);
    const r2 = await open();
    await rejection(r2.attachSpace(SP));
    expect(r2.indexError()?.code).toBe("store.corrupt");
    expect(r2.indexErrorDoc()).toBe(IX);
    r2.setSpaceReadOnly(true);
    const from2 = tauri.calls.length;
    const err2 = await rejection(r2.reloadFromServer(IX));
    expect(err2).toBeInstanceOf(Refused);
    expect((err2 as Refused).message).toBe(READ_ONLY);
    expect(callsOf(from2, "store_set_aside")).toHaveLength(0);
    expect(r2.indexError()?.message).toBe("Bad record in seg-0.log.");
    expect(r2.indexErrorDoc()).toBe(IX);
  });

  it("opening a session notifies before it resolves", async () => {
    const e = spaceEnv();
    seedIndex(e.mem, "local", listing("P"));
    seedPlan(e.mem, "P", "Pea");
    const r = await open();
    const seen: number[] = [];
    r.subscribe(() => seen.push(r.openSessions().length));
    const opening = r.session("P");
    expect(seen).toEqual([]);
    await opening;
    expect(seen).toContain(1);
  });

  it("synced heads are kept in settings", async () => {
    const e = spaceEnv();
    const r = await open();
    expect(r.syncedHeads("P")).toBeNull();
    const from = tauri.calls.length;
    await r.setSyncedHeads("P", ["a1", "a2"]);
    expect(r.syncedHeads("P")).toEqual(["a1", "a2"]);
    expect(settingsWrites(from).map((s) => s.syncedHeads)).toEqual([{ P: ["a1", "a2"] }]);
    e.state.writeFail = { code: "settings.io", message: "Could not save settings.json: disk full" };
    const cb = vi.fn();
    r.subscribe(cb);
    await r.setSyncedHeads(IX, ["b1"]);
    expect(r.settingsError()?.code).toBe("settings.io");
    expect(cb).toHaveBeenCalled();
    expect(r.syncedHeads(IX)).toEqual(["b1"]);
  });
});
