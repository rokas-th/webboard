import type { ReactNode } from "react";
import { workCalendar, type WorkCalendar } from "../../domain/calendar";
import { fmtShort, toDay, toIso, type DateStyle, type Day } from "../../domain/dates";
import { meOf, type MeState } from "../../domain/me";
import type { Item, ItemId, Link, PersonId, StepId } from "../../domain/model";
import { projectBoard, storedStepOf, type BoardProjection, type Step } from "../../domain/steps";
import { childrenOf, liveLinks } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { ghostIds } from "../ghosts";
import { Avatar } from "../people/Avatar";
import { assigneeName } from "../people/assign";
import { moreText } from "../people/text";
import { planGroupPath, statusLabel, type StatusLabel } from "./groups";
import type { ColumnId } from "./prefs";
import { lateText, MILESTONE, NO_STEP, progressText, TASK } from "./text";
import { Highlight } from "../search/Highlight";

export type NoteText = (id: ItemId) => string;

export interface RowContext {
  view: PlanView;
  board: BoardProjection;
  links: readonly Link[];
  cal: WorkCalendar;
  today: Day;
  stepRank: ReadonlyMap<StepId, number>;
  personRank: ReadonlyMap<PersonId, number>;
  outline: ReadonlyMap<ItemId, number>;
  ghosts: ReadonlySet<ItemId>;
  notes: NoteText;
  me: MeState;
  style: DateStyle | null;
}

export type SortValue = number | string | null;

export interface ColumnSpec {
  id: ColumnId;
  title: string;
  value(ctx: RowContext, id: ItemId): string;
  csv(ctx: RowContext, id: ItemId): string;
  sortKey(ctx: RowContext, id: ItemId): SortValue;
  render(ctx: RowContext, id: ItemId, q: string): ReactNode;
  minWidth: number;
  defaultWidth: number;
  align: "start" | "end";
  pinned: boolean;
}

const STATUS_RANK: readonly StatusLabel[] = ["conflict", "held", "late", "in progress", "not started", "done"];

const STATUS_CLASS: Readonly<Record<StatusLabel, string>> = {
  conflict: "st conflict",
  held: "st held",
  late: "st late",
  "in progress": "st doing",
  done: "st done",
  "not started": "st todo",
};

const MAX_AVATARS = 3;

const outlineOf = (view: PlanView): Map<ItemId, number> => {
  const walk = (parent: ItemId | null): ItemId[] => childrenOf(view.plan, parent).flatMap((i) => (i.kind === "group" ? [i.id, ...walk(i.id)] : [i.id]));
  return new Map(walk(null).map((id, i): [ItemId, number] => [id, i]));
};

export function rowContext(view: PlanView, notes: NoteText, me: PersonId | null, style: DateStyle | null): RowContext {
  const board = projectBoard(view.plan, view.derived);
  return {
    view,
    board,
    links: liveLinks(view.plan),
    cal: workCalendar(view.plan.calendar),
    today: toDay(view.today),
    stepRank: new Map(board.steps.map((s, i): [StepId, number] => [s.id, i])),
    personRank: new Map(view.people.people.map((p, i): [PersonId, number] => [p.id, i])),
    outline: outlineOf(view),
    ghosts: ghostIds(view),
    notes,
    me: meOf(view, me),
    style,
  };
}

const itemOf = (view: PlanView, id: ItemId): Item => {
  const item = view.plan.items.get(id);
  if (item === undefined) throw new Error(`List: no item ${id}`);
  return item;
};

const dayOf = (m: ReadonlyMap<ItemId, Day>, id: ItemId, what: string): Day => {
  const d = m.get(id);
  if (d === undefined) throw new Error(`List: scheduled item ${id} has no ${what}`);
  return d;
};

const lagText = (lag: number): string => (lag === 0 ? "" : `${lag > 0 ? "+" : ""}${lag}d`);

