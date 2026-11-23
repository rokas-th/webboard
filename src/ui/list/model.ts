import { formerText } from "../../actions/copy";
import type { Item, ItemId, PersonId, StepColour } from "../../domain/model";
import { derivedStatus } from "../status";
import { heldOf } from "../people/assign";
import { stepOf, columnById, type RowContext, type SortValue } from "./columns";
import { listGroups } from "./groups";
import type { Chip, ChipField, ColumnId, ListPrefs, ScopeId, SortKey } from "./prefs";
import { UNASSIGNED } from "../people/text";
import { NO_STEP } from "./text";
import type { Matcher } from "../search/match";

export interface ListSection {
  key: string;
  title: string;
  swatch: StepColour | null;
  group: ItemId | null;
  rows: readonly ItemId[];
}

export interface ListModel {
  sections: readonly ListSection[];
  order: readonly ItemId[];
  scoped: number;
  shown: number;
  scopeCounts: Readonly<Record<ScopeId, number>>;
}

const SOON_WORKDAYS = 7;

const itemOf = (ctx: RowContext, id: ItemId): Item => {
  const item = ctx.view.plan.items.get(id);
  if (item === undefined) throw new Error(`List: no item ${id}`);
  return item;
};

const outlineAt = (ctx: RowContext, id: ItemId): number => {
  const at = ctx.outline.get(id);
  if (at === undefined) throw new Error(`List: item ${id} is not in the outline`);
  return at;
};

const byPlan = (ctx: RowContext) => (a: ItemId, b: ItemId): number => outlineAt(ctx, a) - outlineAt(ctx, b);

export const planOrder = (ctx: RowContext): ItemId[] => listGroups(ctx.view).flatMap((s) => s.items).sort(byPlan(ctx));

const done = (ctx: RowContext, id: ItemId): boolean => derivedStatus(ctx.view, id, "List") === "done";

const blocked = (ctx: RowContext, id: ItemId): boolean => !done(ctx, id) && ctx.links.some((l) => l.to === id && !done(ctx, l.from));

const dueSoon = (ctx: RowContext, id: ItemId): boolean => {
  if (done(ctx, id)) return false;
  const end = ctx.view.derived.end.get(id);
  return end !== undefined && end >= ctx.today && end <= ctx.cal.addWork(ctx.today, SOON_WORKDAYS);
};

const SCOPES: Readonly<Record<ScopeId, (ctx: RowContext, id: ItemId) => boolean>> = {
  open: (ctx, id) => !done(ctx, id),
  soon: dueSoon,
  late: (ctx, id) => ctx.view.derived.late.has(id),
  blocked,
  unscheduled: (ctx, id) => {
    const s = itemOf(ctx, id).schedule;
    return s === null || s.start === null;
  },
  unassigned: (ctx, id) => heldOf(ctx.view, id).length === 0,
  milestones: (ctx, id) => itemOf(ctx, id).kind === "milestone",
  done,
  all: () => true,
};

export const inScope = (ctx: RowContext, scope: ScopeId, id: ItemId): boolean => ctx.ghosts.has(id) || SCOPES[scope](ctx, id);

const CHIP_TEST: Readonly<Record<ChipField, (ctx: RowContext, id: ItemId, v: string | null) => boolean>> = {
  step: (ctx, id, v) => (stepOf(ctx, id)?.id ?? null) === v,
  assignee: (ctx, id, v) => {
    const held = heldOf(ctx.view, id);
    return v === null ? held.length === 0 : held.includes(v);
  },
  kind: (ctx, id, v) => itemOf(ctx, id).kind === v,
  group: (ctx, id, v) => itemOf(ctx, id).place.parent === v,
};

const FIELDS: readonly ChipField[] = ["step", "assignee", "kind", "group"];

export function passesChips(ctx: RowContext, chips: readonly Chip[], id: ItemId): boolean {
  if (ctx.ghosts.has(id)) return true;
  return FIELDS.every((f) => {
    const mine = chips.filter((c) => c.f === f);
    return mine.length === 0 || mine.some((c) => CHIP_TEST[f](ctx, id, c.v));
  });
}

const compareValues = (a: SortValue, b: SortValue): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  throw new Error(`List: cannot compare ${JSON.stringify(a)} with ${JSON.stringify(b)}`);
};

export function sortRows(ctx: RowContext, sort: readonly SortKey[], rows: readonly ItemId[]): ItemId[] {
  const plan = byPlan(ctx);
  const keys = sort.map((s) => ({ dir: s.dir, spec: columnById(s.id) }));
  const keyed = rows.map((id) => ({ id, values: keys.map((k) => k.spec.sortKey(ctx, id)) }));
  const compare = (a: (typeof keyed)[number], b: (typeof keyed)[number]): number => {
    const decided = keys
      .map((k, i) => {
        const x = a.values[i];
        const y = b.values[i];
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
        const c = compareValues(x, y);
        return k.dir === "asc" ? c : -c;
      })
      .find((c) => c !== 0);
    return decided ?? plan(a.id, b.id);
  };
  return keyed.sort(compare).map((k) => k.id);
}

