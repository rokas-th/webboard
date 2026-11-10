import type * as Y from "yjs";
import { initialAction, normalizeName } from "../actions/build";
import { buildExample, exampleYears } from "../actions/example";
import { Refused } from "../actions/intents";
import { regionKey, type Calendar, type HolidayYear, type RegionRef } from "../domain/calendar";
import { toDay, yearOf } from "../domain/dates";
import type { ItemId, PlanId, PlanState } from "../domain/model";
import { newId } from "../log/ids";
import { LogState } from "../log/state";
import type { Action, ActionId, DeviceId } from "../log/types";
import { PlanIncomplete, projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { region as regionCodec, validateWrite } from "../plan/units";
import { collected, notifyEach, systemClock, type Clock } from "../services/clock";
import { HolidayService } from "../services/holidays";
import { AppError, call } from "../services/ipc";
import { LOCAL, PlanDoc } from "./doc";
import type { ImportResult } from "./file";
import { IndexDoc } from "./index-doc";
import { openPersisted, type PersistedDoc } from "./persist";
import { newPlanId, SPACE_PREFIX } from "./plan-id";
import { readActions } from "./read-actions";
import { movePlan } from "../sync/move";
import { PlanSession, type SessionDeps } from "./session";

export interface Settings {
  v: 1;
  lastRegion: RegionRef | null;
  names: Record<PlanId, string>;
  syncedHeads?: Record<string, readonly ActionId[]>;
  exampleOffered?: boolean;
}

export interface DeviceInfo {
  deviceId: DeviceId;
  name: string;
  platform: "macos" | "linux" | "ios";
}

export interface PlanListing {
  id: PlanId;
  name: string | null;
  trashed: boolean;
  loaded: boolean;
  space: string | null;
}

const READ_ONLY = "This device was removed from the space; its plans are read-only.";
const MOVE_READ_ONLY = "This device was removed from the space. Join again to move plans there.";
const INCOMPLETE = "This plan has not arrived yet; it opens once it syncs.";
const INDEX_REPAIRED = "The last change to the plan list before WebBoard closed was not saved.";
const LOCAL_INDEX = "local";
const PROBE = "probe";

const isIndexDoc = (id: string): boolean => id === LOCAL_INDEX || id.startsWith(SPACE_PREFIX);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function defaultDeviceName(platform: DeviceInfo["platform"], shortSide: number): string {
  switch (platform) {
    case "ios":
      return shortSide >= 600 ? "iPad" : "iPhone";
    case "macos":
      return "Mac";
    case "linux":
      return "Linux";
  }
}

function parseSettings(raw: unknown): Settings {
  if (raw === null) return { v: 1, lastRegion: null, names: {} };
  const bad = (what: string): AppError => new AppError("settings.corrupt", `settings.json does not hold WebBoard settings: ${what}.`);
  if (typeof raw !== "object" || Array.isArray(raw)) throw bad("it is not an object");
  if (!("v" in raw) || raw.v !== 1) throw bad("its version is not 1");
  if (!("names" in raw) || typeof raw.names !== "object" || raw.names === null || Array.isArray(raw.names)) throw bad("names is not an object");
  const names = Object.fromEntries(
    Object.entries(raw.names).map(([id, name]): [string, string] => {
      if (typeof name !== "string") throw bad(`the name of plan ${id} is not text`);
      return [id, name];
    }),
  );
  if (!("lastRegion" in raw)) throw bad("lastRegion is missing");
  let lastRegion: RegionRef | null;
  try {
    lastRegion = regionCodec.dec(raw.lastRegion);
  } catch (e) {
    throw bad(`lastRegion is not a region: ${messageOf(e)}`);
  }
  if ("exampleOffered" in raw && typeof raw.exampleOffered !== "boolean") throw bad("exampleOffered is not true or false");
  const base: Settings = { ...raw, v: 1, lastRegion, names };
  if (!("syncedHeads" in raw)) return base;
  const heads = raw.syncedHeads;
  if (typeof heads !== "object" || heads === null || Array.isArray(heads)) throw bad("syncedHeads is not an object");
  const syncedHeads = Object.fromEntries(
    Object.entries(heads).map(([doc, ids]): [string, readonly ActionId[]] => {
      if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === "string")) throw bad(`the synced heads of ${doc} are not a list of ids`);
      return [doc, ids];
    }),
  );
  return { ...base, syncedHeads };
}