export const depsOf = (view: PlanView, links: readonly Link[], id: ItemId): string =>
  links
    .filter((l) => l.to === id)
    .map((l) => `${itemOf(view, l.from).name} ${l.type}${lagText(l.lag)}`)
    .join(", ");

export const blocksOf = (view: PlanView, links: readonly Link[], id: ItemId): string =>
  links
    .filter((l) => l.from === id)
    .map((l) => `${itemOf(view, l.to).name} ${l.type}${lagText(l.lag)}`)
    .join(", ");

const textKey = (s: string): string | null => (s === "" ? null : s.toLocaleLowerCase());

const startOf = (ctx: RowContext, id: ItemId): Day | null => {
  const item = itemOf(ctx.view, id);
  return item.schedule === null || item.schedule.start === null ? null : dayOf(ctx.view.derived.start, id, "start");
};

const endOf = (ctx: RowContext, id: ItemId): Day | null => {
  const item = itemOf(ctx.view, id);
  return item.kind === "milestone" || startOf(ctx, id) === null ? null : dayOf(ctx.view.derived.end, id, "end");
};

const durOf = (ctx: RowContext, id: ItemId): number | null => {
  const item = itemOf(ctx.view, id);
  return item.schedule === null || item.kind === "milestone" ? null : item.schedule.dur;
};

const progressOf = (ctx: RowContext, id: ItemId): number | null => {
  const item = itemOf(ctx.view, id);
  return item.schedule === null ? null : item.schedule.progress;
};

const lateOf = (ctx: RowContext, id: ItemId): number | null => {
  if (!ctx.view.derived.late.has(id)) return null;
  const end = dayOf(ctx.view.derived.end, id, "end");
  if (end >= ctx.today) throw new Error(`List: item ${id} is marked late, but it ends on or after today`);
  return ctx.cal.workBetween(end + 1, ctx.today);
};

const stepRankOf = (ctx: RowContext, step: Step): number => {
  const rank = ctx.stepRank.get(step.id);
  if (rank === undefined) throw new Error(`List: step ${step.id} has no rank`);
  return rank;
};

export function stepOf(ctx: RowContext, id: ItemId): Step | null {
  const item = itemOf(ctx.view, id);
  const live = (sid: StepId | null): Step | null => (sid === null ? null : (ctx.board.steps.find((s) => s.id === sid) ?? null));
  if (ctx.board.columnOf.has(id)) return live(ctx.board.columnOf.get(id) ?? null);
  return live(storedStepOf(ctx.view.plan, item));
}

const assigneesOf = (ctx: RowContext, id: ItemId) => ctx.view.people.assignees.get(id) ?? [];

const personKey = (ctx: RowContext, id: ItemId): number | null => {
  const list = assigneesOf(ctx, id);
  if (list.length === 0) return null;
  const first = list.find((a) => a.kind === "live");
  if (first === undefined || first.kind !== "live") return ctx.view.people.people.length;
  const rank = ctx.personRank.get(first.person.id);
  if (rank === undefined) throw new Error(`List: person ${first.person.id} has no rank`);
  return rank;
};

const parentOf = (ctx: RowContext, id: ItemId): ItemId | null => itemOf(ctx.view, id).place.parent;

const outlineKey = (ctx: RowContext, id: ItemId): number => {
  const at = ctx.outline.get(id);
  if (at === undefined) throw new Error(`List: item ${id} is not in the outline`);
  return at;
};

const firstLine = (text: string): string => text.split("\n")[0].trim();

const fmtDay = (d: Day | null, style: DateStyle): string => (d === null ? "" : fmtShort(toIso(d), style));

export const styleOf = (ctx: RowContext): DateStyle => {
  if (ctx.style === null) throw new Error("List: this row context orders and filters only, so it has no date style to show a date in");
  return ctx.style;
};

const numText = (n: number | null): string => (n === null ? "" : String(n));

const isoDay = (d: Day | null): string => (d === null ? "" : toIso(d));

interface Body {
  value(ctx: RowContext, id: ItemId): string;
  csv?(ctx: RowContext, id: ItemId): string;
  sortKey(ctx: RowContext, id: ItemId): SortValue;
  render?(ctx: RowContext, id: ItemId, q: string): ReactNode;
}

