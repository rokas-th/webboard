import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Refused, type Intent } from "../../actions/intents";
import { toDay, type Day } from "../../domain/dates";
import type { ItemId, LinkType, PlanId } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { EMPTY_PLAN } from "../copy";
import { useRun } from "../run";
import { useUiValue, type Zoom } from "../state";
import { Chart, itemOf, rowAt, type DropGhost, type Point, type TempLink, type TouchHost } from "./Chart";
import { fitSpan, geometry, leadFor, ROW, type Geometry } from "./geometry";
import { gestureIntent, isClick, startIntent } from "./gesture";
import { Grid, type Marks, type Placed } from "./Grid";
import { timelineRows, visibleRange } from "./rows";
import { Scale } from "./Scale";
import type { Handle } from "./touch";

type Mode = "move" | "resize" | "start" | "link" | "select" | "blank";

interface Drag {
  mode: Mode;
  item: ItemId | null;
  down: { x: number; y: number };
  from: { x: number; y: number };
}

const marksOf = (view: PlanView): Marks => {
  const early = new Map<ItemId, { pred: ItemId; type: LinkType; doneOrDoing: boolean }>();
  const badLinks = new Set<string>();
  const dayoff = new Map<ItemId, number>();
  view.derived.conflicts.forEach((c) => {
    if (c.kind === "dayoff") {
      dayoff.set(c.item, c.shownFrom);
      return;
    }
    badLinks.add(c.link);
    if (c.kind !== "early" || early.has(c.succ)) return;
    const link = view.plan.links.get(c.link);
    if (link === undefined) throw new Error(`Conflict link ${c.link} is not in the plan`);
    early.set(c.succ, { pred: c.pred, type: link.type, doneOrDoing: c.succLock === "done" || c.succLock === "doing" });
  });
  return { early, badLinks, dayoff };
};

export const chartWidth = (scroller: HTMLElement): number => {
  const grid = scroller.querySelector(".tl-grid");
  if (!(grid instanceof HTMLElement)) throw new Error("Timeline: no task column to lead past");
  return scroller.clientWidth - grid.offsetWidth;
};

const leadIn = (scroller: HTMLElement): number => leadFor(chartWidth(scroller));

const headHeight = (scroller: HTMLElement): number => {
  const head = scroller.querySelector(".tl-head");
  if (!(head instanceof HTMLElement)) throw new Error("Timeline: no header to reveal under");
  return head.offsetHeight;
};

const openingDay = (view: PlanView, today: Day): Day => {
  const starts = [...view.derived.start.values()];
  const ends = [...view.derived.end.values()];
  if (starts.length === 0 || ends.length === 0) return today;
  const first = Math.min(...starts);
  return today < first || today > Math.max(...ends) ? first : today;
};

interface Place {
  plan: PlanId;
  zoom: Zoom;
  origin: Day;
  ppd: number;
  left: number;
}

const isEmptyPlan = (view: PlanView, rows: number): boolean => rows === 0 && [...view.plan.items.values()].every((i) => i.trashed);

const MODE: Readonly<Record<Handle, Mode>> = { body: "move", end: "resize", start: "start", link: "link" };

function intentOf(geo: Geometry, mode: Mode, item: ItemId, dxPx: number): Intent | null {
  if (mode === "move" || mode === "resize") return gestureIntent(geo, { kind: mode, item, dxPx });
  if (mode === "start") return startIntent(geo, item, dxPx);
  return null;
}

function landing(geo: Geometry, view: PlanView, item: ItemId, intent: Intent): { start: Day; end: Day } {
  const span = geo.span(item);
  if (span === null) throw new Error(`Timeline row ${item} has no dates`);
  const cal = geo.cal;
  if (intent.t === "move") {
    const start = intent.days >= 0 ? cal.addWork(span.start, intent.days) : cal.subWork(span.start, -intent.days);
    const milestone = itemOf(view, item).kind === "milestone";
    return { start, end: milestone ? start : cal.addWork(start, cal.workBetween(span.start, span.end) - 1) };
  }
  if (intent.t === "resize") return { start: span.start, end: cal.addWork(span.start, intent.dur - 1) };
  if (intent.t === "schedule" && intent.set.start !== undefined && intent.set.start !== null) return { start: toDay(intent.set.start), end: span.end };
  throw new Error(`Timeline: a ${intent.t} drag has no landing`);
}

