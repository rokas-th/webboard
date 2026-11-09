import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import { buildAction } from "../actions/build";
import { deviceName } from "../actions/copy";
import { Refused, type Built, type Ctx, type Intent, type Preview } from "../actions/intents";
import { buildResolve, previewResolve, type Pick, type ResolveOptions, type ResolvePreview } from "../actions/resolve";
import { buildRevert, buildUndo, OfferRefused, undoOffer, type Offer } from "../actions/undo";
import { yearOf, toDay } from "../domain/dates";
import { derive } from "../domain/derive";
import type { ItemId, PlanId } from "../domain/model";
import { newId } from "../log/ids";
import { LogState } from "../log/state";
import type { ActionId, DeviceId, SessionId, UnitKey } from "../log/types";
import { choices, heldItems, type Choice } from "../plan/choices";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { validateWrite } from "../plan/units";
import type { Clock } from "../services/clock";
import type { HolidayHost, HolidayService } from "../services/holidays";
import type { AppError } from "../services/ipc";
import { LOCAL, PlanDoc, type PlanView } from "./doc";
import type { PersistedDoc } from "./persist";
import { readActions } from "./read-actions";

export interface SessionDeps {
  persist(id: string): Promise<PersistedDoc>;
  holidays: HolidayService;
  clock: Clock;
  device: DeviceId;
  devices(): ReadonlyMap<DeviceId, string>;
  onDevices(cb: () => void): () => void;
  onName(id: PlanId, name: string): void;
}

export interface HistoryEntry {
  id: ActionId;
  label: string;
  device: string;
  at: number;
  active: boolean;
  root: boolean;
}

const READ_ONLY = "This device was removed from the space; its plans are read-only.";
const SETTLED = "This choice was settled meanwhile.";
const REPAIRED = "The last change before WebBoard stopped was cut off while saving and was not kept.";

interface Bad {
  dev: DeviceId | null;
  error: string;
}

export class PlanSession implements HolidayHost {
  private readonly id: PlanId;
  private readonly deps: SessionDeps;
  private readonly doc: PersistedDoc;
  private readonly planDoc: PlanDoc;
  private readonly actionMap: Y.Map<unknown>;
  private readonly ses: SessionId = newId();
  private readonly log = new LogState(planRules);
  private readonly bad = new Map<ActionId, Bad>();
  private readonly devOf = new Map<ActionId, DeviceId>();
  private readonly subscribers = new Set<() => void>();
  private readonly undoStack: ActionId[] = [];
  private readonly redoStack: ActionId[] = [];
  private readonly offs: (() => void)[] = [];
  private devices: ReadonlyMap<DeviceId, string>;
  private current: PlanView;
  private seenMissing: ReadonlySet<number> = new Set();
  private lastName = "";
  private repairPending: boolean;
  private ro = false;
  private closed = false;
  private quiet = false;

  private constructor(id: PlanId, deps: SessionDeps, doc: PersistedDoc) {
    this.id = id;
    this.deps = deps;
    this.doc = doc;
    this.planDoc = new PlanDoc(doc.ydoc);
    this.actionMap = doc.ydoc.getMap("actions");
    this.devices = new Map(deps.devices());
    this.repairPending = doc.repairedTornTail;
    this.ingest([...this.actionMap.keys()], false);
    this.current = this.build();
    this.lastName = this.current.plan.name;
  }

  static async open(id: PlanId, deps: SessionDeps): Promise<PlanSession> {
    const s = new PlanSession(id, deps, await deps.persist(id));
    s.start();
    return s;
  }

  private start(): void {
    const missing = this.current.derived.missingYears;
    if (missing.length > 0) this.deps.holidays.onMissing(this.id, this, missing, "merge");
    this.seenMissing = new Set(missing);
    this.deps.holidays.reconcile(this.id, this);
    this.actionMap.observe(this.observer);
    this.offs.push(
      () => this.actionMap.unobserve(this.observer),
      this.deps.clock.subscribe(this.onClock),
      this.deps.onDevices(this.onDevices),
      this.doc.onError(() => this.notify()),
    );
    const cal = this.current.plan.calendar;
    const region = cal.region;
    if (region === null) return;
    const year = yearOf(toDay(this.current.today));
    const years = [...new Set([...cal.holidays.keys(), year, year + 1])].sort((a, b) => a - b);
    const holidays = this.deps.holidays;
    void holidays.warm(region, years).then(() => {
      if (!this.closed) return holidays.refresh(this.id, this);
    });
  }

