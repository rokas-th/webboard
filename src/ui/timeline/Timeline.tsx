import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Refused, type Intent } from "../../actions/intents";
import { toDay, type Day } from "../../domain/dates";
import type { ItemId } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { useRun } from "../run";
import { useUiValue } from "../state";
import { Chart, type DropGhost, type TempLink } from "./Chart";
import { geometry, ROW, type Geometry } from "./geometry";
import { gestureIntent, isClick, startIntent } from "./gesture";
import { Grid, type Marks, type Placed } from "./Grid";
import { timelineRows, visibleRange } from "./rows";
import { Scale } from "./Scale";

export const EMPTY_PLAN = "No items yet. Add one with + Task.";

type Mode = "move" | "resize" | "start" | "link" | "select" | "blank";

interface Drag {
  mode: Mode;
  item: ItemId | null;
  down: { x: number; y: number };
  from: { x: number; y: number };
}

const marksOf = (view: PlanView): Marks => {
  const early = new Map<ItemId, { pred: ItemId; doneOrDoing: boolean }>();
  const badLinks = new Set<string>();
  const dayoff = new Map<ItemId, number>();
  view.derived.conflicts.forEach((c) => {
    if (c.kind === "dayoff") {
      dayoff.set(c.item, c.shownFrom);
      return;
    }
    badLinks.add(c.link);
    if (c.kind === "early" && !early.has(c.succ)) early.set(c.succ, { pred: c.pred, doneOrDoing: c.succLock === "done" || c.succLock === "doing" });
  });
  return { early, badLinks, dayoff };
};

const isEmptyPlan = (view: PlanView, rows: number): boolean => rows === 0 && [...view.plan.items.values()].every((i) => i.trashed);

function intentOf(geo: Geometry, d: Drag, dxPx: number): Intent | null {
  if (d.item === null) return null;
  if (d.mode === "move" || d.mode === "resize") return gestureIntent(geo, { kind: d.mode, item: d.item, dxPx });
  if (d.mode === "start") return startIntent(geo, d.item, dxPx);
  return null;
}

function landing(geo: Geometry, view: PlanView, intent: Intent): { start: Day; end: Day } | null {
  const id = intent.t === "move" ? intent.items[0] : intent.t === "resize" || intent.t === "schedule" ? intent.item : null;
  const span = id === null ? null : geo.span(id);
  if (id === null || span === null) return null;
  const cal = geo.cal;
  if (intent.t === "move") {
    const start = intent.days >= 0 ? cal.addWork(span.start, intent.days) : cal.subWork(span.start, -intent.days);
    const milestone = view.plan.items.get(id)?.kind === "milestone";
    return { start, end: milestone ? start : cal.addWork(start, cal.workBetween(span.start, span.end) - 1) };
  }
  if (intent.t === "resize") return { start: span.start, end: cal.addWork(span.start, intent.dur - 1) };
  if (intent.t === "schedule" && intent.set.start !== undefined && intent.set.start !== null) return { start: toDay(intent.set.start), end: span.end };
  return null;
}

