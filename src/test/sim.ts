import * as Y from "yjs";
import { buildAction, initialAction } from "../actions/build";
import { Refused, type Intent } from "../actions/intents";
import { buildResolve, type Pick, type ResolveOptions } from "../actions/resolve";
import { buildRevert, buildUndo, undoOffer } from "../actions/undo";
import type { Calendar, Closure, Tuning } from "../domain/calendar";
import { toDay, toIso, type IsoDate, type Weekday } from "../domain/dates";
import type { Item, ItemId, ItemKind, LinkType, Status, Horizon } from "../domain/model";
import { newId } from "../log/ids";
import { LogState } from "../log/state";
import type { Action, ActionId, DeviceId, SessionId } from "../log/types";
import type { Choice } from "../plan/choices";
import { childrenOf, projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { parseKey } from "../plan/units";
import { PlanDoc, type PlanView } from "../store/doc";
import { CH_ZH } from "./fixtures/calendars";
import { ctxOf, FIXTURE_DEVICES } from "./planCtx";

export const SIM_TODAY: IsoDate = "2026-11-09";

export const PLAN = "P";

export type BuiltKind = Intent["t"] | "undo" | "redo" | "revert" | "resolve";

export interface SimBuilt {
  action: Action;
  kind: BuiltKind;
  view: PlanView;
  choice?: Choice;
  pick?: Pick;
  opts?: ResolveOptions;
}

export interface SimDevice {
  id: DeviceId;
  name: string;
  ses: SessionId;
  doc: PlanDoc;
  log: LogState;
}

export interface SimResult {
  devices: SimDevice[];
  shuffled: LogState;
  built: SimBuilt[];
  notes: { item: ItemId; marker: string }[];
  root: Action;
  lost: ReadonlySet<ActionId>;
  steps: readonly string[];
}

interface Device extends SimDevice {
  undo: ActionId[];
  redo: ActionId[];
  backups: Uint8Array[];
  stop: () => void;
}

type Rnd = () => number;

const rngOf = (seed: number): Rnd => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const NAMES = ["Draft", "Review", "Plan review", "Ship", "Spec", "Build", "QA"];
const KINDS: readonly ItemKind[] = ["task", "task", "task", "milestone", "group"];
const LINK_TYPES: readonly LinkType[] = ["FS", "FS", "SS", "FF", "SF"];
const STATUSES: readonly Status[] = ["todo", "todo", "doing", "done"];
const HORIZONS: readonly Horizon[] = ["now", "next", "later"];
const FIRST = toDay("2026-11-02");
const DATES: readonly IsoDate[] = Array.from({ length: 70 }, (_, k) => toIso(FIRST + k));

const INTENTS = [
  ["create", 4],
  ["rename", 4],
  ["schedule", 8],
  ["move", 24],
  ["resize", 6],
  ["place", 3],
  ["trash", 3],
  ["restore", 2],
  ["link", 14],
  ["unlink", 2],
  ["calendar", 4],
  ["snap", 2],
  ["fix", 6],
  ["baseline", 3],
  ["planName", 2],
] as const;

const weighted = <K extends string>(table: readonly (readonly [K, number])[], roll: number): K => {
  const total = table.reduce((n, [, w]) => n + w, 0);
  const at = roll * total;
  const found = table.reduce<{ k: K | null; acc: number }>((s, [k, w]) => (s.k !== null ? s : at < s.acc + w ? { k, acc: s.acc } : { k: null, acc: s.acc + w }), {
    k: null,
    acc: 0,
  }).k;
  if (found === null) throw new Error(`No entry for roll ${roll}`);
  return found;
};

const STEPS = [
  ["intent", 44],
  ["undo", 7],
  ["redo", 4],
  ["revert", 5],
  ["resolve", 10],
  ["note", 8],
  ["sync", 16],
  ["partition", 5],
  ["backup", 3],
  ["restore", 2],
] as const;

const addAll = (log: LogState, actions: Iterable<Action>): void => {
  const delta = log.add(actions);
  if (delta.refused.length > 0) throw new Error(`Refused: ${delta.refused.map((r) => `${r.id} ${r.message}`).join("; ")}`);
};

const send = (from: Device, to: Device): void => {
  Y.applyUpdate(to.doc.ydoc, Y.encodeStateAsUpdate(from.doc.ydoc, Y.encodeStateVector(to.doc.ydoc)));
};

const noteTexts = (doc: PlanDoc): Map<ItemId, string> => {
  const notes = doc.ydoc.getMap("notes");
  return new Map([...notes.keys()].map((item) => [item, doc.note(item).toString()]));
};

const actionIds = (doc: PlanDoc): Set<ActionId> => new Set(doc.ydoc.getMap("actions").keys());

const isRefused = (e: unknown): boolean => e instanceof Refused;

export function simulate(seed: number): SimResult {
  const r = rngOf(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => {
    if (xs.length === 0) throw new Error("pick from an empty list");
    return xs[Math.floor(r() * xs.length)];
  };
  const chance = (p: number): boolean => r() < p;
  const freshDoc = (): Y.Doc => {
    const ydoc = new Y.Doc();
    ydoc.clientID = int(1, 2 ** 31 - 1);
    return ydoc;
  };

  const attach = (d: Omit<Device, "log" | "stop">): Device => {
    const log = new LogState(planRules);
    addAll(log, d.doc.actions());
    const stop = d.doc.onActions((added) => addAll(log, added));
    return { ...d, log, stop };
  };

  const ids = [...FIXTURE_DEVICES.keys()].slice(0, int(2, 3));
  const devices: Device[] = ids.map((id) =>
    attach({ id, name: FIXTURE_DEVICES.get(id) ?? id, ses: newId(), doc: new PlanDoc(freshDoc()), undo: [], redo: [], backups: [] }),
  );
  const root = initialAction({ dev: devices[0].id, ses: devices[0].ses, now: 0, name: "Plan", calendar: CH_ZH });
  devices[0].doc.append(root, []);
  devices.slice(1).forEach((d) => send(devices[0], d));

  const built: SimBuilt[] = [];
  const notes: { item: ItemId; marker: string }[] = [];
  const lost = new Set<ActionId>();
  const steps: string[] = [];
  const createdIn = new Map<ItemId, number>();
  let epoch = 0;
  let partition: { group: ReadonlyMap<DeviceId, number>; left: number } | null = null;
  let clock = 0;

  const ctxFor = (d: Device) => ctxOf(d.log, d.id, SIM_TODAY, FIXTURE_DEVICES, { ses: d.ses, now: (clock += 60_000) });

  const record = (d: Device, b: SimBuilt, newNotes: readonly ItemId[]): void => {
    d.doc.append(b.action, newNotes);
    if (d.log.get(b.action.id) === undefined) throw new Error(`Action ${b.action.id} did not reach the log of ${d.id}`);
    newNotes.forEach((item) => createdIn.set(item, epoch));
    built.push(b);
  };

  const attempt = (label: string, fn: () => void): void => {
    try {
      fn();
      steps.push(label);
    } catch (e) {
      if (!isRefused(e)) throw e;
      steps.push(`${label} refused: ${(e as Error).message}`);
    }
  };

  const nonGroups = (items: readonly Item[]): Item[] => items.filter((i) => i.kind !== "group");

  const nextCalendar = (cal: Calendar): Calendar => {
    const op = int(0, 3);
    if (op === 0) {
      const day = pick<Weekday>([5, 6]);
      const has = cal.workdays.includes(day);
      const workdays = has ? cal.workdays.filter((x) => x !== day) : [...cal.workdays, day].sort((a, b) => a - b);
      return { ...cal, workdays };
    }
    if (op === 1) {
      const id = newId();
      const from = int(0, DATES.length - 5);
      const closure: Closure = { id, from: DATES[from], to: DATES[from + int(0, 4)], name: pick(["Office move", "Offsite"]) };
      return { ...cal, closures: new Map([...cal.closures, [id, closure]]) };
    }
    if (op === 2 && cal.closures.size > 0) {
      const gone = pick([...cal.closures.keys()]);
      return { ...cal, closures: new Map([...cal.closures].filter(([id]) => id !== gone)) };
    }
    const date = pick(DATES);
    const t: Tuning = pick<Tuning>([{ kind: "off" }, { kind: "work" }, { kind: "add", name: "Team day" }]);
    const tuning = new Map(cal.tuning);
    if (tuning.has(date) && chance(0.5)) tuning.delete(date);
    else tuning.set(date, t);
    return { ...cal, tuning };
  };

  const intentFor = (view: PlanView): Intent => {
    const plan = view.plan;
    const items = [...plan.items.values()];
    const groups = items.filter((i) => i.kind === "group");
    const scheduled = nonGroups(items);
    const t = items.length < 4 || (items.length < 7 && chance(0.15)) ? "create" : weighted(INTENTS, r());
    const parentPick = (): ItemId | null => (groups.length === 0 || chance(0.5) ? null : pick(groups).id);
    const durFor = (it: Item): number => (it.kind === "milestone" ? 0 : int(1, 6));
    switch (t) {
      case "create": {
        const kind = pick(KINDS);
        const parent = parentPick();
        const sibs = childrenOf(plan, parent);
        const after = sibs.length === 0 || chance(0.5) ? null : pick(sibs).id;
        if (kind === "group") return { t: "create", kind, name: pick(NAMES), parent, after, start: null };
        const start = chance(0.85) ? pick(DATES) : null;
        const dur = chance(0.3) ? undefined : kind === "milestone" ? 0 : int(1, 5);
        return { t: "create", kind, name: pick(NAMES), parent, after, start, dur };
      }
      case "rename":
        return { t: "rename", item: pick(items).id, name: pick(NAMES) };
      case "schedule": {
        if (scheduled.length === 0) return { t: "planName", name: pick(NAMES) };
        const it = pick(scheduled);
        const set: Partial<{ start: IsoDate | null; dur: number; status: Status; progress: number; horizon: Horizon }> = {};
        if (chance(0.5)) set.start = chance(0.9) ? pick(DATES) : null;
        if (chance(0.3)) set.dur = durFor(it);
        if (chance(0.3)) set.status = pick(STATUSES);
        if (chance(0.2)) set.progress = pick([0, 50, 100]);
        if (chance(0.2) || Object.keys(set).length === 0) set.horizon = pick(HORIZONS);
        return { t: "schedule", item: it.id, set };
      }
      case "move":
        return { t: "move", items: [...new Set([pick(items).id, ...(chance(0.3) ? [pick(items).id] : [])])], days: pick([-2, -1, 1, 2, 3, 5]) };
      case "resize":
        return scheduled.length === 0 ? { t: "planName", name: pick(NAMES) } : { t: "resize", item: pick(scheduled).id, dur: int(1, 6) };
      case "place": {
        const it = pick(items);
        const parent = parentPick();
        const sibs = childrenOf(plan, parent).filter((s) => s.id !== it.id);
        return { t: "place", item: it.id, parent, after: sibs.length === 0 || chance(0.4) ? null : pick(sibs).id };
      }
      case "trash":
        return { t: "trash", items: [pick(items).id] };
      case "restore": {
        const trashed = items.filter((i) => i.trashed);
        return { t: "restore", items: [pick(trashed.length > 0 && chance(0.8) ? trashed : items).id] };
      }
      case "link": {
        if (scheduled.length < 2) return { t: "planName", name: pick(NAMES) };
        return { t: "link", from: pick(scheduled).id, to: pick(scheduled).id, type: pick(LINK_TYPES), lag: pick([0, 0, 1, 2, -1]) };
      }
      case "unlink": {
        const shown = [...plan.links].filter(([, l]) => plan.items.has(l.from) && plan.items.has(l.to)).map(([k]) => k);
        return shown.length === 0 ? { t: "rename", item: pick(items).id, name: pick(NAMES) } : { t: "unlink", link: pick(shown) };
      }
      case "calendar":
        return chance(0.5) ? { t: "calendar", next: nextCalendar(plan.calendar), base: plan.calendar } : { t: "calendar", next: nextCalendar(plan.calendar) };
      case "snap":
        return scheduled.length === 0 ? { t: "planName", name: pick(NAMES) } : { t: "snap", item: pick(scheduled).id };
      case "fix": {
        const cs = view.derived.conflicts;
        if (cs.length === 0) return { t: "move", items: [pick(items).id], days: pick([1, 2]) };
        const c = pick(cs);
        return { t: "fix", conflict: c, how: c.kind === "dayoff" ? "push" : pick(["push", "shorten", "remove"] as const) };
      }
      case "baseline": {
        const bs = [...plan.baselines.keys()];
        if (bs.length === 0 || chance(0.4)) return { t: "baseline", op: "save", name: pick(NAMES) };
        return chance(0.5) ? { t: "baseline", op: "rename", id: pick(bs), name: pick(NAMES) } : { t: "baseline", op: "remove", id: pick(bs) };
      }
      case "planName":
        return { t: "planName", name: pick(NAMES) };
    }
  };

  const stepIntent = (d: Device): void => {
    const ctx = ctxFor(d);
    const intent = intentFor(ctx.view);
    attempt(`${d.id} ${intent.t}`, () => {
      const b = buildAction(ctx, intent);
      record(d, { action: b.action, kind: intent.t, view: ctx.view }, b.newNotes);
      d.undo.push(b.action.id);
      d.redo = [];
    });
  };

  const stepUndo = (d: Device, redo: boolean): void => {
    const stack = redo ? d.redo : d.undo;
    const target = stack[stack.length - 1];
    if (target === undefined || !d.log.active(target)) return void steps.push(`${d.id} ${redo ? "redo" : "undo"} skipped`);
    const ctx = ctxFor(d);
    if (undoOffer(ctx, target) !== null) return void steps.push(`${d.id} ${redo ? "redo" : "undo"} offered`);
    attempt(`${d.id} ${redo ? "redo" : "undo"} ${target}`, () => {
      const b = buildUndo(ctx, target);
      record(d, { action: b.action, kind: redo ? "redo" : "undo", view: ctx.view }, b.newNotes);
      stack.pop();
      (redo ? d.undo : d.redo).push(b.action.id);
    });
  };

  const stepRevert = (d: Device): void => {
    const candidates = d.log.order().filter((id) => id !== root.id);
    if (candidates.length === 0) return void steps.push(`${d.id} revert skipped`);
    const target = pick(candidates);
    const ctx = ctxFor(d);
    if (undoOffer(ctx, target) !== null) return void steps.push(`${d.id} revert offered`);
    attempt(`${d.id} revert ${target}`, () => {
      const b = buildRevert(ctx, target);
      record(d, { action: b.action, kind: "revert", view: ctx.view }, b.newNotes);
      d.undo.push(b.action.id);
      d.redo = [];
    });
  };

  const stepResolve = (d: Device): void => {
    const ctx = ctxFor(d);
    if (ctx.view.choices.length === 0) return void steps.push(`${d.id} resolve skipped`);
    const choice = pick(ctx.view.choices);
    const keys = choice.sides.map((s) => s.key);
    const perUnit = chance(0.3) ? new Map(choice.units.filter(() => chance(0.5)).map((u) => [u, pick(keys)] as const)) : undefined;
    const p: Pick = perUnit === undefined ? { side: pick(keys) } : { side: pick(keys), perUnit };
    const opts: ResolveOptions = { pushFromPredecessors: chance(0.7), returnPushed: chance(0.7) };
    attempt(`${d.id} resolve ${choice.kind} ${choice.id}`, () => {
      const b = buildResolve(ctx, choice, p, opts);
      record(d, { action: b.action, kind: "resolve", view: ctx.view, choice, pick: p, opts }, b.newNotes);
      d.undo.push(b.action.id);
      d.redo = [];
    });
  };

  const stepNote = (d: Device, n: number): void => {
    const known = [...projectPlan(PLAN, d.log).items.keys()];
    if (known.length === 0) return void steps.push(`${d.id} note skipped`);
    const fresh = known.filter((item) => createdIn.get(item) === epoch);
    const item = fresh.length > 0 && chance(0.5) ? pick(fresh) : pick(known);
    const marker = `<m${n}>`;
    const text = d.doc.note(item);
    text.insert(text.length, marker);
    notes.push({ item, marker });
    steps.push(`${d.id} note ${item} ${marker}`);
  };

  const canTalk = (a: Device, b: Device): boolean => partition === null || partition.group.get(a.id) === partition.group.get(b.id);

  const stepSync = (): void => {
    const a = pick(devices);
    const others = devices.filter((x) => x !== a && canTalk(a, x));
    if (others.length === 0) return void steps.push("sync skipped");
    const b = pick(others);
    const order = chance(0.5) ? [a, b] : [b, a];
    if (chance(0.3)) send(order[0], order[1]);
    else {
      send(order[0], order[1]);
      send(order[1], order[0]);
    }
    steps.push(`sync ${order[0].id}→${order[1].id}`);
  };

  const stepPartition = (): void => {
    epoch += 1;
    const lone = pick(devices).id;
    const group = new Map(devices.map((d) => [d.id, d.id === lone || (devices.length === 3 && chance(0.3)) ? 1 : 0]));
    partition = { group, left: int(3, 14) };
    steps.push(`partition ${[...group].map(([id, g]) => `${id}:${g}`).join(" ")} for ${partition.left}`);
  };

  const stepRestore = (d: Device, n: number): void => {
    if (d.backups.length === 0) return void steps.push(`${d.id} restore skipped`);
    const at = int(0, d.backups.length - 1);
    const backup = d.backups[at];
    const ydoc = freshDoc();
    Y.applyUpdate(ydoc, backup);
    const doc = new PlanDoc(ydoc);
    const others = devices.filter((x) => x !== d);
    const kept = [actionIds(doc), ...others.map((x) => actionIds(x.doc))];
    [...actionIds(d.doc)].filter((id) => kept.every((s) => !s.has(id))).forEach((id) => lost.add(id));
    const texts = [noteTexts(doc), ...others.map((x) => noteTexts(x.doc))];
    const survivors = notes.filter((n) => texts.some((t) => (t.get(n.item) ?? "").includes(n.marker)));
    notes.splice(0, notes.length, ...survivors);
    d.stop();
    const next = attach({ id: d.id, name: d.name, ses: newId(), doc, undo: [], redo: [], backups: d.backups.slice(0, at + 1) });
    devices[devices.indexOf(d)] = next;
    steps.push(`${d.id} restore at ${n} from backup ${at}`);
  };

  const count = int(20, 80);
  const stepAt = (n: number, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      if (e instanceof Error) e.message = `simulate(${seed}) failed at step ${n}: ${e.message}\n${steps.join("\n")}`;
      throw e;
    }
  };
  const opening = devices[0];
  const chain: string[] = [];
  Array.from({ length: int(3, 5) }).forEach((_, k) =>
    stepAt(-1, () => {
      const ctx = ctxFor(opening);
      const b = buildAction(ctx, { t: "create", kind: "task", name: NAMES[k], parent: null, after: null, start: pick(DATES.slice(0, 20)), dur: int(1, 4) });
      record(opening, { action: b.action, kind: "create", view: ctx.view }, b.newNotes);
      chain.push(parseKey(b.action.w[0].u).arg);
    }),
  );
  chain.slice(1).forEach((to, k) =>
    stepAt(-1, () => {
      const ctx = ctxFor(opening);
      attempt(`${opening.id} link`, () => {
        const b = buildAction(ctx, { t: "link", from: chain[k], to, type: "FS", lag: 0 });
        record(opening, { action: b.action, kind: "link", view: ctx.view }, b.newNotes);
      });
    }),
  );
  devices.slice(1).forEach((d) => send(opening, d));
  Array.from({ length: count }).forEach((_, n) => stepAt(n, () => {
    if (partition !== null) {
      partition.left -= 1;
      if (partition.left <= 0) partition = null;
    }
    const d = pick(devices);
    const kind = weighted(STEPS, r());
    switch (kind) {
      case "intent":
        return stepIntent(d);
      case "undo":
        return stepUndo(d, false);
      case "redo":
        return stepUndo(d, true);
      case "revert":
        return stepRevert(d);
      case "resolve":
        return stepResolve(d);
      case "note":
        return stepNote(d, n);
      case "sync":
        return stepSync();
      case "partition":
        return stepPartition();
      case "backup":
        d.backups.push(Y.encodeStateAsUpdate(d.doc.ydoc));
        return void steps.push(`${d.id} backup`);
      case "restore":
        return stepRestore(d, n);
    }
  }));

  partition = null;
  devices.slice(1).forEach((d) => send(d, devices[0]));
  devices.slice(1).forEach((d) => send(devices[0], d));

  const everything = [root, ...built.map((b) => b.action)].filter((a) => !lost.has(a.id));
  const depth = new Map<ActionId, number>();
  const byId = new Map(everything.map((x) => [x.id, x]));
  const depthOf = (a: Action): number => {
    const known = depth.get(a.id);
    if (known !== undefined) return known;
    const parentDepth = a.par.map((p) => {
      const parent = byId.get(p);
      if (parent === undefined) throw new Error(`Action ${a.id} has parent ${p}, which is lost`);
      return depthOf(parent);
    });
    const v = 1 + Math.max(0, ...parentDepth);
    depth.set(a.id, v);
    return v;
  };
  const shuffledOrder = everything
    .map((a) => ({ a, key: r() }))
    .sort((x, y) => x.key - y.key)
    .map((x) => x.a)
    .sort((x, y) => depthOf(y) - depthOf(x));
  const shuffled = new LogState(planRules);
  const cuts = [0, ...Array.from({ length: int(1, 4) }, () => int(0, shuffledOrder.length)).sort((a, b) => a - b), shuffledOrder.length];
  cuts.slice(1).forEach((end, k) => addAll(shuffled, shuffledOrder.slice(cuts[k], end)));
  devices.forEach((d) => d.stop());

  return {
    devices: devices.map(({ id, name, ses, doc, log }) => ({ id, name, ses, doc, log })),
    shuffled,
    built,
    notes,
    root,
    lost,
    steps,
  };
}