  private readonly observer = (event: Y.YMapEvent<unknown>): void => {
    const changes = [...event.changes.keys];
    changes.forEach(([id, change]) => {
      if (change.action === "update") throw new Error(`Action ${id} was updated; the action log is append-only`);
      if (change.action === "delete") throw new Error(`Action ${id} was deleted; the action log is append-only`);
    });
    const local = event.transaction.origin === LOCAL;
    this.ingest(
      changes.map(([id]) => id),
      local,
    );
    this.recompute(local ? "own" : "merge");
  };

  private readonly onClock = (): void => {
    if (this.closed || this.deps.clock.today() === this.current.today) return;
    this.recompute("merge");
    void this.deps.holidays.refresh(this.id, this);
  };

  private readonly onDevices = (): void => {
    if (this.closed) return;
    this.devices = new Map(this.deps.devices());
    this.recompute("merge");
  };

  private ingest(ids: readonly ActionId[], local: boolean): void {
    const { ok, unreadable } = readActions(
      ids.map((id): readonly [string, unknown] => [id, this.actionMap.get(id)]),
      validateWrite,
    );
    ok.forEach((a) => this.devOf.set(a.id, a.dev));
    const delta = this.log.add(ok);
    const refused = delta.refused.map((r): [ActionId, Bad] => {
      const dev = this.devOf.get(r.id);
      if (dev === undefined) throw new Error(`Refused action ${r.id} was never read`);
      return [r.id, { dev, error: r.message }];
    });
    const bad = [...unreadable.map((u): [ActionId, Bad] => [u.id, { dev: u.dev, error: u.error }]), ...refused];
    if (local && bad.length > 0) throw new Error(`This device wrote an action it cannot read: ${bad.map(([, b]) => b.error).join("; ")}`);
    bad.forEach(([id, b]) => this.bad.set(id, b));
  }

  private build(): PlanView {
    const plan = projectPlan(this.id, this.log);
    const cs = choices(this.log, plan, this.devices);
    const held = heldItems(cs, plan);
    const today = this.deps.clock.today();
    return {
      plan,
      derived: derive(plan, held, today),
      choices: cs,
      held,
      pending: this.log.pending.length,
      today,
      unreadable: [...this.bad].map(([id, b]) => ({
        id,
        message: `A change from ${b.dev === null ? "another device" : deviceName(this.devices, b.dev)} could not be read: ${b.error}. Update WebBoard on this device.`,
      })),
    };
  }

  private recompute(cause: "own" | "merge"): void {
    this.current = this.build();
    const name = this.current.plan.name;
    if (name !== this.lastName) {
      this.lastName = name;
      this.deps.onName(this.id, name);
    }
    const missing = this.current.derived.missingYears;
    const fresh = missing.filter((y) => !this.seenMissing.has(y));
    this.seenMissing = new Set(missing);
    if (fresh.length > 0) this.deps.holidays.onMissing(this.id, this, fresh, cause);
    this.deps.holidays.reconcile(this.id, this);
    if (!this.quiet) this.notify();
  }

  private notify(): void {
    [...this.subscribers].forEach((cb) => cb());
  }

  private ctx(): Ctx {
    const holidays = this.deps.holidays;
    return {
      view: this.current,
      log: this.log,
      dev: this.deps.device,
      ses: this.ses,
      now: this.deps.clock.now(),
      devices: this.devices,
      cachedHolidays: (region, year) => holidays.cached(region, year),
    };
  }

  private writable(): void {
    if (this.closed) throw new Error(`Plan session ${this.id} is closed`);
    if (this.ro) throw new Refused(READ_ONLY);
  }