interface Shape {
  id: ColumnId;
  title: string;
  minWidth: number;
  defaultWidth: number;
  align?: "start" | "end";
  pinned?: boolean;
  ghost?: boolean;
}

const column = (shape: Shape, body: Body): ColumnSpec => {
  const shown = (ctx: RowContext, id: ItemId): boolean => shape.ghost === true || !ctx.ghosts.has(id);
  const draw = body.render ?? ((ctx: RowContext, id: ItemId): ReactNode => body.value(ctx, id));
  const csv = body.csv ?? body.value;
  return {
    id: shape.id,
    title: shape.title,
    minWidth: shape.minWidth,
    defaultWidth: shape.defaultWidth,
    align: shape.align ?? "start",
    pinned: shape.pinned ?? false,
    value: (ctx, id) => (shown(ctx, id) ? body.value(ctx, id) : ""),
    csv: (ctx, id) => (shown(ctx, id) ? csv(ctx, id) : ""),
    sortKey: (ctx, id) => (shown(ctx, id) ? body.sortKey(ctx, id) : null),
    render: (ctx, id, q) => (shown(ctx, id) ? draw(ctx, id, q) : null),
  };
};

const statusRank = (label: StatusLabel): number => STATUS_RANK.indexOf(label);

function AssigneesCell(p: { ctx: RowContext; id: ItemId }) {
  const list = assigneesOf(p.ctx, p.id);
  const [first] = list;
  if (first === undefined) return null;
  return (
    <span className="cell-who">
      {list.slice(0, MAX_AVATARS).map((a) => (
        <Avatar key={a.kind === "live" ? a.person.id : a.id} assignee={a} />
      ))}
      <span className="who-names">{list.length > 1 ? `${assigneeName(first)} ${moreText(list.length - 1)}` : assigneeName(first)}</span>
    </span>
  );
}

