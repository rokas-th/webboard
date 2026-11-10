import type * as Y from "yjs";
import type { ActionId, DeviceId } from "../log/types";
import { notifyEach } from "../services/clock";
import { AppError, syncMarkRevoked, syncStatus, syncTicket, type SpaceInfo } from "../services/ipc";
import type { PersistedDoc } from "../store/persist";
import { SPACE_PREFIX } from "../store/plan-id";
import { readActions } from "../store/read-actions";
import { RegistryClosed, type Registry } from "../store/registry";
import type { PlanSession } from "../store/session";
import type { ProviderFactory, ProviderLike, ProviderStatus } from "./provider";

type ErrorCode =
  | "revoked"
  | "unauthorized"
  | "keychain"
  | "local-failed"
  | "not-configured"
  | "failed"
  | "limited"
  | "unreachable"
  | "store-failed"
  | "rejected"
  | "too-large";

export type SyncState =
  | { kind: "off" }
  | { kind: "synced" }
  | { kind: "syncing" }
  | { kind: "receiving" }
  | { kind: "offline"; waiting: number }
  | {
      kind: "error";
      code: ErrorCode;
      since: number;
      doc: string | null;
      waiting: number;
      message: string | null;
      cause: string | null;
      op: "load" | "save" | null;
    };

type ErrorState = Extract<SyncState, { kind: "error" }>;
type Fault = Omit<ErrorState, "kind" | "waiting">;

export interface SyncManagerDeps {
  factory: ProviderFactory;
  registry: Registry;
  sessions: () => Iterable<PlanSession>;
  online: () => boolean;
  onlineChange: (cb: () => void) => () => void;
  now: () => number;
}

const PRECEDENCE: readonly ErrorCode[] = [
  "revoked",
  "unauthorized",
  "keychain",
  "local-failed",
  "not-configured",
  "failed",
  "too-large",
  "rejected",
  "store-failed",
  "limited",
  "unreachable",
];
const rank = (c: ErrorCode): number => PRECEDENCE.indexOf(c);
const LIMITED = rank("limited");

const isIndex = (doc: string): boolean => doc.startsWith(SPACE_PREFIX);
const RESET_HINT = " Reset sync, then join with a code again.";
const MAX_BACKOFF_MS = 30_000;
const LATER_MS = 300_000;
const MINUTES = /Try again in (\d+) minutes?\.$/;
const LATER = /Try again later\.$/;

const MESSAGES = {
  tooLargeHeld: "This plan is too large to sync. It keeps working on this device; export it to keep a copy.",
  tooLargeMissing: "This plan is too large to send to this device. Export it on a device that has it.",
  tooLargeIndex: "The plan list is too large to sync. Plans keep working on this device.",
  rejectedNamed: (name: string) => `The server refused a change to “${name}” from this device. Update WebBoard, then try again.`,
  rejected: "The server refused a change from this device. Update WebBoard, then try again.",
  storeNamed: (name: string) => `The server could not store a change to “${name}”. Try again; if it repeats, export it.`,
  store: "The server could not store a change from this device. Try again.",
  storeIndex: "The server could not store a change to the plan list. Try again.",
} as const;

export function holdsPlan(registry: Registry, doc: string): boolean {
  return registry.plans().find((p) => p.id === doc)?.loaded === true;
}

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function localFailedText(s: ErrorState): string {
  if (s.doc === null) return "Sync state on this device could not be read";
  if (!isIndex(s.doc)) throw new Error(`local-failed names ${s.doc}, which is not a plan list`);
  if (s.op === "save") return "The space’s plan list on this device could not be saved";
  if (s.cause === "store.corrupt") return "The space’s plan list on this device is damaged";
  return "The space’s plan list on this device could not be read";
}

function errorText(s: ErrorState, docName: (doc: string) => string | null): string {
  const name = s.doc === null || isIndex(s.doc) ? null : docName(s.doc);
  switch (s.code) {
    case "revoked":
      return "Device removed";
    case "unauthorized":
      return "Not in the space — set up sync again";
    case "keychain":
      return "Keychain unavailable";
    case "local-failed":
      return localFailedText(s);
    case "not-configured":
      return "Sync is not set up on the server";
    case "failed":
      if (s.message === null) throw new Error("A failed sync state carries no message");
      return `Sync stopped: ${s.message}`;
    case "limited":
      return "Server asked to wait — retrying";
    case "unreachable":
      return `Server unreachable since ${hhmm(s.since)}`;
    case "store-failed":
      return name === null ? `Server could not store changes since ${hhmm(s.since)}` : `Server could not store changes to “${name}” since ${hhmm(s.since)}`;
    case "rejected":
      if (s.doc !== null && isIndex(s.doc)) return "The server refused a change to the plan list — update WebBoard";
      return name === null
        ? "The server refused a change from this device — update WebBoard"
        : "The server refused a change from this device — export this plan and check for an update";
    case "too-large":
      return s.doc !== null && isIndex(s.doc) ? "The plan list is too large to sync" : `Too large to sync: ${name ?? "a plan"}`;
  }
}