function parseDevice(raw: unknown): { deviceId: DeviceId; platform: DeviceInfo["platform"] } {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "deviceId" in raw &&
    typeof raw.deviceId === "string" &&
    "platform" in raw &&
    (raw.platform === "macos" || raw.platform === "linux" || raw.platform === "ios")
  ) {
    return { deviceId: raw.deviceId, platform: raw.platform };
  }
  throw new AppError("ipc.shape", "device_info answered an unexpected shape");
}

function parseList(raw: unknown): string[] {
  if (Array.isArray(raw) && raw.every((x): x is string => typeof x === "string")) return raw;
  throw new AppError("ipc.shape", "store_list answered an unexpected shape");
}

const sameDevices = (a: ReadonlyMap<DeviceId, string>, b: ReadonlyMap<DeviceId, string>): boolean =>
  a.size === b.size && [...a].every(([id, name]) => b.get(id) === name);

const afterEither = (): void => undefined;

export class RegistryClosed extends Error {
  constructor(id: string) {
    super(`The registry closed while ${id} was loading`);
    this.name = "RegistryClosed";
  }
}

interface Tracker {
  log: LogState;
  projected: boolean;
  off(): void;
}

export class Registry {
  readonly holidays: HolidayService;
  private readonly clock: Clock;
  private readonly deviceId: DeviceId;
  private readonly platform: DeviceInfo["platform"];
  private settings: Settings;
  private localIx: IndexDoc | null = null;
  private offLocal: (() => void) | null = null;
  private stored: readonly string[] = [];
  private spaceIds: readonly string[] = [];
  private readonly spaces = new Map<string, IndexDoc>();
  private attachedId: string | null = null;
  private hookedSpace: IndexDoc | null = null;
  private offSpace: (() => void) | null = null;
  private readonly attaching = new Map<string, Promise<IndexDoc>>();
  private readOnlySpace = false;
  private readonly memo = new Map<string, Promise<PersistedDoc>>();
  private readonly loaded = new Map<string, PersistedDoc>();
  private readonly docOffs = new Map<string, () => void>();
  private readonly trackers = new Map<PlanId, Tracker>();
  private readonly failed = new Map<PlanId, AppError>();
  private readonly indexFailed = new Map<string, AppError>();
  private readonly reloads = new Map<string, Promise<void>>();
  private readonly sessionMemo = new Map<PlanId, Promise<PlanSession>>();
  private readonly sessions = new Map<PlanId, PlanSession>();
  private readonly deviceCbs = new Set<() => void>();
  private readonly subscribers = new Set<() => void>();
  private lastDevices: ReadonlyMap<DeviceId, string> = new Map();
  private settingsFailure: AppError | null = null;
  private settingsQueue: Promise<void> = Promise.resolve();
  private indexRepairPending = false;
  private closed = false;
  private closing: Promise<void> | null = null;

  private constructor(clock: Clock, holidays: HolidayService, settings: Settings, device: { deviceId: DeviceId; platform: DeviceInfo["platform"] }) {
    this.clock = clock;
    this.holidays = holidays;
    this.settings = settings;
    this.deviceId = device.deviceId;
    this.platform = device.platform;
  }

  static async open(opts?: { clock?: Clock; holidays?: HolidayService }): Promise<Registry> {
    const clock = opts?.clock ?? systemClock;
    const settings = parseSettings(await call<unknown>("settings_read"));
    const device = parseDevice(await call<unknown>("device_info"));
    const r = new Registry(clock, opts?.holidays ?? new HolidayService(() => clock.now()), settings, device);
    try {
      await r.start();
      await r.offerExample();
    } catch (e) {
      await r.close().catch((c: unknown) => {
        throw Object.assign(new Error(`${messageOf(e)} (closing the plan list afterwards failed too: ${messageOf(c)})`), { cause: e, suppressed: c });
      });
      throw e;
    }
    return r;
  }

