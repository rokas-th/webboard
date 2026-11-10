import * as Y from "yjs";
import { buildAction, initialAction } from "../actions/build";
import type { Calendar } from "../domain/calendar";
import type { Item, ItemId } from "../domain/model";
import { LogState } from "../log/state";
import type { Action, ActionId, DeviceId, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { decodeAction, encodeAction, PlanDoc } from "../store/doc";
import type { PlanSession } from "../store/session";
import { readActions } from "../store/read-actions";
import { act as action } from "./act";
import type { FakeProvider } from "./fakeProvider";
import { memoryStore, type MemoryStore } from "./fixtures/store";
import { ctxOf } from "./planCtx";
import { offeredSettings, resetTauri, type Answer, type Call } from "./tauriMock";

export const SP = "sp000000000";
export const IX = "ix-" + SP;
export const TODAY = "2026-11-08";
export const NOW = new Date(2026, 10, 8, 14, 2).getTime();
export const SPACE = { server: "https://webboard.rokass.org", spaceId: SP, deviceId: "dev-A", deviceName: "Mac" };
export const RESET_HINT = " Reset sync, then join with a code again.";

const PLAIN: Calendar = { region: null, workdays: [1, 2, 3, 4, 5], closures: new Map(), tuning: new Map(), holidays: new Map() };
const DEVICES: ReadonlyMap<DeviceId, string> = new Map([
  ["dev-A", "Mac"],
  ["dev-B", "iPhone"],
]);

export type Err = { code: string; message: string };

export interface SyncWorld {
  mem: MemoryStore;
  settings: { value: unknown };
  status: () => unknown;
  ticket: (doc: string) => unknown;
  answers: Record<string, Answer>;
  issued: number;
}

export const fail =
  (e: Err) =>
  (): never => {
    throw { ...e };
  };

export const argsOf = (c: Pick<Call, "args">): Record<string, unknown> =>
  c.args !== undefined && !(c.args instanceof Uint8Array) && !(c.args instanceof ArrayBuffer) && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {};

export function syncWorld(o: { names?: Record<string, string>; platform?: "macos" | "linux" | "ios"; answers?: Record<string, Answer> } = {}): SyncWorld {
  const mem = memoryStore();
  const w: SyncWorld = {
    mem,
    settings: { value: { ...offeredSettings(), names: o.names ?? {} } },
    status: () => ({ space: SPACE, revoked: false }),
    ticket: () => {
      w.issued += 1;
      return { ticket: "tk_" + w.issued, expiresAt: 0 };
    },
    answers: {},
    issued: 0,
  };
  w.answers = {
    ...mem.answers,
    settings_read: () => w.settings.value,
    settings_write: (args) => {
      w.settings.value = argsOf({ args }).settings;
      return null;
    },
    device_info: () => ({ deviceId: "dev-A", platform: o.platform ?? "macos" }),
    holidays_year: fail({ code: "holidays.offline", message: "No connection to the holiday source." }),
    sync_status: () => w.status(),
    sync_ticket: (args) => {
      const doc = argsOf({ args }).doc;
      if (typeof doc !== "string") throw new Error("sync_ticket without a doc");
      return w.ticket(doc);
    },
    sync_mark_revoked: () => null,
    ...o.answers,
  };
  resetTauri(w.answers);
  return w;
}

export const own = (u: string, v: unknown): Write => ({ u, v, c: "own" });
export const ip = (plan: string, t: boolean): Write => own("ip:" + plan, { t });

export function seedIndex(mem: MemoryStore | null, doc: string, entries: readonly (readonly [ActionId, unknown])[]): Y.Doc {
  const ydoc = new Y.Doc();
  const map = ydoc.getMap("actions");
  ydoc.transact(() => entries.forEach(([id, raw]) => map.set(id, raw)));
  if (mem !== null) mem.seed(doc, Y.encodeStateAsUpdate(ydoc));
  return ydoc;
}

export const ixAct = (id: ActionId, par: readonly ActionId[], w: readonly Write[], dev: DeviceId = "dev-A", lbl = "Add plan"): readonly [ActionId, unknown] => [
  id,
  encodeAction(action(id, par, w, { dev, lbl })),
];

export function seedPlan(mem: MemoryStore | null, id: string, name: string, o: { items?: readonly string[]; dev?: DeviceId; link?: boolean } = {}): Y.Doc {
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
    const names = o.items ?? [];
    if (names.length < 2) throw new Error("seedPlan: a link needs two items");
    const items = [...ctxOf(log, dev, TODAY, DEVICES).view.plan.items.values()];
    const idOf = (n: string): ItemId => {
      const found = items.find((i) => i.name === n);
      if (found === undefined) throw new Error(`no item ${n}`);
      return found.id;
    };
    const l = buildAction(ctxOf(log, dev, TODAY, DEVICES, { ses: "seed" }), { t: "link", from: idOf(names[0]), to: idOf(names[1]), type: "FS", lag: 0 });
    pd.append(l.action, l.newNotes);
    log.add([l.action]);
  }
  if (mem !== null) mem.seed(id, Y.encodeStateAsUpdate(ydoc));
  return ydoc;
}