export function Timeline(p: { session: PlanSession; readOnly?: boolean }) {
  const readOnly = p.readOnly ?? false;
  const view = usePlanView(p.session);
  const { ui, setUi } = useUiValue();
  const { run } = useRun(p.session);
  const geo = useMemo(() => geometry(view, ui.zoom), [view, ui.zoom]);
  const rows = useMemo(() => timelineRows(view, ui.collapsed), [view, ui.collapsed]);
  const marks = useMemo(() => marksOf(view), [view]);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const scrolledFor = useRef<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [ghost, setGhost] = useState<DropGhost | null>(null);
  const [temp, setTemp] = useState<TempLink | null>(null);
  const [dragging, setDragging] = useState<ItemId | null>(null);
  const empty = isEmptyPlan(view, rows.length);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) throw new Error("Timeline: no scroller");
    setHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const today = toDay(view.today);
  const scrollKey = `${view.plan.id}:${ui.zoom}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || empty || scrolledFor.current === scrollKey) return;
    scrolledFor.current = scrollKey;
    el.scrollLeft = Math.max(0, geo.x(today) - 160);
  }, [scrollKey, empty, geo, today]);

  const cancel = (): void => {
    drag.current = null;
    setGhost(null);
    setTemp(null);
    setDragging(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && drag.current !== null) cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [first, last] = visibleRange(scrollTop, height, rows.length);
  const mounted: Placed[] = rows.slice(first, last).map((row, i) => ({ row, index: first + i }));
  const indexOf = (id: ItemId): number => rows.findIndex((r) => r.id === id);

  const chartPoint = (e: ReactPointerEvent): { x: number; y: number } => {
    const chart = e.currentTarget.querySelector(".tl-chart");
    if (chart === null) throw new Error("Timeline: no chart");
    const r = chart.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const down = { x: e.clientX, y: e.clientY };
    const nub = e.target.closest("[data-nub]");
    const bar = e.target.closest("[data-bar]");
    if (nub === null && bar === null) {
      drag.current = e.target.closest(".tl-chart") === null ? null : { mode: "blank", item: null, down, from: down };
      return;
    }
    const id = nub instanceof HTMLElement ? nub.dataset.nub : bar instanceof HTMLElement ? bar.dataset.bar : undefined;
    if (id === undefined) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const handle = e.target.closest("[data-h]");
    const side = handle instanceof HTMLElement ? handle.dataset.h : undefined;
    const mode: Mode = readOnly ? "select" : nub !== null ? "link" : side === "l" ? "start" : side === "r" ? "resize" : "move";
    drag.current = { mode, item: id, down, from: chartPoint(e) };
  };

  const previewLabel = (intent: Intent): string => {
    try {
      return `moves ${p.session.preview(intent).itemsChanged}`;
    } catch (e) {
      if (e instanceof Refused) return e.message;
      throw e;
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || d.item === null || d.mode === "select" || d.mode === "blank") return;
    if (d.mode === "link") {
      const pt = chartPoint(e);
      setTemp({ x0: d.from.x, y0: d.from.y, x1: pt.x, y1: pt.y });
      return;
    }
    const dx = e.clientX - d.down.x;
    if (Math.abs(dx) >= 4) setDragging(d.item);
    const intent = intentOf(geo, d, dx);
    const span = intent === null ? null : landing(geo, view, intent);
    if (intent === null || span === null) {
      setGhost(null);
      return;
    }
    const milestone = view.plan.items.get(d.item)?.kind === "milestone";
    const left = milestone ? geo.x(span.start) + geo.ppd / 2 - 7 : geo.x(span.start);
    const width = milestone ? 14 : geo.x(span.end) - geo.x(span.start) + geo.ppd;
    setGhost({ item: d.item, left, width, top: indexOf(d.item) * ROW + 8, label: previewLabel(intent) });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    cancel();
    if (d === null) return;
    const up = { x: e.clientX, y: e.clientY };
    const click = isClick(d.down, up);
    if (d.mode === "blank") {
      if (click) setUi({ selected: null });
      return;
    }
    if (d.item === null) return;
    if (d.mode === "link") {
      const hit = document.elementFromPoint(up.x, up.y);
      const target = hit === null ? null : hit.closest("[data-bar],[data-row]");
      const to = target instanceof HTMLElement ? (target.dataset.bar ?? target.dataset.row) : undefined;
      const intent = gestureIntent(geo, { kind: "link", item: d.item, dxPx: up.x - d.down.x, target: to });
      if (intent !== null) run(intent);
      else if (click) setUi({ selected: d.item });
      return;
    }
    if (click) {
      setUi({ selected: d.item });
      return;
    }
    const intent = intentOf(geo, d, up.x - d.down.x);
    if (intent !== null) run(intent);
  };

  return (
    <div
      className="tl-scroll"
      ref={scroller}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancel}
    >
      {empty ? (
        <p className="tl-empty">{EMPTY_PLAN}</p>
      ) : (
        <div className="tl-canvas" style={{ width: `calc(var(--grid-w) + ${geo.width}px)` }}>
          <Scale geo={geo} zoom={ui.zoom} today={today} missing={view.derived.missingYears} />
          <div className="tl-body">
            <Grid mounted={mounted} count={rows.length} view={view} geo={geo} marks={marks} ui={ui} setUi={setUi} />
            <Chart
              view={view}
              geo={geo}
              zoom={ui.zoom}
              ui={ui}
              mounted={mounted}
              count={rows.length}
              marks={marks}
              readOnly={readOnly}
              dragging={dragging}
              ghost={ghost}
              temp={temp}
            />
          </div>
        </div>
      )}
    </div>
  );
}