  private async start(): Promise<void> {
    const local = await this.openIndex(LOCAL_INDEX);
    this.localIx = local;
    if (!local.devices().has(this.deviceId)) {
      local.nameDevice(this.deviceId, defaultDeviceName(this.platform, Math.min(window.screen.width, window.screen.height)));
    }
    this.lastDevices = local.devices();
    this.offLocal = local.subscribe(() => this.onIndexChange());
    this.stored = parseList(await call<unknown>("store_list"));
    this.spaceIds = this.stored.filter((id) => id.startsWith(SPACE_PREFIX));
    await Promise.all(this.spaceIds.map((id) => this.openSpace(id)));
    this.adoptOrphans();
  }

  private async offerExample(): Promise<void> {
    if (this.settings.exampleOffered === true) return;
    const spacesEmpty = this.spaceIds.every((id) => {
      const ix = this.spaces.get(id);
      return ix !== undefined && ix.plans().length === 0;
    });
    if (this.local.plans().length === 0 && spacesEmpty) {
      const id = await this.createExample();
      await this.loadedDoc(id).flush();
      await this.loadedDoc(LOCAL_INDEX).flush();
    }
    this.settings = { ...this.settings, exampleOffered: true };
    await this.writeSettings();
  }

  private adoptOrphans(): void {
    if (this.spaceIds.some((id) => !this.spaces.has(id))) return;
    const local = this.local;
    const listed = new Set([local, ...this.spaces.values()].flatMap((ix) => ix.plans().map((p) => p.id)));
    this.stored.filter((id) => !isIndexDoc(id) && id !== PROBE && !listed.has(id)).forEach((id) => local.addPlan(id));
  }

  private async openIndex(id: string): Promise<IndexDoc> {
    const ix = await IndexDoc.open(id, this.deviceId, (d) => this.doc(d));
    if (this.loadedDoc(id).repairedTornTail) this.indexRepairPending = true;
    return ix;
  }

  private async openSpace(id: string): Promise<IndexDoc | null> {
    try {
      const ix = await this.openIndex(id);
      this.spaces.set(id, ix);
      return ix;
    } catch (e) {
      if (e instanceof AppError && this.indexFailed.get(id) === e) return null;
      throw e;
    }
  }

  private get local(): IndexDoc {
    if (this.localIx === null) throw new Error("The local plan list is not open");
    return this.localIx;
  }

  private loadedDoc(id: string): PersistedDoc {
    const d = this.loaded.get(id);
    if (d === undefined) throw new Error(`Document ${id} is not loaded`);
    return d;
  }

  private usable(): void {
    if (this.closed) throw new Error("The registry is closed");
  }

  private emit(): void {
    notifyEach(this.subscribers);
  }

  private onIndexChange(): void {
    const devices = this.devices();
    const changed = !sameDevices(devices, this.lastDevices);
    this.lastDevices = devices;
    notifyEach([...(changed ? this.deviceCbs : []), ...this.subscribers]);
  }

  private record(id: string, e: AppError): void {
    if (isIndexDoc(id)) this.indexFailed.set(id, e);
    else this.failed.set(id, e);
  }

  doc(id: string): Promise<PersistedDoc> {
    return this.load(id, true);
  }

  private load(id: string, record: boolean): Promise<PersistedDoc> {
    this.usable();
    const memo = this.memo.get(id);
    if (memo !== undefined) return memo;
    const p: Promise<PersistedDoc> = openPersisted(id).then(
      (d) => this.adopt(id, p, d, record),
      (e: unknown) => this.loadFailed(id, p, record, e, []),
    );
    this.memo.set(id, p);
    return p;
  }

  private async adopt(id: string, p: Promise<PersistedDoc>, d: PersistedDoc, record: boolean): Promise<PersistedDoc> {
    if (this.closed || this.memo.get(id) !== p) {
      await d.discard();
      if (this.closed) throw new RegistryClosed(id);
      return this.load(id, record);
    }
    try {
      this.attach(id, d);
    } catch (e) {
      this.detach(id);
      const closing = await d.close().then(
        (): unknown[] => [],
        (c: unknown) => [c],
      );
      return this.loadFailed(id, p, record, e, closing);
    }
    return d;
  }

