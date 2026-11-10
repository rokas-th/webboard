import { memo, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { q, workingDays } from "../../actions/copy";
import { fmtShort, toDay, toIso, type Day } from "../../domain/dates";
import { linkKey, type Item, type ItemId } from "../../domain/model";
import { liveLinks } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import type { SetUi, UiState, Zoom } from "../state";
import { ROW, type Geometry } from "./geometry";
import type { Marks, Placed } from "./Grid";
import { linkPath, type End } from "./linkPath";
import { dayLabel } from "./dayText";
import { EARLY } from "./earlyText";
import { TouchGesture, type GestureEvent, type Handle, type Sample } from "./touch";

export interface Point {
  x: number;
  y: number;
}

export interface TouchHost {
  has(item: ItemId): boolean;
  pick(item: ItemId, handle: Handle): void;
  drag(item: ItemId, handle: Handle, dx: number, from: Point, at: Point): void;
  drop(item: ItemId, handle: Handle, dx: number, target: ItemId | null): void;
  clear(): void;
}

const HIT_PX = 44;
const HANDLE_INSIDE_PX = 14;
const ZOOM_ORDER: readonly Zoom[] = ["Q", "M", "W"];

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
  index: ReadonlyMap<ItemId, number>;
  window: readonly [number, number];
  count: number;
  marks: Marks;
  readOnly: boolean;
  dragging: ItemId | null;
  ghost: DropGhost | null;
  temp: TempLink | null;
  touch: TouchHost;
}

export const rowAt = (mounted: readonly Placed[], y: number): Placed | null => {
  const index = Math.floor(y / ROW);
  const m = mounted.find((r) => r.index === index);
  return m === undefined || (m.row.kind !== "task" && m.row.kind !== "milestone") ? null : m;
};

function zoneOf(geo: Geometry, kind: "task" | "milestone", id: ItemId, x: number): Handle | null {
  const span = spanOf(geo, id);
  if (kind === "milestone") return Math.abs(x - (geo.x(span.start) + geo.ppd / 2)) < HIT_PX / 2 ? "body" : null;
  const x0 = geo.x(span.start);
  const x1 = geo.x(span.end) + geo.ppd;
  if (x1 - x0 < HIT_PX) {
    if (x >= x0 - HIT_PX / 2 && x < x0) return "start";
    if (x >= x0 && x < x1) return "body";
    if (x >= x1 && x < x1 + HIT_PX / 2) return "end";
    return null;
  }
  const inside = Math.min(HANDLE_INSIDE_PX, Math.floor((x1 - x0) / 4));
  const outside = HIT_PX - inside;
  if (x >= x0 - outside && x < x0 + inside) return "start";
  if (x >= x1 - inside && x < x1 + outside) return "end";
  if (x >= x0 + inside && x < x1 - inside) return "body";
  return null;
}

function touchHit(mounted: readonly Placed[], geo: Geometry, target: EventTarget, at: Point): { item: ItemId; handle: Handle } | null {
  if (!(target instanceof Element)) throw new Error("Timeline: a touch target that is not an element");
  const nub = target.closest("[data-nub]");
  if (nub instanceof HTMLElement && nub.dataset.nub !== undefined) return { item: nub.dataset.nub, handle: "link" };
  const row = rowAt(mounted, at.y);
  if (row !== null) {
    const kind = row.row.kind === "milestone" ? "milestone" : "task";
    const zone = zoneOf(geo, kind, row.row.id, at.x);
    if (zone !== null) return { item: row.row.id, handle: zone };
  }
  const bar = target.closest("[data-bar]");
  return bar instanceof HTMLElement && bar.dataset.bar !== undefined ? { item: bar.dataset.bar, handle: "body" } : null;
}

const zoomed = (zoom: Zoom, step: 1 | -1): Zoom => {
  const at = ZOOM_ORDER.indexOf(zoom);
  if (at < 0) throw new Error(`Timeline: unknown zoom ${zoom}`);
  return ZOOM_ORDER[Math.min(ZOOM_ORDER.length - 1, Math.max(0, at + step))];
};

const timer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

