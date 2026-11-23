import { useId, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import type { ItemId } from "../../domain/model";
import { useNotes, usePlanView, type PlanSession } from "../../store/session";
import type { PickSection } from "../common/ContextMenu";
import { pointBelow, usePickMenu } from "../common/pickMenu";
import { columnById, rowContext, type RowContext } from "../list/columns";
import { statusLabel, type StatusLabel } from "../list/groups";
import { groupOfRow, groupSection, ListBar } from "../list/ListBar";
import { listModel, planOrder, sortClick, type ListSection } from "../list/model";
import { useListPrefs, writeListPrefs, type ColumnId, type ListPrefs } from "../list/prefs";
import { META_SEP, NO_DATES, nothingText, PLAN_ORDER, SORT_AND_GROUP, SORT_ASC, SORT_BY, SORT_DESC, spanText } from "../list/text";
import { assigneeName } from "../people/assign";
import { moreText, UNASSIGNED } from "../people/text";
import { Highlight } from "../search/Highlight";
import { searchMatcher } from "../search/match";
import { SearchBox } from "../search/SearchField";
import { useUiValue } from "../state";

export const PHONE_EMPTY_PLAN = "No items yet. Add one with +.";

const PLAN_ROW = "order";

const SORT_PREFIX = "sort:";

const whoText = (ctx: RowContext, id: ItemId): string => {
  const list = ctx.view.people.assignees.get(id) ?? [];
  const [first] = list;
  if (first === undefined) return UNASSIGNED;
  return list.length > 1 ? `${assigneeName(first)} ${moreText(list.length - 1)}` : assigneeName(first);
};

const whenText = (ctx: RowContext, id: ItemId): string => {
  const start = columnById("start").value(ctx, id);
  const end = columnById("end").value(ctx, id);
  if (start === "") return NO_DATES;
  return end === "" || end === start ? start : spanText(start, end);
};

const ALARMS: Readonly<Partial<Record<StatusLabel, string>>> = { conflict: "st conflict", held: "st held", late: "st late" };

const metaText = (ctx: RowContext, id: ItemId): string =>
  ctx.ghosts.has(id) ? columnById("status").value(ctx, id) : [columnById("step").value(ctx, id), whoText(ctx, id), whenText(ctx, id)].join(META_SEP);

const sortSection = (prefs: ListPrefs): PickSection => {
  const primary = prefs.sort[0];
  return {
    title: SORT_BY,
    rows: [
      { id: PLAN_ROW, title: PLAN_ORDER, checked: primary === undefined, checkable: true },
      ...prefs.cols.map((c) => {
        const title = columnById(c.id).title;
        const on = primary !== undefined && primary.id === c.id;
        return { id: `${SORT_PREFIX}${c.id}`, title: on ? `${title} ${primary.dir === "asc" ? SORT_ASC : SORT_DESC}` : title, checked: on, checkable: true };
      }),
    ],
  };
};

const sortedBy = (prefs: ListPrefs, row: string): ListPrefs => {
  if (row === PLAN_ROW) return { ...prefs, sort: [] };
  const col = prefs.cols.find((c) => `${SORT_PREFIX}${c.id}` === row);
  if (col === undefined) throw new Error(`PhoneList: the Sort by row ${JSON.stringify(row)} names no shown column`);
  const id: ColumnId = col.id;
  return sortClick(prefs, id, false);
};

function SortGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <line x1="3" y1="4" x2="13" y2="4" />
      <line x1="3" y1="8" x2="10" y2="8" />
      <line x1="3" y1="12" x2="7" y2="12" />
    </svg>
  );
}