  private commit(built: Built, stacks: () => void): Built {
    this.quiet = true;
    try {
      this.planDoc.append(built.action, built.newNotes);
      stacks();
    } finally {
      this.quiet = false;
      this.notify();
    }
    return built;
  }

  private pushed(built: Built): Built {
    return this.commit(built, () => {
      this.undoStack.push(built.action.id);
      this.redoStack.length = 0;
    });
  }

  private offerFor(target: ActionId): void {
    const offer = undoOffer(this.ctx(), target);
    if (offer !== null) throw new OfferRefused(offer);
  }

  private choice(id: string): Choice {
    const found = this.current.choices.find((c) => c.id === id);
    if (found === undefined) throw new Refused(SETTLED);
    return found;
  }

  view(): PlanView {
    return this.current;
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  apply(intent: Intent): Built {
    this.writable();
    return this.pushed(buildAction(this.ctx(), intent));
  }

  preview(intent: Intent): Preview {
    return buildAction(this.ctx(), intent).preview;
  }

  undo(): Built | null {
    this.writable();
    const target = this.nextUndo();
    if (target === null) return null;
    this.offerFor(target);
    const built = buildUndo(this.ctx(), target);
    return this.commit(built, () => {
      this.undoStack.pop();
      this.redoStack.push(built.action.id);
    });
  }

  redo(): Built | null {
    this.writable();
    const target = this.redoStack.length > 0 ? this.redoStack[this.redoStack.length - 1] : null;
    if (target === null) return null;
    const built = buildUndo(this.ctx(), target);
    return this.commit(built, () => {
      this.redoStack.pop();
      this.undoStack.push(built.action.id);
    });
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  revert(id: ActionId): Built {
    this.writable();
    this.offerFor(id);
    return this.pushed(buildRevert(this.ctx(), id));
  }

  previewRevert(id: ActionId): Preview {
    this.offerFor(id);
    return buildRevert(this.ctx(), id).preview;
  }

  resolve(choice: string, pick: Pick, opts: ResolveOptions): Built {
    this.writable();
    const c = this.choice(choice);
    return this.pushed(buildResolve(this.ctx(), c, pick, opts));
  }

  previewResolve(choice: string, pick: Pick, opts: ResolveOptions): ResolvePreview {
    const c = this.choice(choice);
    return previewResolve(this.ctx(), c, pick, opts);
  }

  nextUndo(): ActionId | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1] : null;
  }

  undoOffer(): Offer | null {
    const target = this.nextUndo();
    return target === null ? null : undoOffer(this.ctx(), target);
  }

  authorOf(u: UnitKey): { dev: DeviceId; device: string } | null {
    const unit = this.log.unit(u);
    if (unit === undefined) return null;
    const a = this.log.get(unit.from);
    if (a === undefined) throw new Error(`Action ${unit.from} wrote ${u} but is not ready`);
    return { dev: a.dev, device: deviceName(this.devices, a.dev) };
  }

  storeError(): AppError | null {
    return this.doc.error();
  }

  takeRepairNotice(): string | null {
    if (!this.repairPending) return null;
    this.repairPending = false;
    return REPAIRED;
  }

  history(): readonly HistoryEntry[] {
    return [...this.log.order()].reverse().map((id) => {
      const a = this.log.get(id);
      if (a === undefined) throw new Error(`Action ${id} is in the replay order but not ready`);
      return { id, label: a.lbl, device: deviceName(this.devices, a.dev), at: a.at, active: this.log.active(id), root: a.par.length === 0 };
    });
  }

  note(item: ItemId): Y.Text {
    return this.planDoc.note(item);
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc.ydoc);
  }

  get readOnly(): boolean {
    return this.ro;
  }

  setReadOnly(on: boolean): void {
    this.ro = on;
    this.notify();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.offs.splice(0).forEach((off) => off());
  }
}

export function usePlanView(session: PlanSession): PlanView {
  return useSyncExternalStore(
    (cb) => session.subscribe(cb),
    () => session.view(),
  );
}
