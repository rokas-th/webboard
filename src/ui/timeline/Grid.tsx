import type { ItemId, LinkType } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import type { SetUi, UiState } from "../state";
import type { Geometry } from "./geometry";
import { ROW } from "./geometry";
import type { Row } from "./rows";

export interface Placed {
  row: Row;
  index: number;
}

export interface Marks {
  early: ReadonlyMap<ItemId, { pred: ItemId; type: LinkType; doneOrDoing: boolean }>;
  badLinks: ReadonlySet<string>;
  dayoff: ReadonlyMap<ItemId, number>;
}

const dotOf = (view: PlanView, marks: Marks, id: ItemId): string => {
  if (marks.early.has(id)) return "dot dot-conflict";
  if (view.derived.late.has(id)) return "dot dot-late";
  const status = view.derived.status.get(id);
  return status === "done" ? "dot dot-done" : status === "doing" ? "dot dot-doing" : "dot";
};

function GridRow(p: { placed: Placed; view: PlanView; geo: Geometry; marks: Marks; ui: UiState; setUi: SetUi; tabStop: boolean }) {
  const { row, index } = p.placed;
  const item = p.view.plan.items.get(row.id);
  if (item === undefined) throw new Error(`Timeline row ${row.id} is not in the plan`);
  const selected = p.ui.selected === row.id;
  const pad = 14 + row.depth * 16;
  const common = {
    "data-row": row.id,
    "data-index": index,
    role: "option",
    "aria-selected": selected,
    tabIndex: p.tabStop ? 0 : -1,
    style: { top: index * ROW, paddingLeft: row.kind === "group" ? pad - 4 : pad },
    onClick: () => p.setUi({ selected: row.id, reveal: row.id }),
  };
  if (row.kind === "ghost") {
    return (
      <div className={selected ? "tl-row ghost-row selected" : "tl-row ghost-row"} {...common}>
        <span className="name">{item.name}</span>
      </div>
    );
  }
  if (row.kind === "group") {
    const open = !p.ui.collapsed.has(row.id);
    const span = p.geo.span(row.id);
    const toggle = (): void => {
      const next = new Set(p.ui.collapsed);
      if (open) next.add(row.id);
      else next.delete(row.id);
      p.setUi({ collapsed: next });
    };
    return (
      <div className={selected ? "tl-row group selected" : "tl-row group"} {...common}>
        <button
          type="button"
          className="caret"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${item.name}`}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="name">{item.name}</span>
        <span className="days">{span === null ? "" : `${p.geo.cal.workBetween(span.start, span.end)}d`}</span>
      </div>
    );
  }
  if (item.schedule === null) throw new Error(`Timeline row ${row.id} has no schedule`);
  const dur = item.schedule.dur;
  return (
    <div className={`tl-row ${row.kind}${selected ? " selected" : ""}`} {...common}>
      <span className={dotOf(p.view, p.marks, row.id)} />
      <span className="name">{item.name}</span>
      <span className="days">{row.kind === "milestone" ? "◆" : `${dur}d`}</span>
    </div>
  );
}

export function Grid(p: { mounted: readonly Placed[]; count: number; view: PlanView; geo: Geometry; marks: Marks; ui: UiState; setUi: SetUi }) {
  const stop = p.mounted.some((m) => m.row.id === p.ui.selected) ? p.ui.selected : p.mounted.length === 0 ? null : p.mounted[0].row.id;
  return (
    <div className="tl-grid">
      <div className="tl-rows" role="listbox" aria-label="Plan rows" style={{ height: p.count * ROW }}>
        {p.mounted.map((placed) => (
          <GridRow key={placed.row.id} placed={placed} view={p.view} geo={p.geo} marks={p.marks} ui={p.ui} setUi={p.setUi} tabStop={placed.row.id === stop} />
        ))}
      </div>
    </div>
  );
}