export const actionsOf = (ydoc: Y.Doc): Action[] => readActions(ydoc.getMap("actions").entries(), () => undefined).ok;

export const headsOf = (ydoc: Y.Doc): ActionId[] => {
  const ok = actionsOf(ydoc);
  const parents = new Set(ok.flatMap((a) => [...a.par]));
  return ok.map((a) => a.id).filter((id) => !parents.has(id));
};

export function remoteUpdate(base: Y.Doc, id: ActionId, raw: unknown): Uint8Array {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(base));
  other.getMap("actions").set(id, raw);
  return Y.encodeStateAsUpdate(other, Y.encodeStateVector(base));
}

export const remoteIndex = (p: FakeProvider, id: ActionId, w: readonly Write[], dev: DeviceId = "dev-B"): void =>
  p.deliver(remoteUpdate(p.ydoc, id, encodeAction(action(id, headsOf(p.ydoc), w, { dev, lbl: "Add plan" }))));

export const remotePlan = (p: FakeProvider, id: ActionId, w: readonly Write[], dev: DeviceId = "dev-B", lbl = "Change"): void =>
  p.deliver(remoteUpdate(p.ydoc, id, encodeAction(action(id, headsOf(p.ydoc), w, { dev, lbl }))));

export const itemNamed = (source: Y.Doc | PlanSession, name: string): ItemId => {
  const items = (): Iterable<Item> => {
    if (!(source instanceof Y.Doc)) return source.view().plan.items.values();
    const log = new LogState(planRules);
    log.add(new PlanDoc(source).actions());
    return ctxOf(log, "dev-A", TODAY).view.plan.items.values();
  };
  const found = [...items()].find((i) => i.name === name);
  if (found === undefined) throw new Error(`no item ${name}`);
  return found.id;
};

export function appendedWrites(calls: readonly Call[]): [string, Write][] {
  return calls
    .filter((c) => c.cmd === "store_append")
    .flatMap((c) => {
      const doc = new Headers(c.options?.headers).get("x-doc");
      if (doc === null) throw new Error("store_append without an x-doc header");
      if (!(c.args instanceof Uint8Array)) throw new Error("store_append carried no bytes");
      return Y.decodeUpdate(c.args)
        .structs.flatMap((s) => (s instanceof Y.Item && s.parentSub !== null ? [decodeAction(s.parentSub, s.content.getContent()[0])] : []))
        .flatMap((a) => a.w.map((w): [string, Write] => [doc, w]));
    });
}

export function seedSpace(w: SyncWorld, o: { trashedP2?: boolean; link?: boolean } = {}): void {
  seedIndex(w.mem, "local", [ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"), ixAct("l-L", ["l-n"], [ip("L", false)])]);
  seedIndex(w.mem, IX, [
    ixAct("s-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"),
    ixAct("s-P", ["s-n"], [ip("P", false)]),
    ...(o.trashedP2 === true ? [ixAct("s-P2", ["s-P"], [ip("P2", false)]), ixAct("s-P2t", ["s-P2"], [ip("P2", true)], "dev-A", "Move plan to Trash")] : []),
  ]);
  seedPlan(w.mem, "P", "Launch", { items: o.link === true ? ["A", "B"] : ["A"], link: o.link });
  seedPlan(w.mem, "L", "Alpha");
  if (o.trashedP2 === true) seedPlan(w.mem, "P2", "Pod");
}
