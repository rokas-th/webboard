import { generateKeyBetween } from "fractional-indexing";
import { regionKey, workCalendar, type Calendar, type Closure, type Tuning, type WorkCalendar } from "../domain/calendar";
import { toDay, toIso, type Day, type IsoDate } from "../domain/dates";
import { derive, schedView, type Derived } from "../domain/derive";
import { linkKey, type Item, type ItemId, type Link, type PlanState, type Schedule } from "../domain/model";
import { lagThatHolds, push, recalendar, wouldLoop, type Conflict, type PushResult, type RecalResult, type Sched, type SchedView, type Stop } from "../domain/schedule";
import { newId } from "../log/ids";
import type { Action, DeviceId, SessionId, UnitKey, Write } from "../log/types";
import { heldItems } from "../plan/choices";
import { applyWrites, childrenOf, liveLinks } from "../plan/project";
import { planRules } from "../plan/rules";
import * as codec from "../plan/units";
import { key, parseKey, validateWrite, type UnitKind } from "../plan/units";
import { fmtShort, items, label, pushSuffix, q, refusal, sentence, toastOf } from "./copy";
import { HeldRefused, Refused, type Built, type Ctx, type Intent, type Preview } from "./intents";

export interface Derivation {
  writes: readonly Write[];
  push: PushResult | null;
  recal: RecalResult | null;
}

interface Draft {
  own: readonly Write[];
  roots: readonly ItemId[];
  newNotes: readonly ItemId[];
  ownStarts?: readonly UnitKey[];
  label(d: Derivation, preview: Preview): string;
  sentences: readonly string[];
}

const CALENDAR_UNITS: ReadonlySet<UnitKind> = new Set<UnitKind>(["cr", "cw", "cc", "ct", "ch"]);

const own = (u: UnitKey, v: unknown): Write => ({ u, v, c: "own" });

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

export function normalizeName(raw: string): string {
  const name = raw.replace(/\s+/g, (run) => (/[\n\r\t]/.test(run) ? " " : run)).trim();
  if (name.length === 0) throw new Refused(refusal.emptyName);
  return name;
}

const itemOf = (plan: PlanState, id: ItemId): Item => {
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`Item ${id} is not in this plan`);
  return it;
};

const trashRootAbove = (plan: PlanState, it: Item): Item | null => {
  const above = (at: ItemId | null, found: Item | null): Item | null => {
    if (at === null) return found;
    const p = itemOf(plan, at);
    return above(p.place.parent, p.trashed ? p : found);
  };
  return above(it.place.parent, null);
};

const notInsideTrash = (plan: PlanState, it: Item): Item => {
  const root = trashRootAbove(plan, it);
  if (root !== null) throw new Refused(refusal.inside(it.name, root.name));
  return it;
};

const live = (plan: PlanState, id: ItemId): Item => {
  const it = notInsideTrash(plan, itemOf(plan, id));
  if (it.trashed) throw new Refused(refusal.trashed(it.name));
  return it;
};

const scheduleOf = (it: Item): Schedule => {
  if (it.schedule === null) throw new Error(`Group ${it.id} has no schedule`);
  return it.schedule;
};

const datedStart = (it: Item): IsoDate => {
  const start = scheduleOf(it).start;
  if (start === null) throw new Refused(refusal.noDates(it.name));
  return start;
};

const checkDur = (it: Item, dur: number): void => {
  if (it.kind === "milestone") {
    if (dur !== 0) throw new Refused(refusal.milestoneDur);
    return;
  }
  if (!Number.isInteger(dur) || dur < 1) throw new Refused(refusal.taskDur);
};

const schedWrite = (id: ItemId, s: Schedule): Write => own(key.s(id), codec.sched.enc(s));

const hasPredecessor = (plan: PlanState, id: ItemId): boolean => liveLinks(plan).some((l) => l.to === id);

const untrashedDescendants = (plan: PlanState, group: ItemId): Item[] =>
  childrenOf(plan, group)
    .filter((c) => !c.trashed)
    .flatMap((c) => [c, ...(c.kind === "group" ? untrashedDescendants(plan, c.id) : [])]);

