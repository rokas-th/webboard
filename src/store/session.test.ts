import { act as reactAct, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { buildAction, initialAction } from "../actions/build";
import { Refused, type Built, type Intent } from "../actions/intents";
import { buildResolve } from "../actions/resolve";
import { buildRevert, OfferRefused } from "../actions/undo";
import type { Calendar, HolidayDay, RegionRef } from "../domain/calendar";
import type { ItemId } from "../domain/model";
import { newId } from "../log/ids";
import { LogState } from "../log/state";
import type { Action, ActionId, DeviceId } from "../log/types";
import { planRules } from "../plan/rules";
import { key, sched, validateWrite } from "../plan/units";
import { CLOCK_CHECK_MS, fixedClock, notifyEach, systemClock, type Clock } from "../services/clock";
import { HolidayService, noticeText } from "../services/holidays";
import { AppError } from "../services/ipc";
import { act } from "../test/act";
import { CH_ZH, CH_ZH_2026, CH_ZH_2027, FETCHED_AT, holidayDay } from "../test/fixtures/calendars";
import { encodeLoad, memoryStore, type MemoryStore } from "../test/fixtures/store";
import { ctxOf, PLAN_ID } from "../test/planCtx";
import { commandsSince, commandsWith, hold, resetTauri, tauri, type Answer } from "../test/tauriMock";
import { encodeAction, PlanDoc, decodeAction } from "./doc";
import { openPersisted, type PersistedDoc } from "./persist";
import { PlanSession, usePlanView, type SessionDeps } from "./session";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const ID = PLAN_ID;
const TODAY = "2026-11-09";
const OPTS = { pushFromPredecessors: true, returnPushed: true };
const READ_ONLY = "This device was removed from the space; its plans are read-only.";
const OFFER_MESSAGE = "This change is one side of an open choice. Keep the other version to undo it.";
const CHZH: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const RK = "oh:CH:CH-ZH";
const NOON = (d: number): number => new Date(2026, 10, d, 12).getTime();

const PLAIN: Calendar = { region: null, workdays: [1, 2, 3, 4, 5], closures: new Map(), tuning: new Map(), holidays: new Map() };
const ONLY_2026: Calendar = { ...CH_ZH, holidays: new Map([[2026, CH_ZH_2026]]) };
const NO_YEARS: Calendar = { ...CH_ZH, holidays: new Map() };
const DAYS_2028: readonly HolidayDay[] = [holidayDay("2028-01-01", "New Year's Day", "public")];

const daysFor = (year: number): readonly HolidayDay[] =>
  year === 2026 ? CH_ZH_2026.days : year === 2027 ? CH_ZH_2027.days : year === 2028 ? DAYS_2028 : [];

const yearAnswer =
  (o: { fetchedAt?: string; fromCache?: boolean } = {}): Answer =>
  (args) => {
    const year = args !== undefined && !(args instanceof Uint8Array) && !(args instanceof ArrayBuffer) && !Array.isArray(args) ? args.year : undefined;
    if (typeof year !== "number") throw new Error("holidays_year without a year");
    return { days: daysFor(year), fetchedAt: o.fetchedAt ?? FETCHED_AT, fromCache: o.fromCache ?? false, coverage: [2020, 2030] };
  };

const pending = (): Answer => () => new Promise(() => {});

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

const DEVICES: ReadonlyMap<DeviceId, string> = new Map([
  ["dev-A", "Mac"],
  ["dev-B", "iPhone"],
]);

interface Seed {
  calendar?: Calendar;
  link?: boolean;
}

const ROOTS = new WeakMap<Y.Doc, ActionId>();

const rootOf = (d: Y.Doc): ActionId => {
  const id = ROOTS.get(d);
  if (id === undefined) throw new Error("not a seeded doc");
  return id;
};

function seedDoc(o: Seed = {}): Y.Doc {
  const ydoc = new Y.Doc();
  const pd = new PlanDoc(ydoc);
  const log = new LogState(planRules);
  const add = (a: Action, notes: readonly ItemId[]): void => {
    pd.append(a, notes);
    log.add([a]);
  };
  const root = initialAction({ dev: "dev-A", ses: "seed", now: 0, name: "Plan", calendar: o.calendar ?? PLAIN });
  ROOTS.set(ydoc, root.id);
  add(root, []);
  const build = (i: Intent): Built => {
    const b = buildAction(ctxOf(log, "dev-A", TODAY, DEVICES, { ses: "seed" }), i);
    add(b.action, b.newNotes);
    return b;
  };
  const a = build({ t: "create", kind: "task", name: "A", parent: null, after: null, start: "2026-11-09", dur: 3 }).newNotes[0];
  const b = build({ t: "create", kind: "task", name: "B", parent: null, after: null, start: "2026-11-12", dur: 2 }).newNotes[0];
  if (o.link === true) build({ t: "link", from: a, to: b, type: "FS", lag: 0 });
  return ydoc;
}

interface Env {
  mem: MemoryStore;
  docs: PersistedDoc[];
  holidays: HolidayService;
  clock: TestClock;
  devices: Map<DeviceId, string>;
  deviceCbs: (() => void)[];
  offDevices: ReturnType<typeof vi.fn>;
  names: ReturnType<typeof vi.fn>;
  deps: SessionDeps;
}

type TestClock = Clock & { set(today: string): void };

function silentClock(): TestClock & { shift(today: string): void } {
  const base = fixedClock(TODAY);
  let day = TODAY;
  return {
    today: () => day,
    now: () => base.now(),
    subscribe: (cb) => base.subscribe(cb),
    set(next) {
      day = next;
      base.set(next);
    },
    shift(next) {
      day = next;
    },
  };
}

type RejectionListener = (reason: unknown) => void;

declare const process: {
  listeners(event: "unhandledRejection"): RejectionListener[];
  removeAllListeners(event: "unhandledRejection"): void;
  on(event: "unhandledRejection", l: RejectionListener): void;
  once(event: "unhandledRejection", l: RejectionListener): void;
};

let restoreUnhandled: (() => void) | null = null;

const nextUnhandled = (): Promise<unknown> => {
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  restoreUnhandled = () => {
    process.removeAllListeners("unhandledRejection");
    saved.forEach((l) => process.on("unhandledRejection", l));
  };
  return new Promise((resolve) => process.once("unhandledRejection", resolve));
};

afterEach(() => {
  restoreUnhandled?.();
  restoreUnhandled = null;
});

function env(o: { holidays?: HolidayService; devices?: Map<DeviceId, string>; answers?: Record<string, Answer>; clock?: TestClock } = {}): Env {
  const mem = memoryStore();
  resetTauri({ ...mem.answers, holidays_year: yearAnswer(), ...o.answers });
  const docs: PersistedDoc[] = [];
  const holidays = o.holidays ?? new HolidayService(() => NOON(9));
  const clock = o.clock ?? fixedClock(TODAY);
  const devices = o.devices ?? new Map(DEVICES);
  const deviceCbs: (() => void)[] = [];
  const offDevices = vi.fn();
  const names = vi.fn();
  const deps: SessionDeps = {
    persist: async (id) => {
      const d = await openPersisted(id);
      docs.push(d);
      return d;
    },
    holidays,
    clock,
    device: "dev-A",
    devices: () => devices,
    onDevices: (cb) => {
      deviceCbs.push(cb);
      return offDevices;
    },
    onName: names,
  };
  return { mem, docs, holidays, clock, devices, deviceCbs, offDevices, names, deps };
}

async function open(e: Env, seed: Y.Doc | null = seedDoc()): Promise<PlanSession> {
  if (seed !== null) e.mem.seed(ID, Y.encodeStateAsUpdate(seed));
  return PlanSession.open(ID, e.deps);
}

const lastDoc = (e: Env): PersistedDoc => {
  const d = e.docs[e.docs.length - 1];
  if (d === undefined) throw new Error("no doc opened");
  return d;
};

const settle = (e: Env): Promise<void> => lastDoc(e).flush();

const appends = (): number => tauri.calls.filter((c) => c.cmd === "store_append").length;

const itemId = (s: PlanSession, name: string): ItemId => {
  const it = [...s.view().plan.items.values()].find((i) => i.name === name);
  if (it === undefined) throw new Error(`no item ${name}`);
  return it.id;
};

const nameOf = (s: PlanSession, id: ItemId): string => {
  const it = s.view().plan.items.get(id);
  if (it === undefined) throw new Error(`no item ${id}`);
  return it.name;
};

const remoteOf = (s: PlanSession): Y.Doc => {
  const r = new Y.Doc();
  Y.applyUpdate(r, s.encodeState());
  return r;
};

const logOf = (r: Y.Doc): LogState => {
  const l = new LogState(planRules);
  l.add(new PlanDoc(r).actions());
  return l;
};

const remoteBuild = (r: Y.Doc, i: Intent, dev: DeviceId = "dev-B"): Built => {
  const b = buildAction(ctxOf(logOf(r), dev, TODAY, DEVICES), i);
  new PlanDoc(r).append(b.action, b.newNotes);
  return b;
};

const remoteRaw = (r: Y.Doc, id: ActionId, raw: unknown): void => {
  r.getMap("actions").set(id, raw);
};

const deliver = (r: Y.Doc, e: Env): void => {
  const local = lastDoc(e).ydoc;
  Y.applyUpdate(local, Y.encodeStateAsUpdate(r, Y.encodeStateVector(local)));
};

const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

const entry = (s: PlanSession, id: ActionId) => {
  const h = s.history().find((x) => x.id === id);
  if (h === undefined) throw new Error(`no history entry ${id}`);
  return h;
};

async function clash(e: Env) {
  const s = await open(e);
  const r = remoteOf(s);
  const a = itemId(s, "A");
  const north = s.apply({ t: "rename", item: a, name: "North" });
  const south = remoteBuild(r, { t: "rename", item: a, name: "South" });
  deliver(r, e);
  expect(s.view().choices).toHaveLength(1);
  const choice = s.view().choices[0];
  const side = (label: string): string => {
    const found = choice.sides.find((x) => x.label === label);
    if (found === undefined) throw new Error(`no side ${label}`);
    return found.key;
  };
  const macKey = side("Mac");
  const other = choice.sides.find((x) => x.key !== macKey);
  if (other === undefined) throw new Error("no second side");
  return { s, r, a, north, south, choice, macKey, bKey: other.key };
}

beforeEach(() => resetTauri({}));

describe("PlanSession", () => {
  it("apply persists", async () => {
    const e = env();
    const s = await open(e);
    await settle(e);
    const from = tauri.calls.length;
    const built = s.apply({ t: "create", kind: "task", name: "C", parent: null, after: null, start: "2026-11-16", dur: 3 });
    await settle(e);
    const sent = tauri.calls.slice(from).filter((c) => c.cmd === "store_append");
    expect(sent).toHaveLength(1);
    const body = sent[0].args;
    if (!(body instanceof Uint8Array)) throw new Error("store_append was not sent raw bytes");
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, body);
    const map = fresh.getMap("actions");
    expect([...map.keys()]).toEqual([built.action.id]);
    expect(decodeAction(built.action.id, map.get(built.action.id))).toEqual(built.action);
    expect(s.view().today).toBe("2026-11-09");
    expect(nameOf(s, built.newNotes[0])).toBe("C");
  });

  it("undo and redo", async () => {
    const s = await open(env());
    const live = (): boolean => [...s.view().plan.items.values()].some((i) => i.name === "C" && !i.trashed);
    s.apply({ t: "create", kind: "task", name: "C", parent: null, after: null, start: "2026-11-16", dur: 3 });
    expect(live()).toBe(true);
    expect(s.undo()).not.toBeNull();
    expect(live()).toBe(false);
    expect(s.canRedo()).toBe(true);
    expect(s.redo()).not.toBeNull();
    expect(live()).toBe(true);
    expect(s.undo()).not.toBeNull();
    s.apply({ t: "rename", item: itemId(s, "A"), name: "A2" });
    expect(s.canRedo()).toBe(false);
  });

  it("remote never pushes", async () => {
    const e = env();
    const s = await open(e, seedDoc({ link: true }));
    const a = itemId(s, "A");
    const b = itemId(s, "B");
    const bBefore = s.view().plan.items.get(b);
    const r = remoteOf(s);
    const l = logOf(r);
    const sc = s.view().plan.items.get(a)?.schedule;
    if (sc === undefined || sc === null) throw new Error("A has no schedule");
    const move = act(newId(), [...l.heads], [{ u: key.s(a), v: sched.enc({ ...sc, start: "2026-11-12" }), c: "own" }], { dev: "dev-B" });
    new PlanDoc(r).append(move, []);
    const size = lastDoc(e).ydoc.getMap("actions").size;
    deliver(r, e);
    expect(lastDoc(e).ydoc.getMap("actions").size).toBe(size + 1);
    expect(s.view().plan.items.get(b)).toEqual(bBefore);
    const early = s.view().derived.conflicts.filter((c) => c.kind === "early");
    expect(early).toHaveLength(1);
    expect(early[0].kind === "early" && early[0].link).toBe(`${a}>${b}`);
    expect(s.canUndo()).toBe(false);
  });

  it("refused leaves no trace", async () => {
    const e = env();
    const s = await open(e, seedDoc({ link: true }));
    await settle(e);
    const before = appends();
    expect(() => s.apply({ t: "link", from: itemId(s, "B"), to: itemId(s, "A"), type: "FS", lag: 0 })).toThrow(Refused);
    await settle(e);
    expect(appends()).toBe(before);
    expect(s.canUndo()).toBe(false);
  });

  it("preview", async () => {
    const e = env();
    const s = await open(e);
    await settle(e);
    const before = appends();
    const view = s.view();
    expect(s.preview({ t: "move", items: [itemId(s, "B")], days: 2 }).itemsChanged).toBe(1);
    await settle(e);
    expect(appends()).toBe(before);
    expect(s.view()).toBe(view);
  });

  it("revert", async () => {
    const e = env();
    const s = await open(e);
    const first = s.apply({ t: "rename", item: itemId(s, "A"), name: "A2" });
    s.apply({ t: "rename", item: itemId(s, "B"), name: "B2" });
    const id = first.action.id;
    const r1 = s.revert(id);
    expect(r1.action.w).toEqual([{ u: key.a(id), v: false, c: "revert" }]);
    expect(r1.action.meta?.revert).toBe(id);
    expect(entry(s, id).active).toBe(false);
    const label = entry(s, id).label;
    const r2 = s.revert(id);
    expect(r2.action.w).toEqual([{ u: key.a(id), v: true, c: "revert" }]);
    expect(r2.action.lbl).toBe("Brought back: " + label);
    expect(entry(s, id).active).toBe(true);
    await settle(e);
    const stored = lastDoc(e).ydoc.getMap("actions");
    expect(decodeAction(r1.action.id, stored.get(r1.action.id))).toEqual(r1.action);
    expect(decodeAction(r2.action.id, stored.get(r2.action.id))).toEqual(r2.action);
  });

  it("revert appends what buildRevert builds", async () => {
    const s = await open(env());
    const first = s.apply({ t: "rename", item: itemId(s, "A"), name: "A2" });
    const expected = buildRevert(ctxOf(logOf(remoteOf(s)), "dev-A", TODAY, DEVICES), first.action.id).action;
    const got = s.revert(first.action.id).action;
    expect({ w: got.w, lbl: got.lbl, meta: got.meta, dev: got.dev }).toEqual({ w: expected.w, lbl: expected.lbl, meta: expected.meta, dev: expected.dev });
  });

  it("resolve", async () => {
    const e = env();
    const { s, a, choice, macKey } = await clash(e);
    await settle(e);
    const before = appends();
    s.resolve(choice.id, { side: macKey }, OPTS);
    expect(nameOf(s, a)).toBe("North");
    expect(s.view().choices).toEqual([]);
    await settle(e);
    expect(appends()).toBe(before + 1);
    expect(s.canRedo()).toBe(false);
  });

  it("undo offer", async () => {
    const e = env();
    const { s, choice, bKey } = await clash(e);
    await settle(e);
    const before = appends();
    const held = s.view().held;
    const cs = s.view().choices;
    const next = s.nextUndo();
    expect(s.undoOffer()).toEqual({ choice: choice.id, side: bKey });
    const err = thrown(() => s.undo());
    expect(err).toBeInstanceOf(OfferRefused);
    expect(err instanceof OfferRefused && err.offer).toEqual({ choice: choice.id, side: bKey });
    expect(s.view().held).toEqual(held);
    expect(s.view().choices).toEqual(cs);
    expect(s.nextUndo()).toBe(next);
    await settle(e);
    expect(appends()).toBe(before);
  });

  it("revert offer", async () => {
    const e = env();
    const { s, choice, bKey, north } = await clash(e);
    await settle(e);
    const before = appends();
    const id = north.action.id;
    const canUndo = s.canUndo();
    const next = s.nextUndo();
    [() => s.revert(id), () => s.previewRevert(id)].forEach((f) => {
      const err = thrown(f);
      expect(err).toBeInstanceOf(OfferRefused);
      expect(err instanceof OfferRefused && err.offer).toEqual({ choice: choice.id, side: bKey });
      expect(err instanceof Error && err.message).toBe(OFFER_MESSAGE);
    });
    await settle(e);
    expect(appends()).toBe(before);
    expect(entry(s, id).active).toBe(true);
    expect(s.canUndo()).toBe(canUndo);
    expect(s.nextUndo()).toBe(next);
  });

  it("read-only", async () => {
    const e = env();
    const { s, a, choice, macKey, north } = await clash(e);
    expect(s.readOnly).toBe(false);
    const cb = vi.fn();
    s.subscribe(cb);
    s.setReadOnly(true);
    expect(s.readOnly).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    await settle(e);
    const before = appends();
    const writes: (() => unknown)[] = [
      () => s.apply({ t: "rename", item: a, name: "X" }),
      () => s.undo(),
      () => s.redo(),
      () => s.revert(north.action.id),
      () => s.resolve(choice.id, { side: macKey }, OPTS),
    ];
    writes.forEach((f) => {
      const err = thrown(f);
      expect(err).toBeInstanceOf(Refused);
      expect(err instanceof Error && err.message).toBe(READ_ONLY);
    });
    await settle(e);
    expect(appends()).toBe(before);
    s.setReadOnly(false);
    s.apply({ t: "rename", item: itemId(s, "B"), name: "B2" });
    await settle(e);
    expect(appends()).toBe(before + 1);
  });

  it("reopen forgets undo", async () => {
    const e = env();
    const s = await open(e);
    s.apply({ t: "rename", item: itemId(s, "A"), name: "A2" });
    expect(s.canUndo()).toBe(true);
    await s.close();
    await lastDoc(e).close();
    const again = await open(e, null);
    expect(nameOf(again, itemId(again, "A2"))).toBe("A2");
    expect(again.canUndo()).toBe(false);
    expect(again.nextUndo()).toBeNull();
  });

  it("same device, other session", async () => {
    const e = env();
    const s = await open(e);
    const r = remoteOf(s);
    const b = buildAction(ctxOf(logOf(r), "dev-A", TODAY, DEVICES, { ses: "other" }), { t: "rename", item: itemId(s, "A"), name: "A2" });
    new PlanDoc(r).append(b.action, []);
    deliver(r, e);
    expect(nameOf(s, itemId(s, "A2"))).toBe("A2");
    expect(s.canUndo()).toBe(false);
  });

  it("append failure", async () => {
    const e = env();
    const s = await open(e);
    await settle(e);
    e.mem.fail("store_append", ID, { code: "store.io", message: "The disk is full." });
    const cb = vi.fn();
    s.subscribe(cb);
    s.apply({ t: "rename", item: itemId(s, "A"), name: "A2" });
    const afterApply = cb.mock.calls.length;
    await flush();
    expect(s.storeError()?.code).toBe("store.io");
    expect(cb.mock.calls.length).toBeGreaterThan(afterApply);
  });

  it("repair notice once", async () => {
    const e = env();
    resetTauri({ ...e.mem.answers, store_load: () => encodeLoad({ torn: true, snapshot: Y.encodeStateAsUpdate(seedDoc()), lastSeq: 1 }) });
    const s = await PlanSession.open(ID, e.deps);
    expect(s.takeRepairNotice()).toBe("The last change before WebBoard stopped was cut off while saving and was not kept.");
    expect(s.takeRepairNotice()).toBeNull();
    const plain = await open(env());
    expect(plain.takeRepairNotice()).toBeNull();
  });

  it("clock", async () => {
    const e = env();
    const s = await open(e);
    const cb = vi.fn();
    s.subscribe(cb);
    e.clock.set("2026-11-10");
    expect(s.view().today).toBe("2026-11-10");
    expect(cb).toHaveBeenCalled();
  });

  it("date change re-checks holidays", async () => {
    let now = NOON(9);
    const holidays = new HolidayService(() => now);
    const e = env({ holidays, answers: { holidays_year: yearAnswer({ fromCache: true, fetchedAt: "2026-11-09T11:00:00Z" }) } });
    await holidays.warm(CHZH, [2026, 2027]);
    tauri.answers.holidays_year = yearAnswer();
    const from = tauri.calls.length;
    const refresh = vi.spyOn(holidays, "refresh");
    const s = await open(e, seedDoc({ calendar: CH_ZH }));
    await flush();
    expect(commandsSince(from).filter((c) => c === "holidays_year")).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
    const at = tauri.calls.length;
    now = NOON(10);
    e.clock.set("2026-11-10");
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(ID, s);
    expect(commandsSince(at).filter((c) => c === "holidays_year")).toHaveLength(2);
    expect(commandsWith(at, "holidays_year", { year: 2026, fresh: true })).toBe(1);
    expect(commandsWith(at, "holidays_year", { year: 2027, fresh: true })).toBe(1);
    await s.close();
    const closedAt = tauri.calls.length;
    now = NOON(11);
    e.clock.set("2026-11-11");
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(commandsSince(closedAt).filter((c) => c === "holidays_year")).toEqual([]);
  });

  it("devices change", async () => {
    const e = env({ devices: new Map([["dev-A", "Mac"]]) });
    const { s, choice, south } = await clash(e);
    const label = (): string | undefined => s.view().choices[0]?.sides.find((x) => x.key !== choice.sides.find((y) => y.label === "Mac")?.key)?.label;
    expect(choice.sides.map((x) => x.label).sort()).toEqual(["Device dev-", "Mac"]);
    expect(entry(s, south.action.id).device).toBe("Device dev-");
    const cb = vi.fn();
    s.subscribe(cb);
    e.devices.set("dev-B", "iPhone");
    e.deviceCbs.forEach((f) => f());
    expect(label()).toBe("iPhone");
    expect(entry(s, south.action.id).device).toBe("iPhone");
    expect(cb).toHaveBeenCalled();
    await s.close();
    expect(e.offDevices).toHaveBeenCalledTimes(1);
  });

  it("kept line names the device", async () => {
    const e = env();
    const s = await open(e);
    const a = itemId(s, "A");
    const m = s.apply({ t: "move", items: [a], days: 3 }).action.id;
    const r = remoteOf(s);
    remoteBuild(r, { t: "move", items: [a], days: 1 });
    deliver(r, e);
    expect(s.previewRevert(m).kept).toEqual(["“A” was changed since on the iPhone — kept"]);
    e.devices.set("dev-B", "iPad");
    e.deviceCbs.forEach((f) => f());
    const line = "“A” was changed since on the iPad — kept";
    expect(s.previewRevert(m).kept).toEqual([line]);
    const undone = s.undo();
    if (undone === null) throw new Error("nothing to undo");
    expect(undone.preview.kept).toEqual([line]);
    expect(undone.toast.endsWith(` ${line}.`)).toBe(true);
  });

  it("history", async () => {
    const e = env();
    const seed = seedDoc();
    const s = await open(e, seed);
    const a = itemId(s, "A");
    const b = itemId(s, "B");
    const n1 = s.apply({ t: "rename", item: a, name: "X" }).action.id;
    const n2 = s.apply({ t: "rename", item: b, name: "Y" }).action.id;
    const u = s.undo()?.action.id;
    if (u === undefined) throw new Error("nothing to undo");
    expect(entry(s, n2).active).toBe(false);
    expect(entry(s, u).active).toBe(true);
    const rd = s.redo()?.action.id;
    if (rd === undefined) throw new Error("nothing to redo");
    expect(entry(s, rd).active).toBe(true);
    const v = s.revert(n1).action.id;
    expect(entry(s, v).active).toBe(true);
    expect(entry(s, n1).active).toBe(false);
    const r = remoteOf(s);
    const zed = remoteBuild(r, { t: "rename", item: b, name: "Z" }, "dev-Zed").action.id;
    deliver(r, e);
    expect(entry(s, zed).device).toBe("Device dev-");
    const r2 = remoteOf(s);
    s.apply({ t: "rename", item: a, name: "North" });
    remoteBuild(r2, { t: "rename", item: a, name: "South" });
    deliver(r2, e);
    const choice = s.view().choices[0];
    const mac = choice.sides.find((x) => x.label === "Mac")?.key;
    if (mac === undefined) throw new Error("no Mac side");
    const res = s.resolve(choice.id, { side: mac }, OPTS).action.id;
    expect(entry(s, res).active).toBe(true);
    const h = s.history();
    expect(h[0].id).toBe(res);
    const roots = h.filter((x) => x.root);
    expect(roots.map((x) => x.id)).toEqual([rootOf(seed)]);
    const others = h.filter((x) => x.id !== rootOf(seed));
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((x) => x.root === false)).toBe(true);
    expect(entry(s, n1).device).toBe("Mac");
    await settle(e);
    const before = appends();
    const root = roots[0].id;
    [() => s.revert(root), () => s.previewRevert(root)].forEach((f) => {
      const err = thrown(f);
      expect(err).toBeInstanceOf(Refused);
      expect(err instanceof Error && err.message).toBe("The action that created this plan cannot be reverted.");
    });
    await settle(e);
    expect(appends()).toBe(before);
    expect(s.history()).toEqual(h);
  });

  it("nextUndo", async () => {
    const s = await open(env());
    const built = s.apply({ t: "rename", item: itemId(s, "A"), name: "A2" });
    expect(s.nextUndo()).toBe(built.action.id);
    s.undo();
    expect(s.nextUndo()).toBeNull();
  });

  it("previewResolve", async () => {
    const e = env();
    const { s, a, choice, macKey } = await clash(e);
    await settle(e);
    const before = appends();
    const view = s.view();
    const rp = s.previewResolve(choice.id, { side: macKey }, OPTS);
    expect(rp.rows.map((x) => x.item)).toContain(a);
    await settle(e);
    expect(appends()).toBe(before);
    expect(s.view()).toBe(view);
  });

  it("settled meanwhile", async () => {
    const e = env();
    const { s, r, a, choice, macKey, bKey } = await clash(e);
    const old = choice.id;
    Y.applyUpdate(r, s.encodeState());
    const l = logOf(r);
    const ctx = ctxOf(l, "dev-B", TODAY);
    const there = ctx.view.choices.find((c) => c.id === old);
    if (there === undefined) throw new Error("the remote does not see the choice");
    const res = buildResolve(ctx, there, { side: bKey }, OPTS);
    new PlanDoc(r).append(res.action, []);
    deliver(r, e);
    expect(s.view().choices).toEqual([]);
    expect(nameOf(s, a)).toBe("South");
    await settle(e);
    const before = appends();
    const canUndo = s.canUndo();
    [() => s.previewResolve(old, { side: macKey }, OPTS), () => s.resolve(old, { side: macKey }, OPTS)].forEach((f) => {
      const err = thrown(f);
      expect(err).toBeInstanceOf(Refused);
      expect(err instanceof Error && err.message).toBe("This choice was settled meanwhile.");
    });
    await settle(e);
    expect(appends()).toBe(before);
    expect(nameOf(s, a)).toBe("South");
    expect(s.canUndo()).toBe(canUndo);
  });

  it("unreadable remote action", async () => {
    const e = env();
    const seed = seedDoc();
    const pd = new PlanDoc(seed);
    const l = logOf(seed);
    const items = [...l.units().keys()].filter((u) => u.startsWith("n:"));
    const nameUnit = (n: string): string => {
      const u = items.find((x) => l.unit(x)?.value === n);
      if (u === undefined) throw new Error(`no item named ${n}`);
      return u;
    };
    const aId = nameUnit("A").slice(2);
    const bad = { u: key.s(aId), v: "x", c: "own" as const };
    const rId = newId();
    pd.append(act(rId, [...l.heads], [bad], { dev: "dev-B" }), []);
    pd.append(act(newId(), [rId], [{ u: nameUnit("A"), v: "A2", c: "own" }], { dev: "dev-B" }), []);
    pd.append(act(newId(), [...l.heads], [{ u: nameUnit("B"), v: "B2", c: "own" }], { dev: "dev-B" }), []);
    const message = ((): string => {
      try {
        validateWrite(bad);
      } catch (err) {
        if (err instanceof Error) return err.message;
      }
      throw new Error("validateWrite accepted the bad write");
    })();
    const s = await open(e, seed);
    expect(s.view().unreadable).toEqual([{ id: rId, message: "A change from iPhone could not be read: " + message + ". Update WebBoard on this device." }]);
    expect(s.view().pending).toBe(1);
    expect(itemId(s, "B2")).toBeDefined();
    expect(nameOf(s, aId)).toBe("A");
  });

  it("undecodable remote action", async () => {
    const e = env();
    const s = await open(e);
    const r = remoteOf(s);
    const l = logOf(r);
    const d = newId();
    remoteRaw(r, d, ["dev-B", "s-dev-B", 0, [...l.heads], 5, []]);
    const child = act(newId(), [d], [{ u: key.n(itemId(s, "A")), v: "A2", c: "own" }], { dev: "dev-B" });
    remoteRaw(r, child.id, encodeAction(child));
    deliver(r, e);
    expect(s.view().unreadable).toEqual([{ id: d, message: "A change from iPhone could not be read: Action " + d + " has a malformed lbl. Update WebBoard on this device." }]);
    expect(s.view().pending).toBe(1);
    expect(nameOf(s, itemId(s, "A"))).toBe("A");
  });

  it("refused remote action joins unreadable", async () => {
    const e = env();
    const s = await open(e);
    const a = itemId(s, "A");
    const r = remoteOf(s);
    const x = s.apply({ t: "rename", item: itemId(s, "B"), name: "Local" }).action.id;
    const parent = remoteBuild(r, { t: "rename", item: a, name: "Remote" }).action.id;
    const q = act(newId(), [parent], [{ u: key.a(x), v: false, c: "revert" }], { dev: "dev-B" });
    const q2 = act(newId(), [q.id], [{ u: key.n(a), v: "Later", c: "own" }], { dev: "dev-B" });
    remoteRaw(r, q.id, encodeAction(q));
    remoteRaw(r, q2.id, encodeAction(q2));
    deliver(r, e);
    const expected = [{ id: q.id, message: `A change from iPhone could not be read: Action ${q.id} writes a:${x} without having seen it. Update WebBoard on this device.` }];
    expect(s.view().unreadable).toEqual(expected);
    expect(nameOf(s, a)).toBe("Remote");
    expect(s.view().pending).toBe(1);
    expect(entry(s, x).active).toBe(true);
    await s.close();
    await lastDoc(e).close();
    const again = await open(e, null);
    expect(again.view().unreadable).toEqual(expected);
    expect(again.view().pending).toBe(1);
    expect(nameOf(again, a)).toBe("Remote");
  });

  it("an update to a stored action is loud", async () => {
    const e = env();
    const s = await open(e);
    const r = remoteOf(s);
    const first = s.history()[s.history().length - 1].id;
    r.getMap("actions").set(first, ["dev-B", "s", 0, [], "changed", []]);
    expect(() => deliver(r, e)).toThrow(`Action ${first} was updated; the action log is append-only`);
  });

  it("name cache", async () => {
    const e = env();
    const s = await open(e);
    expect(e.names).not.toHaveBeenCalled();
    s.apply({ t: "planName", name: "Bridge" });
    expect(e.names).toHaveBeenCalledTimes(1);
    expect(e.names).toHaveBeenLastCalledWith(ID, "Bridge");
    s.apply({ t: "rename", item: itemId(s, "A"), name: "A2" });
    expect(e.names).toHaveBeenCalledTimes(1);
    const r = remoteOf(s);
    remoteBuild(r, { t: "planName", name: "Harbour" });
    deliver(r, e);
    expect(e.names).toHaveBeenCalledTimes(2);
    expect(e.names).toHaveBeenLastCalledWith(ID, "Harbour");
  });

  it("missing years", async () => {
    const e = env();
    const onMissing = vi.spyOn(e.holidays, "onMissing");
    const s = await open(e, seedDoc({ calendar: CH_ZH }));
    expect(onMissing).not.toHaveBeenCalled();
    s.apply({ t: "create", kind: "task", name: "Far", parent: null, after: null, start: "2028-03-01", dur: 2 });
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing).toHaveBeenLastCalledWith(ID, s, [2028], "own");
    const r = remoteOf(s);
    remoteBuild(r, { t: "create", kind: "task", name: "Farther", parent: null, after: null, start: "2029-03-01", dur: 2 });
    deliver(r, e);
    expect(onMissing).toHaveBeenCalledTimes(2);
    expect(onMissing).toHaveBeenLastCalledWith(ID, s, [2029], "merge");
    await flush();
  });

  it("cached year rides", async () => {
    const e = env();
    await e.holidays.warm(CHZH, [2028]);
    const onMissing = vi.spyOn(e.holidays, "onMissing");
    const s = await open(e, seedDoc({ calendar: CH_ZH }));
    const built = s.apply({ t: "create", kind: "task", name: "Far", parent: null, after: null, start: "2028-03-01", dur: 2 });
    expect(built.action.w.map((w) => w.u)).toContain(key.ch(2028));
    expect(s.view().derived.missingYears).toEqual([]);
    expect(onMissing).not.toHaveBeenCalled();
    await flush();
  });

  it("open", async () => {
    const e = env();
    const warm = vi.spyOn(e.holidays, "warm");
    const refresh = vi.spyOn(e.holidays, "refresh");
    const held = hold("holidays_year");
    const s = await open(e, seedDoc({ calendar: ONLY_2026 }));
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith(CHZH, [2026, 2027]);
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    held.resolve({ days: CH_ZH_2026.days, fetchedAt: FETCHED_AT, fromCache: false, coverage: [2020, 2030] });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(ID, s);
  });

  it("closed before the warm settles", async () => {
    const e = env();
    const refresh = vi.spyOn(e.holidays, "refresh");
    const held = hold("holidays_year");
    const s = await open(e, seedDoc({ calendar: ONLY_2026 }));
    await s.close();
    held.resolve({ days: CH_ZH_2026.days, fetchedAt: FETCHED_AT, fromCache: false, coverage: [2020, 2030] });
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("missing at open", async () => {
    const e = env({ answers: { holidays_year: pending() } });
    const onMissing = vi.spyOn(e.holidays, "onMissing");
    const s = await open(e, seedDoc({ calendar: NO_YEARS }));
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing).toHaveBeenCalledWith(ID, s, [2026], "merge");
    expect(e.holidays.notices(ID).map((n) => noticeText(n).text)).toContain("Holidays for 2026 not loaded — load");
  });

  it("failed year at open", async () => {
    const offline = { code: "holidays.offline", message: "Could not reach openholidaysapi.org." };
    const e = env({
      answers: {
        holidays_year: () => {
          throw offline;
        },
      },
    });
    await e.holidays.warm(CHZH, [2026]);
    await open(e, seedDoc({ calendar: NO_YEARS }));
    const texts = e.holidays.notices(ID).map(noticeText);
    const failed = texts.find((t) => t.text === "Holidays for 2026 not loaded — retry");
    if (failed === undefined) throw new Error(`no failed notice in ${JSON.stringify(texts)}`);
    expect(failed.detail?.startsWith(offline.message)).toBe(true);
    expect(failed.detail?.endsWith("Tried 2026-11-09 12:00.")).toBe(true);
    await flush();
  });

  it("no region, no notice", async () => {
    const e = env();
    const onMissing = vi.spyOn(e.holidays, "onMissing");
    const warm = vi.spyOn(e.holidays, "warm");
    await open(e);
    expect(onMissing).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
  });

  it("notice follows the plan", async () => {
    const e = env();
    const reconcile = vi.spyOn(e.holidays, "reconcile");
    const s = await open(e, seedDoc({ calendar: CH_ZH }));
    await flush();
    const r = remoteOf(s);
    remoteBuild(r, { t: "create", kind: "task", name: "Far", parent: null, after: null, start: "2028-03-01", dur: 2 });
    deliver(r, e);
    expect(e.holidays.notices(ID)).toContainEqual({ k: "notLoaded", year: 2028 });
    const cal = s.view().plan.calendar;
    const holidays = new Map(cal.holidays);
    holidays.set(2028, { region: RK, year: 2028, days: DAYS_2028, fetchedAt: FETCHED_AT });
    remoteBuild(r, { t: "calendar", next: { ...cal, holidays }, base: cal });
    deliver(r, e);
    expect(s.view().derived.missingYears).toEqual([]);
    expect(e.holidays.notices(ID).filter((n) => n.year === 2028)).toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(reconcile.mock.calls.every(([plan, host]) => plan === ID && host === s)).toBe(true);
  });

  it("authorOf", async () => {
    const e = env();
    const s = await open(e);
    const a = itemId(s, "A");
    s.apply({ t: "rename", item: a, name: "North" });
    expect(s.authorOf(key.n(a))).toEqual({ dev: "dev-A", device: "Mac" });
    const r = remoteOf(s);
    remoteBuild(r, { t: "trash", items: [a] });
    deliver(r, e);
    expect(s.authorOf(key.e(a))).toEqual({ dev: "dev-B", device: "iPhone" });
    expect(s.authorOf(key.n("nope"))).toBeNull();
  });

  it("encodeState", async () => {
    const e = env();
    const s = await open(e);
    s.apply({ t: "rename", item: itemId(s, "A"), name: "A2" });
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, s.encodeState());
    const ids = (d: Y.Doc): string[] => [...new PlanDoc(d).actions()].map((x) => x.id).sort();
    expect(ids(fresh)).toEqual(ids(lastDoc(e).ydoc));
    const bytes = s.encodeState();
    await settle(e);
    const before = appends();
    s.setReadOnly(true);
    expect(s.encodeState()).toEqual(bytes);
    await settle(e);
    expect(appends()).toBe(before);
  });

  it("note", async () => {
    const e = env();
    const s = await open(e);
    const built = s.apply({ t: "create", kind: "task", name: "C", parent: null, after: null, start: "2026-11-16", dur: 1 });
    expect(s.note(built.newNotes[0]).doc).toBe(lastDoc(e).ydoc);
  });

  it("a recompute before the tick still refreshes holidays on the date change", async () => {
    const clock = silentClock();
    const e = env({ clock });
    const refresh = vi.spyOn(e.holidays, "refresh");
    const s = await open(e, seedDoc({ calendar: CH_ZH }));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    clock.shift("2026-11-10");
    const r = remoteOf(s);
    remoteBuild(r, { t: "rename", item: itemId(s, "A"), name: "A2" });
    deliver(r, e);
    expect(s.view().today).toBe("2026-11-10");
    clock.set("2026-11-10");
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(ID, s);
  });

  it("a failed refresh names the plan", async () => {
    const e = env();
    const s = await open(e, seedDoc({ calendar: CH_ZH }));
    await flush();
    const boom = new Error("boom");
    vi.spyOn(e.holidays, "refresh").mockRejectedValue(boom);
    const rejected = nextUnhandled();
    e.clock.set("2026-11-10");
    const reason = await rejected;
    expect(reason instanceof Error && reason.message).toBe(`Holiday refresh for plan ${ID} failed: boom`);
    expect(reason).toHaveProperty("cause", boom);
    await s.close();
  });

  it("a failed warm names the plan", async () => {
    const e = env();
    const boom = new Error("warm broke");
    vi.spyOn(e.holidays, "warm").mockRejectedValue(boom);
    const rejected = nextUnhandled();
    const s = await open(e, seedDoc({ calendar: CH_ZH }));
    const reason = await rejected;
    expect(reason instanceof Error && reason.message).toBe(`Holiday warm for plan ${ID} failed: warm broke`);
    expect(reason).toHaveProperty("cause", boom);
    await s.close();
  });

  it("a throwing subscriber does not stop the rest", async () => {
    const s = await open(env());
    const boom = new Error("first");
    const second = vi.fn();
    s.subscribe(() => {
      throw boom;
    });
    s.subscribe(second);
    expect(thrown(() => s.setReadOnly(true))).toBe(boom);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a subscriber throw does not hide an append failure", async () => {
    const e = env();
    const s = await open(e);
    const a = itemId(s, "A");
    await lastDoc(e).close();
    const boom = new Error("subscriber");
    s.subscribe(() => {
      throw boom;
    });
    const err = thrown(() => s.apply({ t: "rename", item: a, name: "A2" }));
    expect(err instanceof Error && err.message).toBe(`Document ${ID} was edited after close`);
    expect(err).toHaveProperty("cause", expect.any(AppError));
    expect(err).toHaveProperty("cause.code", "store.closed");
    expect(err).toHaveProperty("suppressed", boom);
  });

  it("a local action this device cannot read is listed before the throw", async () => {
    const e = env();
    const s = await open(e);
    const cb = vi.fn();
    s.subscribe(cb);
    const bad = act(newId(), [...logOf(remoteOf(s)).heads], [{ u: key.s(itemId(s, "A")), v: "x", c: "own" }], { dev: "dev-A" });
    const err = thrown(() => new PlanDoc(lastDoc(e).ydoc).append(bad, []));
    expect(err instanceof Error && err.message.startsWith("This device wrote an action it cannot read: ")).toBe(true);
    expect(s.view().unreadable.map((u) => u.id)).toEqual([bad.id]);
    expect(cb).toHaveBeenCalled();
  });

  it("a closed session refuses previews", async () => {
    const e = env();
    const { s, a, north, choice, macKey } = await clash(e);
    await s.close();
    const closed = `Plan session ${ID} is closed`;
    [
      () => s.preview({ t: "rename", item: a, name: "X" }),
      () => s.previewRevert(north.action.id),
      () => s.previewResolve(choice.id, { side: macKey }, OPTS),
      () => s.undoOffer(),
    ].forEach((f) => {
      const err = thrown(f);
      expect(err instanceof Error && err.message).toBe(closed);
    });
    expect(s.view().plan.items.size).toBe(2);
    expect(s.history().length).toBeGreaterThan(0);
    expect(s.authorOf(key.n(itemId(s, "B")))).toEqual({ dev: "dev-A", device: "Mac" });
  });

  it("undo skips an action another device reverted", async () => {
    const e = env();
    const s = await open(e);
    const a = itemId(s, "A");
    const b = itemId(s, "B");
    const n1 = s.apply({ t: "rename", item: a, name: "A2" }).action.id;
    const n2 = s.apply({ t: "rename", item: b, name: "B2" }).action.id;
    const r = remoteOf(s);
    new PlanDoc(r).append(buildRevert(ctxOf(logOf(r), "dev-B", TODAY, DEVICES), n2).action, []);
    deliver(r, e);
    expect(nameOf(s, b)).toBe("B");
    expect(s.canUndo()).toBe(true);
    expect(s.nextUndo()).toBe(n1);
    const undone = s.undo();
    expect(undone?.action.meta?.undo).toBe(n1);
    expect(nameOf(s, a)).toBe("A");
    expect(s.canUndo()).toBe(false);
    const r2 = remoteOf(s);
    const u = undone?.action.id;
    if (u === undefined) throw new Error("nothing undone");
    new PlanDoc(r2).append(buildRevert(ctxOf(logOf(r2), "dev-B", TODAY, DEVICES), u).action, []);
    deliver(r2, e);
    expect(s.canRedo()).toBe(false);
    expect(s.redo()).toBeNull();
  });

  it("redo refuses an offer", async () => {
    const e = env();
    const s = await open(e);
    const n = s.apply({ t: "rename", item: itemId(s, "A"), name: "North" }).action.id;
    const r = remoteOf(s);
    const undone = s.undo();
    if (undone === null) throw new Error("nothing undone");
    new PlanDoc(r).append(act(newId(), [...logOf(r).heads], [{ u: key.a(n), v: true, c: "revert" }], { dev: "dev-B" }), []);
    deliver(r, e);
    const choice = s.view().choices.find((c) => c.sides.some((x) => x.actions.includes(undone.action.id)));
    if (choice === undefined) throw new Error("no choice holds the undo");
    const other = choice.sides.find((x) => !x.actions.includes(undone.action.id));
    await settle(e);
    const before = appends();
    expect(s.canRedo()).toBe(true);
    const err = thrown(() => s.redo());
    expect(err).toBeInstanceOf(OfferRefused);
    expect(err instanceof OfferRefused && err.offer).toEqual({ choice: choice.id, side: other?.key });
    expect(err instanceof Error && err.message).toBe(OFFER_MESSAGE);
    await settle(e);
    expect(appends()).toBe(before);
    expect(s.canRedo()).toBe(true);
  });

  it("usePlanView subscribes once per session", async () => {
    const s = await open(env());
    const sub = vi.spyOn(s, "subscribe");
    const Probe = () => createElement("span", { "data-testid": "name" }, usePlanView(s).plan.name);
    const view = render(createElement(Probe));
    view.rerender(createElement(Probe));
    view.rerender(createElement(Probe));
    expect(sub).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("usePlanView", async () => {
    const s = await open(env());
    const Probe = () => createElement("span", { "data-testid": "count" }, String(usePlanView(s).plan.items.size));
    render(createElement(Probe));
    expect(screen.getByTestId("count").textContent).toBe("2");
    reactAct(() => {
      s.apply({ t: "create", kind: "task", name: "C", parent: null, after: null, start: "2026-11-16", dur: 1 });
    });
    expect(screen.getByTestId("count").textContent).toBe("3");
  });
});

