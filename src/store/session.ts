import { useCallback, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { buildAction } from "../actions/build";
import { deviceName } from "../actions/copy";
import { Refused, type Built, type Ctx, type Intent, type Preview } from "../actions/intents";
import { buildResolve, previewResolve, type Pick, type ResolveOptions, type ResolvePreview } from "../actions/resolve";
import { buildRevert, buildUndo, OfferRefused, undoChanges, undoOffer, type Offer } from "../actions/undo";
import { yearOf, toDay, type IsoDate } from "../domain/dates";
import { derive } from "../domain/derive";
import { projectDefaults } from "../domain/defaults";
import { projectPeople } from "../domain/people";
import type { ItemId, PlanId } from "../domain/model";
import { newId } from "../log/ids";
import { LogState } from "../log/state";
import type { ActionId, DeviceId, SessionId, UnitKey } from "../log/types";
import { choices, heldItems, type Choice } from "../plan/choices";
import { defaultNames, formerPeople } from "../plan/former";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { key, validateWrite } from "../plan/units";
import { notifyEach, type Clock } from "../services/clock";
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

export const READ_ONLY = "This device was removed from the space; its plans are read-only.";
export const NEWER_PLAN = "This plan has changes from a newer WebBoard. Update to edit.";
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
  private readonly undecoded = new Set<ActionId>();
  private readonly devOf = new Map<ActionId, DeviceId>();
  private readonly subscribers = new Set<() => void>();
  private readonly noteSubscribers = new Set<() => void>();
  private notesSeen = 0;
  private readonly undoStack: ActionId[] = [];
  private readonly redoStack: ActionId[] = [];
  private readonly offs: (() => void)[] = [];
  private devices: ReadonlyMap<DeviceId, string>;
  private current: PlanView;
  private day: IsoDate;
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
    this.ingest([...this.actionMap.keys()]);
    this.current = this.build();
    this.day = this.current.today;
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
      this.planDoc.onNotes(this.onNoteChange),
    );
    const cal = this.current.plan.calendar;
    const region = cal.region;
    if (region === null) return;
    const year = yearOf(toDay(this.current.today));
    const years = [...new Set([...cal.holidays.keys(), year, year + 1])].sort((a, b) => a - b);
    const holidays = this.deps.holidays;
    void holidays.warm(region, years).then(
      () => {
        if (!this.closed) return this.refreshHolidays();
      },
      (e: unknown) => {
        throw this.holidayFailure("warm", e);
      },
    );
  }

  private refreshHolidays(): Promise<void> {
    return this.deps.holidays.refresh(this.id, this).catch((e: unknown) => {
      throw this.holidayFailure("refresh", e);
    });
  }

  private holidayFailure(what: "warm" | "refresh", e: unknown): Error {
    return Object.assign(new Error(`Holiday ${what} for plan ${this.id} failed: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
  }

  private readonly observer = (event: Y.YMapEvent<unknown>): void => {
    const changes = [...event.changes.keys];
    changes.forEach(([id, change]) => {
      if (change.action === "update") throw new Error(`Action ${id} was updated; the action log is append-only`);
      if (change.action === "delete") throw new Error(`Action ${id} was deleted; the action log is append-only`);
    });
    const local = event.transaction.origin === LOCAL;
    const bad = this.ingest(changes.map(([id]) => id));
    this.recompute(local ? "own" : "merge");
    if (local && bad.length > 0) throw new Error(`This device wrote an action it cannot read: ${bad.map((b) => b.error).join("; ")}`);
  };

  private readonly onNoteChange = (): void => {
    this.notesSeen += 1;
    notifyEach(this.noteSubscribers);
  };

  private readonly onClock = (): void => {
    if (this.closed) return;
    const today = this.deps.clock.today();
    if (today === this.day) return;
    this.day = today;
    this.recompute("merge");
    void this.refreshHolidays();
  };

  private readonly onDevices = (): void => {
    if (this.closed) return;
    this.devices = new Map(this.deps.devices());
    this.recompute("merge");
  };

  private ingest(ids: readonly ActionId[]): readonly Bad[] {
    const { ok, unreadable } = readActions(
      ids.map((id): readonly [string, unknown] => [id, this.actionMap.get(id)]),
      validateWrite,
    );
    ok.forEach((a) => this.devOf.set(a.id, a.dev));
    unreadable.forEach((u) => this.undecoded.add(u.id));
    const delta = this.log.add(ok);
    const refused = delta.refused.map((r): [ActionId, Bad] => {
      const dev = this.devOf.get(r.id);
      if (dev === undefined) throw new Error(`Refused action ${r.id} was never read`);
      return [r.id, { dev, error: r.message }];
    });
    const bad = [...unreadable.map((u): [ActionId, Bad] => [u.id, { dev: u.dev, error: u.error }]), ...refused];
    bad.forEach(([id, b]) => this.bad.set(id, b));
    return bad.map(([, b]) => b);
  }

  private build(): PlanView {
    const plan = projectPlan(this.id, this.log);
    const cs = choices(this.log, plan, this.devices);
    const held = heldItems(cs, plan);
    const today = this.deps.clock.today();
    const former = formerPeople(this.log, plan);
    return {
      plan,
      derived: derive(plan, held, today),
      people: projectPeople(plan, former),
      former,
      defaults: projectDefaults(plan, defaultNames(this.log, plan)),
      choices: cs,
      held,
      pending: this.log.pending.length,
      today,
      unreadable: [...this.bad].map(([id, b]) => ({
        id,
        message: `A change from ${b.dev === null ? "another device" : deviceName(this.devices, b.dev)} could not be read: ${b.error}. Update WebBoard on this device.`,
      })),
      newer: this.undecoded.size > 0,
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
    notifyEach(this.subscribers);
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

  private usable(): void {
    if (this.closed) throw new Error(`Plan session ${this.id} is closed`);
  }

  private writable(): void {
    this.usable();
    const reason = this.readOnlyReason;
    if (reason !== null) throw new Refused(reason);
  }

  private commit(built: Built, stacks: () => void): Built {
    this.quiet = true;
    try {
      const texts = (built.noteCopies ?? []).map(([from, to]) => [to, this.planDoc.note(from).toString()] as const);
      this.planDoc.ydoc.transact(() => {
        this.planDoc.append(built.action, built.newNotes);
        texts.forEach(([to, text]) => this.planDoc.note(to).insert(0, text));
      }, LOCAL);
      stacks();
    } catch (e) {
      this.quiet = false;
      this.notifyDespite(e);
      throw e;
    }
    this.quiet = false;
    this.notify();
    return built;
  }

  private notifyDespite(failure: unknown): void {
    try {
      this.notify();
    } catch (n) {
      throw Object.assign(new Error(failure instanceof Error ? failure.message : String(failure)), { cause: failure, suppressed: n });
    }
  }

  private liveTop(stack: readonly ActionId[], live: (id: ActionId) => boolean = (id) => this.log.active(id)): ActionId | null {
    return [...stack].reverse().find(live) ?? null;
  }

  private prune(stack: ActionId[], live?: (id: ActionId) => boolean): ActionId | null {
    const top = this.liveTop(stack, live);
    stack.length = top === null ? 0 : stack.lastIndexOf(top) + 1;
    return top;
  }

  private redoable(): (id: ActionId) => boolean {
    const ctx = this.ctx();
    return (id) => this.log.active(id) && (undoOffer(ctx, id) !== null || undoChanges(this.log, id));
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
    this.usable();
    return buildAction(this.ctx(), intent).preview;
  }

  undo(): Built | null {
    this.writable();
    const target = this.prune(this.undoStack);
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
    const target = this.prune(this.redoStack, this.redoable());
    if (target === null) return null;
    this.offerFor(target);
    const built = buildUndo(this.ctx(), target);
    return this.commit(built, () => {
      this.redoStack.pop();
      this.undoStack.push(built.action.id);
    });
  }

  canUndo(): boolean {
    return this.nextUndo() !== null;
  }

  canRedo(): boolean {
    return this.liveTop(this.redoStack, this.redoable()) !== null;
  }

  revert(id: ActionId): Built {
    this.writable();
    this.offerFor(id);
    return this.pushed(buildRevert(this.ctx(), id));
  }

  previewRevert(id: ActionId): Preview {
    this.usable();
    this.offerFor(id);
    return buildRevert(this.ctx(), id).preview;
  }

  resolve(choice: string, pick: Pick, opts: ResolveOptions): Built {
    this.writable();
    const c = this.choice(choice);
    return this.pushed(buildResolve(this.ctx(), c, pick, opts));
  }

  previewResolve(choice: string, pick: Pick, opts: ResolveOptions): ResolvePreview {
    this.usable();
    const c = this.choice(choice);
    return previewResolve(this.ctx(), c, pick, opts);
  }

  nextUndo(): ActionId | null {
    return this.liveTop(this.undoStack);
  }

  undoOffer(): Offer | null {
    this.usable();
    const target = this.nextUndo();
    return target === null ? null : undoOffer(this.ctx(), target);
  }

  authorOf(u: UnitKey): { dev: DeviceId; device: string } | null {
    const unit = this.log.unit(u);
    if (unit === undefined) return null;
    return this.authorNamed(unit.from, `Action ${unit.from} wrote ${u} but is not ready`);
  }

  trashAuthorOf(item: ItemId): { dev: DeviceId; device: string } {
    const live = this.authorOf(key.e(item));
    if (live !== null) return live;
    const writers = this.log.writers(key.e(item));
    if (writers.length === 0) throw new Error(`Item ${item} has no existence writer`);
    const by = writers
      .map((w) => this.log.unit(key.a(w)))
      .flatMap((st) => (st !== undefined && st.value === false ? [st.from] : []))
      .reduce<ActionId | null>((m, x) => (m === null || this.log.before(m, x) ? x : m), null);
    if (by === null) throw new Error(`Item ${item} is trashed but no action trashed it`);
    return this.authorNamed(by, `Action ${by} trashed ${item} but is not ready`);
  }

  private authorNamed(id: ActionId, notReady: string): { dev: DeviceId; device: string } {
    const a = this.log.get(id);
    if (a === undefined) throw new Error(notReady);
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

  onNotes(cb: () => void): () => void {
    this.noteSubscribers.add(cb);
    return () => {
      this.noteSubscribers.delete(cb);
    };
  }

  notesVersion(): number {
    return this.notesSeen;
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc.ydoc);
  }

  get readOnlyReason(): string | null {
    if (this.ro) return READ_ONLY;
    if (this.current.newer) return NEWER_PLAN;
    return null;
  }

  get readOnly(): boolean {
    return this.readOnlyReason !== null;
  }

  setReadOnly(on: boolean): void {
    this.ro = on;
    this.notify();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.offs.splice(0).forEach((off) => off());
    this.deps.holidays.forget(this.id, this);
  }
}

export function usePlanView(session: PlanSession): PlanView {
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  const snapshot = useCallback(() => session.view(), [session]);
  return useSyncExternalStore(subscribe, snapshot);
}

const quiet = (): (() => void) => () => undefined;

export function useNotes(session: PlanSession | null, active: boolean): number {
  const subscribe = useCallback((cb: () => void) => (active && session !== null ? session.onNotes(cb) : quiet()), [session, active]);
  const snapshot = useCallback(() => (active && session !== null ? session.notesVersion() : 0), [session, active]);
  return useSyncExternalStore(subscribe, snapshot);
}
