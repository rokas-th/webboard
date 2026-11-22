import { goneSet } from "../domain/derive";
import { STEP_COLOURS, type Item, type ItemId, type ItemKind, type PlanState, type Schedule, type StepColour, type StepId, type StepValue } from "../domain/model";
import { MAX_STEP_LIMIT, MAX_STEP_NAME, stepModeOf, stepNameKey, stepsOf, storedStepOf, type Step } from "../domain/steps";
import { newId } from "../log/ids";
import type { Write } from "../log/types";
import { applyWrites } from "../plan/project";
import type { PlanView } from "../store/doc";
import { planRules } from "../plan/rules";
import * as codec from "../plan/units";
import { key } from "../plan/units";
import { items, label, q, refusal, sentence } from "./copy";
import { Refused, type Ctx, type StepIntent, type ToStepIntent } from "./intents";
import { hasPredecessor, live } from "./lookup";
import { normalizeName } from "./names";
import { slotAfter, type Keyed } from "./slot";

export interface StepDraft {
  own: readonly Write[];
  label: string;
  sentences: readonly string[];
}

const own = (u: string, v: unknown): Write => ({ u, v, c: "own" });

const valueOfStep = (s: Step): StepValue => ({
  n: s.name,
  c: s.colour,
  o: s.order,
  ...(s.completes ? { d: true } : {}),
  ...(s.limit === null ? {} : { l: s.limit }),
});

const stepWrite = (s: Step): Write => own(key.ws(s.id), codec.step.enc(valueOfStep(s)));

const refWrite = (item: ItemId, step: StepId | null): Write => own(key.wi(item), codec.stepRef.enc(step));

const schedWrite = (item: ItemId, s: Schedule): Write => own(key.s(item), codec.sched.enc(s));

const missingStep = (id: StepId | null): Error => new Error(`Step ${id} is not in this plan`);

const liveStep = (plan: PlanState, id: StepId): Step => {
  const s = stepsOf(plan).find((x) => x.id === id);
  if (s === undefined) throw missingStep(id);
  return s;
};

const checkColour = (colour: StepColour): StepColour => {
  if (!STEP_COLOURS.includes(colour)) throw new Error(`Step colour ${colour} is not one of ${STEP_COLOURS.join(", ")}`);
  return colour;
};

const checkName = (plan: PlanState, raw: string, self: StepId | null): string => {
  const name = normalizeName(raw);
  if ([...name].length > MAX_STEP_NAME) throw new Refused(refusal.stepNameLong);
  const taken = stepsOf(plan).find((s) => s.id !== self && stepNameKey(s.name) === stepNameKey(name));
  if (taken !== undefined) throw new Refused(refusal.stepNameTaken(taken.name));
  return name;
};

const changed = (before: Step, after: Step): Write => {
  const w = stepWrite(after);
  if (planRules.same(w.u, w.v, codec.step.enc(valueOfStep(before)))) throw new Refused(refusal.nothing);
  return w;
};

const keyed = (steps: readonly Step[]): Keyed[] => steps.map((s) => ({ id: s.id, order: s.order }));

const rekeyedWrites = (plan: PlanState, rekeyed: readonly Keyed[]): Write[] => rekeyed.map((r) => stepWrite({ ...liveStep(plan, r.id), order: r.order }));

const scheduleOf = (it: Item): Schedule => {
  if (it.schedule === null) throw new Error(`Group ${it.id} has no step`);
  return it.schedule;
};

const statusIn = (view: PlanView, id: ItemId) => {
  const s = view.derived.status.get(id);
  if (s === undefined) throw new Error(`Item ${id} has no status`);
  return s;
};

const statusOf = (ctx: Ctx, id: ItemId) => statusIn(ctx.view, id);

export function switchWritesOf(view: PlanView): readonly Write[] {
  const plan = view.plan;
  if (stepModeOf(plan) === "steps") return [];
  const gone = goneSet(plan);
  return [...plan.items.values()]
    .filter((i) => i.kind !== "group" && !gone.has(i.id) && i.schedule !== null && i.schedule.start !== null && statusIn(view, i.id) !== "done")
    .map((i) => {
      const h = view.derived.horizon.get(i.id);
      if (h === undefined) throw new Error(`Item ${i.id} has no horizon`);
      return refWrite(i.id, h);
    });
}

export const switchWrites = (ctx: Ctx): readonly Write[] => switchWritesOf(ctx.view);