describe("fixedClock", () => {
  it("set notifies on a new day only", () => {
    const c = fixedClock("2026-11-09", 5);
    const cb = vi.fn();
    const off = c.subscribe(cb);
    expect(c.now()).toBe(5);
    c.set("2026-11-09");
    expect(cb).not.toHaveBeenCalled();
    c.set("2026-11-10");
    expect(c.today()).toBe("2026-11-10");
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    c.set("2026-11-11");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("a throwing subscriber does not stop the rest", () => {
    const c = fixedClock("2026-11-09");
    const boom = new Error("first");
    const second = vi.fn();
    c.subscribe(() => {
      throw boom;
    });
    c.subscribe(second);
    expect(thrown(() => c.set("2026-11-10"))).toBe(boom);
    expect(second).toHaveBeenCalledTimes(1);
    expect(c.today()).toBe("2026-11-10");
  });

  it("refuses a malformed date", () => {
    expect(() => fixedClock("2026-13-01")).toThrow(RangeError);
  });
});

describe("systemClock", () => {
  it("notifies when the local date changes", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 9, 23, 59, 40));
      const cb = vi.fn();
      const off = systemClock.subscribe(cb);
      expect(systemClock.today()).toBe("2026-11-09");
      vi.advanceTimersByTime(CLOCK_CHECK_MS);
      expect(systemClock.today()).toBe("2026-11-10");
      expect(cb).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(CLOCK_CHECK_MS);
      expect(cb).toHaveBeenCalledTimes(1);
      off();
      vi.setSystemTime(new Date(2026, 10, 11, 12));
      vi.advanceTimersByTime(CLOCK_CHECK_MS);
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("notifyEach", () => {
  it("names the count and keeps the first throw", () => {
    const one = new Error("one");
    const third = vi.fn();
    const err = thrown(() =>
      notifyEach([
        () => {
          throw one;
        },
        () => {
          throw new Error("two");
        },
        third,
      ]),
    );
    expect(third).toHaveBeenCalledTimes(1);
    expect(err instanceof Error && err.message).toBe("2 subscribers threw; the first: one");
    expect(err).toHaveProperty("cause", one);
  });
});
