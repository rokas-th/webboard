import { generateKeyBetween } from "fractional-indexing";
import { toDay, toIso, type Day } from "../../domain/dates";
import type { Horizon, ItemId, ItemKind, LinkType, Status } from "../../domain/model";
import type { Action, ActionId, Cause, DeviceId, SessionId, Write } from "../../log/types";
import * as codec from "../../plan/units";
import { key, validateWrite } from "../../plan/units";

interface Live {
  id: ItemId;
  kind: Exclude<ItemKind, "group">;
  start: Day;
  dur: number;
  order: string;
  status: Status;
  progress: number;
  horizon: Horizon;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const NAMES = ["Review", "Plan file format", "Design pass", "Ship beta", "Spec", "Build", "QA"];
const LABELS = ["Moved “Review”", "Renamed “Design pass”", "Linked “Ship beta” after “Review”", "Scheduled “Plan file format” from 16 Nov."];
const LINK_TYPES: readonly LinkType[] = ["FS", "FS", "FS", "SS", "FF"];
const FIRST: Day = toDay("2026-11-02");
const SPAN = 240;
const AT = 1_762_600_000_000;

const rngOf = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export function bigLog(n: number, seed: number): { actions: Action[]; items: number; links: number } {
  if (!Number.isInteger(n) || n < 200) throw new Error(`bigLog needs at least 200 actions, not ${n}`);
  const rnd = rngOf(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const id = (): string => Array.from({ length: 11 }, () => ALPHABET[Math.floor(rnd() * 64)]).join("");
  const items = Math.floor(n / 20);
  const links = Math.floor(n / 10);
  const sessionCount = Math.max(1, Math.floor(n / 100));
  const devices: DeviceId[] = [id(), id(), id()];
  const sessions: SessionId[] = Array.from({ length: sessionCount }, id);
  const live: Live[] = [];
  const linked = new Map<string, readonly [ItemId, ItemId]>();
  let lastOrder: string | null = null;

  const sched = (it: Live, c: Cause): Write => {
    if (c === "own") {
      it.status = pick(["todo", "todo", "doing", "done"] as const);
      it.progress = it.status === "done" ? 100 : it.status === "doing" ? int(1, 99) : 0;
      it.horizon = pick(["now", "next", "later"] as const);
    }
    return {
      u: key.s(it.id),
      v: codec.sched.enc({ start: toIso(it.start), dur: it.dur, status: it.status, progress: it.progress, horizon: it.horizon }),
      c,
    };
  };

  const create = (): Write[] => {
    const kind = rnd() < 0.1 ? "milestone" : "task";
    const order = generateKeyBetween(lastOrder, null);
    lastOrder = order;
    const it: Live = { id: id(), kind, start: FIRST + int(0, SPAN), dur: kind === "milestone" ? 0 : int(1, 10), order, status: "todo", progress: 0, horizon: "later" };
    live.push(it);
    return [
      { u: key.e(it.id), v: codec.existence.enc({ k: kind, t: false }), c: "own" },
      { u: key.n(it.id), v: codec.name.enc(pick(NAMES)), c: "own" },
      { u: key.p(it.id), v: codec.place.enc({ parent: null, order }), c: "own" },
      { u: key.s(it.id), v: codec.sched.enc({ start: toIso(it.start), dur: it.dur, status: it.status, progress: it.progress, horizon: it.horizon }), c: "own" },
    ];
  };

  const link = (): Write[] => {
    const tries = Array.from({ length: 20 }, () => {
      const a = int(0, live.length - 1);
      const b = int(0, live.length - 1);
      return a < b ? ([live[a].id, live[b].id] as const) : b < a ? ([live[b].id, live[a].id] as const) : null;
    });
    const pair = tries.find((p) => p !== null && !linked.has(key.l(p[0], p[1])));
    if (pair === undefined || pair === null) throw new Error("bigLog found no new link among 20 tries");
    const u = key.l(pair[0], pair[1]);
    linked.set(u, pair);
    return [{ u, v: codec.link.enc({ type: pick(LINK_TYPES), lag: int(0, 2) }), c: "own" }];
  };

  const writeOf = (taken: ReadonlySet<string>, first: boolean): Write | null => {
    const r = rnd();
    const it = pick(live);
    if (r < 0.5) {
      if (taken.has(key.s(it.id))) return null;
      if (first || rnd() < 0.5) {
        it.start = FIRST + int(0, SPAN);
        return sched(it, "own");
      }
      it.start += int(1, 5);
      return sched(it, "push");
    }
    if (r < 0.7) {
      if (taken.has(key.p(it.id))) return null;
      it.order = generateKeyBetween(it.order, null);
      return { u: key.p(it.id), v: codec.place.enc({ parent: null, order: it.order }), c: "own" };
    }
    if (r < 0.85 || linked.size === 0) {
      if (taken.has(key.n(it.id))) return null;
      return { u: key.n(it.id), v: codec.name.enc(pick(NAMES)), c: "own" };
    }
    const u = pick([...linked.keys()]);
    if (taken.has(u)) return null;
    return { u, v: codec.link.enc({ type: pick(LINK_TYPES), lag: int(0, 3) }), c: "own" };
  };

  const mixed = (): Write[] => {
    const r = rnd();
    const size = r < 0.6 ? 1 : r < 0.85 ? 2 : r < 0.95 ? 4 : 8;
    const ws = Array.from({ length: size * 64 }).reduce<Write[]>((acc) => {
      if (acc.length === size) return acc;
      const x = writeOf(new Set(acc.map((y) => y.u)), acc.length === 0);
      return x === null ? acc : [...acc, x];
    }, []);
    if (ws.length !== size) throw new Error(`bigLog made an action of ${ws.length} writes, not ${size}, in ${size * 64} tries, with ${live.length} items and ${linked.size} links`);
    return ws;
  };

  const due = (done: number, total: number, i: number, by: number): boolean => done < total && done < Math.ceil((i * total) / (by * n));

  const root: Action = {
    id: id(),
    dev: devices[0],
    ses: sessions[0],
    at: AT,
    par: [],
    lbl: "Created the plan “Plan”",
    w: [
      { u: key.pn, v: codec.name.enc("Plan"), c: "own" },
      { u: key.cr, v: codec.region.enc(null), c: "own" },
      { u: key.cw, v: codec.weekdays.enc([1, 2, 3, 4, 5]), c: "own" },
    ],
  };
  const per = n / sessionCount;
  const actions = Array.from({ length: n - 1 }).reduce<Action[]>(
    (acc, _, k) => {
      const i = k + 1;
      const w = due(live.length, items, i, 0.8) || live.length < 3 ? create() : due(linked.size, links, i, 0.9) && live.length * (live.length - 1) > 4 * linked.size ? link() : mixed();
      w.forEach(validateWrite);
      const s = Math.min(sessionCount - 1, Math.floor(i / per));
      const prev: ActionId = acc[acc.length - 1].id;
      acc.push({ id: id(), dev: devices[s % devices.length], ses: sessions[s], at: AT + i * 60_000, par: [prev], lbl: pick(LABELS), w });
      return acc;
    },
    [root],
  );
  if (live.length !== items || linked.size !== links) throw new Error(`bigLog made ${live.length} items and ${linked.size} links, not ${items} and ${links}`);
  return { actions, items, links };
}
