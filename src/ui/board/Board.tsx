import { useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { fmtShort, toIso, type Day } from "../../domain/dates";
import { goneSet } from "../../domain/derive";
import type { Horizon, Item, ItemId } from "../../domain/model";
import { childrenOf } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { toast } from "../common/Toast";
import { groupPath, statusLabel, type StatusLabel } from "../list/groups";
import { useRun } from "../run";
import { useUiValue } from "../state";
import { isClick } from "../timeline/gesture";

export const DATED = "Dated items sit where their dates put them. Move them on the timeline.";
export const NOTHING_HERE = "Nothing here.";

const COLUMNS: readonly { h: Horizon; title: string; sub: string }[] = [
  { h: "now", title: "NOW", sub: "In progress, or starting within two weeks." },
  { h: "next", title: "NEXT", sub: "Starting within eight weeks." },
  { h: "later", title: "LATER", sub: "Further out, or no dates yet." },
];

const DOT: Readonly<Record<StatusLabel, string>> = {
  conflict: "dot conflict",
  held: "dot held",
  late: "dot late",
  "in progress": "dot doing",
  done: "dot",
  "not started": "dot",
};

const hiddenLine = (n: number): string => (n === 0 ? "" : n === 1 ? " 1 done item is hidden." : ` ${n} done items are hidden.`);

const horizonOf = (v: string): Horizon => {
  const found = COLUMNS.find((c) => c.h === v);
  if (found === undefined) throw new Error(`Board: no column ${v}`);
  return found.h;
};

interface Columns {
  cards: Readonly<Record<Horizon, readonly Item[]>>;
  column: ReadonlyMap<ItemId, Horizon>;
  done: number;
}

function columnsOf(view: PlanView): Columns {
  const gone = goneSet(view.plan);
  const walk = (parent: ItemId | null): Item[] =>
    childrenOf(view.plan, parent).flatMap((i) => (gone.has(i.id) ? [] : i.kind === "group" ? walk(i.id) : [i]));
  const items = walk(null);
  const column = new Map<ItemId, Horizon>();
  const done = items.filter((i) => {
    const h = view.derived.horizon.get(i.id);
    if (h !== undefined) {
      column.set(i.id, h);
      return false;
    }
    if (view.derived.status.get(i.id) !== "done") throw new Error(`Board: item ${i.id} has no horizon`);
    return true;
  }).length;
  const inColumn = (h: Horizon): Item[] => items.filter((i) => column.get(i.id) === h);
  const cards = { now: inColumn("now"), next: inColumn("next"), later: inColumn("later") };
  return { cards, column, done };
}

const dayOf = (m: ReadonlyMap<ItemId, Day>, id: ItemId, what: string): string => {
  const d = m.get(id);
  if (d === undefined) throw new Error(`Board: scheduled item ${id} has no ${what}`);
  return fmtShort(toIso(d));
};

function When(p: { view: PlanView; item: Item }) {
  const sc = p.item.schedule;
  if (sc === null) throw new Error(`Board: item ${p.item.id} has no schedule`);
  if (sc.start === null) return <span className="unsched">unscheduled</span>;
  const start = dayOf(p.view.derived.start, p.item.id, "start");
  if (p.item.kind === "milestone") return <span className="when">◆ {start}</span>;
  return <span className="when">{`${start} – ${dayOf(p.view.derived.end, p.item.id, "end")}`}</span>;
}

const groupName = (view: PlanView, item: Item): string | null => (item.place.parent === null ? null : groupPath(view, item.place.parent));

export function Board(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const { ui, setUi } = useUiValue();
  const { run } = useRun(p.session);
  const down = useRef<{ id: ItemId; x: number; y: number } | null>(null);
  const dragged = useRef<ItemId | null>(null);
  const [over, setOver] = useState<Horizon | null>(null);
  const { cards, column, done } = columnsOf(view);

  const moveTo = (id: ItemId, h: Horizon): void => {
    const item = view.plan.items.get(id);
    if (item === undefined) throw new Error(`Board: dragged item ${id} is not in the plan`);
    const current = column.get(id);
    if (current === undefined || current === h) return;
    if (item.schedule === null) throw new Error(`Board: item ${id} has no schedule`);
    if (item.schedule.start !== null) {
      toast(DATED);
      return;
    }
    run({ t: "schedule", item: id, set: { horizon: h } });
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>, id: ItemId): void => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest("select") !== null)) {
      down.current = null;
      return;
    }
    down.current = { id, x: e.clientX, y: e.clientY };
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>, id: ItemId): void => {
    const d = down.current;
    down.current = null;
    if (d === null || d.id !== id || !isClick(d, { x: e.clientX, y: e.clientY })) return;
    setUi({ selected: id });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: ItemId): void => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    setUi({ selected: id });
  };

  const onDragStart = (e: ReactDragEvent<HTMLDivElement>, id: ItemId): void => {
    down.current = null;
    dragged.current = id;
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragEnd = (): void => {
    dragged.current = null;
    setOver(null);
  };

  const onDragOver = (e: ReactDragEvent<HTMLElement>, h: Horizon): void => {
    if (dragged.current === null) return;
    e.preventDefault();
    if (over !== h) setOver(h);
  };

  const onDragLeave = (e: ReactDragEvent<HTMLElement>): void => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setOver(null);
  };

  const onDrop = (e: ReactDragEvent<HTMLElement>, h: Horizon): void => {
    e.preventDefault();
    const id = dragged.current;
    dragged.current = null;
    setOver(null);
    if (id !== null) moveTo(id, h);
  };

  const card = (item: Item, h: Horizon) => {
    const group = groupName(view, item);
    return (
      <div
        key={item.id}
        className={ui.selected === item.id ? "card selected" : "card"}
        data-card={item.id}
        tabIndex={0}
        draggable={!p.readOnly}
        onPointerDown={(e) => onDown(e, item.id)}
        onPointerUp={(e) => onUp(e, item.id)}
        onPointerCancel={() => {
          down.current = null;
        }}
        onKeyDown={(e) => onKey(e, item.id)}
        onDragStart={p.readOnly ? undefined : (e) => onDragStart(e, item.id)}
        onDragEnd={p.readOnly ? undefined : onDragEnd}
      >
        <div className="card-top">
          <span className={DOT[statusLabel(view, item.id)]} />
          <span className="card-name">{item.name}</span>
        </div>
        <div className="card-meta">
          <When view={view} item={item} />
          {group !== null && <span className="card-group">{group}</span>}
          {!p.readOnly && (
            <select className="move-to" aria-label="Move to" value={h} onChange={(e) => moveTo(item.id, horizonOf(e.target.value))}>
              {COLUMNS.map((c) => (
                <option key={c.h} value={c.h}>
                  {c.title}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="nnl">
      {COLUMNS.map((c) => {
        const list = cards[c.h];
        return (
          <section
            key={c.h}
            className={over === c.h ? "col over" : "col"}
            data-col={c.h}
            onDragOver={p.readOnly ? undefined : (e) => onDragOver(e, c.h)}
            onDragLeave={p.readOnly ? undefined : onDragLeave}
            onDrop={p.readOnly ? undefined : (e) => onDrop(e, c.h)}
          >
            <div className="col-head">
              <h2>{c.title}</h2>
              <span>{list.length}</span>
            </div>
            <div className="col-sub">{c.sub + (c.h === "now" ? hiddenLine(done) : "")}</div>
            <div className="col-body">{list.length === 0 ? <p className="note">{NOTHING_HERE}</p> : list.map((i) => card(i, c.h))}</div>
          </section>
        );
      })}
    </div>
  );
}