const isInside = (plan: PlanState, at: ItemId | null, ancestor: ItemId): boolean =>
  at !== null && (at === ancestor || isInside(plan, itemOf(plan, at).place.parent, ancestor));

const orderAfter = (plan: PlanState, parent: ItemId | null, after: ItemId | null, self: ItemId | null): string => {
  const sibs = childrenOf(plan, parent).filter((s) => s.id !== self);
  const a = after === null ? null : sibs.find((s) => s.id === after);
  if (a === undefined) throw new Error(`Item ${after} is not a child of ${parent ?? "the top level"}`);
  const next = a === null ? sibs[0] : sibs.find((s) => s.place.order > a.place.order);
  return generateKeyBetween(a?.place.order ?? null, next?.place.order ?? null);
};

const sameAsCurrent = (ctx: Ctx, w: Write): boolean => {
  const current = ctx.log.unit(w.u);
  return current !== undefined && planRules.same(w.u, w.v, current.value);
};

const nameOf = (ctx: Ctx, id: ItemId): string => itemOf(ctx.view.plan, id).name;

const pushed = (ctx: Ctx, d: Derivation): string =>
  d.push === null
    ? ""
    : pushSuffix(
        d.push.moves.size,
        d.push.stopped.map((s) => ({ reason: s.reason, name: nameOf(ctx, s.id) })),
      );

const storedStart = (d: Derivation, id: ItemId): IsoDate | null => {
  const u = key.s(id);
  const x = d.writes.find((y) => y.u === u);
  if (x === undefined) throw new Error(`No write to ${u} in this action`);
  return codec.decodeAs("sched", u, x.v).start;
};

const resnapped = (x: Write, cal: WorkCalendar): Write => {
  const sc = codec.decodeAs("sched", x.u, x.v);
  if (sc.start === null) throw new Error(`Own start ${x.u} has no start to snap`);
  return { ...x, v: codec.sched.enc({ ...sc, start: toIso(cal.snapF(toDay(sc.start))) }) };
};

const linkEnd = (view: SchedView, l: Link, id: ItemId): Sched => {
  const s = view.items.get(id);
  if (s === undefined) throw new Error(`Link ${linkKey(l.from, l.to)}: ${id} is not scheduled`);
  return s;
};

const plain = (text: string, sentences: readonly string[] = []) => ({ label: () => text, sentences });

const withPush = (ctx: Ctx, text: string): Pick<Draft, "label" | "sentences"> => ({
  label: (d) => text + pushed(ctx, d),
  sentences: [],
});

const calendarUnits = (cal: Calendar): Map<UnitKey, unknown> =>
  new Map<UnitKey, unknown>([
    [key.cr, codec.region.enc(cal.region)],
    [key.cw, codec.weekdays.enc(cal.workdays)],
    ...[...cal.closures].map(([id, c]): [UnitKey, unknown] => {
      if (c.id !== id) throw new Error(`Closure ${c.id} is listed under ${id}`);
      return [key.cc(id), codec.closure.enc({ from: c.from, to: c.to, name: c.name })];
    }),
    ...[...cal.tuning].map(([date, t]): [UnitKey, unknown] => [key.ct(date), codec.tuning.enc(t)]),
    ...[...cal.holidays].map(([year, h]): [UnitKey, unknown] => [key.ch(year), codec.holidayYear.enc(h)]),
  ]);

const checkedCalendar = (cal: Calendar): Calendar => {
  if (cal.workdays.length === 0) throw new Refused(refusal.noWorkdays);
  const closures = new Map(
    [...cal.closures].map(([id, c]): [string, Closure] => {
      if (c.name.trim() === "" || c.from === "") throw new Refused(refusal.closure);
      if (toDay(c.to) < toDay(c.from)) throw new Refused(refusal.closureOrder);
      return [id, { ...c, name: normalizeName(c.name) }];
    }),
  );
  const tuning = new Map(
    [...cal.tuning].map(([date, t]): [IsoDate, Tuning] => [date, t.kind === "add" ? { kind: "add", name: normalizeName(t.name) } : t]),
  );
  return { ...cal, closures, tuning };
};

const choiceHolding = (ctx: Ctx, id: ItemId): string => {
  const c = ctx.view.choices.find((x) => heldItems([x], ctx.view.plan).has(id));
  if (c === undefined) throw new Error(`Item ${id} is held by no open choice`);
  return c.id;
};