export function switched(ctx: Ctx, d: StepDraft): StepDraft {
  if (stepModeOf(ctx.view.plan) === "steps") return d;
  const edited = new Set(d.own.map((x) => x.u));
  return { own: [...switchWrites(ctx).filter((x) => !edited.has(x.u)), ...d.own], label: d.label, sentences: [...d.sentences, sentence.switched] };
}

const switchedPlanOf = (view: PlanView): PlanState => {
  const sw = switchWritesOf(view);
  return sw.length === 0 ? view.plan : applyWrites(view.plan, sw);
};

const switchedPlan = (ctx: Ctx): PlanState => switchedPlanOf(ctx.view);

const plain = (own: readonly Write[], text: string): StepDraft => ({ own, label: text, sentences: [] });

const heldBy = (base: PlanState, id: StepId): Item[] => [...base.items.values()].filter((i) => i.kind !== "group" && storedStepOf(base, i) === id);

const openOf = (view: PlanView, base: PlanState, held: readonly Item[]): Item[] => {
  const gone = goneSet(base);
  return held.filter((i) => !gone.has(i.id) && statusIn(view, i.id) !== "done");
};

const openIn = (ctx: Ctx, base: PlanState, held: readonly Item[]): Item[] => openOf(ctx.view, base, held);

export interface StepHolding {
  held: number;
  hidden: number;
}

export function stepHolding(view: PlanView, step: StepId): StepHolding {
  const s = liveStep(view.plan, step);
  const base = switchedPlanOf(view);
  const held = heldBy(base, s.id);
  return { held: held.length, hidden: held.length - openOf(view, base, held).length };
}

const statusMayChange = (plan: PlanState, it: Item): void => {
  if (it.kind === "milestone" && hasPredecessor(plan, it.id)) throw new Refused(refusal.milestoneStatus(it.name));
};

const doneWrite = (plan: PlanState, it: Item): Write => {
  statusMayChange(plan, it);
  return schedWrite(it.id, { ...scheduleOf(it), status: "done", progress: 100 });
};

const completingOf = (plan: PlanState): Step | null => stepsOf(plan).find((s) => s.completes) ?? null;

const editDraft = (ctx: Ctx, intent: StepIntent): StepDraft => {
  const plan = ctx.view.plan;
  switch (intent.op) {
    case "add": {
      const colour = checkColour(intent.colour);
      const name = checkName(plan, intent.name, null);
      const slot = slotAfter(keyed(stepsOf(plan)), intent.after, () => missingStep(intent.after));
      const added: StepValue = { n: name, c: colour, o: slot.order };
      return plain([own(key.ws(newId()), codec.step.enc(added)), ...rekeyedWrites(plan, slot.rekeyed)], label.stepAdded(name));
    }
    case "rename": {
      const s = liveStep(plan, intent.step);
      const name = checkName(plan, intent.name, s.id);
      return plain([changed(s, { ...s, name })], label.stepRenamed(s.name, name));
    }
    case "colour": {
      const s = liveStep(plan, intent.step);
      const colour = checkColour(intent.colour);
      return plain([changed(s, { ...s, colour })], label.stepColoured(s.name, colour));
    }
    case "limit": {
      const s = liveStep(plan, intent.step);
      if (intent.limit !== null && (!Number.isInteger(intent.limit) || intent.limit < 1 || intent.limit > MAX_STEP_LIMIT)) throw new Refused(refusal.stepLimit);
      return plain([changed(s, { ...s, limit: intent.limit })], label.stepLimit(s.name, intent.limit));
    }
    case "reorder": {
      const s = liveStep(plan, intent.step);
      const all = stepsOf(plan);
      const at = all.findIndex((x) => x.id === s.id);
      const prev = at === 0 ? null : all[at - 1].id;
      if (intent.after === s.id) throw new Error(`Step ${s.id} cannot follow itself`);
      if (prev === intent.after) throw new Refused(refusal.nothing);
      const slot = slotAfter(
        keyed(all.filter((x) => x.id !== s.id)),
        intent.after,
        () => missingStep(intent.after),
      );
      return plain([stepWrite({ ...s, order: slot.order }), ...rekeyedWrites(plan, slot.rekeyed)], label.stepReordered(s.name));
    }
    case "completes": {
      const s = liveStep(plan, intent.step);
      const others = intent.completes ? stepsOf(plan).filter((x) => x.id !== s.id && x.completes) : [];
      const writes = [...(s.completes === intent.completes ? [] : [stepWrite({ ...s, completes: intent.completes })]), ...others.map((x) => stepWrite({ ...x, completes: false }))];
      if (writes.length === 0) throw new Refused(refusal.nothing);
      if (intent.completes && !s.completes) {
        if (stepsOf(plan).length === 1) throw new Refused(refusal.lastOpenStep);
        const base = switchedPlan(ctx);
        const open = openIn(ctx, base, heldBy(base, s.id));
        if (open.length > 0) throw new Refused(refusal.stepHoldsOpen(s.name, open.length));
      }
      return plain(writes, label.stepCompletes(s.name, intent.completes));
    }
    case "noneCompletes": {
      const completing = stepsOf(plan).filter((x) => x.completes);
      if (completing.length === 0) throw new Refused(refusal.nothing);
      return plain(
        completing.map((x) => stepWrite({ ...x, completes: false })),
        label.noneCompletes(completing.map((x) => x.name)),
      );
    }
    case "delete": {
      const s = liveStep(plan, intent.step);
      const rest = stepsOf(plan).filter((x) => x.id !== s.id);
      if (rest.length === 0) throw new Refused(refusal.lastStep);
      if (rest.every((x) => x.completes)) throw new Refused(refusal.lastOpenStep);
      if (intent.to === s.id) throw new Error(`Step ${s.id} cannot take its own items`);
      const to = intent.to === null ? null : liveStep(plan, intent.to);
      const base = switchedPlan(ctx);
      const held = heldBy(base, s.id);
      const open = openIn(ctx, base, held);
      if (to === null && held.length > 0) throw new Refused(refusal.stepNotEmpty(s.name, held.length, held.length - open.length));
      const intoCompleting = to !== null && to.completes;
      const finished = intoCompleting ? open.map((i) => doneWrite(plan, i)) : [];
      const moves = to === null ? [] : held.map((i) => refWrite(i.id, to.id));
      return plain([own(key.ws(s.id), codec.step.enc(null)), ...moves, ...finished], label.stepDeleted(s.name, moves.length, to === null ? null : to.name));
    }
  }
};

