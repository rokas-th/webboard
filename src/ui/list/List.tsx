import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ItemId } from "../../domain/model";
import { readPlatform } from "../../platform";
import { haptic } from "../../services/haptics";
import { useNotes, usePlanView, type PlanSession } from "../../store/session";
import { HoldGesture, type HoldEvent } from "../board/hold";
import type { Point } from "../common/ContextMenu";
import { pointBelow, usePickMenu } from "../common/pickMenu";
import { EMPTY_PLAN } from "../copy";
import { useDetail } from "../detail/DetailContext";
import { useDateStyle, useLook, useMe } from "../DeviceProvider";
import { mineLine, MineNote } from "./MineNote";
import { useUiValue } from "../state";
import { isClick } from "../timeline/gesture";
import { dropIndex, fitWidth, minWidthOn, moveColumn, resizeColumn } from "./columnOps";
import { columnById, rowContext, type ColumnSpec, type RowContext } from "./columns";
import { ColumnsPopover } from "./ColumnsPopover";
import { headMenu, runHeadRow } from "./headMenu";
import { ListBar } from "./ListBar";
import { listModel, planOrder, sortClick, type ListSection } from "./model";
import { MAX_WIDTH, useListPrefs, writeListPrefs, type ColumnId, type ListPrefs } from "./prefs";
import { COLUMN_MENU, COLUMNS_TITLE, nothingText, resizeLabel, SORT_DOWN, SORT_TITLE, SORT_UP, sortDirText, sortRankText } from "./text";
import { listWindow, rowPx } from "./window";
import { searchMatcher } from "../search/match";

type Entry = { kind: "group"; section: ListSection; count: number } | { kind: "row"; id: ItemId };

interface Port {
  top: number;
  height: number;
}

interface Shown {
  spec: ColumnSpec;
  w: number;
  min: number;
}

interface HeadPress {
  id: ColumnId;
  pointer: number;
  x: number;
  y: number;
  mode: "press" | "drag" | "dead";
  to: number;
}

interface EdgePress {
  id: ColumnId;
  pointer: number;
  x: number;
  y: number;
  w0: number;
  w: number;
  min: number;
  moved: boolean;
}

interface Drop {
  id: ColumnId;
  left: number;
  top: number;
}

interface Live {
  id: ColumnId;
  w: number;
}

interface Holding {
  id: ColumnId;
  pointer: number;
}

interface HeadHandlers {
  onSort(id: ColumnId, shift: boolean): void;
  onDown(e: ReactPointerEvent<HTMLTableCellElement>, id: ColumnId): void;
  onMove(e: ReactPointerEvent<HTMLTableCellElement>): void;
  onUp(e: ReactPointerEvent<HTMLTableCellElement>): void;
  onCancel(e: ReactPointerEvent<HTMLTableCellElement>): void;
  onMenu(e: ReactMouseEvent<HTMLTableCellElement>, id: ColumnId): void;
  onSortKey(e: ReactKeyboardEvent<HTMLButtonElement>, id: ColumnId): void;
  onEdgeDown(e: ReactPointerEvent<HTMLSpanElement>, col: Shown): void;
  onEdgeMove(e: ReactPointerEvent<HTMLSpanElement>): void;
  onEdgeUp(e: ReactPointerEvent<HTMLSpanElement>): void;
  onEdgeCancel(e: ReactPointerEvent<HTMLSpanElement>): void;
  onEdgeKey(e: ReactKeyboardEvent<HTMLSpanElement>, col: Shown): void;
  onFit(id: ColumnId): void;
}

const RESIZING = "col-resizing";
const EDGE_STEP = 8;
const EDGE_STEP_BIG = 32;

const entriesOf = (sections: readonly ListSection[], ghosts: ReadonlySet<ItemId>): Entry[] =>
  sections.flatMap((s): Entry[] => {
    const heading: Entry[] = s.title === "" ? [] : [{ kind: "group", section: s, count: s.rows.filter((id) => !ghosts.has(id)).length }];
    return [...heading, ...s.rows.map((id): Entry => ({ kind: "row", id }))];
  });