export function Timeline(p: { session: PlanSession; readOnly?: boolean }) {
  const readOnly = p.readOnly ?? false;
  const view = usePlanView(p.session);
  const { ui, setUi } = useUiValue();
  const { run } = useRun(p.session);
  const [width, setWidth] = useState(0);
  const fitWidth = ui.zoom === "F" ? width : undefined;
  const geo = useMemo(() => geometry(view, ui.zoom, fitWidth), [view, ui.zoom, fitWidth]);
  const rows = useMemo(() => timelineRows(view, ui.collapsed), [view, ui.collapsed]);
  const marks = useMemo(() => marksOf(view), [view]);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const place = useRef<Place | null>(null);
  const previewed = useRef<{ key: string; view: PlanView; label: string } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [ghost, setGhost] = useState<DropGhost | null>(null);
  const [temp, setTemp] = useState<TempLink | null>(null);
  const [dragging, setDragging] = useState<ItemId | null>(null);
  const empty = isEmptyPlan(view, rows.length);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) throw new Error("Timeline: no scroller");
    const measure = (): void => {
      setHeight(el.clientHeight);
      if (!empty) setWidth(chartWidth(el));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [empty]);

  const today = toDay(view.today);
  const planId = view.plan.id;
  const opening = useMemo(() => openingDay(view, today), [view, today]);
  const fitFirst = useMemo(() => fitSpan(view).first, [view]);
  const fit = ui.zoom === "F";

  const scrollTo = (el: HTMLElement, left: number): void => {
    el.scrollLeft = Math.max(0, left);
    const at = place.current;
    if (at !== null) place.current = { ...at, left: el.scrollLeft };
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) throw new Error("Timeline: no scroller");
    if (empty) return;
    const prev = place.current;
    const lead = leadIn(el);
    if (prev === null || prev.plan !== planId) el.scrollLeft = Math.max(0, fit ? geo.x(fitFirst) : geo.x(opening) - lead);
    else if (fit && (prev.zoom !== "F" || prev.origin !== geo.origin || prev.ppd !== geo.ppd)) el.scrollLeft = Math.max(0, geo.x(fitFirst));
    else if (prev.origin !== geo.origin || prev.ppd !== geo.ppd) {
      const day = prev.origin + (prev.left + lead) / prev.ppd;
      el.scrollLeft = Math.max(0, Math.round((day - geo.origin) * geo.ppd - lead));
    }
    place.current = { plan: planId, zoom: ui.zoom, origin: geo.origin, ppd: geo.ppd, left: el.scrollLeft };
  }, [planId, empty, geo, opening, fit, fitFirst, ui.zoom]);

  const index = useMemo(() => new Map(rows.map((r, i) => [r.id, i] as const)), [rows]);

  const reveal = ui.reveal;
  useLayoutEffect(() => {
    if (reveal === null) return;
    const el = scroller.current;
    if (el === null) throw new Error("Timeline: no scroller");
    if (reveal === "today") {
      if (!empty) scrollTo(el, geo.x(today) - leadIn(el));
      setUi({ reveal: null });
      return;
    }
    const at = index.get(reveal);
    if (at === undefined) throw new Error(`Timeline: no row for ${reveal} to reveal`);
    el.scrollTop = at * ROW;
    setScrollTop(el.scrollTop);
    const span = geo.span(reveal);
    if (span !== null) scrollTo(el, geo.x(span.start) - leadIn(el));
    setUi({ reveal: null });
  }, [reveal, index, geo, today, empty, setUi]);

  const follow = ui.follow;
  useLayoutEffect(() => {
    if (follow === null) return;
    const el = scroller.current;
    if (el === null) throw new Error("Timeline: no scroller");
    const at = index.get(follow);
    if (at === undefined) throw new Error(`Timeline: no row for ${follow} to keep in view`);
    const top = at * ROW;
    const shown = el.clientHeight - headHeight(el);
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + shown) el.scrollTop = Math.min(top, top + ROW - shown);
    setScrollTop(el.scrollTop);
    const span = geo.span(follow);
    if (span !== null) {
      const x0 = geo.x(span.start);
      const x1 = geo.x(span.end) + geo.ppd;
      if (x1 <= el.scrollLeft || x0 >= el.scrollLeft + chartWidth(el)) scrollTo(el, x0 - leadIn(el));
    }
    setUi({ follow: null });
  }, [follow, index, geo, setUi]);

  const cancel = (): void => {
    drag.current = null;
    previewed.current = null;
    setGhost(null);
    setTemp(null);
    setDragging(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || drag.current === null) return;
      e.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const [first, last] = visibleRange(scrollTop, height, rows.length);
  const mounted: Placed[] = rows.slice(first, last).map((row, i) => ({ row, index: first + i }));
  const indexOf = (id: ItemId): number => index.get(id) ?? -1;

  const chartPoint = (e: ReactPointerEvent): { x: number; y: number } => {
    const chart = e.currentTarget.querySelector(".tl-chart");
    if (chart === null) throw new Error("Timeline: no chart");
    const r = chart.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === "touch" || e.button !== 0 || !(e.target instanceof Element)) return;
    const down = { x: e.clientX, y: e.clientY };
    const nub = e.target.closest("[data-nub]");
    const bar = e.target.closest("[data-bar]");
    if (nub === null && bar === null) {
      drag.current = e.target.closest(".tl-chart") === null ? null : { mode: "blank", item: null, down, from: down };
      return;
    }
    const id = nub instanceof HTMLElement ? nub.dataset.nub : bar instanceof HTMLElement ? bar.dataset.bar : undefined;
    if (id === undefined) throw new Error("Timeline: a bar or nub without an item id");
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const handle = e.target.closest("[data-h]");
    const side = handle instanceof HTMLElement ? handle.dataset.h : undefined;
    const mode: Mode = readOnly ? "select" : nub !== null ? "link" : side === "l" ? "start" : side === "r" ? "resize" : "move";
    drag.current = { mode, item: id, down, from: chartPoint(e) };
  };

  const previewLabel = (intent: Intent): string => {
    const key = JSON.stringify(intent);
    if (previewed.current !== null && previewed.current.key === key && previewed.current.view === view) return previewed.current.label;
    const label = ((): string => {
      try {
        return `moves ${p.session.preview(intent).itemsChanged}`;
      } catch (e) {
        if (e instanceof Refused) return e.message;
        throw e;
      }
    })();
    previewed.current = { key, view, label };
    return label;
  };

  const show = (item: ItemId, mode: Mode, dx: number, from: Point, at: Point, lifted: boolean): void => {
    const index = indexOf(item);
    if (index < 0) {
      cancel();
      return;
    }
    if (mode === "link") {
      setTemp({ x0: from.x, y0: from.y, x1: at.x, y1: at.y });
      return;
    }
    setDragging(lifted || Math.abs(dx) >= 4 ? item : null);
    const intent = intentOf(geo, mode, item, dx);
    if (intent === null) {
      setGhost(null);
      return;
    }
    const span = landing(geo, view, item, intent);
    const milestone = itemOf(view, item).kind === "milestone";
    const left = milestone ? geo.x(span.start) + geo.ppd / 2 - 7 : geo.x(span.start);
    const width = milestone ? 14 : geo.x(span.end) - geo.x(span.start) + geo.ppd;
    setGhost({ item, left, width, top: index * ROW + 8, label: previewLabel(intent) });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || d.item === null || d.mode === "select" || d.mode === "blank") return;
    show(d.item, d.mode, e.clientX - d.down.x, d.from, chartPoint(e), false);
  };

  const touch: TouchHost = {
    has: (item) => indexOf(item) >= 0,
    pick: (item, handle) => {
      if (handle !== "link") setDragging(item);
    },
    drag: (item, handle, dx, from, at) => show(item, MODE[handle], dx, from, at, true),
    drop: (item, handle, dx, target) => {
      cancel();
      const intent =
        handle === "link" ? gestureIntent(geo, { kind: "link", item, dxPx: dx, target: target ?? undefined }) : intentOf(geo, MODE[handle], item, dx);
      if (intent !== null) run(intent);
    },
    clear: cancel,
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === "touch") return;
    const d = drag.current;
    cancel();
    if (d === null) return;
    const up = { x: e.clientX, y: e.clientY };
    const click = isClick(d.down, up);
    if (d.mode === "blank") {
      if (click) setUi({ selected: null });
      return;
    }
    if (d.item === null || indexOf(d.item) < 0) return;
    if (d.mode === "link") {
      const hit = document.elementFromPoint(up.x, up.y);
      const target = hit === null ? null : hit.closest("[data-bar],[data-row]");
      const under = hit === null || hit.closest(".tl-chart") === null ? null : rowAt(mounted, chartPoint(e).y);
      const to = target instanceof HTMLElement ? (target.dataset.bar ?? target.dataset.row) : under === null ? undefined : under.row.id;
      const intent = gestureIntent(geo, { kind: "link", item: d.item, dxPx: up.x - d.down.x, target: to });
      if (intent !== null) run(intent);
      else if (click) setUi({ selected: d.item });
      return;
    }
    if (click) {
      setUi({ selected: d.item });
      return;
    }
    const intent = intentOf(geo, d.mode, d.item, up.x - d.down.x);
    if (intent !== null) run(intent);
  };

  return (
    <div
      className="tl-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        setScrollTop(el.scrollTop);
        const at = place.current;
        if (at !== null) place.current = { ...at, left: el.scrollLeft };
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(e) => {
        if (e.pointerType !== "touch") cancel();
      }}
    >
      {empty ? (
        <p className="tl-empty">{EMPTY_PLAN}</p>
      ) : (
        <div className="tl-canvas" style={{ width: `calc(var(--grid-w) + ${geo.width}px)` }}>
          <Scale geo={geo} today={today} missing={view.derived.missingYears} />
          <div className="tl-body">
            <Grid mounted={mounted} count={rows.length} view={view} geo={geo} marks={marks} ui={ui} setUi={setUi} />
            <Chart
              view={view}
              geo={geo}
              zoom={ui.zoom}
              ui={ui}
              setUi={setUi}
              mounted={mounted}
              index={index}
              range={[first, last]}
              count={rows.length}
              marks={marks}
              readOnly={readOnly}
              dragging={dragging}
              ghost={ghost}
              temp={temp}
              touch={touch}
            />
          </div>
        </div>
      )}
    </div>
  );
}