const toStepDraft = (ctx: Ctx, intent: ToStepIntent): StepDraft => {
  const plan = ctx.view.plan;
  const target = liveStep(plan, intent.step);
  const completing = completingOf(plan);
  const into = completing !== null && completing.id === target.id;
  const base = switchedPlan(ctx);
  const moved = [...new Set(intent.items)].map((id): { item: Item; writes: Write[] } => {
    const it = live(plan, id);
    const sc = scheduleOf(it);
    const done = statusOf(ctx, it.id) === "done";
    if (into) return { item: it, writes: done ? [] : [doneWrite(plan, it)] };
    if (done) {
      statusMayChange(plan, it);
      return { item: it, writes: [schedWrite(it.id, { ...sc, status: "todo", progress: sc.progress === 100 ? 0 : sc.progress }), refWrite(it.id, target.id)] };
    }
    return { item: it, writes: storedStepOf(base, it) === target.id ? [] : [refWrite(it.id, target.id)] };
  });
  const changedItems = moved.filter((m) => m.writes.length > 0).map((m) => m.item);
  if (changedItems.length === 0) throw new Refused(refusal.nothing);
  const what = changedItems.length === 1 ? q(changedItems[0].name) : items(changedItems.length);
  return plain(moved.flatMap((m) => m.writes), label.toStep(what, target.name));
};

export function stepDraft(ctx: Ctx, intent: StepIntent | ToStepIntent): StepDraft {
  return switched(ctx, intent.t === "toStep" ? toStepDraft(ctx, intent) : editDraft(ctx, intent));
}

export interface CreateStep {
  own: readonly Write[];
  done: boolean;
}

export function createStepWrites(ctx: Ctx, id: ItemId, kind: ItemKind, step: StepId | undefined): CreateStep {
  const plan = ctx.view.plan;
  if (kind === "group") {
    if (step !== undefined) throw new Error("A group has no step");
    return { own: [], done: false };
  }
  if (step !== undefined) {
    const s = liveStep(plan, step);
    const completing = completingOf(plan);
    return { own: [refWrite(id, s.id)], done: completing !== null && completing.id === s.id };
  }
  if (stepModeOf(plan) === "dates") return { own: [], done: false };
  const first = stepsOf(plan).find((s) => !s.completes);
  if (first === undefined) throw new Refused(refusal.noOpenStep);
  return { own: [refWrite(id, first.id)], done: false };
}

export function duplicateStepWrites(plan: PlanState, copies: readonly (readonly [from: ItemId, to: ItemId])[]): readonly Write[] {
  return copies.flatMap(([from, to]) => {
    const stored = plan.workflow.items.get(from);
    return stored === undefined ? [] : [refWrite(to, stored)];
  });
}
