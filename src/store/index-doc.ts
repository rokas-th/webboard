import type * as Y from "yjs";
import { normalizeName } from "../actions/build";
import { deviceName } from "../actions/copy";
import type { PlanId } from "../domain/model";
import { newId } from "../log/ids";
import { LogState } from "../log/state";
import type { Action, ActionId, DeviceId, Rules, SessionId, UnitKey, Write } from "../log/types";
import { notifyEach } from "../services/clock";
import { LOCAL, PlanDoc } from "./doc";
import type { PersistedDoc } from "./persist";
import { SPACE_PREFIX } from "./plan-id";
import { readActions } from "./read-actions";

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ea = Object.entries(a);
  const rb = new Map(Object.entries(b));
  return ea.length === rb.size && ea.every(([k, v]) => rb.has(k) && deepEqual(v, rb.get(k)));
};

export const indexRules: Rules = {
  same: (_u, a, b) => deepEqual(a, b),
  mergeDerived(u) {
    throw new Error(`Index unit ${u} has no derived writes`);
  },
  mergeable(u) {
    throw new Error(`Index unit ${u} has no derived writes`);
  },
};

const PLAN = "ip:";
const DEVICE = "dn:";

const LABEL = {
  add: "Add plan",
  trash: "Move plan to Trash",
  restore: "Restore plan",
  name: "Name device",
  purge: "Delete plan forever",
  follow: "Follow a deletion on another device",
} as const;

const isTrash = (v: unknown): v is { t: boolean } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && "t" in v && typeof v.t === "boolean";

const isGoneValue = (v: unknown): v is { gone: true } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && "gone" in v && v.gone === true;

const isDeviceName = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0 && normalizeName(v) === v;

const notAPlan = (id: string): boolean => id === "local" || id === "probe" || id.startsWith(SPACE_PREFIX);

function checkIndexWrite(w: Write): void {
  const plan = w.u.startsWith(PLAN) && w.u.length > PLAN.length && !notAPlan(w.u.slice(PLAN.length));
  const device = w.u.startsWith(DEVICE) && w.u.length > DEVICE.length;
  if (!plan && !device) throw new Error(`Unknown unit key “${w.u}”`);
  if (plan ? !isTrash(w.v) && !isGoneValue(w.v) : !isDeviceName(w.v)) throw new Error(`Malformed value for “${w.u}”`);
  if (w.c !== "own") throw new Error(`${w.u}: ${w.c} cannot write this unit`);
}

interface Tombstone {
  action: ActionId;
  dev: DeviceId;
  purge: boolean;
}

const better = (a: Tombstone, b: Tombstone | undefined): boolean => b === undefined || (a.purge && (!b.purge || a.action < b.action));

interface Bad {
  dev: DeviceId | null;
  error: string;
}

export class IndexDoc {
  readonly id: string;
  private readonly dev: DeviceId;
  private readonly ses: SessionId = newId();
  private readonly doc: PersistedDoc;
  private readonly planDoc: PlanDoc;
  private readonly actionMap: Y.Map<unknown>;
  private readonly log = new LogState(indexRules);
  private readonly bad = new Map<ActionId, Bad>();
  private readonly devOf = new Map<ActionId, DeviceId>();
  private readonly goneBy = new Map<PlanId, Tombstone>();
  private readonly subscribers = new Set<() => void>();
  private closing: Promise<void> | null = null;

  private constructor(id: string, dev: DeviceId, doc: PersistedDoc) {
    this.id = id;
    this.dev = dev;
    this.doc = doc;
    this.planDoc = new PlanDoc(doc.ydoc);
    this.actionMap = doc.ydoc.getMap("actions");
    this.ingest([...this.actionMap.keys()]);
    this.actionMap.observe(this.observer);
  }

  static async open(docId: string, dev: DeviceId, persist: (id: string) => Promise<PersistedDoc>): Promise<IndexDoc> {
    return new IndexDoc(docId, dev, await persist(docId));
  }

  private readonly observer = (event: Y.YMapEvent<unknown>): void => {
    const changes = [...event.changes.keys];
    changes.forEach(([id, change]) => {
      if (change.action === "update") throw new Error(`Index action ${id} was updated; the action log is append-only`);
      if (change.action === "delete") throw new Error(`Index action ${id} was deleted; the action log is append-only`);
    });
    const bad = this.ingest(changes.map(([id]) => id));
    if (event.transaction.origin === LOCAL && bad.length > 0) {
      throw new Error(`This device wrote a plan-list change it cannot read: ${bad.map((b) => b.error).join("; ")}`);
    }
    notifyEach(this.subscribers);
  };