  private loadFailed(id: string, p: Promise<PersistedDoc>, record: boolean, e: unknown, also: readonly unknown[]): never {
    if (this.memo.get(id) === p) this.memo.delete(id);
    if (record && e instanceof AppError) {
      this.record(id, e);
      this.emit();
    }
    throw collected([e, ...also], "failures while loading " + id);
  }

  private attach(id: string, d: PersistedDoc): void {
    const offs: (() => void)[] = [];
    this.loaded.set(id, d);
    this.docOffs.set(id, () => offs.splice(0).forEach((off) => off()));
    offs.push(
      d.onError((e) => {
        if (!isIndexDoc(id)) this.failed.set(id, e);
        this.emit();
      }),
    );
    if (!isIndexDoc(id)) this.track(id, d, offs);
  }

  private track(id: PlanId, d: PersistedDoc, offs: (() => void)[]): void {
    const map = d.ydoc.getMap("actions");
    const tracker: Tracker = { log: new LogState(planRules), projected: false, off: () => map.unobserve(observer) };
    const feed = (ids: readonly string[]): void => {
      tracker.log.add(readActions(ids.map((k): readonly [string, unknown] => [k, map.get(k)]), validateWrite).ok);
      this.project(id, tracker);
    };
    const observer = (event: Y.YMapEvent<unknown>): void => feed([...event.keysChanged]);
    this.trackers.set(id, tracker);
    map.observe(observer);
    offs.push(() => {
      tracker.off();
      if (this.trackers.get(id) === tracker) this.trackers.delete(id);
    });
    feed([...map.keys()]);
  }

  private project(id: PlanId, tracker: Tracker): void {
    let plan: PlanState;
    try {
      plan = projectPlan(id, tracker.log);
    } catch (e) {
      if (!(e instanceof PlanIncomplete)) throw e;
      tracker.projected = false;
      return;
    }
    const first = !tracker.projected;
    tracker.projected = true;
    const named = this.cacheName(id, plan.name);
    if (first || named) this.emit();
  }

  private cacheName(id: PlanId, name: string): boolean {
    if (this.settings.names[id] === name) return false;
    this.settings = { ...this.settings, names: { ...this.settings.names, [id]: name } };
    void this.writeSettings().then(
      () => undefined,
      (e: unknown) => {
        if (!(e instanceof AppError)) throw e;
        this.settingsFailure = e;
        this.emit();
      },
    );
    return true;
  }

  private writeSettings(): Promise<boolean> {
    const run = this.settingsQueue.then(() => call<null>("settings_write", { settings: this.settings }));
    this.settingsQueue = run.then(afterEither, afterEither);
    return run.then(() => {
      if (this.settingsFailure === null) return false;
      this.settingsFailure = null;
      this.emit();
      return true;
    });
  }

  private deps(): SessionDeps {
    return {
      persist: (id) => this.doc(id),
      holidays: this.holidays,
      clock: this.clock,
      device: this.deviceId,
      devices: () => this.devices(),
      onDevices: (cb) => {
        this.deviceCbs.add(cb);
        return () => {
          this.deviceCbs.delete(cb);
        };
      },
      onName: (id, name) => {
        if (this.cacheName(id, name)) this.emit();
      },
    };
  }

  get device(): DeviceInfo {
    const name = this.local.devices().get(this.deviceId);
    if (name === undefined) throw new Error(`Device ${this.deviceId} has no name in the local plan list`);
    return { deviceId: this.deviceId, name, platform: this.platform };
  }

  private spaceIndex(): IndexDoc | null {
    return this.attachedId === null ? null : (this.spaces.get(this.attachedId) ?? null);
  }

  private putSpace(id: string, ix: IndexDoc): void {
    this.spaces.set(id, ix);
    if (id === this.attachedId) this.hookSpace(ix);
  }