const linkOf = (plan: PlanState, k: string): Link => {
  const l = plan.links.get(k);
  if (l === undefined) throw new Error(`Link ${k} is not in this plan`);
  return l;
};

const removeLink = (ctx: Ctx, l: Link): Draft => ({
  own: [own(key.l(l.from, l.to), codec.link.enc(null))],
  roots: [],
  newNotes: [],
  ...plain(label.unlinked(nameOf(ctx, l.from), nameOf(ctx, l.to))),
});

const snapDraft = (ctx: Ctx, it: Item): Draft => {
  const cal = workCalendar(ctx.view.plan.calendar);
  const start = toIso(cal.snapF(toDay(datedStart(it))));
  return {
    own: [schedWrite(it.id, { ...scheduleOf(it), start })],
    roots: [it.id],
    newNotes: [],
    ...withPush(ctx, label.snapped(it.name, fmtShort(start))),
  };
};

const sameConflict = (a: Conflict, b: Conflict): boolean =>
  a.kind === "dayoff" ? b.kind === "dayoff" && a.item === b.item : b.kind !== "dayoff" && a.kind === b.kind && a.link === b.link;

const fixDraft = (ctx: Ctx, conflict: Conflict, how: "push" | "shorten" | "remove"): Draft => {
  const plan = ctx.view.plan;
  const current = ctx.view.derived.conflicts.find((c) => sameConflict(c, conflict));
  if (current === undefined) throw new Refused(refusal.fixed);
  if (current.kind === "loop") {
    if (how !== "remove") throw new Refused(refusal.loopFix);
    return removeLink(ctx, linkOf(plan, current.link));
  }
  if (current.kind === "dayoff") {
    if (how !== "push") throw new Error(`A day-off start is fixed by push, not ${how}`);
    const it = itemOf(plan, current.item);
    if (ctx.view.held.has(it.id)) throw new HeldRefused(refusal.heldFix(it.name), choiceHolding(ctx, it.id));
    return snapDraft(ctx, it);
  }
  const succ = itemOf(plan, current.succ);
  const l = linkOf(plan, current.link);
  if (current.succLock === "held") throw new HeldRefused(refusal.heldFix(succ.name), choiceHolding(ctx, succ.id));
  if (how === "remove") return removeLink(ctx, l);
  if (how === "push") {
    if (current.succLock === "done" || current.succLock === "doing") throw new Refused(refusal.lockedFix(succ.name, current.succLock));
    const start = toIso(current.need);
    return {
      own: [schedWrite(succ.id, { ...scheduleOf(succ), start })],
      roots: [succ.id],
      newNotes: [],
      ...withPush(ctx, label.earliest(succ.name, fmtShort(start))),
    };
  }
  const view = schedView(plan, ctx.view.held);
  const lag = lagThatHolds(linkEnd(view, l, l.to), l, linkEnd(view, l, l.from), view.cal);
  return {
    own: [own(key.l(l.from, l.to), codec.link.enc({ type: l.type, lag }))],
    roots: [],
    newNotes: [],
    ...plain(label.shortened(nameOf(ctx, l.from), nameOf(ctx, l.to), lag)),
  };
};