export function sortClick(prefs: ListPrefs, id: ColumnId, shift: boolean): ListPrefs {
  if (shift) {
    const at = prefs.sort.find((s) => s.id === id);
    if (at === undefined) return { ...prefs, sort: [...prefs.sort, { id, dir: "asc" }] };
    if (at.dir === "asc") return { ...prefs, sort: prefs.sort.map((s) => (s.id === id ? { id, dir: "desc" } : s)) };
    return { ...prefs, sort: prefs.sort.filter((s) => s.id !== id) };
  }
  const primary = prefs.sort[0];
  if (primary === undefined || primary.id !== id) return { ...prefs, sort: [{ id, dir: "asc" }] };
  return { ...prefs, sort: primary.dir === "asc" ? [{ id, dir: "desc" }] : [] };
}

export function toggleChip(prefs: ListPrefs, chip: Chip): ListPrefs {
  const has = prefs.chips.some((c) => c.f === chip.f && c.v === chip.v);
  return { ...prefs, chips: has ? prefs.chips.filter((c) => !(c.f === chip.f && c.v === chip.v)) : [...prefs.chips, chip] };
}

interface Bucket {
  key: string;
  title: string;
  swatch: StepColour | null;
  group: ItemId | null;
  test(id: ItemId): boolean;
}

const outlineBuckets = (ctx: RowContext): Bucket[] =>
  listGroups(ctx.view).map((s) => {
    const members = new Set(s.items);
    return { key: s.group === null ? "outline:none" : `outline:${s.group}`, title: s.name, swatch: null, group: s.group, test: (id: ItemId) => members.has(id) };
  });

const stepBuckets = (ctx: RowContext): Bucket[] => [
  { key: "step:none", title: NO_STEP, swatch: null, group: null, test: (id: ItemId) => stepOf(ctx, id) === null },
  ...ctx.board.steps.map((s) => ({ key: `step:${s.id}`, title: s.name, swatch: s.colour, group: null, test: (id: ItemId) => stepOf(ctx, id)?.id === s.id })),
];

const personBuckets = (ctx: RowContext, rows: readonly ItemId[]): Bucket[] => {
  const firstLive = (id: ItemId): string | null => heldOf(ctx.view, id)[0] ?? null;
  const formerOf = (id: ItemId) => {
    const list = ctx.view.people.assignees.get(id) ?? [];
    return list.length === 0 || firstLive(id) !== null ? null : list[0];
  };
  const formers = [
    ...new Map(
      rows.flatMap((id): [PersonId, string | null][] => {
        const f = formerOf(id);
        return f === null || f.kind !== "former" ? [] : [[f.id, f.name]];
      }),
    ),
  ];
  return [
    ...ctx.view.people.people.map((p) => ({ key: `person:${p.id}`, title: p.name, swatch: p.colour, group: null, test: (id: ItemId) => firstLive(id) === p.id })),
    ...formers.map(([fid, name]) => ({
      key: `former:${fid}`,
      title: formerText(name),
      swatch: null,
      group: null,
      test: (id: ItemId) => {
        const f = formerOf(id);
        return f !== null && f.kind === "former" && f.id === fid;
      },
    })),
    { key: "unassigned", title: UNASSIGNED, swatch: null, group: null, test: (id: ItemId) => (ctx.view.people.assignees.get(id) ?? []).length === 0 },
  ];
};

const bucketsOf = (ctx: RowContext, prefs: ListPrefs, rows: readonly ItemId[]): Bucket[] => {
  if (prefs.group === "outline") return outlineBuckets(ctx);
  if (prefs.group === "step") return stepBuckets(ctx);
  if (prefs.group === "assignee") return personBuckets(ctx, rows);
  return [{ key: "all", title: "", swatch: null, group: null, test: () => true }];
};

export function listModel(ctx: RowContext, prefs: ListPrefs, match: Matcher | null): ListModel {
  const all = planOrder(ctx);
  const chipped = all.filter((id) => passesChips(ctx, prefs.chips, id));
  const rows = chipped.filter((id) => inScope(ctx, prefs.scope, id));
  const found = match === null ? rows : rows.filter(match);
  const sorted = sortRows(ctx, prefs.sort, found);
  const sections = bucketsOf(ctx, prefs, sorted)
    .map((b) => ({ key: b.key, title: b.title, swatch: b.swatch, group: b.group, rows: sorted.filter((id) => b.test(id)) }))
    .filter((s) => s.rows.length > 0);
  const placed = sections.flatMap((s) => s.rows);
  if (placed.length !== sorted.length) throw new Error(`listModel: ${sorted.length} rows but ${placed.length} placed by ${prefs.group}`);
  const live = (ids: readonly ItemId[]): number => ids.filter((id) => !ctx.ghosts.has(id)).length;
  const count = (s: ScopeId): number => live(chipped.filter((id) => inScope(ctx, s, id)));
  return {
    sections,
    order: placed,
    scoped: live(rows),
    shown: live(found),
    scopeCounts: {
      open: count("open"),
      soon: count("soon"),
      late: count("late"),
      blocked: count("blocked"),
      unscheduled: count("unscheduled"),
      unassigned: count("unassigned"),
      milestones: count("milestones"),
      done: count("done"),
      all: count("all"),
    },
  };
}