  private hookSpace(ix: IndexDoc): void {
    if (this.hookedSpace === ix) return;
    this.unhookSpace();
    this.hookedSpace = ix;
    this.offSpace = ix.subscribe(() => this.onIndexChange());
    if (this.readOnlySpace) {
      const listed = new Set(ix.plans().map((p) => p.id));
      [...this.sessions].filter(([id, s]) => listed.has(id) && !s.readOnly).forEach(([, s]) => s.setReadOnly(true));
    }
    this.onIndexChange();
  }

  private unhookSpace(): void {
    this.offSpace?.();
    this.offSpace = null;
    this.hookedSpace = null;
  }

  attachSpace(spaceId: string): Promise<IndexDoc> {
    this.usable();
    const id = SPACE_PREFIX + spaceId;
    if (this.attachedId !== id) {
      this.unhookSpace();
      this.attachedId = id;
    }
    const open = this.spaces.get(id);
    if (open !== undefined) {
      this.hookSpace(open);
      return Promise.resolve(open);
    }
    const pending = this.attaching.get(id);
    if (pending !== undefined) return pending;
    const p = this.openIndex(id).then(
      (ix) => {
        this.attaching.delete(id);
        this.indexFailed.delete(id);
        this.putSpace(id, ix);
        this.adoptOrphans();
        return ix;
      },
      (e: unknown) => {
        this.attaching.delete(id);
        throw e;
      },
    );
    this.attaching.set(id, p);
    return p;
  }

  attachedSpace(): string | null {
    return this.attachedId !== null && this.spaceIndex() !== null ? this.attachedId.slice(SPACE_PREFIX.length) : null;
  }

  private listingOf(id: PlanId, trashed: boolean, space: string | null): PlanListing {
    return { id, name: this.settings.names[id] ?? null, trashed, loaded: this.trackers.get(id)?.projected ?? false, space };
  }

  plans(): readonly PlanListing[] {
    const ix = this.spaceIndex();
    const spaceId = this.attachedSpace();
    const inSpace = new Map((ix?.plans() ?? []).map((p) => [p.id, p.trashed]));
    const local = this.local.plans();
    const localIds = new Set(local.map((p) => p.id));
    return [
      ...local.map((p) => {
        const t = inSpace.get(p.id);
        return t === undefined ? this.listingOf(p.id, p.trashed, null) : this.listingOf(p.id, t, spaceId);
      }),
      ...[...inSpace].filter(([id]) => !localIds.has(id)).map(([id, t]) => this.listingOf(id, t, spaceId)),
    ];
  }

  private listsInSpace(id: PlanId): IndexDoc | null {
    const ix = this.spaceIndex();
    return ix !== null && ix.plans().some((p) => p.id === id) ? ix : null;
  }

  private addTarget(): IndexDoc {
    const ix = this.spaceIndex();
    return ix !== null && !this.readOnlySpace ? ix : this.local;
  }

  session(id: PlanId): Promise<PlanSession> {
    this.usable();
    const memo = this.sessionMemo.get(id);
    if (memo !== undefined) return memo;
    const p: Promise<PlanSession> = this.openSession(id).then(
      (s) => {
        const close = s.close.bind(s);
        s.close = async () => {
          try {
            await close();
          } finally {
            if (this.sessions.get(id) === s) this.sessions.delete(id);
            if (this.sessionMemo.get(id) === p) this.sessionMemo.delete(id);
          }
        };
        this.sessions.set(id, s);
        this.emit();
        return s;
      },
      (e: unknown) => {
        if (this.sessionMemo.get(id) === p) this.sessionMemo.delete(id);
        throw e;
      },
    );
    this.sessionMemo.set(id, p);
    return p;
  }

  private async openSession(id: PlanId): Promise<PlanSession> {
    await this.doc(id);
    const tracker = this.trackers.get(id);
    if (tracker === undefined) throw new Error(`Plan ${id} is loaded without a name tracker`);
    if (!tracker.projected) throw new AppError("plan.incomplete", INCOMPLETE);
    const s = await PlanSession.open(id, this.deps());
    if (this.readOnlySpace && this.listsInSpace(id) !== null) s.setReadOnly(true);
    return s;
  }

  openSessions(): readonly PlanSession[] {
    return [...this.sessions.values()];
  }