export function chipText(c: SyncState, docName: (doc: string) => string | null): string {
  switch (c.kind) {
    case "off":
      return "Local only";
    case "synced":
      return "Synced";
    case "syncing":
      return "Syncing";
    case "receiving":
      return "Receiving…";
    case "offline":
      return c.waiting === 0 ? "Offline" : `Offline — ${c.waiting} ${c.waiting === 1 ? "change" : "changes"} waiting`;
    case "error":
      return errorText(c, docName);
  }
}

function parseStatus(raw: unknown): { space: SpaceInfo | null; revoked: boolean } {
  const bad = (): AppError => new AppError("ipc.shape", "sync_status answered an unexpected shape");
  if (typeof raw !== "object" || raw === null || !("space" in raw) || !("revoked" in raw) || typeof raw.revoked !== "boolean") throw bad();
  const space: unknown = raw.space;
  if (space === null) return { space: null, revoked: raw.revoked };
  if (
    typeof space === "object" &&
    "server" in space &&
    typeof space.server === "string" &&
    "spaceId" in space &&
    typeof space.spaceId === "string" &&
    "deviceId" in space &&
    typeof space.deviceId === "string" &&
    "deviceName" in space &&
    typeof space.deviceName === "string"
  ) {
    return { space: { server: space.server, spaceId: space.spaceId, deviceId: space.deviceId, deviceName: space.deviceName }, revoked: raw.revoked };
  }
  throw bad();
}

class Waiting {
  private readonly par = new Map<ActionId, readonly ActionId[]>();
  private readonly mine = new Set<ActionId>();
  private readonly unreadable = new Set<ActionId>();
  private covered = new Set<ActionId>();
  count = 0;

  constructor(
    private readonly map: Y.Map<unknown>,
    private readonly dev: DeviceId,
    heads: readonly ActionId[],
  ) {
    this.add([...map.keys()]);
    this.cover(heads);
  }

  add(ids: readonly ActionId[]): void {
    const fresh = ids.filter((id) => !this.par.has(id) && !this.unreadable.has(id));
    const read = readActions(
      fresh.map((id): readonly [string, unknown] => [id, this.map.get(id)]),
      () => undefined,
    );
    read.ok.forEach((a) => {
      this.par.set(a.id, a.par);
      if (a.dev !== this.dev) return;
      this.mine.add(a.id);
      if (!this.covered.has(a.id)) this.count += 1;
    });
    read.unreadable
      .filter((u) => u.dev === this.dev)
      .forEach((u) => {
        this.unreadable.add(u.id);
        this.count += 1;
      });
  }

  heads(): ActionId[] {
    const parents = new Set([...this.par.values()].flat());
    return [...this.par.keys()].filter((id) => !parents.has(id));
  }

  cover(heads: readonly ActionId[]): void {
    const seen = new Set<ActionId>();
    const stack = [...heads];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(this.par.get(id) ?? []));
    }
    this.covered = seen;
    this.count = [...this.mine].filter((id) => !seen.has(id)).length + this.unreadable.size;
  }
}

interface Link {
  readonly doc: string;
  readonly persisted: PersistedDoc;
  readonly waiting: Waiting;
  provider: ProviderLike | null;
  status: ProviderStatus;
  synced: boolean;
  stopped: boolean;
  dead: boolean;
  fault: Fault | null;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  off: () => void;
}

class StoppedWhileConnecting extends Error {
  constructor(doc: string) {
    super(`Sync of ${doc} stopped while its ticket was fetched`);
    this.name = "StoppedWhileConnecting";
  }
}

const providerOf = (link: Link): ProviderLike => {
  if (link.provider === null) throw new Error(`The link for ${link.doc} has no provider yet`);
  return link.provider;
};

