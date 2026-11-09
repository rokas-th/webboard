import { memo, useEffect, type ReactNode } from "react";
import { q, workingDays } from "../../actions/copy";
import { fmtShort, toDay, toIso, weekday, type Day } from "../../domain/dates";
import { linkKey, type Item, type ItemId, type LinkType } from "../../domain/model";
import { liveLinks } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import type { SetUi, UiState, Zoom } from "../state";
import { ROW, type Geometry } from "./geometry";
import type { Marks, Placed } from "./Grid";
import { linkPath, type End } from "./linkPath";
import { WEEKDAYS } from "./Scale";

export interface DropGhost {
  item: ItemId;
  left: number;
  width: number;
  top: number;
  label: string;
}

export interface TempLink {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const dayLabel = (d: Day): string => `${WEEKDAYS[weekday(d) - 1]} ${fmtShort(toIso(d))}`;

const MS_HALF = 7;

const fmt = (d: Day): string => fmtShort(toIso(d));

const classes = (...names: readonly (string | false)[]): string => names.filter((n): n is string => n !== false).join(" ");

export const itemOf = (view: PlanView, id: ItemId): Item => {
  const item = view.plan.items.get(id);
  if (item === undefined) throw new Error(`Timeline row ${id} is not in the plan`);
  return item;
};

const spanOf = (geo: Geometry, id: ItemId): { start: Day; end: Day } => {
  const span = geo.span(id);
  if (span === null) throw new Error(`Timeline row ${id} has no dates`);
  return span;
};

const EARLY: Readonly<Record<LinkType, (pred: string) => string>> = {
  FS: (pred) => `Started before ${pred} finished`,
  SS: (pred) => `Started before ${pred} started`,
  FF: (pred) => `Finished before ${pred} finished`,
  SF: (pred) => `Finished before ${pred} started`,
};

function endOf(geo: Geometry, item: Item, y: number): End {
  const span = spanOf(geo, item.id);
  if (item.kind === "milestone") {
    const c = geo.x(span.start) + geo.ppd / 2;
    return { x0: c - MS_HALF, x1: c + MS_HALF, y };
  }
  return { x0: geo.x(span.start), x1: geo.x(span.end) + geo.ppd, y };
}

interface ChartProps {
  view: PlanView;
  geo: Geometry;
  zoom: Zoom;
  ui: UiState;
  setUi: SetUi;
  mounted: readonly Placed[];
  count: number;
  marks: Marks;
  readOnly: boolean;
  dragging: ItemId | null;
  ghost: DropGhost | null;
  temp: TempLink | null;
}

const Shading = memo(function Shading(p: { geo: Geometry; zoom: Zoom }) {
  const { geo } = p;
  return (
    <>
      {Array.from({ length: geo.days }, (_, i) => geo.origin + i).flatMap((d) => {
        const off = geo.cal.off(d);
        if (off !== null) {
          return [<div key={d} className={off.origin === "closure" ? "tl-off closure" : "tl-off hol"} style={{ left: geo.x(d), width: geo.ppd }} title={off.name} />];
        }
        if (geo.cal.isWork(d) || p.zoom === "Q") return [];
        return [<div key={d} className="tl-off" style={{ left: geo.x(d), width: geo.ppd }} />];
      })}
    </>
  );
});

function Links(p: ChartProps & { height: number }) {
  const { geo, view } = p;
  const at = new Map(p.mounted.map((m) => [m.row.id, m.index] as const));
  const ends = (id: ItemId): End | null => {
    const index = at.get(id);
    const item = itemOf(view, id);
    return index === undefined ? null : endOf(geo, item, index * ROW + ROW / 2);
  };
  const paths = liveLinks(view.plan).flatMap((l) => {
    const pred = ends(l.from);
    const succ = ends(l.to);
    if (pred === null || succ === null) return [];
    const key = linkKey(l.from, l.to);
    const bad = p.marks.badLinks.has(key);
    const hot = p.ui.selected === l.from || p.ui.selected === l.to;
    return [
      <path
        key={key}
        className={bad ? "bad" : hot ? "hot" : undefined}
        d={linkPath(l.type, pred, succ)}
        markerEnd={`url(#${bad ? "arrBad" : hot ? "arrHot" : "arr"})`}
      />,
    ];
  });
  const marker = (id: string, fill: string) => (
    <marker id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill={fill} stroke="none" />
    </marker>
  );
  return (
    <svg className="tl-links" width={geo.width} height={p.height} aria-hidden="true">
      <defs>
        {marker("arr", "#158CA6")}
        {marker("arrHot", "#24E0FF")}
        {marker("arrBad", "#FF3B6B")}
      </defs>
      {paths}
      {p.temp !== null && <path className="temp" d={`M${p.temp.x0},${p.temp.y0} L${p.temp.x1},${p.temp.y1}`} />}
    </svg>
  );
}

function titleOf(p: ChartProps, item: Item, start: Day, end: Day): string {
  const shownFrom = p.marks.dayoff.get(item.id);
  if (shownFrom !== undefined) return `Starts on a day off — shown from ${dayLabel(shownFrom)}`;
  const early = p.marks.early.get(item.id);
  if (early !== undefined && early.doneOrDoing) {
    const pred = p.view.plan.items.get(early.pred);
    if (pred === undefined) throw new Error(`Conflict predecessor ${early.pred} is not in the plan`);
    return EARLY[early.type](q(pred.name));
  }
  if (item.kind === "milestone") return `${item.name} · ${dayLabel(start)}`;
  return `${item.name} · ${fmt(start)} – ${fmt(end)} · ${workingDays(p.geo.cal.workBetween(start, end))}`;
}

function Bar(p: ChartProps & { placed: Placed; slip: ReadonlyMap<ItemId, number> | null }) {
  const { geo, view } = p;
  const { row, index } = p.placed;
  const y = index * ROW;
  const item = itemOf(view, row.id);
  if (row.kind === "ghost") return null;
  if (row.kind === "group") {
    const group = geo.span(row.id);
    if (group === null) return null;
    return <div className="gbar" style={{ left: geo.x(group.start), width: geo.x(group.end) - geo.x(group.start) + geo.ppd, top: y + 14 }} />;
  }
  const span = spanOf(geo, row.id);
  const status = view.derived.status.get(row.id);
  const done = status === "done";
  const late = view.derived.late.has(row.id);
  const conflict = p.marks.early.has(row.id);
  const shared = [
    done && "done",
    conflict && "conflict",
    p.ui.selected === row.id && "selected",
    view.held.has(row.id) && "held",
    p.marks.dayoff.has(row.id) && "dayoff",
    p.dragging === row.id && "dragging",
  ];
  const slip = p.slip === null ? undefined : p.slip.get(row.id);
  const extra: ReactNode[] = [
    conflict ? (
      <span key="c" className="bad">
        starts before its predecessor allows
      </span>
    ) : late ? (
      <span key="l" className="warn">
        late
      </span>
    ) : null,
    slip !== undefined && slip !== 0 ? (
      <span key="s" className="meta">
        {slip > 0 ? "+" : ""}
        {slip}d vs baseline
      </span>
    ) : null,
  ];
  const title = titleOf(p, item, span.start, span.end);
  const nub = p.readOnly ? null : <span className="nub" data-nub={row.id} />;
  if (row.kind === "milestone") {
    const x = geo.x(span.start) + geo.ppd / 2;
    return (
      <>
        <div className={classes("ms", ...shared)} data-bar={row.id} style={{ left: x, top: y + 10 }} title={title}>
          {nub}
        </div>
        <div className="bar-label" style={{ left: x + 18, top: y + 8 }}>
          {item.name}
          <span className="meta">{fmt(span.start)}</span>
          {extra}
        </div>
      </>
    );
  }
  const x = geo.x(span.start);
  const w = geo.x(span.end) - x + geo.ppd;
  if (item.schedule === null) throw new Error(`Timeline row ${row.id} has no schedule`);
  const progress = item.schedule.progress;
  const meta = done ? "done" : progress > 0 ? `${progress}%` : "";
  return (
    <>
      <div className={classes("bar", late && "late", ...shared)} data-bar={row.id} style={{ left: x, width: w, top: y + 8 }} title={title}>
        <div className="fill" style={{ width: `${done ? 0 : progress}%` }} />
        {!p.readOnly && <span className="h l" data-h="l" />}
        {!p.readOnly && <span className="h r" data-h="r" />}
        {nub}
      </div>
      <div className="bar-label" style={{ left: x + w + 22, top: y + 8 }}>
        {item.name}
        {meta !== "" && <span className="meta">{meta}</span>}
        {extra}
      </div>
    </>
  );
}

function Ghost(p: { geo: Geometry; placed: Placed; item: Item; dates: { start: string; dur: number } }) {
  const { geo } = p;
  const y = p.placed.index * ROW;
  const bs = geo.cal.snapF(toDay(p.dates.start));
  if (p.item.kind === "milestone") return <div className="ghost ms-ghost" style={{ left: geo.x(bs) + geo.ppd / 2, top: y + 22 }} />;
  const be = geo.cal.addWork(bs, p.dates.dur - 1);
  return <div className="ghost" style={{ left: geo.x(bs), width: geo.x(be) - geo.x(bs) + geo.ppd, top: y + 28 }} />;
}

export function Chart(p: ChartProps) {
  const { geo, view } = p;
  const height = Math.max(p.count * ROW, 200);
  const baseline = p.ui.baseline === null ? undefined : view.plan.baselines.get(p.ui.baseline);
  const lost = p.ui.baseline !== null && baseline === undefined;
  const { setUi } = p;
  useEffect(() => {
    if (lost) setUi({ baseline: null });
  }, [lost, setUi]);
  const slip = baseline === undefined ? null : view.derived.slip(baseline.id);
  const today = toDay(view.today);
  const live = p.mounted.filter((m) => m.row.kind === "task" || m.row.kind === "milestone");
  return (
    <div className="tl-chart" style={{ width: geo.width, height }}>
      <Shading geo={geo} zoom={p.zoom} />
      {p.mounted.map((m) => (
        <div key={m.row.id} className={p.ui.selected === m.row.id ? "tl-rowline selected" : "tl-rowline"} style={{ top: m.index * ROW }} />
      ))}
      <div className="tl-today" style={{ left: geo.x(today) + geo.ppd / 2 }} />
      {baseline !== undefined &&
        live.flatMap((m) => {
          const dates = baseline.dates[m.row.id];
          const item = itemOf(view, m.row.id);
          return dates === undefined ? [] : [<Ghost key={m.row.id} geo={geo} placed={m} item={item} dates={dates} />];
        })}
      <Links {...p} height={height} />
      {p.mounted.map((m) => (
        <Bar key={m.row.id} {...p} placed={m} slip={slip} />
      ))}
      {p.ghost !== null && (
        <div className="drop-ghost" style={{ left: p.ghost.left, width: p.ghost.width, top: p.ghost.top }}>
          {p.ghost.label}
        </div>
      )}
    </div>
  );
}