  localSpaces(): readonly string[] {
    return this.spaceIds.map((id) => id.slice(SPACE_PREFIX.length));
  }

  devices(): ReadonlyMap<DeviceId, string> {
    const ix = this.spaceIndex();
    return ix === null ? this.local.devices() : new Map([...this.local.devices(), ...ix.devices()]);
  }

  indexUnreadable(): readonly string[] {
    const ix = this.spaceIndex();
    return [...this.local.unreadable(), ...(ix?.unreadable() ?? [])].map((u) => u.message);
  }

  nameThisDevice(name: string): void {
    this.usable();
    const normal = normalizeName(name);
    [this.local, this.spaceIndex()]
      .filter((ix): ix is IndexDoc => ix !== null && ix.devices().get(this.deviceId) !== normal)
      .forEach((ix) => ix.nameDevice(this.deviceId, normal));
  }

  private async newCalendar(years: readonly number[]): Promise<Calendar> {
    const region = this.settings.lastRegion;
    if (region !== null) await this.holidays.warm(region, years);
    const rk = region === null ? null : regionKey(region);
    const holidays = new Map(
      years.flatMap((year): [number, HolidayYear][] => {
        const h = rk === null ? null : this.holidays.cached(rk, year);
        return h === null ? [] : [[year, h]];
      }),
    );
    return { region, workdays: [1, 2, 3, 4, 5], closures: new Map(), tuning: new Map(), holidays };
  }

  async createPlan(name: string): Promise<PlanId> {
    this.usable();
    const y = yearOf(toDay(this.clock.today()));
    const calendar = await this.newCalendar([y, y + 1]);
    const action = initialAction({ dev: this.deviceId, ses: newId(), now: this.clock.now(), name, calendar });
    const id = newPlanId();
    const doc = await this.load(id, false);
    new PlanDoc(doc.ydoc).append(action, []);
    this.addTarget().addPlan(id);
    await this.session(id);
    if (this.cacheName(id, normalizeName(name))) this.emit();
    return id;
  }

  async createPlanFrom(r: ImportResult): Promise<PlanId> {
    this.usable();
    const texts = r.newNotes.map((item): [ItemId, string] => {
      const text = r.notes.get(item);
      if (text === undefined) throw new Error(`The import lists a note for ${item} without its text`);
      return [item, text];
    });
    return this.writePlan(r.planId, { ...r.action, at: this.clock.now() }, r.newNotes, texts, () => this.addTarget());
  }

  async createExample(): Promise<PlanId> {
    this.usable();
    const today = this.clock.today();
    const calendar = await this.newCalendar(exampleYears(today));
    const id = newPlanId();
    const ex = buildExample({ id, dev: this.deviceId, ses: newId(), now: this.clock.now(), today, calendar });
    return this.writePlan(id, ex.action, ex.newNotes, [...ex.notes], () => this.local);
  }

  private async writePlan(id: PlanId, action: Action, newNotes: readonly ItemId[], texts: readonly (readonly [ItemId, string])[], target: () => IndexDoc): Promise<PlanId> {
    const doc = await this.load(id, false);
    const planDoc = new PlanDoc(doc.ydoc);
    doc.ydoc.transact(() => {
      planDoc.append(action, newNotes);
      texts.forEach(([item, text]) => planDoc.note(item).insert(0, text));
    }, LOCAL);
    target().addPlan(id);
    const session = await this.session(id);
    if (this.cacheName(id, session.view().plan.name)) this.emit();
    return id;
  }

  private planIndex(id: PlanId): IndexDoc {
    const ix = this.listsInSpace(id);
    if (ix === null) return this.local;
    if (this.readOnlySpace) throw new Refused(READ_ONLY);
    return ix;
  }

  trashPlan(id: PlanId): void {
    this.usable();
    this.planIndex(id).trashPlan(id);
  }

  restorePlan(id: PlanId): void {
    this.usable();
    this.planIndex(id).restorePlan(id);
  }

