import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { newItemIntent } from "../../actions/newItem";
import type { Item, ItemId } from "../../domain/model";
import { projectBoard, type Step } from "../../domain/steps";
import { haptic } from "../../services/haptics";
import { useNotes, usePlanView, type PlanSession } from "../../store/session";
import { BoardLine } from "../board/BoardLine";
import { CardBody } from "../board/Card";
import { liveStep, useCardMenu } from "../board/cardMenu";
import { HoldGesture, type HoldEvent } from "../board/hold";
import { boardLayout, filterLayout, statusOf } from "../board/layout";
import { MoveAll } from "../board/MoveAll";
import { useBoardPrefs, writeBoardPrefs, type BoardPrefs } from "../board/prefs";
import {
  addLabel,
  BY_DATES_PHONE,
  collapseLabel,
  countText,
  doneStripLabel,
  DROP_TO_FINISH,
  EXPAND,
  foldedText,
  hiddenPageText,
  hiddenStripLabel,
  NO_STEP,
  NO_STEP_LINE,
  NO_STEP_TAB,
  NOTHING_HERE,
  nothingMatchesText,
  overLimit,
  SHOW,
  stepTabLabel,
  STEPS_BAR,
} from "../board/text";
import { useDetail } from "../detail/DetailContext";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { pointBelow } from "../common/pickMenu";
import { toast } from "../common/Toast";
import { createdItem, NEW_NAME } from "../palette/commands";
import { useRun } from "../run";
import { planMatcher } from "../search/match";
import { useUiValue } from "../state";
import { isClick } from "../timeline/gesture";
import { boardPages, keptPage, pageAt, pageOfItem, type BoardPage } from "./boardPages";
import { useReadOnly } from "./readOnly";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const NO_STEP_STYLE: CSSProperties = { "--step": "var(--amber)" };

const pageStyle = (pg: BoardPage): CSSProperties => (pg.step === null ? NO_STEP_STYLE : { "--step": `var(--s-${pg.step.colour})` });

const tabName = (pg: BoardPage): string => (pg.step === null ? NO_STEP_TAB : pg.step.name);

const pastLimit = (pg: BoardPage): boolean => pg.limit !== null && pg.count > pg.limit;

type Placed = { key: string; index: number };

type Aim = { key: string; left: number };

type Holding = { item: ItemId; anchor: HTMLElement; pointer: number; x: number; y: number };

const indexOf = (pages: readonly BoardPage[], key: string): number => {
  const at = pages.findIndex((pg) => pg.key === key);
  if (at < 0) throw new Error(`PhoneBoard: the step bar names page ${key}, which is not on the Board`);
  return at;
};

const startKey = (pages: readonly BoardPage[], selected: ItemId | null): string | null => {
  if (pages.length === 0) return null;
  return (selected === null ? null : pageOfItem(pages, selected)) ?? pages[0].key;
};

function AddGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function CollapseGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 3 5 8l5 5" />
    </svg>
  );
}