  private ingest(ids: readonly ActionId[]): readonly Bad[] {
    const { ok, unreadable } = readActions(
      ids.map((id): readonly [string, unknown] => [id, this.actionMap.get(id)]),
      checkIndexWrite,
    );
    ok.forEach((a) => this.devOf.set(a.id, a.dev));
    const delta = this.log.add(ok);
    const refused = delta.refused.map((r): [ActionId, Bad] => {
      const dev = this.devOf.get(r.id);
      if (dev === undefined) throw new Error(`Refused index action ${r.id} was never read`);
      return [r.id, { dev, error: r.message }];
    });
    const refusedIds = new Set(delta.refused.map((r) => r.id));
    ok.filter((a) => !refusedIds.has(a.id))
      .flatMap((a) =>
        a.w
          .filter((w) => w.u.startsWith(PLAN) && isGoneValue(w.v))
          .map((w): [PlanId, Tombstone] => [w.u.slice(PLAN.length), { action: a.id, dev: a.dev, purge: a.lbl === LABEL.purge }]),
      )
      .forEach(([id, t]) => {
        if (better(t, this.goneBy.get(id))) this.goneBy.set(id, t);
      });
    const bad = [...unreadable.map((u): [ActionId, Bad] => [u.id, { dev: u.dev, error: u.error }]), ...refused];
    bad.forEach(([id, b]) => this.bad.set(id, b));
    return bad.map(([, b]) => b);
  }

  private units(prefix: string): [string, unknown][] {
    const order = new Map(this.log.order().map((id, n) => [id, n]));
    const rank = (u: UnitKey): number => {
      const first = this.log.writers(u)[0];
      const n = first === undefined ? undefined : order.get(first);
      if (n === undefined) throw new Error(`Index unit ${u} has no ready writer`);
      return n;
    };
    return [...this.log.units()]
      .filter(([u]) => u.startsWith(prefix))
      .map(([u, s]): [UnitKey, unknown, number] => [u, s.value, rank(u)])
      .sort((a, b) => a[2] - b[2])
      .map(([u, v]) => [u.slice(prefix.length), v]);
  }

  plans(): readonly { id: PlanId; trashed: boolean }[] {
    return this.units(PLAN)
      .filter(([id]) => !this.goneBy.has(id))
      .map(([id, v]) => {
        if (!isTrash(v)) throw new Error(`Index unit ${PLAN}${id} holds a malformed value`);
        return { id, trashed: v.t };
      });
  }

  gone(): ReadonlyMap<PlanId, DeviceId | null> {
    return new Map([...this.goneBy].map(([id, t]) => [id, t.purge ? t.dev : null]));
  }

  lists(id: PlanId): boolean {
    return this.log.unit(PLAN + id) !== undefined;
  }

  devices(): ReadonlyMap<DeviceId, string> {
    return new Map(
      this.units(DEVICE).map(([id, v]): [DeviceId, string] => {
        if (typeof v !== "string") throw new Error(`Index unit ${DEVICE}${id} holds a malformed value`);
        return [id, v];
      }),
    );
  }

  private listed(id: PlanId): void {
    if (!this.lists(id)) throw new Error(`Plan ${id} is not listed in ${this.id}`);
  }

  private notGone(id: PlanId): void {
    if (this.goneBy.has(id)) throw new Error(`Plan ${id} was deleted forever; ${this.id} cannot list it again`);
  }

  private append(lbl: string, w: readonly Write[]): void {
    if (this.closing !== null) throw new Error(`Index ${this.id} is closed`);
    w.forEach(checkIndexWrite);
    const action: Action = { id: newId(), dev: this.dev, ses: this.ses, at: Date.now(), par: [...this.log.heads], lbl, w };
    this.planDoc.append(action, []);
  }

  addPlan(id: PlanId): void {
    this.notGone(id);
    if (this.lists(id)) throw new Error(`Plan ${id} is already listed in ${this.id}`);
    this.append(LABEL.add, [{ u: PLAN + id, v: { t: false }, c: "own" }]);
  }

  trashPlan(id: PlanId): void {
    this.notGone(id);
    this.listed(id);
    this.append(LABEL.trash, [{ u: PLAN + id, v: { t: true }, c: "own" }]);
  }

  restorePlan(id: PlanId): void {
    this.notGone(id);
    this.listed(id);
    this.append(LABEL.restore, [{ u: PLAN + id, v: { t: false }, c: "own" }]);
  }

  purgePlan(id: PlanId): void {
    this.listed(id);
    if (this.goneBy.get(id)?.purge === true) return;
    this.append(LABEL.purge, [{ u: PLAN + id, v: { gone: true }, c: "own" }]);
  }

  markGone(id: PlanId): void {
    this.listed(id);
    if (this.goneBy.has(id)) return;
    this.append(LABEL.follow, [{ u: PLAN + id, v: { gone: true }, c: "own" }]);
  }

  nameDevice(id: DeviceId, name: string): void {
    const normal = normalizeName(name);
    this.append(LABEL.name, [{ u: DEVICE + id, v: normal, c: "own" }]);
  }

  unreadable(): readonly { id: ActionId; message: string }[] {
    const devices = this.devices();
    return [...this.bad]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, b]) => ({
        id,
        message: `A change to the plan list from ${b.dev === null ? "another device" : deviceName(devices, b.dev)} could not be read: ${b.error}. Update WebBoard on this device.`,
      }));
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  close(): Promise<void> {
    if (this.closing === null) {
      this.actionMap.unobserve(this.observer);
      this.subscribers.clear();
      this.closing = this.doc.close();
    }
    return this.closing;
  }

  discard(): Promise<void> {
    if (this.closing === null) {
      this.actionMap.unobserve(this.observer);
      this.subscribers.clear();
      this.closing = this.doc.discard();
    }
    return this.closing;
  }
}
