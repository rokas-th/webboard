import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ItemId } from "../../domain/model";
import { useNotes, usePlanView, type PlanSession } from "../../store/session";
import { EMPTY_PLAN } from "../copy";
import { useDetail } from "../detail/DetailContext";
import { useUiValue } from "../state";
import { isClick } from "../timeline/gesture";
import { columnById, rowContext, type ColumnSpec, type RowContext } from "./columns";
import { ListBar } from "./ListBar";
import { listModel, planOrder, sortClick, type ListSection } from "./model";
import { useListPrefs, writeListPrefs, type ColumnId, type ListPrefs } from "./prefs";
import { nothingText, SORT_DOWN, SORT_TITLE, SORT_UP, sortDirText, sortRankText } from "./text";
import { listWindow, ROW_PX } from "./window";
import { searchMatcher } from "../search/match";

type Entry = { kind: "group"; section: ListSection; count: number } | { kind: "row"; id: ItemId };

interface Port {
  top: number;
  height: number;
}

interface Shown {
  spec: ColumnSpec;
  w: number;
}

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

function Head(p: { cols: readonly Shown[]; prefs: ListPrefs; headRef: RefObject<HTMLTableSectionElement | null>; onSort(id: ColumnId, shift: boolean): void }) {
  const ranked = p.prefs.sort.length >= 2;
  const base = useId();
  return (
    <thead ref={p.headRef}>
      <tr>
        {p.cols.map(({ spec }) => {
          const rank = p.prefs.sort.findIndex((s) => s.id === spec.id);
          const key = rank < 0 ? null : p.prefs.sort[rank];
          const described = `${base}-${spec.id}`;
          return (
            <th key={spec.id} data-col={spec.id} aria-sort={ariaSort(p.prefs, spec.id)} className={spec.align === "end" ? "end" : undefined}>
              <button
                type="button"
                className="th-sort"
                title={SORT_TITLE}
                aria-describedby={key === null ? undefined : described}
                onClick={(e: ReactMouseEvent<HTMLButtonElement>) => p.onSort(spec.id, e.shiftKey)}
              >
                {spec.title}
              </button>
              {key !== null && (
                <>
                  <span className="sort-chev" data-dir={key.dir} aria-hidden="true">
                    {key.dir === "asc" ? SORT_UP : SORT_DOWN}
                    {ranked && <span className="sort-rank">{rank + 1}</span>}
                  </span>
                  <span id={described} className="sort-said">
                    {ranked ? sortRankText(rank + 1, p.prefs.sort.length, key.dir) : sortDirText(key.dir)}
                  </span>
                </>
              )}
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
  const { ui } = useUiValue();
  const q = ui.query.trim();
  const notesSeen = useNotes(p.session, q !== "" || prefs.cols.some((c) => c.id === "note"));
  const detail = useDetail();
  const down = useRef<{ id: ItemId; x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLTableSectionElement>(null);
  const scrolledFor = useRef<ItemId | null>(null);
  const [port, setPort] = useState<Port>({ top: 0, height: 0 });
  const session = p.session;
  const ctx: RowContext = useMemo(() => rowContext(view, (id) => session.note(id).toString()), [view, session, notesSeen]);
  const match = useMemo(() => searchMatcher(ctx, q), [ctx, q]);
  const model = useMemo(() => listModel(ctx, prefs, match), [ctx, prefs, match]);
  const listed = useMemo(() => planOrder(ctx).length, [ctx]);
  const cols: Shown[] = useMemo(() => prefs.cols.map((c) => ({ spec: columnById(c.id), w: c.w })), [prefs]);
  const width = cols.reduce((sum, c) => sum + c.w, 0);
  const entries = useMemo(() => entriesOf(model.sections, ctx.ghosts), [model, ctx]);
  const win = listWindow(port.top, port.height, entries.length);
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
    const top = selectedAt * ROW_PX;
    const bottom = headH + (selectedAt + 1) * ROW_PX;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    else return;
    setPort({ top: el.scrollTop, height: el.clientHeight });
  }, [ui.selected, selectedAt]);

  const setPrefs = (next: ListPrefs): void => {
    writeListPrefs(window.localStorage, plan, next);
  };

  const onSort = (id: ColumnId, shift: boolean): void => {
    setPrefs(sortClick(prefs, id, shift));
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

  const empty = listed === 0 ? EMPTY_PLAN : model.order.length === 0 ? nothingText(prefs.scope, prefs.chips.length > 0, q) : null;

  return (
    <>
      <ListBar ctx={ctx} prefs={prefs} model={model} searching={q !== ""} onPrefs={setPrefs} />
      <div className="list-wrap" ref={wrap} onScroll={(e) => setPort({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        <table className="list" style={tableStyle}>
          <colgroup>
            {cols.map(({ spec, w }) => (
              <col key={spec.id} style={{ width: w }} />
            ))}
          </colgroup>
          <Head cols={cols} prefs={prefs} headRef={head} onSort={onSort} />
          <tbody>
            {pad("pad:top", win.top)}
            {entries.slice(win.first, win.last).map((e) => (e.kind === "group" ? groupRow(e.section, e.count) : row(e.id)))}
            {pad("pad:bottom", win.bottom)}
          </tbody>
        </table>
        {empty !== null && <p className="note">{empty}</p>}
      </div>
    </>
  );
}