  movePlanToSpace(id: PlanId): void {
    this.usable();
    if (this.readOnlySpace) throw new Refused(MOVE_READ_ONLY);
    const ix = this.spaceIndex();
    if (ix === null) throw new Error("No space is attached.");
    movePlan(id, this.local, ix);
  }

  async setLastRegion(r: RegionRef): Promise<void> {
    this.usable();
    const previous = this.settings.lastRegion;
    this.settings = { ...this.settings, lastRegion: r };
    try {
      await this.writeSettings();
    } catch (e) {
      if (this.settings.lastRegion === r) this.settings = { ...this.settings, lastRegion: previous };
      throw e;
    }
  }

  async warm(): Promise<void> {
    for (const { id } of this.plans()) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.closed) return;
      if (this.memo.has(id) || this.failed.has(id)) continue;
      await this.doc(id).then(afterEither, (e: unknown) => {
        if (e instanceof RegistryClosed) return;
        if (!(e instanceof AppError) || this.failed.get(id) !== e) throw e;
      });
    }
  }

  failures(): ReadonlyMap<PlanId, AppError> {
    return this.failed;
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  async retryPlan(id: PlanId): Promise<void> {
    this.usable();
    const d = this.loaded.get(id);
    this.failed.delete(id);
    this.emit();
    const attempt = d === undefined ? this.doc(id).then(afterEither) : d.retry();
    await attempt.then(afterEither, (e: unknown) => {
      if (!(e instanceof AppError) || this.failed.get(id) !== e) throw e;
    });
  }

  private indexStates(): [string, AppError | null][] {
    const attached = this.attachedId === null || this.spaceIds.includes(this.attachedId) ? [] : [this.attachedId];
    return [LOCAL_INDEX, ...this.spaceIds, ...attached].map((id) => [id, this.indexFailed.get(id) ?? this.loaded.get(id)?.error() ?? null]);
  }

  indexError(): AppError | null {
    return this.indexStates().find(([, e]) => e !== null)?.[1] ?? null;
  }

  indexErrorDoc(): string | null {
    return this.indexStates().find(([, e]) => e !== null)?.[0] ?? null;
  }

  indexErrorOf(doc: string): AppError | null {
    return this.indexFailed.get(doc) ?? this.loaded.get(doc)?.error() ?? null;
  }

  async retryIndex(): Promise<void> {
    this.usable();
    const failing = this.indexStates().flatMap(([id, e]) => (e === null ? [] : [id]));
    const results = await Promise.allSettled(failing.map((id) => this.retryIndexDoc(id)));
    this.emit();
    const thrown = results.flatMap((r, i) => (r.status === "rejected" && !this.indexRecorded(failing[i], r.reason) ? [r.reason] : []));
    if (thrown.length > 0) throw collected(thrown, "plan-list retries failed");
  }

  private indexRecorded(id: string, e: unknown): boolean {
    return e instanceof AppError && (this.indexFailed.get(id) === e || this.loaded.get(id)?.error() === e);
  }

  private async retryIndexDoc(id: string): Promise<void> {
    const d = this.loaded.get(id);
    if (d !== undefined && d.error() !== null) {
      await d.retry();
      return;
    }
    if (id === LOCAL_INDEX) throw new Error("The local plan list failed without a loaded document");
    let ix: IndexDoc;
    try {
      ix = await this.openIndex(id);
    } catch (e) {
      if (e instanceof AppError) this.indexFailed.set(id, e);
      throw e;
    }
    this.indexFailed.delete(id);
    this.putSpace(id, ix);
    this.adoptOrphans();
  }

  spaceReadOnly(): boolean {
    return this.readOnlySpace;
  }

  setSpaceReadOnly(on: boolean): void {
    this.usable();
    if (this.readOnlySpace === on) return;
    this.readOnlySpace = on;
    [...this.sessions].filter(([id]) => this.listsInSpace(id) !== null).forEach(([, s]) => s.setReadOnly(on));
    this.emit();
  }

  syncedHeads(doc: string): readonly ActionId[] | null {
    return this.settings.syncedHeads?.[doc] ?? null;
  }

  async setSyncedHeads(doc: string, heads: readonly ActionId[]): Promise<void> {
    this.usable();
    this.settings = { ...this.settings, syncedHeads: { ...this.settings.syncedHeads, [doc]: [...heads] } };
    try {
      await this.writeSettings();
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      this.settingsFailure = e;
      this.emit();
    }
  }

  async reloadFromServer(docId: string): Promise<void> {
    this.usable();
    if (this.spaceReadOnly()) throw new Refused(READ_ONLY);
    if (docId === LOCAL_INDEX) throw new Error("The local plan list is not loaded from the server");
    const inFlight = this.reloads.get(docId);
    if (inFlight !== undefined) return inFlight;
    const reload = Promise.resolve().then(() => this.reload(docId));
    this.reloads.set(docId, reload);
    this.emit();
    return reload;
  }

  private async reload(docId: string): Promise<void> {
    try {
      const p: Promise<PersistedDoc> = this.setAside(docId).then(
        () =>
          this.closed
            ? this.loadFailed(docId, p, false, new RegistryClosed(docId), [])
            : openPersisted(docId).then(
                (d) => this.adopt(docId, p, d, true),
                (e: unknown) => this.loadFailed(docId, p, true, e, []),
              ),
        (e: unknown) => this.loadFailed(docId, p, false, e, []),
      );
      this.memo.set(docId, p);
      await p;
      if (docId.startsWith(SPACE_PREFIX)) this.putSpace(docId, await this.openIndex(docId));
    } finally {
      this.reloads.delete(docId);
      this.emit();
    }
  }

  reloading(doc: string): boolean {
    return this.reloads.has(doc);
  }

  private async setAside(id: string): Promise<void> {
    await this.release(id);
    try {
      await call<null>("store_set_aside", { doc: id });
    } catch (e) {
      if (e instanceof AppError) {
        this.record(id, e);
        this.emit();
      }
      throw e;
    }
    this.failed.delete(id);
    this.indexFailed.delete(id);
  }

  private async release(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session !== undefined) await session.close();
    const ix = this.spaces.get(id);
    const d = this.loaded.get(id);
    const before = d?.error() ?? null;
    this.unhook(id);
    if (ix !== undefined) {
      this.spaces.delete(id);
      if (this.hookedSpace === ix) this.unhookSpace();
      if (d === undefined) throw new Error(`Index ${id} is open without a loaded document`);
    }
    if (d === undefined) return;
    try {
      await (ix === undefined ? d.close() : ix.close());
    } catch (e) {
      if (before === null || e !== before) throw e;
    }
  }

  private detach(id: string): void {
    this.unhook(id);
    this.memo.delete(id);
  }

  private unhook(id: string): void {
    this.docOffs.get(id)?.();
    this.docOffs.delete(id);
    this.loaded.delete(id);
  }

  settingsError(): AppError | null {
    return this.settingsFailure;
  }

  async retrySettings(): Promise<void> {
    this.usable();
    let notified: boolean;
    try {
      notified = await this.writeSettings();
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      this.settingsFailure = e;
      this.emit();
      return;
    }
    if (!notified) this.emit();
  }

  takeIndexRepairNotice(): string | null {
    if (!this.indexRepairPending) return null;
    this.indexRepairPending = false;
    return INDEX_REPAIRED;
  }

  close(): Promise<void> {
    if (this.closing === null) this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    this.offLocal?.();
    this.offLocal = null;
    this.unhookSpace();
    const sessions = await Promise.allSettled([...this.sessions.values()].map(async (s) => s.close()));
    const indexes = [...(this.localIx === null ? [] : [this.localIx]), ...this.spaces.values()];
    const indexDocs = await Promise.allSettled(indexes.map(async (ix) => ix.close()));
    const docs = [...this.loaded];
    docs.forEach(([id]) => this.detach(id));
    this.memo.clear();
    const planDocs = await Promise.allSettled(docs.map(async ([, d]) => d.close()));
    await this.settingsQueue;
    const thrown = [...new Set([...sessions, ...indexDocs, ...planDocs].flatMap((r) => (r.status === "rejected" ? [r.reason] : [])))];
    if (thrown.length > 0) throw collected(thrown, "documents failed to close");
  }
}