function useTouch(p: ChartProps): {
  root: RefObject<HTMLDivElement | null>;
  handlers: {
    onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void;
    onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void;
    onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void;
    onPointerCancel(e: ReactPointerEvent<HTMLDivElement>): void;
    onLostPointerCapture(e: ReactPointerEvent<HTMLDivElement>): void;
  };
} {
  const root = useRef<HTMLDivElement>(null);
  const picked = useRef<ItemId | null>(null);
  const downs = useRef(new Map<number, Point>());
  const last = useRef<{ from: Point; at: Point } | null>(null);
  const gesture = useRef<TouchGesture | null>(null);
  const handle = useRef<(events: readonly GestureEvent[]) => void>(() => {
    throw new Error("Timeline: a touch gesture before the chart mounted");
  });
  const reset = useRef<(g: TouchGesture) => void>(() => {
    throw new Error("Timeline: a touch reset before the chart mounted");
  });
  const allowPickup = !p.readOnly;
  const { setUi, zoom, touch } = p;

  const live = (): TouchGesture => {
    const g = gesture.current;
    if (g === null) throw new Error("Timeline: no touch recogniser");
    return g;
  };

  useLayoutEffect(() => {
    reset.current = (g) => {
      [...downs.current.keys()].forEach((id) => g.cancel(id));
      downs.current.clear();
      last.current = null;
      picked.current = null;
      touch.clear();
    };
    handle.current = (events) =>
      events.forEach((ev) => {
        if (ev.k === "zoom") {
          const next = zoomed(zoom, ev.step);
          if (next !== zoom) setUi({ zoom: next });
        } else if (ev.k === "cancel") {
          picked.current = null;
          touch.clear();
        } else if (ev.k === "tap") {
          if (ev.item === null) setUi({ selected: null });
          else if (touch.has(ev.item)) setUi({ selected: ev.item });
          else reset.current(live());
        } else if (!touch.has(ev.item)) {
          reset.current(live());
        } else if (ev.k === "pickup") {
          picked.current = ev.item;
          touch.pick(ev.item, ev.handle);
        } else if (ev.k === "drag") {
          const l = last.current;
          if (l === null) throw new Error("Timeline: a touch drag with no position");
          touch.drag(ev.item, ev.handle, ev.dx, l.from, l.at);
        } else {
          picked.current = null;
          touch.drop(ev.item, ev.handle, ev.dx, ev.target);
        }
      });
  });

  useLayoutEffect(() => {
    const g = new TouchGesture({ allowPickup, schedule: timer, emit: (events) => handle.current(events) });
    gesture.current = g;
    return () => {
      gesture.current = null;
      reset.current(g);
    };
  }, [allowPickup]);

  useLayoutEffect(() => {
    const item = picked.current;
    if (item !== null && !touch.has(item)) reset.current(live());
  });

  useEffect(() => {
    const el = root.current;
    if (el === null) throw new Error("Timeline: no chart");
    const onTouchMove = (e: TouchEvent): void => {
      if (picked.current !== null) e.preventDefault();
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, []);

  const pointOf = (e: ReactPointerEvent<HTMLDivElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const sample = (e: ReactPointerEvent<HTMLDivElement>, at: Point): Sample => ({ pointer: e.pointerId, x: at.x, y: at.y, t: e.timeStamp });
  const ended = (pointer: number): void => {
    downs.current.delete(pointer);
    if (downs.current.size === 0) last.current = null;
  };
  const lost = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType !== "touch") return;
    const events = live().cancel(e.pointerId);
    ended(e.pointerId);
    handle.current(events);
  };

  return {
    root,
    handlers: {
      onPointerDown: (e) => {
        if (e.pointerType !== "touch") return;
        const g = live();
        if (e.isPrimary && downs.current.size > 0) reset.current(g);
        const at = pointOf(e);
        downs.current.set(e.pointerId, at);
        handle.current(g.down(sample(e, at), touchHit(p.mounted, p.geo, e.target, at)));
      },
      onPointerMove: (e) => {
        const from = downs.current.get(e.pointerId);
        if (e.pointerType !== "touch" || from === undefined) return;
        const at = pointOf(e);
        last.current = { from, at };
        handle.current(live().move(sample(e, at)));
      },
      onPointerUp: (e) => {
        if (e.pointerType !== "touch") return;
        const at = pointOf(e);
        const events = live().up(sample(e, at), rowAt(p.mounted, at.y)?.row.id ?? null);
        ended(e.pointerId);
        handle.current(events);
      },
      onPointerCancel: lost,
      onLostPointerCapture: lost,
    },
  };
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
  const [first, last] = p.window;
  const rowOf = (id: ItemId): number | null => {
    const index = p.index.get(id);
    return index === undefined || geo.span(id) === null ? null : index;
  };
  const endAt = (id: ItemId, index: number): End => endOf(geo, itemOf(view, id), index * ROW + ROW / 2);
  const paths = liveLinks(view.plan).flatMap((l) => {
    const from = rowOf(l.from);
    const to = rowOf(l.to);
    if (from === null || to === null || Math.max(from, to) < first || Math.min(from, to) >= last) return [];
    const pred = endAt(l.from, from);
    const succ = endAt(l.to, to);
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
  const marker = (id: string, tone: "hot" | "bad" | undefined) => (
    <marker id={id} className={tone} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" />
    </marker>
  );
  return (
    <svg className="tl-links" width={geo.width} height={p.height} aria-hidden="true">
      <defs>
        {marker("arr", undefined)}
        {marker("arrHot", "hot")}
        {marker("arrBad", "bad")}
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
  const { root, handlers } = useTouch(p);
  return (
    <div className="tl-chart" ref={root} style={{ width: geo.width, height }} {...handlers}>
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
