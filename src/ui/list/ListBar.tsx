import { useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { formerText } from "../../actions/copy";
import { goneSet } from "../../domain/derive";
import type { Item, ItemId } from "../../domain/model";
import { CloseGlyph } from "../common/dismiss";
import type { PickSection } from "../common/ContextMenu";
import { pointBelow, usePickMenu } from "../common/pickMenu";
import { UNASSIGNED } from "../people/text";
import { columnById, type RowContext } from "./columns";
import { planGroupPath } from "./groups";
import { toggleChip, type ListModel } from "./model";
import { SCOPE_IDS, type Chip, type ChipField, type GroupBy, type ListPrefs, type ScopeId } from "./prefs";
import {
  chipText,
  CLEAR_ALL,
  FIELD_LABELS,
  FILTER,
  filterLabel,
  GROUP_BY,
  GROUP_LABELS,
  GROUP_PREFIX,
  itemsText,
  MILESTONE,
  NO_STEP,
  NOT_IN_A_GROUP,
  PLAN_ORDER,
  PULL_CARET,
  REMOVED_GROUP,
  REMOVED_STEP,
  removeChipLabel,
  SCOPE,
  SCOPE_LABELS,
  scopeLabel,
  SCOPE_TITLES,
  sortedText,
  TASK,
} from "./text";
import { countText } from "../search/text";

const FIELDS: readonly ChipField[] = ["step", "assignee", "kind", "group"];

const GROUPINGS: readonly GroupBy[] = ["outline", "step", "assignee", "none"];

const chipId = (c: Chip): string => `${c.f}:${c.v ?? ""}`;

const chipOfRow = (row: string): Chip => {
  const at = row.indexOf(":");
  const f = FIELDS.find((x) => x === row.slice(0, at));
  if (at < 0 || f === undefined) throw new Error(`List: the Filter row ${JSON.stringify(row)} names no field`);
  const v = row.slice(at + 1);
  return { f, v: v === "" ? null : v };
};

const groupOfRow = (row: string): GroupBy => {
  const g = GROUPINGS.find((x) => x === row);
  if (g === undefined) throw new Error(`List: the Group by row ${JSON.stringify(row)} names no grouping`);
  return g;
};

interface Value {
  v: string | null;
  label: string;
}

const itemOf = (ctx: RowContext, id: ItemId): Item => {
  const item = ctx.view.plan.items.get(id);
  if (item === undefined) throw new Error(`List: no item ${id}`);
  return item;
};

const liveGroups = (ctx: RowContext): ItemId[] => {
  const gone = goneSet(ctx.view.plan);
  return [...ctx.outline.keys()].filter((id) => itemOf(ctx, id).kind === "group" && !gone.has(id));
};

const revealScope = (bar: HTMLElement): void => {
  const on = bar.querySelector<HTMLElement>(".scope.active");
  if (on === null) throw new Error("List: the scope bar has no chosen scope");
  const left = on.offsetLeft - bar.offsetLeft;
  if (left < bar.scrollLeft) bar.scrollLeft = left - 8;
  else if (left + on.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = left + on.offsetWidth - bar.clientWidth + 8;
};

function FilterGlyph() {
  return (
    <svg className="tool-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3.5h12l-4.5 5.2v4.3l-3 1.2V8.7z" />
    </svg>
  );
}

const formerName = (ctx: RowContext, id: string): string => {
  const former = [...ctx.view.people.assignees.values()].flat().find((a) => a.kind === "former" && a.id === id);
  return formerText(former === undefined || former.kind !== "former" ? null : former.name);
};

const valuesOf = (ctx: RowContext, f: ChipField): Value[] => {
  if (f === "step") return [...ctx.board.steps.map((s) => ({ v: s.id, label: s.name })), { v: null, label: NO_STEP }];
  if (f === "assignee") return [...ctx.view.people.people.map((p) => ({ v: p.id, label: p.name })), { v: null, label: UNASSIGNED }];
  if (f === "kind")
    return [
      { v: "task", label: TASK },
      { v: "milestone", label: MILESTONE },
    ];
  return [
    ...liveGroups(ctx).map((id) => ({
      v: id,
      label: planGroupPath(ctx.view.plan, id),
    })),
    { v: null, label: NOT_IN_A_GROUP },
  ];
};

const deadLabel = (ctx: RowContext, c: Chip): string => {
  if (c.f === "step") return REMOVED_STEP;
  if (c.f === "group") return REMOVED_GROUP;
  if (c.f === "assignee" && c.v !== null) return formerName(ctx, c.v);
  throw new Error(`List: the chip ${chipId(c)} has no value to show`);
};

const chipLabel = (ctx: RowContext, c: Chip): string => chipText(c.f, valuesOf(ctx, c.f).find((x) => x.v === c.v)?.label ?? deadLabel(ctx, c));

function ScopeBar(p: { prefs: ListPrefs; counts: Readonly<Record<ScopeId, number>>; onScope(s: ScopeId): void }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (el === null) throw new Error("List: the scope bar is not mounted");
    revealScope(el);
  }, [p.prefs.scope]);
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>, from: ScopeId): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const at = SCOPE_IDS.indexOf(from);
    const next = SCOPE_IDS[(at + (e.key === "ArrowRight" ? 1 : SCOPE_IDS.length - 1)) % SCOPE_IDS.length];
    const bar = e.currentTarget.parentElement;
    if (bar === null) throw new Error("List: a scope has no bar");
    p.onScope(next);
    const target = bar.querySelector<HTMLButtonElement>(`[data-scope="${next}"]`);
    if (target === null) throw new Error(`List: no scope ${next} to focus`);
    target.focus();
  };
  return (
    <div ref={bar} className="scope-bar" role="radiogroup" aria-label={SCOPE}>
      {SCOPE_IDS.map((s) => {
        const on = p.prefs.scope === s;
        const title = SCOPE_TITLES[s];
        return (
          <button
            key={s}
            type="button"
            role="radio"
            className={on ? "scope active" : "scope"}
            aria-checked={on}
            aria-label={scopeLabel(SCOPE_LABELS[s], p.counts[s])}
            tabIndex={on ? 0 : -1}
            data-scope={s}
            title={title ?? undefined}
            onClick={() => p.onScope(s)}
            onKeyDown={(e) => onKey(e, s)}
          >
            <span className="scope-label">{SCOPE_LABELS[s]}</span>
            <span className="scope-n">{p.counts[s]}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ListBar(p: { ctx: RowContext; prefs: ListPrefs; model: ListModel; searching: boolean; onPrefs(next: ListPrefs): void }) {
  const filter = usePickMenu(FILTER);
  const grouping = usePickMenu(GROUP_BY);
  const { ctx, prefs, model } = p;

  const openFilter = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    const anchor = e.currentTarget;
    const sections: PickSection[] = FIELDS.map((f) => ({
      title: FIELD_LABELS[f],
      rows: valuesOf(ctx, f).map((x) => ({
        id: chipId({ f, v: x.v }),
        title: x.label,
        checked: prefs.chips.some((c) => c.f === f && c.v === x.v),
        checkable: true,
      })),
    }));
    filter.open("filter", anchor, pointBelow(anchor), sections, (row) => p.onPrefs(toggleChip(prefs, chipOfRow(row))));
  };

  const openGroup = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    const anchor = e.currentTarget;
    const sections: PickSection[] = [
      {
        title: GROUP_BY,
        rows: GROUPINGS.map((g) => ({
          id: g,
          title: GROUP_LABELS[g],
          checked: prefs.group === g,
          checkable: true,
        })),
      },
    ];
    grouping.open("group", anchor, pointBelow(anchor), sections, (row) => p.onPrefs({ ...prefs, group: groupOfRow(row) }));
  };

  const sortKeys = prefs.sort.map((s) => ({
    title: columnById(s.id).title,
    dir: s.dir,
  }));

  return (
    <>
      <div className="list-bar">
        <ScopeBar prefs={prefs} counts={model.scopeCounts} onScope={(scope) => p.onPrefs({ ...prefs, scope })} />
      </div>
      {prefs.chips.length > 0 && (
        <div className="chip-row">
          {prefs.chips.map((c) => {
            const label = chipLabel(ctx, c);
            return (
              <span key={chipId(c)} className="filter-chip" data-chip={chipId(c)}>
                <span className="chip-text">{label}</span>
                <button type="button" className="chip-x" aria-label={removeChipLabel(label)} onClick={() => p.onPrefs(toggleChip(prefs, c))}>
                  <CloseGlyph />
                </button>
              </span>
            );
          })}
          {prefs.chips.length >= 2 && (
            <button type="button" className="link-button" onClick={() => p.onPrefs({ ...prefs, chips: [] })}>
              {CLEAR_ALL}
            </button>
          )}
        </div>
      )}
      <div className="list-status">
        {sortKeys.length === 0 ? (
          <span className="sort-summary plan-order">{PLAN_ORDER}</span>
        ) : (
          <span className="sort-summary">
            {sortedText(sortKeys)}
            <button type="button" className="link-button" onClick={() => p.onPrefs({ ...prefs, sort: [] })}>
              {PLAN_ORDER}
            </button>
          </span>
        )}
        <span className="list-count">{p.searching ? countText(model.shown, model.scoped) : itemsText(model.scoped)}</span>
        <span className="list-tools">
          <button
            type="button"
            className="tool-btn"
            data-list="filter"
            aria-label={filterLabel(prefs.chips.length)}
            aria-haspopup="menu"
            aria-expanded={filter.openFor !== null}
            onClick={openFilter}
          >
            <FilterGlyph />
            {FILTER}
            {prefs.chips.length > 0 && <span className="tool-n">{prefs.chips.length}</span>}
          </button>
          <button type="button" className="tool-btn" data-list="group" aria-haspopup="menu" aria-expanded={grouping.openFor !== null} onClick={openGroup}>
            {GROUP_PREFIX}
            <span className="tool-val">{GROUP_LABELS[prefs.group]}</span>
            <span className="pull-caret" aria-hidden="true">
              {` ${PULL_CARET}`}
            </span>
          </button>
        </span>
      </div>
      {filter.node}
      {grouping.node}
    </>
  );
}
