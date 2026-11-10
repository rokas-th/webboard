import * as Y from "yjs";
import type { ProviderFactory, ProviderLike, ProviderStatus } from "../sync/provider";

type Call = "connect" | "disconnect" | "destroy";

export class FakeProvider implements ProviderLike {
  readonly host: string;
  readonly doc: string;
  readonly ydoc: Y.Doc;
  readonly calls: Call[] = [];
  readonly sent: Uint8Array[] = [];
  synced = false;
  lastParams: Record<string, string> | null = null;
  private readonly params: () => Promise<Record<string, string>>;
  private readonly syncOnConnect: boolean;
  private readonly statusCbs = new Set<(s: { status: ProviderStatus }) => void>();
  private readonly syncedCbs = new Set<(synced: boolean) => void>();
  private readonly closeCbs = new Set<(ev: { code: number; reason: string }) => void>();
  private watching = false;

  constructor(host: string, doc: string, ydoc: Y.Doc, params: () => Promise<Record<string, string>>, syncOnConnect: boolean) {
    this.host = host;
    this.doc = doc;
    this.ydoc = ydoc;
    this.params = params;
    this.syncOnConnect = syncOnConnect;
  }

  private readonly onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this) this.sent.push(update);
  };

  async connect(): Promise<void> {
    this.calls.push("connect");
    const params = await this.params();
    this.lastParams = params;
    this.sent.push(Y.encodeStateAsUpdate(this.ydoc));
    if (!this.watching) {
      this.watching = true;
      this.ydoc.on("update", this.onUpdate);
    }
    if (this.syncOnConnect) {
      this.emitStatus("connected");
      this.emitSynced(true);
    }
  }

  disconnect(): void {
    this.calls.push("disconnect");
    this.synced = false;
    this.emitStatus("disconnected");
  }

  destroy(): void {
    this.calls.push("destroy");
    this.synced = false;
    this.ydoc.off("update", this.onUpdate);
    this.emitStatus("disconnected");
  }

  on(e: "status", cb: (s: { status: ProviderStatus }) => void): void;
  on(e: "synced", cb: (synced: boolean) => void): void;
  on(e: "connection-close", cb: (ev: { code: number; reason: string }) => void): void;
  on(e: "status" | "synced" | "connection-close", cb: ((s: { status: ProviderStatus }) => void) | ((synced: boolean) => void) | ((ev: { code: number; reason: string }) => void)): void {
    if (e === "status") this.statusCbs.add(cb as (s: { status: ProviderStatus }) => void);
    else if (e === "synced") this.syncedCbs.add(cb as (synced: boolean) => void);
    else this.closeCbs.add(cb as (ev: { code: number; reason: string }) => void);
  }

  emitStatus(status: ProviderStatus): void {
    [...this.statusCbs].forEach((cb) => cb({ status }));
  }

  emitSynced(on: boolean): void {
    this.synced = on;
    [...this.syncedCbs].forEach((cb) => cb(on));
  }

  closeWith(code: number, reason: string): void {
    [...this.closeCbs].forEach((cb) => cb({ code, reason }));
    this.emitStatus("disconnected");
  }

  deliver(update: Uint8Array): void {
    Y.applyUpdate(this.ydoc, update, this);
  }

  connects(): number {
    return this.calls.filter((c) => c === "connect").length;
  }
}

export type FakeFactory = ProviderFactory & { providers: Map<string, FakeProvider>; all: FakeProvider[] };

export function fakeFactory(opts?: { syncOnConnect?: boolean }): FakeFactory {
  const providers = new Map<string, FakeProvider>();
  const all: FakeProvider[] = [];
  const make: ProviderFactory = (host, doc, ydoc, params) => {
    const p = new FakeProvider(host, doc, ydoc, params, opts?.syncOnConnect === true);
    providers.set(doc, p);
    all.push(p);
    return p;
  };
  return Object.assign(make, { providers, all });
}