const scheduleDraft = (ctx: Ctx, id: ItemId, set: Partial<Schedule>): Draft => {
  const plan = ctx.view.plan;
  const it = live(plan, id);
  const sc = scheduleOf(it);
  if (set.dur !== undefined) checkDur(it, set.dur);
  if (set.progress !== undefined && (!Number.isInteger(set.progress) || set.progress < 0 || set.progress > 100)) {
    throw new Refused(refusal.progress);
  }
  if (set.status !== undefined && it.kind === "milestone" && hasPredecessor(plan, it.id)) throw new Refused(refusal.milestoneStatus(it.name));
  const status = set.status ?? sc.status;
  if (status === "done" && set.progress !== undefined && set.progress !== 100) {
    throw new Refused(set.status === "done" ? refusal.doneProgress : refusal.doneSetProgress(it.name));
  }
  const cal = workCalendar(plan.calendar);
  const start = set.start === undefined ? sc.start : set.start === null ? null : toIso(cal.snapF(toDay(set.start)));
  const next: Schedule = {
    start,
    dur: set.dur ?? sc.dur,
    status,
    progress: set.progress ?? (status === "done" ? 100 : sc.progress),
    horizon: set.horizon ?? sc.horizon,
  };
  const fields = (Object.keys(set) as (keyof Schedule)[]).filter((k) => set[k] !== undefined);
  const one = (d: Derivation): string => {
    switch (fields[0]) {
      case "start": {
        const stored = storedStart(d, it.id);
        return stored === null ? label.unscheduled(it.name) : label.scheduled(it.name, fmtShort(stored));
      }
      case "dur":
        return label.resized(it.name, next.dur);
      case "status":
        return label.marked(it.name, next.status);
      case "progress":
        return label.progress(it.name, next.progress);
      case "horizon":
        return label.horizon(it.name, next.horizon);
    }
  };
  const moves = next.start !== null && (next.start !== sc.start || next.dur !== sc.dur);
  return {
    own: [schedWrite(it.id, next)],
    roots: moves ? [it.id] : [],
    newNotes: [],
    ownStarts: start === null || set.start === undefined ? [] : [key.s(it.id)],
    label: (d) => (fields.length === 1 ? one(d) : label.changed(it.name)) + pushed(ctx, d),
    sentences: [],
  };
};

