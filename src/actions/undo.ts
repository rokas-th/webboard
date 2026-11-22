import type { ItemId, PlanState } from "../domain/model";
import { newId } from "../log/ids";
import type { LogState } from "../log/state";
import type { Action, ActionId, UnitKey, Write } from "../log/types";
import { projectPlan } from "../plan/project";
import { decodeAs, key, parseKey, type UnitKind } from "../plan/units";
import { previewOf } from "./build";
import { deviceName, linkText, q, toastOf } from "./copy";
import { Refused, type Built, type Ctx } from "./intents";
import { baselineName, personNameIn, stepNameIn } from "./names";

export interface Offer {
  choice: string;
  side: string;
}

export class OfferRefused extends Refused {
  readonly offer: Offer;

  constructor(offer: Offer) {
    super("This change is one side of an open choice. Keep the other version to undo it.");
    this.name = "OfferRefused";
    this.offer = offer;
  }
}

const ITEM_KINDS: ReadonlySet<UnitKind> = new Set<UnitKind>(["e", "n", "s", "p", "r", "wi", "pa"]);
const CALENDAR_KINDS: ReadonlySet<UnitKind> = new Set<UnitKind>(["cr", "cw", "cc", "ct", "ch"]);
const ORPHAN_UNITS = [key.n, key.s, key.p] as const;

const targetOf = (ctx: Ctx, target: ActionId, what: "undone" | "reverted"): Action => {
  const a = ctx.log.get(target);
  if (a === undefined) throw new Error(`Action ${target} is not in this plan`);
  if (a.par.length === 0) throw new Refused(`The action that created this plan cannot be ${what}.`);
  return a;
};

const isHistoryAction = (a: Action): boolean =>
  a.meta?.undo !== undefined || a.meta?.redo !== undefined || a.meta?.revert !== undefined;

const frontierHolds = (log: LogState, u: UnitKey, id: ActionId): boolean => log.frontier(u).includes(id);

const nameOf = (log: LogState, plans: readonly PlanState[], id: ItemId): string => {
  const found = plans.map((p) => p.items.get(id)).find((it) => it !== undefined);
  if (found !== undefined) return found.name;
  const u = key.n(id);
  const ws = log.writers(u);
  if (ws.length === 0) throw new Error(`No item ${id}`);
  const last = ws[ws.length - 1];
  const x = log.get(last)?.w.find((y) => y.u === u);
  if (x === undefined) throw new Error(`Action ${last} holds no write to ${u}`);
  return decodeAs("name", u, x.v);
};

interface Subject {
  id: string;
  item: ItemId | null;
  text: string;
}

const subjectOf = (log: LogState, plans: readonly PlanState[], w: Write): Subject => {
  const k = parseKey(w.u);
  if (ITEM_KINDS.has(k.kind)) return { id: "i:" + k.arg, item: k.arg, text: q(nameOf(log, plans, k.arg)) };
  if (CALENDAR_KINDS.has(k.kind)) return { id: "calendar", item: null, text: "The calendar" };
  if (k.kind === "pn") return { id: "pn", item: null, text: "The plan name" };
  if (k.kind === "l") {
    if (k.to === undefined) throw new Error(`Link ${w.u} has no successor`);
    return { id: w.u, item: null, text: `The link ${linkText(nameOf(log, plans, k.arg), nameOf(log, plans, k.to))}` };
  }
  if (k.kind === "b") return { id: w.u, item: null, text: `Baseline ${q(baselineName(log, plans, w.u, k.arg))}` };
  if (k.kind === "ws") {
    const step = stepNameIn(log, plans, w.u, k.arg);
    if (step === null) return { id: w.u, item: null, text: "A removed step" };
    return { id: w.u, item: null, text: step.removed ? `The removed step ${q(step.name)}` : `The step ${q(step.name)}` };
  }
  if (k.kind === "pp") {
    const person = personNameIn(log, plans, k.arg);
    if (person === null) return { id: w.u, item: null, text: "A removed person" };
    return { id: w.u, item: null, text: person.removed ? `The removed person ${q(person.name)}` : `The person ${q(person.name)}` };
  }
  throw new Error(`No subject for ${w.u}`);
};

const liveWriter = (log: LogState, u: UnitKey): Action => {
  const st = log.unit(u);
  if (st === undefined) throw new Error(`Unit ${u} has no live value`);
  const by = log.get(st.from);
  if (by === undefined) throw new Error(`Action ${st.from} is not ready`);
  return by;
};

const fromDevice = (ctx: Ctx, log: LogState, u: UnitKey): string => deviceName(ctx.devices, liveWriter(log, u).dev);

const placedBy = (ctx: Ctx, log: LogState, u: UnitKey): string => {
  const dev = liveWriter(log, u).dev;
  return dev === ctx.dev ? "" : ` on the ${deviceName(ctx.devices, dev)}`;
};

const trashedBy = (log: LogState, a: Action, item: ItemId): UnitKey | undefined => {
  if (!a.w.some((w) => w.u === key.e(item)) || log.unit(key.e(item)) !== undefined) return undefined;
  const u = ORPHAN_UNITS.map((f) => f(item)).find((x) => log.unit(x) !== undefined);
  if (u === undefined) throw new Error(`Item ${item} has no live unit after ${a.id}`);
  return u;
};

