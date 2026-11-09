import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";
import { initialAction } from "../actions/build";
import type { Calendar } from "../domain/calendar";
import type { IsoDate } from "../domain/dates";
import type { Horizon, ItemId, ItemKind, LinkType, PlanId, Status } from "../domain/model";
import { newId } from "../log/ids";
import type { Action, ActionId, DeviceId, UnitKey, Write } from "../log/types";
import { existence, key, link, name as nameCodec, place, sched, validateWrite } from "../plan/units";
import { fixedClock, type Clock } from "../services/clock";
import { HolidayService } from "../services/holidays";
import { PlanDoc } from "../store/doc";
import { openPersisted, type PersistedDoc } from "../store/persist";
import { PlanSession, type SessionDeps } from "../store/session";
import { memoryStore } from "./fixtures/store";
import { resetTauri, type Answer } from "./tauriMock";

export const SEED_ROOT: ActionId = "seed0000000";
export const TEST_PLAN: PlanId = "plan0000001";
export const TEST_DEVICES: ReadonlyMap<DeviceId, string> = new Map([
  ["mac", "Mac"],
  ["iphone", "iPhone"],
]);

export interface SeedDep {
  from: ItemId;
  type: LinkType;
  lag: number;
}

export interface SeedItem {
  id?: ItemId;
  name: string;
  kind?: ItemKind;
  parent?: ItemId | null;
  start?: IsoDate | null;
  dur?: number;
  status?: Status;
  progress?: number;
  deps?: readonly SeedDep[];
  note?: string;
  horizon?: Horizon;
}

export const fs = (from: ItemId, lag = 0): SeedDep => ({ from, type: "FS", lag });

const T = (id: ItemId, name: string, o: Omit<SeedItem, "id" | "name"> = {}): SeedItem => ({ id, name, ...o });

export const MESA_SEED: readonly SeedItem[] = [
  T("g1", "Site works · dome and pier", { kind: "group" }),
  T("t1", "Pour the pier and the dome footings", { parent: "g1", start: "2026-11-02", dur: 5, status: "done", progress: 100 }),
  T("t2", "Dome shell delivery, crane and bolts", { parent: "g1", start: "2026-11-03", dur: 4, status: "doing", progress: 80 }),
  T("t6", "Telescope mount model chosen", { parent: "g1", start: "2026-11-02", dur: 4, status: "done", progress: 100 }),
  T("m1", "Dome set", { kind: "milestone", parent: "g1", start: "2026-11-06", dur: 0, deps: [fs("t1"), fs("t2"), fs("t6")] }),
  T("g2", "Commission", { kind: "group" }),
  T("t3", "Tracking: review results", { parent: "g2", start: "2026-11-09", dur: 4, deps: [fs("t2")] }),
  T("t4", "Camera and filter kit", { parent: "g2", start: "2026-11-04", dur: 6, status: "doing", progress: 50 }),
  T("t5", "Image quality check: mirror and camera", { parent: "g2", start: "2026-11-11", dur: 5 }),
  T("t7", "First light: dry runs", {
    parent: "g2",
    start: "2026-11-18",
    dur: 3,
    deps: [fs("t3"), fs("t4"), fs("t5")],
    note: "Plan-only task: the guides run it on the night, and it needs no checklist.",
  }),
  T("m2", "Optics ready", { kind: "milestone", parent: "g2", start: "2026-11-23", dur: 0, deps: [fs("t7")] }),
  T("g3", "Visitor services", { kind: "group" }),
  T("t10", "Website: pick a CMS host", { parent: "g3", start: "2026-11-09", dur: 5, status: "doing", progress: 30 }),
  T("t11", "Website: build the programme pages", { parent: "g3", start: "2026-11-16", dur: 10, deps: [fs("t10")] }),
  T("t8", "Signage: trail maps and safety notes", { parent: "g3", start: "2026-11-16", dur: 8 }),
  T("m3", "Signs placed", { kind: "milestone", parent: "g3", start: "2026-11-30", dur: 0, deps: [fs("t8")] }),
  T("t9", "Volunteers: recruit and train crews", {
    parent: "g3",
    start: "2026-11-23",
    dur: 20,
    status: "doing",
    progress: 55,
    note: "Covers each guided evening of the first season, so its progress follows the bookings made so far.",
  }),
  T("t12", "School visits: draft the class offer", { parent: "g3", start: "2026-11-30", dur: 5 }),
  T("g4", "Debut", { kind: "group" }),
  T("t13", "Permits and insurance papers", {
    parent: "g4",
    start: "2027-01-05",
    dur: 6,
    deps: [fs("t9"), fs("t11"), fs("t12")],
    note: "Plan-only task. Filed by the club treasurer alone.",
  }),
  T("m4", "Opening night", { kind: "milestone", parent: "g4", start: "2027-01-15", dur: 0, deps: [fs("m2"), fs("m3"), fs("t13")] }),
  T("u1", "Kids star parties", { horizon: "next" }),
  T("u2", "Solar telescope add-on", { horizon: "later" }),
  T("u3", "Live-stream the eclipse", { horizon: "later" }),
  T("u4", "Membership and season pass", { horizon: "later" }),
  T("u5", "Gift shop counter", { horizon: "later" }),
];

export type Clash =
  | { unit: UnitKey; mac: unknown; iphone: unknown }
  | { unit: readonly UnitKey[]; mac: readonly unknown[]; iphone: readonly unknown[] };