const draftOf = (ctx: Ctx, intent: Intent): Draft => {
  const plan = ctx.view.plan;
  const none = { roots: [], newNotes: [] } as const;
  switch (intent.t) {
    case "create": {
      const name = normalizeName(intent.name);
      if (intent.parent !== null && live(plan, intent.parent).kind !== "group") throw new Error(`Item ${intent.parent} is not a group`);
      const id = newId();
      const placed = own(key.p(id), codec.place.enc({ parent: intent.parent, order: orderAfter(plan, intent.parent, intent.after, null) }));
      const base = [own(key.e(id), codec.existence.enc({ k: intent.kind, t: false })), own(key.n(id), codec.name.enc(name)), placed];
      const text = label.added(intent.kind, name);
      if (intent.kind === "group") {
        if (intent.start !== null || intent.dur !== undefined) throw new Error("A group has no start or duration");
        return { own: base, roots: [], newNotes: [id], ...plain(text) };
      }
      const dur = intent.kind === "milestone" ? (intent.dur ?? 0) : (intent.dur ?? 3);
      if (intent.kind === "milestone" && dur !== 0) throw new Refused(refusal.milestoneDur);
      if (intent.kind === "task" && (!Number.isInteger(dur) || dur < 1)) throw new Refused(refusal.taskDur);
      const cal = workCalendar(plan.calendar);
      const start = intent.start === null ? null : toIso(cal.snapF(toDay(intent.start)));
      return {
        own: [...base, schedWrite(id, { start, dur, status: "todo", progress: 0, horizon: "later" })],
        roots: [],
        newNotes: [id],
        ownStarts: start === null ? [] : [key.s(id)],
        ...plain(text),
      };
    }
    case "rename": {
      const it = live(plan, intent.item);
      const name = normalizeName(intent.name);
      return { own: [own(key.n(it.id), codec.name.enc(name))], ...none, ...plain(label.renamed(it.name, name)) };
    }
    case "planName": {
      const name = normalizeName(intent.name);
      return { own: [own(key.pn, codec.name.enc(name))], ...none, ...plain(label.planRenamed(name)) };
    }
    case "schedule":
      return scheduleDraft(ctx, intent.item, intent.set);
    case "move": {
      if (!Number.isInteger(intent.days)) throw new Error(`A move is in whole working days, not ${intent.days}`);
      const moved = unique(
        intent.items.flatMap((id) => {
          const it = live(plan, id);
          if (it.kind === "group") {
            return untrashedDescendants(plan, it.id)
              .filter((d) => d.kind !== "group" && scheduleOf(d).start !== null)
              .map((d) => d.id);
          }
          datedStart(it);
          return [it.id];
        }),
      );
      const cal = workCalendar(plan.calendar);
      const writes = moved.map((id) => {
        const sc = scheduleOf(itemOf(plan, id));
        const from = sc.start;
        if (from === null) throw new Error(`Moved item ${id} has no start`);
        const start = intent.days === 0 ? from : toIso(cal.addWork(cal.snapF(toDay(from)), intent.days));
        return schedWrite(id, { ...sc, start });
      });
      const what = intent.items.length === 1 ? q(itemOf(plan, intent.items[0]).name) : items(moved.length);
      return { own: writes, roots: moved, newNotes: [], ...withPush(ctx, label.moved(what, intent.days)) };
    }
    case "resize": {
      const it = live(plan, intent.item);
      if (it.kind === "milestone") throw new Refused(refusal.milestoneDur);
      datedStart(it);
      checkDur(it, intent.dur);
      return {
        own: [schedWrite(it.id, { ...scheduleOf(it), dur: intent.dur })],
        roots: [it.id],
        newNotes: [],
        ...withPush(ctx, label.resized(it.name, intent.dur)),
      };
    }
    case "place": {
      const it = live(plan, intent.item);
      if (intent.parent !== null) {
        const p = itemOf(plan, intent.parent);
        if (p.kind !== "group") throw new Error(`Item ${p.id} is not a group`);
        if (isInside(plan, p.id, it.id)) throw new Refused(refusal.selfParent);
        live(plan, p.id);
      }
      const sibs = childrenOf(plan, it.place.parent);
      const at = sibs.findIndex((s) => s.id === it.id);
      const prev = at > 0 ? sibs[at - 1].id : null;
      const stays = intent.parent === it.place.parent && prev === intent.after;
      const order = stays ? it.place.order : orderAfter(plan, intent.parent, intent.after, it.id);
      const text =
        intent.parent === it.place.parent
          ? label.reordered(it.name)
          : intent.parent === null
            ? label.top(it.name)
            : label.into(it.name, itemOf(plan, intent.parent).name);
      return { own: [own(key.p(it.id), codec.place.enc({ parent: intent.parent, order }))], ...none, ...plain(text) };
    }
    case "trash":
    case "restore": {
      const ids = unique(intent.items);
      const trash = intent.t === "trash";
      const writes = ids.map((id) => {
        const it = notInsideTrash(plan, itemOf(plan, id));
        return own(key.e(it.id), codec.existence.enc({ k: it.kind, t: trash }));
      });
      const what = ids.length === 1 ? q(itemOf(plan, ids[0]).name) : items(ids.length);
      return {
        own: writes,
        ...none,
        ...(trash ? plain(label.trashed(what), [ids.length === 1 ? sentence.trashUndo : sentence.trashUndoMany]) : plain(label.restored(what))),
      };
    }
    case "link": {
      if (intent.from === intent.to) throw new Refused(refusal.self);
      const f = itemOf(plan, intent.from);
      const t = itemOf(plan, intent.to);
      if (f.kind === "group" || t.kind === "group") throw new Refused(refusal.groupLink);
      live(plan, f.id);
      live(plan, t.id);
      if (!Number.isInteger(intent.lag)) throw new Error(`A lag is in whole working days, not ${intent.lag}`);
      const candidate: Link = { from: f.id, to: t.id, type: intent.type, lag: intent.lag };
      const loop = wouldLoop(liveLinks(plan), candidate);
      if (loop !== null) throw new Refused(refusal.loop(loop.map((id) => nameOf(ctx, id))));
      const text = plan.links.has(linkKey(f.id, t.id)) ? label.linkChanged(f.name, t.name) : label.linked(f.name, t.name, intent.type);
      return {
        own: [own(key.l(f.id, t.id), codec.link.enc({ type: intent.type, lag: intent.lag }))],
        roots: [f.id],
        newNotes: [],
        ...withPush(ctx, text),
      };
    }
    case "unlink":
      return removeLink(ctx, linkOf(plan, intent.link));
    case "calendar": {
      const next = calendarUnits(checkedCalendar(intent.next));
      const base = calendarUnits(intent.base ?? plan.calendar);
      const writes = unique([...next.keys(), ...base.keys()])
        .filter((u) => !planRules.same(u, next.get(u) ?? null, base.get(u) ?? null))
        .map((u) => own(u, next.get(u) ?? null));
      return {
        own: writes,
        ...none,
        label: (_d, p) => label.calendar(p.endsChanged, p.movedLater),
        sentences: [sentence.calendarUndo],
      };
    }
    case "snap": {
      const it = live(plan, intent.item);
      scheduleOf(it);
      return snapDraft(ctx, it);
    }
    case "fix":
      return fixDraft(ctx, intent.conflict, intent.how);
    case "baseline": {
      if (intent.op === "save") {
        const name = normalizeName(intent.name);
        const dates = Object.fromEntries(
          [...schedView(plan, new Set()).items.values()].map((s) => [s.id, { start: toIso(s.start), dur: s.dur }]),
        );
        return {
          own: [own(key.b(newId()), codec.baseline.enc({ name, at: ctx.view.today, dates }))],
          ...none,
          ...plain(label.baselineSaved(name)),
        };
      }
      const b = plan.baselines.get(intent.id);
      if (b === undefined) throw new Error(`Baseline ${intent.id} is not in this plan`);
      if (intent.op === "remove") return { own: [own(key.b(b.id), codec.baseline.enc(null))], ...none, ...plain(label.baselineRemoved(b.name)) };
      const name = normalizeName(intent.name);
      return {
        own: [own(key.b(b.id), codec.baseline.enc({ name, at: b.at, dates: b.dates }))],
        ...none,
        ...plain(label.baselineRenamed(b.name, name)),
      };
    }
  }
};