const keptLines = (ctx: Ctx, fork: LogState, after: PlanState, flipped: readonly ActionId[]): string[] => {
  const plans = [after, ctx.view.plan];
  const lines = new Map<string, string>();
  flipped.forEach((x) => {
    const a = fork.get(x);
    if (a === undefined) throw new Error(`Action ${x} is not ready`);
    const holder = fork.active(x) ? fork : ctx.log;
    a.w
      .filter((w) => parseKey(w.u).kind !== "a")
      .forEach((w) => {
        if (frontierHolds(holder, w.u, x)) return;
        const k = parseKey(w.u);
        if ((k.kind === "wi" || k.kind === "pa") && !after.items.has(k.arg)) return;
        const s = subjectOf(fork, plans, w);
        if (lines.has(s.id)) return;
        const orphan = s.item === null ? undefined : trashedBy(fork, a, s.item);
        lines.set(
          s.id,
          orphan === undefined
            ? `${s.text} was changed since on the ${fromDevice(ctx, fork, w.u)} — kept`
            : `${s.text} was changed since on the ${fromDevice(ctx, fork, orphan)} — moved to the Trash`,
        );
      });
  });
  const removed = new Set([...ctx.view.plan.items.keys()].filter((id) => !after.items.has(id)));
  [...after.items.values()]
    .filter((it) => !lines.has("i:" + it.id))
    .forEach((it) => {
      const u = key.p(it.id);
      const st = fork.unit(u);
      if (st === undefined) return;
      const parent = decodeAs("place", u, st.value).parent;
      if (parent === null || !removed.has(parent)) return;
      lines.set("i:" + it.id, `${q(it.name)} was placed inside it${placedBy(ctx, fork, u)} — moved to the top level`);
    });
  return [...lines.values()];
};

const built = (ctx: Ctx, w: readonly Write[], lbl: string, meta: NonNullable<Action["meta"]>): Built => {
  const action: Action = { id: newId(), dev: ctx.dev, ses: ctx.ses, at: ctx.now, par: [...ctx.log.heads], lbl, w, meta };
  const fork = ctx.log.fork();
  const delta = fork.add([action]);
  if (delta.refused.length > 0) throw new Error(delta.refused.map((r) => r.message).join("; "));
  const after = projectPlan(ctx.view.plan.id, fork);
  const flipped = fork.order().filter((id) => delta.activity.has(id));
  const kept = keptLines(ctx, fork, after, flipped);
  return { action, newNotes: [], toast: toastOf(lbl, kept.map((k) => k + ".")), preview: previewOf(ctx, after, { push: null, recal: null }, kept) };
};

const baseOf = (log: LogState, a: Action): Action => {
  const next = a.meta?.undo ?? a.meta?.redo ?? a.meta?.revert;
  if (next === undefined) return a;
  const b = log.get(next);
  if (b === undefined) throw new Error(`Action ${next} is not in this plan`);
  return baseOf(log, b);
};

const historyLabel = (log: LogState, target: Action, w: readonly Write[]): string => {
  const base = baseOf(log, target);
  return w.some((x) => x.u === key.a(base.id) && x.v === true) ? "Redid: " + base.lbl : "Undid: " + target.lbl;
};

const historyWrites = (log: LogState, a: Action): Write[] => {
  const stray = a.w.find((x) => parseKey(x.u).kind !== "a");
  if (a.w.length === 0 || stray !== undefined) {
    throw new Error(`History action ${a.id} writes ${stray?.u ?? "nothing"}; expected only a: units`);
  }
  return a.w.map((x): Write => ({ u: x.u, v: log.valueWithout(x.u, new Set([a.id]))?.value ?? true, c: "undo" }));
};

export function undoChanges(log: LogState, target: ActionId): boolean {
  const a = log.get(target);
  if (a === undefined) throw new Error(`Action ${target} is not in this plan`);
  if (!log.active(target)) throw new Error(`Action ${target} is already undone`);
  return !isHistoryAction(a) || historyWrites(log, a).some((x) => (log.unit(x.u)?.value ?? true) !== x.v);
}

export function buildUndo(ctx: Ctx, target: ActionId): Built {
  const a = targetOf(ctx, target, "undone");
  if (!ctx.log.active(target)) throw new Error(`Action ${target} is already undone`);
  if (!isHistoryAction(a)) return built(ctx, [{ u: key.a(target), v: false, c: "undo" }], "Undid: " + a.lbl, { undo: target });
  const w = historyWrites(ctx.log, a);
  return built(ctx, w, historyLabel(ctx.log, a, w), { redo: target });
}

export function buildRevert(ctx: Ctx, target: ActionId): Built {
  const a = targetOf(ctx, target, "reverted");
  const active = ctx.log.active(target);
  return built(ctx, [{ u: key.a(target), v: !active, c: "revert" }], (active ? "Reverted: " : "Brought back: ") + a.lbl, { revert: target });
}

export function undoOffer(ctx: Ctx, target: ActionId): Offer | null {
  const choice = ctx.view.choices.find((c) => c.sides.some((s) => s.actions.includes(target)));
  if (choice === undefined) return null;
  const other = choice.sides.find((s) => !s.actions.includes(target));
  if (other === undefined) throw new Error(`Choice ${choice.id} has no side without ${target}`);
  return { choice: choice.id, side: other.key };
}