export function PhoneBoard(p: { session: PlanSession }) {
  const view = usePlanView(p.session);
  const readOnly = useReadOnly(p.session);
  const { ui, setUi } = useUiValue();
  const detail = useDetail();
  const { run } = useRun(p.session);
  const prefs = useBoardPrefs(view.plan.id);
  const cards = useCardMenu(p.session, readOnly, (id) => setUi({ selected: id }));
  const base = useId();
  const pager = useRef<HTMLDivElement>(null);
  const aiming = useRef<Aim | null>(null);
  const placed = useRef<Placed | null>(null);
  const down = useRef<{ id: ItemId; x: number; y: number } | null>(null);
  const holding = useRef<Holding | null>(null);
  const gesture = useRef<HoldGesture | null>(null);
  const onHoldRef = useRef<(events: readonly HoldEvent[]) => void>(() => undefined);
  const lostRef = useRef<(e: PointerEvent) => void>(() => undefined);
  const stopScroll = useRef<(() => void) | null>(null);
  const [lifted, setLifted] = useState<ItemId | null>(null);
  const projection = projectBoard(view.plan, view.derived);
  const query = ui.query.trim();
  const notesSeen = useNotes(p.session, query !== "");
  const session = p.session;
  const match = useMemo(() => planMatcher(view, (id) => session.note(id).toString(), query), [view, session, query, notesSeen]);
  const layout = filterLayout(boardLayout(view, projection, prefs), match);
  const pages = boardPages(layout);
  const steps = projection.steps;
  const live: ReadonlySet<string> = new Set(steps.map((s) => s.id));
  const [current, setCurrent] = useState<string | null>(() => startKey(pages, ui.selected));
  const seenSelection = useRef<ItemId | null>(ui.selected);
  const replaceRef = useRef<() => void>(() => undefined);

  const tabId = (key: string): string => `${base}-tab-${key}`;
  const pageId = (key: string): string => `${base}-page-${key}`;

  const pagerEl = (): HTMLDivElement => {
    const el = pager.current;
    if (el === null) throw new Error("PhoneBoard: the pager is not rendered");
    return el;
  };

  const pageLeft = (el: HTMLDivElement, key: string): number => {
    const target = document.getElementById(pageId(key));
    if (target === null) throw new Error(`PhoneBoard: page ${key} is not rendered`);
    return Math.round(target.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft);
  };

  const setPrefs = (next: BoardPrefs): void => writeBoardPrefs(window.localStorage, view.plan.id, next, live);

  const goTo = (key: string, behavior: ScrollBehavior): void => {
    const index = indexOf(pages, key);
    setCurrent(key);
    const el = pagerEl();
    if (el.clientWidth === 0) {
      placed.current = null;
      aiming.current = null;
      return;
    }
    const left = pageLeft(el, key);
    placed.current = { key, index };
    if (Math.abs(el.scrollLeft - left) <= 1) {
      aiming.current = null;
      return;
    }
    aiming.current = { key, left };
    el.scrollTo({ left, behavior });
  };

  const motion = (): ScrollBehavior => (window.matchMedia(REDUCED_MOTION).matches ? "auto" : "smooth");

  useLayoutEffect(() => {
    if (pages.length === 0) {
      placed.current = null;
      aiming.current = null;
      if (current !== null) setCurrent(null);
      return;
    }
    const was = placed.current;
    const at = current === null ? -1 : pages.findIndex((pg) => pg.key === current);
    if (current !== null && at >= 0 && (was === null ? at === 0 : was.key === current && was.index === at)) {
      if (was === null) placed.current = { key: current, index: at };
      return;
    }
    goTo(keptPage(pages, current, was === null ? 0 : was.index), "auto");
  });

  useLayoutEffect(() => {
    replaceRef.current = () => {
      if (current !== null) goTo(current, "auto");
    };
  });

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => replaceRef.current());
    observer.observe(pagerEl());
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (current === null) return;
    const t = document.getElementById(tabId(current));
    if (t === null) throw new Error(`PhoneBoard: page ${current} has no tab`);
    t.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  useEffect(() => {
    const sel = ui.selected;
    if (sel === seenSelection.current) return;
    seenSelection.current = sel;
    if (sel === null) return;
    const key = pageOfItem(pages, sel);
    if (key === null || key === current) return;
    goTo(key, motion());
  });

  const settled = (): void => {
    const el = pagerEl();
    if (el.clientWidth === 0) return;
    const index = pageAt(el.scrollLeft, el.clientWidth, pages);
    const key = pages[index].key;
    placed.current = { key, index };
    setCurrent(key);
  };

  const onScrollEnd = (): void => {
    aiming.current = null;
    settled();
  };

  const onScroll = (): void => {
    const aim = aiming.current;
    if (aim !== null && Math.abs(pagerEl().scrollLeft - aim.left) > 1) return;
    aiming.current = null;
    settled();
  };

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, key: string): void => {
    const at = indexOf(pages, key);
    const last = pages.length - 1;
    const to = e.key === "ArrowRight" ? (at === last ? 0 : at + 1) : e.key === "ArrowLeft" ? (at === 0 ? last : at - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    const next = pages[to].key;
    goTo(next, motion());
    const t = document.getElementById(tabId(next));
    if (t === null) throw new Error(`PhoneBoard: page ${next} has no tab`);
    t.focus();
  };

  const add = (step: Step): void => {
    if (liveStep(p.session, step.id) === null) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    const now = p.session.view();
    const built = run(newItemIntent(now, now.today, "task", NEW_NAME.task, { column: step.id }));
    if (built === null) return;
    const id = createdItem(built);
    seenSelection.current = id;
    setUi({ selected: id, naming: id });
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>, id: ItemId): void => {
    if (e.button !== 0) {
      down.current = null;
      return;
    }
    down.current = { id, x: e.clientX, y: e.clientY };
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>, id: ItemId): void => {
    const d = down.current;
    down.current = null;
    if (d === null || d.id !== id || !isClick(d, { x: e.clientX, y: e.clientY })) return;
    detail.press({ item: id, x: e.clientX, y: e.clientY, at: performance.now() });
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
  };

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

  const onHold = (events: readonly HoldEvent[], h: Holding | null): void => {
    if (h === null) {
      if (events.length > 0) throw new Error(`PhoneBoard: a hold emitted ${events.map((e) => e.k).join(", ")} without a held card`);
      return;
    }
    events.forEach((ev) => {
      switch (ev.k) {
        case "held":
          blockScroll();
          setLifted(h.item);
          haptic("medium");
          return;
        case "drag":
        case "drop":
        case "cancel":
          endLift();
          return;
        case "menu":
          endLift();
          cards.open(h.item, h.anchor, pointBelow(h.anchor));
          return;
        case "tap":
          detail.press({ item: h.item, x: h.x, y: h.y, at: performance.now() });
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

  const sample = (e: ReactPointerEvent<HTMLDivElement>) => ({ pointer: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp });

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

  const holdDown = (e: ReactPointerEvent<HTMLDivElement>, id: ItemId): void => {
    if (holding.current === null) holding.current = { item: id, anchor: e.currentTarget, pointer: e.pointerId, x: e.clientX, y: e.clientY };
    onHold(gestureOf().down(sample(e)), holding.current);
  };

  const holdMove = (e: ReactPointerEvent<HTMLDivElement>): void => onHold(gestureOf().move(sample(e)), holding.current);

  const holdUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = sample(e);
    const g = gestureOf();
    released([...g.move(s), ...g.up(s)]);
  };

  const holdCancel = (e: ReactPointerEvent<HTMLDivElement>): void => released(gestureOf().cancel(e.pointerId));

  const touched = (e: ReactPointerEvent<HTMLDivElement>): boolean => e.pointerType !== "mouse";

  const onCardKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: ItemId): void => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    setUi({ selected: id });
  };

  const card = (item: Item) => (
    <div
      key={item.id}
      className={["card", ...(ui.selected === item.id ? ["selected"] : []), ...(lifted === item.id ? ["lifted"] : [])].join(" ")}
      data-card={item.id}
      role="button"
      aria-haspopup="menu"
      aria-expanded={cards.openFor === item.id}
      tabIndex={0}
      onPointerDown={(e) => {
        if (touched(e)) holdDown(e, item.id);
        else onDown(e, item.id);
      }}
      onPointerMove={(e) => {
        if (touched(e)) holdMove(e);
      }}
      onPointerUp={(e) => {
        if (touched(e)) holdUp(e);
        else onUp(e, item.id);
      }}
      onPointerCancel={(e) => {
        if (touched(e)) holdCancel(e);
        else down.current = null;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (holding.current !== null) return;
        cards.open(item.id, e.currentTarget, { x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => onCardKey(e, item.id)}
    >
      <CardBody view={view} layout={layout} item={item} />
    </div>
  );

  const emptyNote = (pg: BoardPage): string => (pg.items.length > 0 ? nothingMatchesText(query) : pg.completing ? DROP_TO_FINISH : NOTHING_HERE);

  const cardsOf = (pg: BoardPage) => (pg.shown.length === 0 ? <p className="note">{emptyNote(pg)}</p> : pg.shown.map(card));

  const head = (pg: BoardPage) => {
    const step = pg.step;
    if (step === null) {
      return (
        <div className="page-head">
          <span className="swatch warn" />
          <h2>{NO_STEP}</h2>
          <span className="col-badge">{pg.count}</span>
        </div>
      );
    }
    const past = pastLimit(pg);
    return (
      <div className="page-head">
        <span className="swatch" />
        <h2>{step.name.toLocaleUpperCase()}</h2>
        <span className={past ? "col-count over" : "col-count"} title={past && pg.limit !== null ? overLimit(pg.limit) : undefined}>
          {countText(pg.count, pg.limit)}
        </span>
        {pg.kind === "step" && !readOnly && (
          <button type="button" className="col-btn col-add" aria-label={addLabel(step.name)} title={addLabel(step.name)} onClick={() => add(step)}>
            <AddGlyph />
          </button>
        )}
        {pg.kind === "step" && pg.completing && prefs.doneOpen && pg.items.every((i) => statusOf(view, i.id) === "done") && (
          <button type="button" className="col-btn col-collapse" aria-label={collapseLabel(step.name)} title={collapseLabel(step.name)} onClick={() => setPrefs({ ...prefs, doneOpen: false })}>
            <CollapseGlyph />
          </button>
        )}
      </div>
    );
  };

  const body = (pg: BoardPage) => {
    const step = pg.step;
    switch (pg.kind) {
      case "noStep":
        return (
          <>
            <div className="col-note">
              <span>{NO_STEP_LINE}</span>
              {!readOnly && pg.shown.length > 0 && <MoveAll steps={steps} onPick={(to) => run({ t: "toStep", items: pg.shown.map((i) => i.id), step: to })} />}
            </div>
            {cardsOf(pg)}
          </>
        );
      case "step":
        return cardsOf(pg);
      case "folded":
        if (step === null) throw new Error("PhoneBoard: a folded page has no step");
        return (
          <>
            <p className="page-folded">{foldedText(pg.count)}</p>
            <button type="button" className="page-show" aria-label={doneStripLabel(step.name, pg.count)} onClick={() => setPrefs({ ...prefs, doneOpen: true })}>
              {EXPAND}
            </button>
          </>
        );
      case "hidden":
        if (step === null) throw new Error("PhoneBoard: a hidden page has no step");
        return (
          <>
            <p className="page-hidden">{hiddenPageText(pg.count)}</p>
            <button
              type="button"
              className="page-show"
              aria-label={hiddenStripLabel(step.name, pg.count)}
              onClick={() => setPrefs({ ...prefs, hidden: prefs.hidden.filter((h) => h !== step.id) })}
            >
              {SHOW}
            </button>
          </>
        );
    }
  };

  const stepTab = (pg: BoardPage) => {
    const on = pg.key === current;
    return (
      <button
        key={pg.key}
        id={tabId(pg.key)}
        type="button"
        role="tab"
        className="step-tab"
        data-page={pg.key}
        aria-selected={on}
        aria-controls={pageId(pg.key)}
        aria-label={stepTabLabel(tabName(pg), pg.count, pg.kind, pg.limit)}
        tabIndex={on ? 0 : -1}
        style={pageStyle(pg)}
        data-hidden={pg.kind === "hidden" ? "" : undefined}
        data-folded={pg.kind === "folded" ? "" : undefined}
        onClick={() => goTo(pg.key, motion())}
        onKeyDown={(e) => onTabKey(e, pg.key)}
      >
        <span className="swatch" />
        <span className="step-tab-name">{tabName(pg)}</span>
        <span className={pastLimit(pg) ? "step-tab-count over" : "step-tab-count"}>{countText(pg.count, pg.limit)}</span>
      </button>
    );
  };

  const boardPage = (pg: BoardPage) => (
    <section key={pg.key} id={pageId(pg.key)} className="board-page" role="tabpanel" data-page={pg.key} aria-labelledby={tabId(pg.key)} style={pageStyle(pg)}>
      {head(pg)}
      <div className="page-body">{body(pg)}</div>
    </section>
  );

  return (
    <div className="phone-board">
      <BoardLine layout={layout} completing={projection.completing !== null} query={query} byDates={BY_DATES_PHONE} onClear={() => setUi({ query: "" })} />
      {layout.empty !== null && (
        <p className="note" data-empty-board="">
          {layout.empty}
        </p>
      )}
      <div className="step-bar" role="tablist" aria-label={STEPS_BAR}>
        {pages.map(stepTab)}
      </div>
      <div
        ref={pager}
        className="board-pages"
        onScroll={onScroll}
        onScrollEnd={onScrollEnd}
        onPointerDown={() => {
          aiming.current = null;
        }}
      >
        {pages.map(boardPage)}
      </div>
      {cards.node}
    </div>
  );
}