export const COLUMNS: readonly ColumnSpec[] = [
  column(
    { id: "name", title: "Name", minWidth: 180, defaultWidth: 300, pinned: true, ghost: true },
    {
      value: (ctx, id) => itemOf(ctx.view, id).name,
      sortKey: (ctx, id) => itemOf(ctx.view, id).name.toLocaleLowerCase(),
      render: (ctx, id, q) => {
        const item = itemOf(ctx.view, id);
        return (
          <span className="list-name">
            {item.kind === "milestone" ? "◆ " : null}
            <Highlight text={item.name} q={q} />
          </span>
        );
      },
    },
  ),
  column(
    { id: "step", title: "Step", minWidth: 90, defaultWidth: 140 },
    {
      value: (ctx, id) => stepOf(ctx, id)?.name ?? NO_STEP,
      csv: (ctx, id) => stepOf(ctx, id)?.name ?? "",
      sortKey: (ctx, id) => {
        const step = stepOf(ctx, id);
        return step === null ? -1 : stepRankOf(ctx, step);
      },
      render: (ctx, id) => {
        const step = stepOf(ctx, id);
        if (step === null) return <span className="dim">{NO_STEP}</span>;
        return (
          <span className="cell-step" style={{ "--step": `var(--s-${step.colour})` }}>
            <span className="swatch" />
            {step.name}
          </span>
        );
      },
    },
  ),
  column(
    { id: "status", title: "Status", minWidth: 90, defaultWidth: 110, ghost: true },
    {
      value: (ctx, id) => statusLabel(ctx.view, id),
      sortKey: (ctx, id) => statusRank(statusLabel(ctx.view, id)),
      render: (ctx, id) => {
        const label = statusLabel(ctx.view, id);
        return <span className={STATUS_CLASS[label]}>{label}</span>;
      },
    },
  ),
  column(
    { id: "assignees", title: "Assignees", minWidth: 110, defaultWidth: 170 },
    {
      value: (ctx, id) => assigneesOf(ctx, id).map(assigneeName).join(", "),
      csv: (ctx, id) => assigneesOf(ctx, id).map(assigneeName).join("; "),
      sortKey: personKey,
      render: (ctx, id) => <AssigneesCell ctx={ctx} id={id} />,
    },
  ),
  column(
    { id: "start", title: "Start", minWidth: 72, defaultWidth: 88, align: "end" },
    { value: (ctx, id) => fmtDay(startOf(ctx, id), styleOf(ctx)), csv: (ctx, id) => isoDay(startOf(ctx, id)), sortKey: startOf },
  ),
  column(
    { id: "end", title: "End", minWidth: 72, defaultWidth: 88, align: "end" },
    { value: (ctx, id) => fmtDay(endOf(ctx, id), styleOf(ctx)), csv: (ctx, id) => isoDay(endOf(ctx, id)), sortKey: endOf },
  ),
  column(
    { id: "days", title: "Days", minWidth: 56, defaultWidth: 64, align: "end" },
    { value: (ctx, id) => numText(durOf(ctx, id)), sortKey: durOf },
  ),
  column(
    { id: "progress", title: "Progress", minWidth: 90, defaultWidth: 110 },
    {
      value: (ctx, id) => {
        const p = progressOf(ctx, id);
        return p === null ? "" : progressText(p);
      },
      csv: (ctx, id) => numText(progressOf(ctx, id)),
      sortKey: progressOf,
    },
  ),
  column(
    { id: "late", title: "Late by", minWidth: 70, defaultWidth: 84, align: "end" },
    {
      value: (ctx, id) => {
        const days = lateOf(ctx, id);
        return days === null ? "" : lateText(days);
      },
      csv: (ctx, id) => numText(lateOf(ctx, id)),
      sortKey: lateOf,
      render: (ctx, id) => {
        const days = lateOf(ctx, id);
        return days === null ? null : <span className="st late">{lateText(days)}</span>;
      },
    },
  ),
  column(
    { id: "deps", title: "Depends on", minWidth: 120, defaultWidth: 180 },
    { value: (ctx, id) => depsOf(ctx.view, ctx.links, id), sortKey: (ctx, id) => textKey(depsOf(ctx.view, ctx.links, id)) },
  ),
  column(
    { id: "blocks", title: "Blocks", minWidth: 120, defaultWidth: 180 },
    { value: (ctx, id) => blocksOf(ctx.view, ctx.links, id), sortKey: (ctx, id) => textKey(blocksOf(ctx.view, ctx.links, id)) },
  ),
  column(
    { id: "group", title: "Group", minWidth: 110, defaultWidth: 160 },
    {
      value: (ctx, id) => {
        const parent = parentOf(ctx, id);
        return parent === null ? "" : planGroupPath(ctx.view.plan, parent);
      },
      sortKey: (ctx, id) => {
        const parent = parentOf(ctx, id);
        return parent === null ? null : outlineKey(ctx, parent);
      },
    },
  ),
  column(
    { id: "kind", title: "Kind", minWidth: 80, defaultWidth: 90 },
    {
      value: (ctx, id) => (itemOf(ctx.view, id).kind === "milestone" ? MILESTONE : TASK),
      sortKey: (ctx, id) => (itemOf(ctx.view, id).kind === "milestone" ? 1 : 0),
    },
  ),
  column(
    { id: "note", title: "Note", minWidth: 140, defaultWidth: 240 },
    {
      value: (ctx, id) => firstLine(ctx.notes(id)),
      csv: (ctx, id) => ctx.notes(id),
      sortKey: (ctx, id) => textKey(firstLine(ctx.notes(id))),
      render: (ctx, id, q) => (
        <span className="cell-note">
          <Highlight text={firstLine(ctx.notes(id))} q={q} />
        </span>
      ),
    },
  ),
];

export function columnById(id: string): ColumnSpec {
  const spec = COLUMNS.find((c) => c.id === id);
  if (spec === undefined) throw new Error(`No List column ${id}`);
  return spec;
}