export interface TestSessionOpts {
  today?: IsoDate;
  calendar?: Partial<Calendar>;
  clashes?: readonly Clash[];
  raw?: Record<ActionId, unknown>;
  answers?: Record<string, Answer>;
  plan?: PlanId;
}

export interface TestSession {
  session: PlanSession;
  clock: Clock & { set(today: IsoDate): void };
  doc: PersistedDoc;
  holidays: HolidayService;
  peer(device: DeviceId): Promise<{ session: PlanSession; sync(): void }>;
}

const PLAIN: Calendar = { region: null, workdays: [1, 2, 3, 4, 5], closures: new Map(), tuning: new Map(), holidays: new Map() };

const idOf = (s: SeedItem): ItemId => s.id ?? s.name;

function itemWrites(seed: readonly SeedItem[]): Write[] {
  const own = (u: UnitKey, v: unknown): Write => ({ u, v, c: "own" });
  const last = new Map<ItemId | null, string>();
  return seed.flatMap((s) => {
    const id = idOf(s);
    const kind = s.kind ?? "task";
    const parent = s.parent ?? null;
    const order = generateKeyBetween(last.get(parent) ?? null, null);
    last.set(parent, order);
    const base = [
      own(key.e(id), existence.enc({ k: kind, t: false })),
      own(key.n(id), nameCodec.enc(s.name)),
      own(key.p(id), place.enc({ parent, order })),
    ];
    const schedule =
      kind === "group"
        ? []
        : [
            own(
              key.s(id),
              sched.enc({
                start: s.start ?? null,
                dur: kind === "milestone" ? 0 : (s.dur ?? 3),
                status: s.status ?? "todo",
                progress: s.progress ?? 0,
                horizon: s.horizon ?? "later",
              }),
            ),
          ];
    const links = (s.deps ?? []).map((d) => own(key.l(d.from, id), link.enc({ type: d.type, lag: d.lag })));
    return [...base, ...schedule, ...links];
  });
}

function clashActions(c: Clash): Action[] {
  const units: readonly UnitKey[] = typeof c.unit === "string" ? [c.unit] : c.unit;
  const valuesOf = (v: unknown): readonly unknown[] => (typeof c.unit === "string" ? [v] : Array.isArray(v) ? v : []);
  const side = (dev: DeviceId, v: unknown): Action => {
    const values = valuesOf(v);
    if (values.length !== units.length) throw new Error(`testSession: clash on ${units.join(", ")} needs one ${dev} value per unit`);
    return { id: newId(), dev, ses: "ses-" + dev, at: 0, par: [SEED_ROOT], lbl: `${dev} clash`, w: units.map((u, i) => ({ u, v: values[i], c: "own" })) };
  };
  return [side("mac", c.mac), side("iphone", c.iphone)];
}

export function memoryDoc(id: string, ydoc: Y.Doc): PersistedDoc {
  return {
    id,
    ydoc,
    repairedTornTail: false,
    error: () => null,
    onError: () => () => undefined,
    retry: async () => undefined,
    flush: async () => undefined,
    compact: async () => undefined,
    close: async () => undefined,
    discard: async () => undefined,
  };
}

export async function testSession(seed: readonly SeedItem[], opts: TestSessionOpts = {}): Promise<TestSession> {
  const plan = opts.plan ?? TEST_PLAN;
  const mem = memoryStore();
  resetTauri({ ...mem.answers, ...opts.answers });
  const clock = fixedClock(opts.today ?? "2026-11-09");
  const holidays = new HolidayService(() => clock.now());
  const calendar: Calendar = { ...PLAIN, ...opts.calendar };
  const root = initialAction({ dev: "mac", ses: "ses-mac", now: 0, name: "Plan", calendar });
  const items = itemWrites(seed);
  items.forEach(validateWrite);
  const rootAction: Action = { ...root, id: SEED_ROOT, w: [...root.w, ...items] };
  const ydoc = new Y.Doc();
  const pd = new PlanDoc(ydoc);
  pd.append(rootAction, seed.map(idOf));
  seed.forEach((s) => {
    if (s.note !== undefined) pd.note(idOf(s)).insert(0, s.note);
  });
  (opts.clashes ?? []).flatMap(clashActions).forEach((a) => pd.append(a, []));
  const actions = ydoc.getMap("actions");
  ydoc.transact(() => Object.entries(opts.raw ?? {}).forEach(([id, raw]) => actions.set(id, raw)), "raw");
  mem.seed(plan, Y.encodeStateAsUpdate(ydoc));
  const doc = await openPersisted(plan);
  const deps = (device: DeviceId, persisted: PersistedDoc, h: HolidayService): SessionDeps => ({
    persist: async (id) => {
      if (id !== plan) throw new Error(`testSession: no document ${id}`);
      return persisted;
    },
    holidays: h,
    clock,
    device,
    devices: () => TEST_DEVICES,
    onDevices: () => () => undefined,
    onName: () => undefined,
  });
  const session = await PlanSession.open(plan, deps("mac", doc, holidays));
  const peer = async (device: DeviceId): Promise<{ session: PlanSession; sync(): void }> => {
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc.ydoc));
    const s = await PlanSession.open(plan, deps(device, memoryDoc(plan, other), new HolidayService(() => clock.now())));
    const sync = (): void => {
      Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc.ydoc)));
      Y.applyUpdate(other, Y.encodeStateAsUpdate(doc.ydoc, Y.encodeStateVector(other)));
    };
    return { session: s, sync };
  };
  return { session, clock, doc, holidays, peer };
}