export function PhoneList(p: { session: PlanSession; onOpen: (item: ItemId) => void }) {
  const view = usePlanView(p.session);
  const plan = view.plan.id;
  const prefs = useListPrefs(plan);
  const { ui, setUi } = useUiValue();
  const q = ui.query.trim();
  const notesSeen = useNotes(p.session, q !== "");
  const menu = usePickMenu(SORT_AND_GROUP);
  const base = useId();
  const session = p.session;
  const ctx: RowContext = useMemo(() => rowContext(view, (id) => session.note(id).toString()), [view, session, notesSeen]);
  const match = useMemo(() => searchMatcher(ctx, q), [ctx, q]);
  const model = useMemo(() => listModel(ctx, prefs, match), [ctx, prefs, match]);
  const listed = useMemo(() => planOrder(ctx).length, [ctx]);
  const dayoff = new Set(view.derived.conflicts.flatMap((c) => (c.kind === "dayoff" ? [c.item] : [])));

  const setPrefs = (next: ListPrefs): void => {
    writeListPrefs(window.localStorage, plan, next);
  };

  const openSort = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    const anchor = e.currentTarget;
    menu.open("sort", anchor, pointBelow(anchor), [sortSection(prefs), groupSection(prefs)], (row) =>
      setPrefs(row === PLAN_ROW || row.startsWith(SORT_PREFIX) ? sortedBy(prefs, row) : { ...prefs, group: groupOfRow(row) }),
    );
  };

  const row = (id: ItemId) => {
    const item = ctx.view.plan.items.get(id);
    if (item === undefined) throw new Error(`PhoneList: no item ${id}`);
    const ghost = ctx.ghosts.has(id);
    const classes = ["prow", ghost ? "ghost-row" : "", dayoff.has(id) ? "dayoff" : "", ui.selected === id ? "selected" : ""].filter((c) => c !== "").join(" ");
    const label = statusLabel(ctx.view, id);
    const alarm = ghost ? undefined : ALARMS[label];
    const nameId = `${base}-name-${id}`;
    const metaId = `${base}-meta-${id}`;
    return (
      <li key={id}>
        <button type="button" className={classes} aria-labelledby={nameId} aria-describedby={metaId} onClick={() => p.onOpen(id)}>
          <span id={nameId} className="prow-name">
            {item.kind === "milestone" ? "◆ " : null}
            <Highlight text={item.name} q={q} />
          </span>
          <span id={metaId} className="prow-meta">
            {alarm !== undefined && (
              <>
                <span className={alarm}>{label}</span>
                {META_SEP}
              </>
            )}
            {metaText(ctx, id)}
          </span>
        </button>
      </li>
    );
  };

  const heading = (s: ListSection) => {
    if (s.title === "") return null;
    const group = s.group;
    if (group !== null) {
      return (
        <button type="button" className="psec-title" onClick={() => p.onOpen(group)}>
          {s.title}
        </button>
      );
    }
    return (
      <h2 className="psec-title">
        {s.swatch !== null && <span className="swatch" style={{ "--step": `var(--s-${s.swatch})` }} />}
        {s.title}
      </h2>
    );
  };

  const empty = listed === 0 ? PHONE_EMPTY_PLAN : model.order.length === 0 ? nothingText(prefs.scope, prefs.chips.length > 0, q) : null;

  return (
    <div className="phone-list">
      <div className="plist-top">
        <SearchBox
          query={ui.query}
          count={null}
          ask={ui.searchAsk}
          onQuery={(query) => setUi({ query })}
          onFirst={() => {
            const el = document.activeElement;
            if (el instanceof HTMLElement) el.blur();
          }}
        />
        <button
          type="button"
          className="icon-button"
          data-list="sort"
          aria-label={SORT_AND_GROUP}
          title={SORT_AND_GROUP}
          aria-haspopup="menu"
          aria-expanded={menu.openFor !== null}
          onClick={openSort}
        >
          <SortGlyph />
        </button>
      </div>
      <ListBar ctx={ctx} prefs={prefs} model={model} searching={q !== ""} tools={false} onPrefs={setPrefs} />
      {empty !== null && <p className="dim">{empty}</p>}
      {model.sections.map((s) => (
        <section key={s.key} className="psec">
          {heading(s)}
          <ul className="prows">{s.rows.map(row)}</ul>
        </section>
      ))}
      {menu.node}
    </div>
  );
}
