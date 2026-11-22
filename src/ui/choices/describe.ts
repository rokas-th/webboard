import { q, workingDays } from "../../actions/copy";
import { regionKey } from "../../domain/calendar";
import { fmtShort } from "../../domain/dates";
import type { ItemId, PlanState, StepId } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { stepsOf, type Step } from "../../domain/steps";
import type { ActionId, UnitKey } from "../../log/types";
import { choiceOf, heldItems, type Choice } from "../../plan/choices";
import { decodeAs, key, parseKey } from "../../plan/units";
import type { PlanView } from "../../store/doc";
import { planGroupPath } from "../list/groups";
import { regionText, weekdaysText } from "../panel/calendarText";
import { orderedSides } from "./order";

const nameOf = (plan: PlanState, id: ItemId): string => {
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`No item ${id}`);
  return it.name;
};

const signed = (n: number): string => (n < 0 ? `−${-n}` : `+${n}`);

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const andList = (parts: readonly string[]): string => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

const STATUS_TAIL: Readonly<Record<"todo" | "doing" | "done", string>> = { todo: "", doing: " · in progress", done: " · done" };

function closureText(from: string, to: string, name: string): string {
  const span =
    from === to
      ? fmtShort(from)
      : from.slice(0, 7) === to.slice(0, 7)
        ? `${Number(from.slice(8, 10))}–${fmtShort(to)}`
        : `${fmtShort(from)}–${fmtShort(to)}`;
  return `closure ${span} ${q(name)}`;
}

function sourceText(region: string, plan: PlanState): string {
  if (region.startsWith("oh:")) return "OpenHolidays";
  if (region.startsWith("govuk:")) return "GOV.UK";
  if (region === "opm") return "US OPM";
  if (region.startsWith("ics:")) {
    const own = plan.calendar.region;
    return own !== null && own.src === "ics" && regionKey(own) === region ? regionText(own) : "a calendar link";
  }
  throw new Error(`Unknown holiday region ${region}`);
}

export function describeUnit(u: UnitKey, v: unknown, plan: PlanState, labels: ReadonlyMap<ActionId, string>): string {
  const k = parseKey(u);
  switch (k.kind) {
    case "pn":
    case "n":
      return q(decodeAs("name", u, v));
    case "e":
      return decodeAs("existence", u, v).t ? "in the Trash" : "in the plan";
    case "s": {
      const s = decodeAs("sched", u, v);
      const start = s.start === null ? "unscheduled" : `starts ${fmtShort(s.start)}`;
      const dur = s.dur === 0 ? "" : ` · ${workingDays(s.dur)}`;
      return `${start}${dur}${STATUS_TAIL[s.status]}`;
    }
    case "p": {
      const parent = decodeAs("place", u, v).parent;
      return parent === null ? "at the top level" : `in ${q(planGroupPath(plan, parent))}`;
    }
    case "r": {
      const refs = Object.keys(decodeAs("refs", u, v)).sort();
      return refs.length === 0 ? "no references" : `${count(refs.length, "reference", "references")}: ${refs.join(", ")}`;
    }
    case "l": {
      const l = decodeAs("link", u, v);
      if (l === null) return "no link";
      return l.lag === 0 ? l.type : `${l.type} ${signed(l.lag)}d`;
    }
    case "cr": {
      const r = decodeAs("region", u, v);
      return r === null ? "no holiday region" : `holiday region ${regionText(r)}`;
    }
    case "cw":
      return weekdaysText(decodeAs("weekdays", u, v));
    case "cc": {
      const c = decodeAs("closure", u, v);
      return c === null ? "no closure" : closureText(c.from, c.to, c.name);
    }
    case "ct": {
      const t = decodeAs("tuning", u, v);
      if (t === null) return "not tuned";
      if (t.kind === "add") return `day off ${q(t.name)}`;
      return t.kind === "work" ? "work this day" : "counted as a day off";
    }
    case "ch": {
      const y = decodeAs("holidayYear", u, v);
      if (y === null) return `${k.arg}: no holiday data`;
      return `${k.arg}: ${count(y.days.length, "day", "days")} from ${sourceText(y.region, plan)}`;
    }
    case "b": {
      const b = decodeAs("baseline", u, v);
      return b === null ? "removed" : `baseline ${q(b.name)}`;
    }
    case "a": {
      if (decodeAs("activity", u, v)) return "this change stands";
      const label = labels.get(k.arg);
      if (label === undefined) throw new Error(`No label for action ${k.arg}`);
      return `this change is undone: ${label}`;
    }
    case "ws": {
      const s = decodeAs("step", u, v);
      if (s === null) return "removed";
      return `step ${q(s.n)} · ${s.c}${s.d === true ? " · completes" : ""}${s.l === undefined ? "" : ` · limit ${s.l}`}`;
    }
    case "wi": {
      const ref = decodeAs("stepRef", u, v);
      if (ref === null) return "no step";
      const s = liveStep(plan, ref);
      return s === undefined ? "in a removed step" : `in step ${q(s.name)}`;
    }
    case "pp": {
      const p = decodeAs("person", u, v);
      return p === null ? "removed" : `person ${q(p.n)} · ${p.i} · ${p.c}`;
    }
    case "pa": {
      const ids = decodeAs("assignees", u, v) ?? [];
      if (ids.length === 0) return "unassigned";
      const live = peopleOf(plan).filter((p) => ids.includes(p.id));
      const former = ids.length - live.length;
      const formerPart = former === 0 ? [] : [former === 1 ? "a former person" : `${former} former people`];
      return `assigned to ${andList([...live.map((p) => q(p.name)), ...formerPart])}`;
    }
  }
}