const ariaSort = (prefs: ListPrefs, id: ColumnId): "ascending" | "descending" | undefined => {
  const primary = prefs.sort[0];
  if (primary === undefined || primary.id !== id) return undefined;
  return primary.dir === "asc" ? "ascending" : "descending";
};

const cellClass = (spec: ColumnSpec, empty: boolean): string | undefined => {
  const classes = [spec.id === "name" ? "item" : "", spec.align === "end" ? "end" : "", empty ? "nil" : ""].filter((c) => c !== "");
  return classes.length === 0 ? undefined : classes.join(" ");
};

const headClass = (spec: ColumnSpec, dragging: boolean, lifted: boolean): string | undefined => {
  const classes = [spec.align === "end" ? "end" : "", dragging ? "dragging" : "", lifted ? "lifted" : ""].filter((c) => c !== "");
  return classes.length === 0 ? undefined : classes.join(" ");
};

const px = (v: string, what: string): number => {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`List: ${what} is ${JSON.stringify(v)}, not a length`);
  return n;
};

const leavesOf = (n: Node): Node[] => {
  if (n.nodeType === Node.TEXT_NODE) return n.textContent === "" ? [] : [n];
  if (n instanceof Element && n.textContent === "") return [n];
  return [...n.childNodes].flatMap(leavesOf);
};

const rangeRect = (n: Node): DOMRect => {
  const r = document.createRange();
  if (n.nodeType === Node.TEXT_NODE) r.selectNodeContents(n);
  else r.selectNode(n);
  return r.getBoundingClientRect();
};

const contentWidth = (root: Element): number => {
  const boxes = [...root.childNodes].flatMap(leavesOf).map(rangeRect).filter((r) => r.width > 0 || r.height > 0);
  if (boxes.length === 0) return 0;
  return Math.max(...boxes.map((b) => b.right)) - Math.min(...boxes.map((b) => b.left));
};

const padX = (cell: Element): number => {
  const s = getComputedStyle(cell);
  return px(s.paddingLeft, "a List cell's padding-left") + px(s.paddingRight, "a List cell's padding-right");
};

function ColumnsGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6" y1="3" x2="6" y2="13" />
      <line x1="10" y1="3" x2="10" y2="13" />
    </svg>
  );
}