const isCalendarWrite = (x: Write): boolean => CALENDAR_UNITS.has(parseKey(x.u).kind);

const newHolidayYears = (ctx: Ctx, ownWrites: readonly Write[], writes: readonly Write[]): Write[] => {
  const plan = ctx.view.plan;
  const after = applyWrites(plan, writes);
  const region = after.calendar.region;
  if (region === null) return [];
  const before = new Set(derive(applyWrites(plan, ownWrites.filter(isCalendarWrite)), ctx.view.held, ctx.view.today).missingYears);
  return derive(after, ctx.view.held, ctx.view.today)
    .missingYears.filter((y) => !before.has(y) && !ownWrites.some((x) => x.u === key.ch(y)))
    .flatMap((y) => {
      const cached = ctx.cachedHolidays(regionKey(region), y);
      return cached === null ? [] : [own(key.ch(y), codec.holidayYear.enc(cached))];
    });
};

const mergedDerived = (ws: readonly Write[]): Map<UnitKey, Write> =>
  ws.reduce((m, x) => {
    const earlier = m.get(x.u);
    return m.set(x.u, earlier === undefined ? x : planRules.mergeDerived(x.u, earlier, x));
  }, new Map<UnitKey, Write>());

export function withDerived(ctx: Ctx, ownWrites: readonly Write[], roots: readonly ItemId[], held: ReadonlySet<ItemId>): Derivation {
  const plan = ctx.view.plan;
  const after = applyWrites(plan, ownWrites);
  const ownUnits = new Map(ownWrites.map((x): [UnitKey, Write] => [x.u, x]));
  const recal = ownWrites.some(isCalendarWrite) ? recalendar(schedView(plan, held), workCalendar(after.calendar)) : null;
  const pushResult = roots.length > 0 ? push(schedView(after, held), roots) : null;
  const derivedWrite = (id: ItemId, start: Day | undefined, dur: number | undefined, c: Write["c"]): Write => {
    const u = key.s(id);
    const sc = scheduleOf(itemOf(after, id));
    if (sc.start === null) {
      throw new Error(ownUnits.has(u) ? `Derived write to ${u}, which this action unschedules` : `Derived write to unscheduled ${id}`);
    }
    return { u, v: codec.sched.enc({ ...sc, start: start === undefined ? sc.start : toIso(start), dur: dur ?? sc.dur }), c };
  };
  const recalWrites: Write[] =
    recal === null
      ? []
      : [
          ...[...recal.starts].map(([id, start]) => derivedWrite(id, start, recal.durs.get(id), "recalendar")),
          ...[...recal.durs].filter(([id]) => !recal.starts.has(id)).map(([id, dur]) => derivedWrite(id, undefined, dur, "recalendar")),
          ...[...recal.pushed.moves].map(([id, start]) => derivedWrite(id, start, recal.durs.get(id), "push")),
        ];
  const pushWrites = pushResult === null ? [] : [...pushResult.moves].map(([id, start]) => derivedWrite(id, start, undefined, "push"));
  const pushedOwn = new Map(pushWrites.filter((x) => ownUnits.has(x.u)).map((x): [UnitKey, Write] => [x.u, x]));
  const merged = ownWrites.map((o) => {
    const p = pushedOwn.get(o.u);
    return p === undefined ? o : { u: o.u, v: p.v, c: o.c };
  });
  const derived = mergedDerived([...recalWrites, ...pushWrites].filter((x) => !ownUnits.has(x.u)));
  return { writes: [...merged, ...derived.values()], push: pushResult, recal };
}