const liveStep = (plan: PlanState, id: StepId): Step | undefined => stepsOf(plan).find((s) => s.id === id);

export function unitSubject(u: UnitKey, plan: PlanState): string {
  const k = parseKey(u);
  switch (k.kind) {
    case "e":
    case "n":
    case "s":
    case "p":
    case "r":
    case "wi":
    case "pa":
      return q(nameOf(plan, k.arg));
    case "l": {
      if (k.to === undefined) throw new Error(`Link ${u} has no successor`);
      return `The link ${q(nameOf(plan, k.arg))} → ${q(nameOf(plan, k.to))}`;
    }
    case "cr":
    case "cw":
    case "cc":
    case "ct":
    case "ch":
      return "The calendar";
    case "pn":
      return "The plan name";
    case "b": {
      const b = plan.baselines.get(k.arg);
      return b === undefined ? "A removed baseline" : `Baseline ${q(b.name)}`;
    }
    case "a":
      return "The change";
    case "ws": {
      const s = liveStep(plan, k.arg);
      return s === undefined ? "A removed step" : `The step ${q(s.name)}`;
    }
    case "pp": {
      const p = peopleOf(plan).find((x) => x.id === k.arg);
      return p === undefined ? "A removed person" : `The person ${q(p.name)}`;
    }
  }
}

export function itemChoices(view: PlanView, item: ItemId): Choice[] {
  const links = [...view.plan.links.values()].filter((l) => l.from === item || l.to === item).map((l) => key.l(l.from, l.to));
  const units = [key.e(item), key.n(item), key.s(item), key.p(item), key.r(item), key.wi(item), key.pa(item), ...links];
  const found = new Set(units.map((u) => choiceOf(view.choices, u)).filter((c): c is Choice => c !== null));
  return view.choices.filter((c) => found.has(c));
}

export function heldChoice(view: PlanView): Choice | null {
  const [item] = view.held;
  return item === undefined ? null : (view.choices.find((c) => heldItems([c], view.plan).has(item)) ?? null);
}

export function bannerText(choice: Choice, local: string): string {
  const labels = orderedSides(choice, local).map((s) => s.label);
  const names = labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `Changed on ${names}. Choose which to keep.`;
}