function Head(p: { cols: readonly Shown[]; prefs: ListPrefs; dragging: ColumnId | null; lifted: ColumnId | null; headRef: RefObject<HTMLTableSectionElement | null>; on: HeadHandlers }) {
  const ranked = p.prefs.sort.length >= 2;
  const base = useId();
  const { on } = p;
  return (
    <thead ref={p.headRef}>
      <tr>
        {p.cols.map((col, i) => {
          const { spec, w } = col;
          const rank = p.prefs.sort.findIndex((s) => s.id === spec.id);
          const key = rank < 0 ? null : p.prefs.sort[rank];
          const described = `${base}-${spec.id}`;
          return (
            <th
              key={spec.id}
              data-col={spec.id}
              aria-sort={ariaSort(p.prefs, spec.id)}
              className={headClass(spec, p.dragging === spec.id, p.lifted === spec.id)}
              style={{ zIndex: 2 + p.cols.length - i }}
              onPointerDown={(e) => on.onDown(e, spec.id)}
              onPointerMove={(e) => on.onMove(e)}
              onPointerUp={(e) => on.onUp(e)}
              onPointerCancel={(e) => on.onCancel(e)}
              onContextMenu={(e) => on.onMenu(e, spec.id)}
            >
              <span className="th-in">
                <button
                  type="button"
                  className="th-sort"
                  title={SORT_TITLE}
                  aria-describedby={key === null ? undefined : described}
                  onClick={(e: ReactMouseEvent<HTMLButtonElement>) => {
                    if (e.detail === 0) on.onSort(spec.id, e.shiftKey);
                  }}
                  onKeyDown={(e) => on.onSortKey(e, spec.id)}
                >
                  {spec.title}
                </button>
                {key !== null && (
                  <span className="sort-chev" data-dir={key.dir} aria-hidden="true">
                    {key.dir === "asc" ? SORT_UP : SORT_DOWN}
                    {ranked && <span className="sort-rank">{rank + 1}</span>}
                  </span>
                )}
              </span>
              {key !== null && (
                <span id={described} className="sort-said">
                  {ranked ? sortRankText(rank + 1, p.prefs.sort.length, key.dir) : sortDirText(key.dir)}
                </span>
              )}
              <span
                className="th-edge"
                data-col={spec.id}
                role="separator"
                aria-orientation="vertical"
                aria-label={resizeLabel(spec.title)}
                aria-valuenow={w}
                aria-valuemin={col.min}
                aria-valuemax={MAX_WIDTH}
                tabIndex={0}
                onPointerDown={(e) => on.onEdgeDown(e, col)}
                onPointerMove={(e) => on.onEdgeMove(e)}
                onPointerUp={(e) => on.onEdgeUp(e)}
                onPointerCancel={(e) => on.onEdgeCancel(e)}
                onKeyDown={(e) => on.onEdgeKey(e, col)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  on.onFit(spec.id);
                }}
              />
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

export function List(p: { session: PlanSession }) {
  const view = usePlanView(p.session);
  const plan = view.plan.id;
  const prefs = useListPrefs(plan);
  const { ui, setUi } = useUiValue();
  const q = ui.query.trim();
  const notesSeen = useNotes(p.session, q !== "" || prefs.cols.some((c) => c.id === "note"));
  const detail = useDetail();
  const menu = usePickMenu(COLUMN_MENU);
  const down = useRef<{ id: ItemId; x: number; y: number } | null>(null);
  const headPress = useRef<HeadPress | null>(null);
  const edgePress = useRef<EdgePress | null>(null);
  const refocus = useRef<ColumnId | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLTableSectionElement>(null);
  const scrolledFor = useRef<ItemId | null>(null);
  const [port, setPort] = useState<Port>({ top: 0, height: 0 });
  const [drop, setDrop] = useState<Drop | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [lifted, setLifted] = useState<ColumnId | null>(null);
  const [colsAt, setColsAt] = useState<HTMLElement | null>(null);
  const colsBtn = useRef<HTMLButtonElement>(null);
  const asked = useRef(ui.columnsAsk);
  const gesture = useRef<HoldGesture | null>(null);
  const holding = useRef<Holding | null>(null);
  const onHoldRef = useRef<(events: readonly HoldEvent[]) => void>(() => undefined);
  const lostRef = useRef<(e: PointerEvent) => void>(() => undefined);
  const stopScroll = useRef<(() => void) | null>(null);
  const os = readPlatform(window).os;
  const ios = os === "ios";
  const session = p.session;
  const style = useDateStyle();
  const me = useMe(plan);
  const ctx: RowContext = useMemo(() => rowContext(view, (id) => session.note(id).toString(), me, style), [view, session, notesSeen, me, style]);
  const match = useMemo(() => searchMatcher(ctx, q), [ctx, q]);
  const model = useMemo(() => listModel(ctx, prefs, match), [ctx, prefs, match]);
  const listed = useMemo(() => planOrder(ctx).length, [ctx]);
  const cols: Shown[] = useMemo(
    () =>
      prefs.cols.map((c) => {
        const min = minWidthOn(c.id, ios, style.format);
        return { spec: columnById(c.id), w: Math.max(min, live !== null && live.id === c.id ? live.w : c.w), min };
      }),
    [prefs, live, ios, style.format],
  );
  const width = cols.reduce((sum, c) => sum + c.w, 0);
  const entries = useMemo(() => entriesOf(model.sections, ctx.ghosts), [model, ctx]);
  const rowH = rowPx(useLook().density);
  const win = listWindow(port.top, port.height, entries.length, rowH);
  const selectedAt = ui.selected === null ? -1 : entries.findIndex((e) => e.kind === "row" && e.id === ui.selected);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (el === null) throw new Error("List: no scroller");
    const measure = (): void => setPort({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (scrolledFor.current === ui.selected) return;
    scrolledFor.current = ui.selected;
    if (selectedAt < 0) return;
    const el = wrap.current;
    if (el === null) throw new Error("List: no scroller");
    const thead = head.current;
    if (thead === null) throw new Error("List: no header");
    const headH = thead.offsetHeight;
    const top = selectedAt * rowH;
    const bottom = headH + (selectedAt + 1) * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    else return;
    setPort({ top: el.scrollTop, height: el.clientHeight });
  }, [ui.selected, selectedAt, rowH]);

  useLayoutEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    const button = head.current?.querySelector<HTMLButtonElement>(`th[data-col="${id}"] .th-sort`);
    if (button === null || button === undefined) throw new Error(`List: no header ${id} to focus`);
    button.focus();
  }, [prefs]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const h = headPress.current;
      const edge = edgePress.current;
      if ((h === null || h.mode !== "drag") && edge === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (h !== null) h.mode = "dead";
      edgePress.current = null;
      document.documentElement.classList.remove(RESIZING);
      setDrop(null);
      setLive(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.documentElement.classList.remove(RESIZING);
    };
  }, []);

  useEffect(() => {
    if (asked.current === ui.columnsAsk) return;
    asked.current = ui.columnsAsk;
    const b = colsBtn.current;
    if (b === null) throw new Error("List: asked for Columns without the Columns button");
    setColsAt(b);
  }, [ui.columnsAsk]);

  useEffect(() => {
    const lost = (e: PointerEvent): void => lostRef.current(e);
    window.addEventListener("pointerup", lost);
    window.addEventListener("pointercancel", lost);
    return () => {
      window.removeEventListener("pointerup", lost);
      window.removeEventListener("pointercancel", lost);
      const g = gesture.current;
      if (g !== null) g.cancelAll();
      holding.current = null;
      const unblock = stopScroll.current;
      stopScroll.current = null;
      if (unblock !== null) unblock();
    };
  }, []);

  const setPrefs = (next: ListPrefs): void => {
    writeListPrefs(window.localStorage, plan, next);
  };

  const onSort = (id: ColumnId, shift: boolean): void => {
    setPrefs(sortClick(prefs, id, shift));
  };

  const headCells = (): HTMLTableCellElement[] => {
    const thead = head.current;
    if (thead === null) throw new Error("List: no header");
    return [...thead.querySelectorAll<HTMLTableCellElement>("th[data-col]")];
  };

  const headCell = (id: ColumnId): HTMLTableCellElement => {
    const th = headCells().find((c) => c.dataset.col === id);
    if (th === undefined) throw new Error(`List: no header ${id}`);
    return th;
  };

  const dropAt = (x: number): { to: number; left: number; top: number } => {
    const el = wrap.current;
    if (el === null) throw new Error("List: no scroller");
    const rects = headCells().map((c) => c.getBoundingClientRect());
    const to = dropIndex(
      rects.slice(1).map((r) => (r.left + r.right) / 2),
      x,
    );
    const at = to < rects.length ? rects[to].left : rects[rects.length - 1].right;
    return { to, left: at - el.getBoundingClientRect().left + el.scrollLeft - 1, top: el.scrollTop };
  };

  const fitOf = (id: ColumnId): number => {
    const el = wrap.current;
    if (el === null) throw new Error("List: no scroller");
    const at = cols.findIndex((c) => c.spec.id === id);
    if (at < 0) throw new Error(`List: ${id} is not a shown column`);
    const th = headCell(id);
    const inner = th.querySelector(".th-in");
    if (inner === null) throw new Error(`List: the header ${id} has no title`);
    const cells = [...el.querySelectorAll(`tbody tr[data-lrow] > td:nth-child(${at + 1})`)];
    return fitWidth(cols[at].min, [contentWidth(inner) + padX(th), ...cells.map((td) => contentWidth(td) + padX(td))]);
  };

  const onFit = (id: ColumnId): void => {
    setPrefs(resizeColumn(prefs, id, fitOf(id)));
  };

  const openMenu = (id: ColumnId, anchor: HTMLElement, at: Point): void => {
    menu.open(`head:${id}`, anchor, at, headMenu(prefs, id), (row) => {
      const r = runHeadRow(prefs, id, row);
      if ("prefs" in r) setPrefs(r.prefs);
      else if ("fit" in r) onFit(id);
      else setUi({ columnsAsk: ui.columnsAsk + 1 });
    });
  };

  const moveBy = (id: ColumnId, step: -1 | 1): void => {
    const at = prefs.cols.findIndex((c) => c.id === id);
    if (at < 0) throw new Error(`List: ${id} is not a shown column`);
    const to = step < 0 ? at - 1 : at + 2;
    if (id === "name" || to < 1 || to > prefs.cols.length) return;
    refocus.current = id;
    setPrefs(moveColumn(prefs, id, to));
  };

  const blockScroll = (): void => {
    if (stopScroll.current !== null) return;
    const stop = (e: Event): void => e.preventDefault();
    document.addEventListener("touchmove", stop, { passive: false });
    stopScroll.current = () => document.removeEventListener("touchmove", stop);
  };

  const endLift = (): void => {
    const unblock = stopScroll.current;
    stopScroll.current = null;
    if (unblock !== null) unblock();
    setLifted(null);
    setDrop(null);
  };

  const onHold = (events: readonly HoldEvent[], h: Holding | null): void => {
    if (h === null) {
      if (events.length > 0) throw new Error(`List: a hold emitted ${events.map((e) => e.k).join(", ")} without a held header`);
      return;
    }
    events.forEach((ev) => {
      switch (ev.k) {
        case "tap":
          onSort(h.id, false);
          return;
        case "held":
          blockScroll();
          setLifted(h.id);
          haptic("medium");
          return;
        case "drag": {
          if (h.id === "name") return;
          const d = dropAt(ev.x);
          setDrop({ id: h.id, left: d.left, top: d.top });
          return;
        }
        case "drop": {
          endLift();
          if (h.id === "name") return;
          setPrefs(moveColumn(prefs, h.id, dropAt(ev.x).to));
          return;
        }
        case "menu": {
          endLift();
          const th = headCell(h.id);
          openMenu(h.id, th, pointBelow(th));
          return;
        }
        case "cancel":
          endLift();
          return;
      }
    });
  };

  const gestureOf = (): HoldGesture => {
    const known = gesture.current;
    if (known !== null) return known;
    const made = new HoldGesture({
      schedule: (ms, fn) => {
        const t = window.setTimeout(fn, ms);
        return () => window.clearTimeout(t);
      },
      emit: (events) => onHoldRef.current(events),
    });
    gesture.current = made;
    return made;
  };

  const released = (events: readonly HoldEvent[]): void => {
    const h = holding.current;
    holding.current = null;
    onHold(events, h);
  };

  useLayoutEffect(() => {
    onHoldRef.current = (events) => onHold(events, holding.current);
    lostRef.current = (e) => {
      const h = holding.current;
      if (h === null || h.pointer !== e.pointerId) return;
      released(gestureOf().cancel(e.pointerId));
    };
  });

  const sample = (e: ReactPointerEvent<HTMLElement>) => ({ pointer: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp });

  const touchOnIos = (e: ReactPointerEvent<HTMLElement>): boolean => ios && e.pointerType !== "mouse";

  const notPrimary = (e: ReactPointerEvent<HTMLElement>): boolean => e.button !== 0 || (os === "macos" && e.ctrlKey);

  const handlers: HeadHandlers = {
    onSort,
    onDown: (e, id) => {
      if (touchOnIos(e)) {
        headPress.current = null;
        if (holding.current === null) holding.current = { id, pointer: e.pointerId };
        onHold(gestureOf().down(sample(e)), holding.current);
        return;
      }
      if (notPrimary(e)) {
        headPress.current = null;
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      headPress.current = { id, pointer: e.pointerId, x: e.clientX, y: e.clientY, mode: "press", to: 0 };
    },
    onMove: (e) => {
      if (touchOnIos(e)) {
        onHold(gestureOf().move(sample(e)), holding.current);
        return;
      }
      const h = headPress.current;
      if (h === null || h.pointer !== e.pointerId || h.mode === "dead") return;
      if (h.mode === "press") {
        if (isClick(h, { x: e.clientX, y: e.clientY })) return;
        if (h.id === "name") {
          h.mode = "dead";
          return;
        }
        h.mode = "drag";
      }
      const d = dropAt(e.clientX);
      h.to = d.to;
      setDrop({ id: h.id, left: d.left, top: d.top });
    },
    onUp: (e) => {
      if (touchOnIos(e)) {
        released(gestureOf().up(sample(e)));
        return;
      }
      const h = headPress.current;
      headPress.current = null;
      if (h === null || h.pointer !== e.pointerId) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (h.mode === "drag") {
        setDrop(null);
        setPrefs(moveColumn(prefs, h.id, h.to));
        return;
      }
      if (h.mode === "press" && isClick(h, { x: e.clientX, y: e.clientY })) onSort(h.id, e.shiftKey);
    },
    onCancel: (e) => {
      if (touchOnIos(e)) {
        released(gestureOf().cancel(e.pointerId));
        return;
      }
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      headPress.current = null;
      setDrop(null);
    },
    onMenu: (e, id) => {
      e.preventDefault();
      if (ios && holding.current !== null) return;
      openMenu(id, e.currentTarget, { x: e.clientX, y: e.clientY });
    },
    onSortKey: (e, id) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        moveBy(id, e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const th = headCell(id);
        openMenu(id, th, pointBelow(th));
      }
    },
    onEdgeDown: (e, col) => {
      if (notPrimary(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      edgePress.current = { id: col.spec.id, pointer: e.pointerId, x: e.clientX, y: e.clientY, w0: col.w, w: col.w, min: col.min, moved: false };
      document.documentElement.classList.add(RESIZING);
    },
    onEdgeMove: (e) => {
      const d = edgePress.current;
      if (d === null || d.pointer !== e.pointerId) return;
      if (!d.moved && isClick(d, { x: e.clientX, y: e.clientY })) return;
      d.moved = true;
      const dx = e.clientX - d.x;
      d.w = Math.min(MAX_WIDTH, Math.max(d.min, Math.round(d.w0 + dx)));
      setLive({ id: d.id, w: d.w });
    },
    onEdgeUp: (e) => {
      e.stopPropagation();
      const d = edgePress.current;
      if (d === null || d.pointer !== e.pointerId) return;
      edgePress.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      document.documentElement.classList.remove(RESIZING);
      setLive(null);
      if (d.moved) setPrefs(resizeColumn(prefs, d.id, d.w));
    },
    onEdgeCancel: (e) => {
      const d = edgePress.current;
      if (d === null || d.pointer !== e.pointerId) return;
      edgePress.current = null;
      document.documentElement.classList.remove(RESIZING);
      setLive(null);
    },
    onEdgeKey: (e, col) => {
      const id = col.spec.id;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") {
        e.preventDefault();
        onFit(id);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const step = e.shiftKey ? EDGE_STEP_BIG : EDGE_STEP;
      setPrefs(resizeColumn(prefs, id, Math.max(col.min, col.w + (e.key === "ArrowLeft" ? -step : step))));
    },
    onFit,
  };

  const onDown = (e: ReactPointerEvent<HTMLTableRowElement>, id: ItemId): void => {
    down.current = e.button === 0 ? { id, x: e.clientX, y: e.clientY } : null;
  };

  const onUp = (e: ReactPointerEvent<HTMLTableRowElement>, id: ItemId): void => {
    const d = down.current;
    down.current = null;
    if (d === null || d.id !== id || !isClick(d, { x: e.clientX, y: e.clientY })) return;
    detail.press({ item: id, x: e.clientX, y: e.clientY, at: performance.now() });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTableRowElement>, id: ItemId): void => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (e.key === "Enter") detail.rename(id);
    else detail.promote(id);
  };

  const groupRow = (s: ListSection, count: number) => (
    <tr key={`grp:${s.key}`} className="grp" data-group-row={s.key}>
      <td colSpan={cols.length}>
        {s.swatch !== null && <span className="swatch" style={{ "--step": `var(--s-${s.swatch})` }} />}
        <span className="grp-name">{s.title}</span>
        <span className="grp-count">{count}</span>
      </td>
    </tr>
  );

  const row = (id: ItemId) => {
    const ghost = ctx.ghosts.has(id);
    const classes = [ghost ? "ghost-row" : "", ui.selected === id ? "selected" : ""].filter((c) => c !== "").join(" ");
    return (
      <tr
        key={id}
        className={classes === "" ? undefined : classes}
        data-lrow={id}
        tabIndex={0}
        onPointerDown={(e) => onDown(e, id)}
        onPointerUp={(e) => onUp(e, id)}
        onPointerCancel={() => {
          down.current = null;
        }}
        onKeyDown={(e) => onKey(e, id)}
      >
        {cols.map(({ spec }) => {
          const empty = spec.value(ctx, id) === "";
          return (
            <td key={spec.id} className={cellClass(spec, empty)}>
              {empty ? null : spec.render(ctx, id, q)}
            </td>
          );
        })}
      </tr>
    );
  };

  const pad = (key: string, height: number) =>
    height === 0 ? null : (
      <tr key={key} className="list-pad" aria-hidden="true" style={{ height }}>
        <td colSpan={cols.length} />
      </tr>
    );

  const tableStyle: CSSProperties = { width };

  const mine = mineLine(prefs.scope, ctx.me);
  const empty = mine !== null ? null : listed === 0 ? EMPTY_PLAN : model.order.length === 0 ? nothingText(prefs.scope, prefs.chips.length > 0, q) : null;

  return (
    <>
      <ListBar ctx={ctx} prefs={prefs} model={model} searching={q !== ""} tools onPrefs={setPrefs} />
      <div className="list-body">
        <div className="list-wrap" ref={wrap} onScroll={(e) => setPort({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
          <table className="list" style={tableStyle}>
            <colgroup>
              {cols.map(({ spec, w }) => (
                <col key={spec.id} style={{ width: w }} />
              ))}
            </colgroup>
            <Head cols={cols} prefs={prefs} dragging={drop === null ? null : drop.id} lifted={lifted} headRef={head} on={handlers} />
            <tbody>
              {pad("pad:top", win.top)}
              {entries.slice(win.first, win.last).map((e) => (e.kind === "group" ? groupRow(e.section, e.count) : row(e.id)))}
              {pad("pad:bottom", win.bottom)}
            </tbody>
          </table>
          {drop !== null && <div className="th-drop" style={{ left: drop.left, top: drop.top }} />}
          {mine !== null && <MineNote line={mine} className="note" />}
          {empty !== null && <p className="note">{empty}</p>}
        </div>
        <div className="cols-gutter">
          <div className="cols-head">
            <button
              ref={colsBtn}
              type="button"
              className="icon-button cols-btn"
              aria-label={COLUMNS_TITLE}
              title={COLUMNS_TITLE}
              aria-haspopup="dialog"
              aria-expanded={colsAt !== null}
              onClick={(e) => {
                const b = e.currentTarget;
                setColsAt((at) => (at === null ? b : null));
              }}
            >
              <ColumnsGlyph />
            </button>
          </div>
        </div>
      </div>
      {colsAt !== null && <ColumnsPopover prefs={prefs} anchor={colsAt} onPrefs={setPrefs} onClose={() => setColsAt(null)} />}
      {menu.node}
    </>
  );
}