const sameStop = (a: Stop, b: Stop): boolean => a.id === b.id && a.reason === b.reason;

const recalStopsCaused = (ctx: Ctx, recal: RecalResult): Stop[] => {
  const unchanged = recalendar(schedView(ctx.view.plan, ctx.view.held), workCalendar(ctx.view.plan.calendar)).pushed.stopped;
  return recal.pushed.stopped.filter((s) => !unchanged.some((u) => sameStop(s, u)));
};

const itemState = (plan: PlanState, dv: Derived, id: ItemId): string => {
  const it = plan.items.get(id);
  if (it === undefined) return "absent";
  return JSON.stringify([!it.trashed, dv.start.get(id) ?? null, dv.end.get(id) ?? null, dv.status.get(id) ?? null, it.name, it.place.parent, it.place.order]);
};

export function previewOf(ctx: Ctx, after: PlanState, d: { push: PushResult | null; recal: RecalResult | null }, kept: readonly string[]): Preview {
  const beforePlan = ctx.view.plan;
  const before = ctx.view.derived;
  const next = derive(after, ctx.view.held, ctx.view.today);
  const ids = unique([...beforePlan.items.values(), ...after.items.values()].filter((i) => i.kind !== "group").map((i) => i.id));
  return {
    itemsChanged: ids.filter((id) => itemState(beforePlan, before, id) !== itemState(after, next, id)).length,
    endsChanged: ids.filter((id) => before.end.get(id) !== next.end.get(id)).length,
    movedLater: (d.push?.moves.size ?? 0) + (d.recal?.movedLater ?? 0),
    stopped: [...(d.push?.stopped ?? []), ...(d.recal === null ? [] : recalStopsCaused(ctx, d.recal))],
    conflictsAfter: next.conflicts.length,
    kept,
  };
}

export function buildAction(ctx: Ctx, intent: Intent): Built {
  const plan = ctx.view.plan;
  const draft = draftOf(ctx, intent);
  if (draft.own.every((x) => sameAsCurrent(ctx, x))) throw new Refused(refusal.nothing);
  const years = newHolidayYears(ctx, draft.own, withDerived(ctx, draft.own, draft.roots, ctx.view.held).writes);
  const cal = workCalendar(applyWrites(plan, [...draft.own.filter(isCalendarWrite), ...years]).calendar);
  const starts = new Set(draft.ownStarts ?? []);
  const snapped = draft.own.map((x) => (starts.has(x.u) ? resnapped(x, cal) : x));
  const d = withDerived(ctx, [...snapped, ...years], draft.roots, ctx.view.held);
  const preview = previewOf(ctx, applyWrites(plan, d.writes), d, []);
  const lbl = draft.label(d, preview);
  const action: Action = { id: newId(), dev: ctx.dev, ses: ctx.ses, at: ctx.now, par: [...ctx.log.heads], lbl, w: d.writes };
  return { action, newNotes: draft.newNotes, toast: toastOf(lbl, draft.sentences), preview };
}

export function initialAction(a: { dev: DeviceId; ses: SessionId; now: number; name: string; calendar: Calendar }): Action {
  const name = normalizeName(a.name);
  const w = [own(key.pn, codec.name.enc(name)), ...[...calendarUnits(checkedCalendar(a.calendar))].map(([u, v]) => own(u, v))];
  w.forEach(validateWrite);
  return { id: newId(), dev: a.dev, ses: a.ses, at: a.now, par: [], lbl: label.created(name), w };
}