export class SyncManager {
  private readonly deps: SyncManagerDeps;
  private readonly subscribers = new Set<() => void>();
  private readonly links = new Map<string, Link>();
  private readonly carried = new Map<string, Fault>();
  private readonly handled = new WeakSet<object>();
  private loading = new Set<string>();
  private offs: (() => void)[] = [];
  private gen = 0;
  private running = false;
  private space: SpaceInfo | null = null;
  private host = "";
  private global: Fault | null = null;
  private indexFault: Fault | null = null;
  private attached = false;
  private attaching = false;
  private revokedLatch = false;
  private warming = false;
  private rewarm = false;
  private last: SyncState = { kind: "off" };

  constructor(deps: SyncManagerDeps) {
    this.deps = deps;
  }

  private get registry(): Registry {
    return this.deps.registry;
  }

  private get indexId(): string {
    if (this.space === null) throw new Error("No space is joined");
    return SPACE_PREFIX + this.space.spaceId;
  }

  private fault(code: ErrorCode, doc: string | null, message: string | null, cause: string | null, op: Fault["op"] = null): Fault {
    return { code, since: this.deps.now(), doc, message, cause, op };
  }

  private emit(): void {
    notifyEach(this.subscribers);
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  async start(): Promise<void> {
    this.teardown();
    const gen = this.gen;
    this.running = true;
    this.revokedLatch = false;
    this.offs.push(this.deps.onlineChange(() => this.emit()));
    this.offs.push(this.registry.subscribe(() => this.onRegistry(gen)));
    let status: { space: SpaceInfo | null; revoked: boolean };
    try {
      status = parseStatus(await syncStatus());
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      if (gen !== this.gen) return;
      this.global = this.statusFault(e);
      if (e.code === "sync.io") await this.attachTheOneOnDisk();
      if (gen === this.gen) this.emit();
      return;
    }
    if (gen !== this.gen) return;
    const space = status.space;
    if (space === null) {
      this.emit();
      return;
    }
    this.space = space;
    this.host = new URL(space.server).host;
    if (status.revoked || this.revokedLatch) {
      if (status.revoked) {
        this.registry.setSpaceReadOnly(true);
        this.revokedLatch = true;
        this.global = this.fault("revoked", null, null, null);
      }
      await this.attachRecorded(space.spaceId);
      if (gen === this.gen) this.emit();
      return;
    }
    this.registry.setSpaceReadOnly(false);
    await this.attach(gen);
    if (gen !== this.gen || this.revokedLatch) return;
    this.registry.nameThisDevice(space.deviceName);
    this.emit();
  }

  stop(): void {
    this.teardown();
    this.emit();
  }

  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  async markRevoked(): Promise<void> {
    if (this.revokedLatch) return;
    this.revokedLatch = true;
    const gen = this.gen;
    this.global = this.fault("revoked", null, null, null);
    this.links.forEach((l) => this.halt(l));
    this.emit();
    let failure: AppError | null = null;
    try {
      await syncMarkRevoked();
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      failure = e;
    }
    if (failure !== null && failure.code === "sync.not_joined") {
      if (gen !== this.gen) throw failure;
      this.global = this.fault("failed", null, failure.message, failure.code);
      this.emit();
      return;
    }
    this.registry.setSpaceReadOnly(true);
    if (gen !== this.gen) {
      if (failure !== null) throw failure;
      return;
    }
    if (failure !== null || this.global?.code !== "revoked") this.global = this.fault("revoked", null, failure?.message ?? null, failure?.code ?? null);
    this.emit();
  }

  state(): SyncState {
    const next = this.compute();
    if (JSON.stringify(next) === JSON.stringify(this.last)) return this.last;
    this.last = next;
    return next;
  }

  private compute(): SyncState {
    if (!this.running) return { kind: "off" };
    const links = [...this.links.values()];
    const faults = [this.global, this.indexFault, ...links.map((l) => l.fault)].filter((f): f is Fault => f !== null);
    if (this.space === null && faults.length === 0) return { kind: "off" };
    const waiting = links.reduce((n, l) => n + l.waiting.count, 0);
    const top = [...faults].sort((a, b) => rank(a.code) - rank(b.code) || a.since - b.since)[0];
    if (top !== undefined && rank(top.code) <= LIMITED) return { kind: "error", ...top, waiting };
    if (!this.deps.online()) return { kind: "offline", waiting };
    if (top !== undefined) return { kind: "error", ...top, waiting };
    if ([...this.deps.sessions()].some((s) => s.view().pending > 0)) return { kind: "receiving" };
    if (links.length === 0 || links.some((l) => !l.synced)) return { kind: "syncing" };
    return { kind: "synced" };
  }

  private statusFault(e: AppError): Fault {
    if (e.code.startsWith("keychain.")) return this.fault("keychain", null, e.message, e.code);
    if (e.code === "sync.http") return this.fault("unreachable", null, e.message, e.code);
    if (e.code === "sync.io") return this.fault("local-failed", null, e.message + RESET_HINT, e.code);
    return this.fault("failed", null, e.message, e.code);
  }

  private async attachTheOneOnDisk(): Promise<void> {
    const spaces = this.registry.localSpaces();
    if (spaces.length !== 1) return;
    await this.attachRecorded(spaces[0]);
  }

  private async attachRecorded(spaceId: string): Promise<void> {
    await this.registry.attachSpace(spaceId).then(
      () => undefined,
      (e: unknown) => {
        if (!(e instanceof AppError) || this.registry.indexErrorOf(SPACE_PREFIX + spaceId) !== e) throw e;
      },
    );
  }

  private async attach(gen: number): Promise<void> {
    if (this.space === null) throw new Error("No space is joined");
    const spaceId = this.space.spaceId;
    this.attaching = true;
    try {
      await this.registry.attachSpace(spaceId);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      if (gen !== this.gen) return;
      this.attaching = false;
      this.indexFault = this.fault("local-failed", this.indexId, e.message, e.code, "load");
      this.emit();
      return;
    }
    if (gen !== this.gen) return;
    this.attaching = false;
    this.attached = true;
    const e = this.registry.indexErrorOf(this.indexId);
    this.indexFault = e === null ? null : this.indexFaultFor(e, "save");
    this.scan(gen);
    this.emit();
  }

  private onRegistry(gen: number): void {
    if (gen !== this.gen || this.space === null || this.revokedLatch) {
      this.emit();
      return;
    }
    const reg = this.registry;
    const ix = this.indexId;
    const spaceId = this.space.spaceId;
    [...this.links.values()].filter((l) => reg.reloading(l.doc)).forEach((l) => this.drop(l));
    const open = reg.attachedSpace() === spaceId;
    if (this.attached && !open) this.attached = false;
    const e = reg.indexErrorOf(ix);
    if (e !== null) this.indexFault = this.indexFaultFor(e, open ? "save" : "load");
    else if (open) this.indexFault = null;
    if (!this.attached) {
      if (open && !this.attaching && this.global === null) {
        void this.attach(gen).then(() => {
          if (gen === this.gen && this.space !== null) this.registry.nameThisDevice(this.space.deviceName);
        });
      }
      this.emit();
      return;
    }
    if (this.global === null) this.scan(gen);
    this.emit();
  }

  private indexFaultFor(e: AppError, op: "load" | "save"): Fault {
    const f = this.indexFault;
    if (f !== null && f.op === op && f.cause === e.code && f.message === e.message) return f;
    return this.fault("local-failed", this.indexId, e.message, e.code, op);
  }

  private failing(doc: string): boolean {
    return this.registry.failures().has(doc) || this.registry.indexErrorOf(doc) !== null;
  }

  private scan(gen: number): void {
    if (this.space === null) throw new Error("No space is joined");
    const spaceId = this.space.spaceId;
    const docs = [this.indexId, ...this.registry.plans().flatMap((p) => (p.space === spaceId ? [p.id] : []))];
    this.links.forEach((link) => {
      if (this.failing(link.doc) || this.registry.reloading(link.doc)) return;
      void this.registry.doc(link.doc).then(
        (d) => {
          if (gen !== this.gen || this.links.get(link.doc) !== link || d === link.persisted) return;
          this.drop(link);
          this.makeLink(link.doc, d);
          this.emit();
        },
        (e: unknown) => this.loadFailed(link.doc, e, gen),
      );
    });
    docs.filter((d) => !this.links.has(d) && !this.loading.has(d) && !this.failing(d) && !this.registry.reloading(d)).forEach((d) => this.load(d, gen));
  }

  private load(doc: string, gen: number): void {
    const loading = this.loading;
    loading.add(doc);
    void this.registry.doc(doc).then(
      (d) => {
        loading.delete(doc);
        if (gen !== this.gen || this.global !== null || this.revokedLatch || this.links.has(doc) || this.registry.reloading(doc)) return;
        this.makeLink(doc, d);
        this.emit();
      },
      (e: unknown) => {
        loading.delete(doc);
        this.loadFailed(doc, e, gen);
      },
    );
  }

  private loadFailed(doc: string, e: unknown, gen: number): void {
    if (e instanceof AppError && (this.registry.failures().get(doc) === e || this.registry.indexErrorOf(doc) === e)) {
      if (gen === this.gen) this.emit();
      return;
    }
    if (gen !== this.gen && e instanceof RegistryClosed) return;
    throw e;
  }

  private makeLink(doc: string, persisted: PersistedDoc): void {
    const map = persisted.ydoc.getMap("actions");
    const link: Link = {
      doc,
      persisted,
      waiting: new Waiting(map, this.registry.device.deviceId, this.registry.syncedHeads(doc) ?? []),
      provider: null,
      status: "connecting",
      synced: false,
      stopped: false,
      dead: false,
      fault: this.carried.get(doc) ?? null,
      attempt: 0,
      timer: null,
      off: () => map.unobserve(observer),
    };
    const observer = (event: Y.YMapEvent<unknown>): void => {
      link.waiting.add([...event.keysChanged]);
      if (event.transaction.origin !== link.provider && link.status === "connected" && link.synced && this.deps.online()) this.recordHeads(link);
      this.emit();
    };
    map.observe(observer);
    this.carried.delete(doc);
    const provider = this.deps.factory(this.host, doc, persisted.ydoc, () => this.params(link));
    link.provider = provider;
    provider.on("status", (s) => this.onStatus(link, s.status));
    provider.on("synced", (on) => this.onSynced(link, on));
    provider.on("connection-close", (ev) => this.onClose(link, ev));
    this.links.set(doc, link);
    this.connect(link);
  }

  private connect(link: Link): void {
    link.timer = null;
    if (link.dead || link.stopped) return;
    void providerOf(link)
      .connect()
      .catch((e: unknown) => {
        if (typeof e === "object" && e !== null && this.handled.has(e)) return;
        throw e;
      });
  }

  private async params(link: Link): Promise<Record<string, string>> {
    let ticket: string;
    try {
      const t: unknown = await syncTicket(link.doc);
      if (typeof t !== "object" || t === null || !("ticket" in t) || typeof t.ticket !== "string") {
        throw new AppError("ipc.shape", "sync_ticket answered an unexpected shape");
      }
      ticket = t.ticket;
    } catch (e) {
      providerOf(link).disconnect();
      if (e instanceof AppError) {
        this.handled.add(e);
        if (!link.dead && (!link.stopped || e.code === "sync.revoked")) this.ticketFailed(link, e);
      }
      throw e;
    }
    if (link.dead || link.stopped) {
      const stop = new StoppedWhileConnecting(link.doc);
      this.handled.add(stop);
      throw stop;
    }
    return { ticket };
  }

  private ticketFailed(link: Link, e: AppError): void {
    switch (e.code) {
      case "sync.revoked":
        void this.markRevoked();
        return;
      case "sync.unauthorized":
      case "keychain.missing":
        this.stopAll(this.fault("unauthorized", null, e.message, e.code));
        return;
      case "keychain.unavailable":
      case "keychain.io":
        this.stopAll(this.fault("keychain", null, e.message, e.code));
        return;
      case "sync.not_configured":
        this.stopAll(this.fault("not-configured", null, e.message, e.code));
        return;
      case "sync.io":
        this.stopAll(this.fault("local-failed", null, e.message + RESET_HINT, e.code));
        return;
      case "sync.rate_limited": {
        const wait = this.rateWait(e.message);
        if (wait === null) {
          this.stopDoc(link, this.fault("failed", link.doc, e.message, e.code));
          return;
        }
        this.setFault(link, this.fault("limited", link.doc, e.message, e.code));
        this.schedule(link, wait);
        this.emit();
        return;
      }
      case "sync.http":
        this.setFault(link, link.fault?.code === "unreachable" ? { ...link.fault, message: e.message, cause: e.code } : this.fault("unreachable", link.doc, e.message, e.code));
        this.schedule(link, Math.min(1000 * 2 ** link.attempt, MAX_BACKOFF_MS));
        link.attempt += 1;
        this.emit();
        return;
      default:
        this.stopDoc(link, this.fault("failed", link.doc, e.message, e.code));
    }
  }

  private rateWait(message: string): number | null {
    const minutes = MINUTES.exec(message);
    if (minutes !== null) return Number(minutes[1]) * 60_000;
    return LATER.test(message) ? LATER_MS : null;
  }

  private setFault(link: Link, fault: Fault): void {
    if (link.fault === null || rank(fault.code) <= rank(link.fault.code)) link.fault = fault;
  }

  private recordHeads(link: Link): void {
    const heads = link.waiting.heads();
    link.waiting.cover(heads);
    void this.registry.setSyncedHeads(link.doc, heads);
  }

  private warm(): void {
    if (this.warming) {
      this.rewarm = true;
      return;
    }
    this.warming = true;
    this.rewarm = false;
    void this.registry.warm().then(
      () => {
        this.warming = false;
        if (this.rewarm) this.warm();
      },
      (e: unknown) => {
        this.warming = false;
        throw e;
      },
    );
  }

  private schedule(link: Link, ms: number): void {
    if (link.timer !== null) clearTimeout(link.timer);
    link.timer = setTimeout(() => this.connect(link), ms);
  }

  private onStatus(link: Link, status: ProviderStatus): void {
    if (link.dead) return;
    link.status = status;
    if (status === "connected") {
      link.attempt = 0;
      if (link.fault?.code === "unreachable" || link.fault?.code === "limited") link.fault = null;
    }
    if (status === "disconnected") link.synced = false;
    this.emit();
  }

  private onSynced(link: Link, on: boolean): void {
    if (link.dead) return;
    link.synced = on;
    if (on) {
      if (link.fault?.code === "store-failed" || link.fault?.code === "unreachable" || link.fault?.code === "limited") link.fault = null;
      this.recordHeads(link);
      if (!isIndex(link.doc)) this.warm();
    }
    this.emit();
  }

  private onClose(link: Link, ev: { code: number; reason: string }): void {
    if (link.dead || link.stopped) return;
    switch (ev.code) {
      case 4403:
        void this.markRevoked();
        return;
      case 4413:
        this.stopDoc(link, this.fault("too-large", link.doc, this.tooLargeText(link.doc), null));
        return;
      case 1007:
        this.stopDoc(link, this.fault("rejected", link.doc, this.rejectedText(link.doc), null));
        return;
      case 1011:
      case 4500:
        this.stopDoc(link, this.fault("store-failed", link.doc, this.storeText(link.doc), null));
        return;
      default:
        if (link.status === "connected") return;
        if (link.fault?.code !== "unreachable") this.setFault(link, this.fault("unreachable", link.doc, null, null));
        this.emit();
    }
  }

  private planName(doc: string): string | null {
    return this.registry.plans().find((p) => p.id === doc)?.name ?? null;
  }

  private tooLargeText(doc: string): string {
    if (isIndex(doc)) return MESSAGES.tooLargeIndex;
    return holdsPlan(this.registry, doc) ? MESSAGES.tooLargeHeld : MESSAGES.tooLargeMissing;
  }

  private rejectedText(doc: string): string {
    const name = isIndex(doc) ? null : this.planName(doc);
    return name === null ? MESSAGES.rejected : MESSAGES.rejectedNamed(name);
  }

  private storeText(doc: string): string {
    if (isIndex(doc)) return MESSAGES.storeIndex;
    const name = this.planName(doc);
    return name === null ? MESSAGES.store : MESSAGES.storeNamed(name);
  }

  private halt(link: Link): void {
    link.stopped = true;
    if (link.timer !== null) clearTimeout(link.timer);
    link.timer = null;
    providerOf(link).disconnect();
  }

  private stopDoc(link: Link, fault: Fault): void {
    this.setFault(link, fault);
    this.halt(link);
    this.emit();
  }

  private stopAll(fault: Fault): void {
    this.global = fault;
    this.links.forEach((l) => {
      if (!l.stopped) this.halt(l);
    });
    this.emit();
  }

  private drop(link: Link): void {
    link.dead = true;
    if (link.timer !== null) clearTimeout(link.timer);
    link.timer = null;
    link.off();
    providerOf(link).destroy();
    if (this.links.get(link.doc) === link) this.links.delete(link.doc);
  }

  private teardown(): void {
    this.gen += 1;
    this.running = false;
    this.offs.splice(0).forEach((off) => off());
    [...this.links.values()].forEach((l) => {
      if (l.fault?.code === "store-failed") this.carried.set(l.doc, l.fault);
      this.drop(l);
    });
    this.loading = new Set();
    this.space = null;
    this.global = null;
    this.indexFault = null;
    this.attached = false;
    this.attaching = false;
  }
}
