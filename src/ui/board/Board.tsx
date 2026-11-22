import { useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { fmtShort, toIso, type Day } from "../../domain/dates";
import type { Horizon, Item, ItemId, StepId } from "../../domain/model";
import { projectBoard, type BoardProjection, type Step, type StepColumn, type StepMode } from "../../domain/steps";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { toast } from "../common/Toast";
import { groupPath, statusLabel, type StatusLabel } from "../list/groups";
import { useRun } from "../run";
import { useUiValue } from "../state";
import { useDetail } from "../detail/DetailContext";
import { isClick } from "../timeline/gesture";

export const DATED = "Dated items sit where their dates put them. Move them on the timeline.";
export const NOTHING_HERE = "Nothing here.";
export const NO_OPEN_STEP = "Every step in this plan completes items, so no open card has a column.";

const SUB: ReadonlyMap<StepId, string> = new Map([
  ["now", "In progress, or starting within two weeks."],
  ["next", "Starting within eight weeks."],
  ["later", "Further out, or no dates yet."],
]);

const HORIZONS: readonly Horizon[] = ["now", "next", "later"];

const NO_STEP = "no-step";

const DOT: Readonly<Record<StatusLabel, string>> = {
  conflict: "dot conflict",
  held: "dot held",
  late: "dot late",
  "in progress": "dot doing",
  done: "dot",
  "not started": "dot",
};

const hiddenLine = (n: number): string => (n === 0 ? "" : n === 1 ? " 1 done item is hidden." : ` ${n} done items are hidden.`);

const horizonOf = (v: StepId): Horizon => {
  const found = HORIZONS.find((h) => h === v);
  if (found === undefined) throw new Error(`Board: no column ${v}`);
  return found;
};

const colKey = (c: StepColumn): string => (c.step === null ? NO_STEP : c.step.id);

const colTitle = (c: StepColumn): string => (c.step === null ? "NO STEP" : c.step.name.toLocaleUpperCase());

const datesSub = (id: StepId): string => {
  const sub = SUB.get(id);
  if (sub === undefined) throw new Error(`Board: no column ${id}`);
  return sub;
};

export interface Columns {
  shown: readonly StepColumn[];
  done: number;
  mode: StepMode;
}

export function columnsFrom(board: BoardProjection): Columns {
  const completing = board.completing;
  const open = new Set(board.problems.flatMap((p) => (p.kind === "openInCompleting" ? p.items : [])));
  const isCompleting = (c: StepColumn): boolean => completing !== null && c.step !== null && c.step.id === completing.id;
  const finished = board.columns.filter(isCompleting).reduce((n, c) => n + c.items.filter((i) => !open.has(i.id)).length, 0);
  const shown = board.columns.flatMap((c): StepColumn[] => {
    if (!isCompleting(c)) return [c];
    const stranded = c.items.filter((i) => open.has(i.id));
    return stranded.length === 0 ? [] : [{ step: c.step, items: stranded }];
  });
  return { shown, done: finished + board.hiddenDone, mode: board.mode };
}

export function columnsOf(view: PlanView): Columns {
  return columnsFrom(projectBoard(view.plan, view.derived));
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
  const { ui } = useUiValue();
  const detail = useDetail();
  const { run } = useRun(p.session);
  const down = useRef<{ id: ItemId; x: number; y: number } | null>(null);
  const dragged = useRef<ItemId | null>(null);
  const [over, setOver] = useState<StepId | null>(null);
  const projection = projectBoard(view.plan, view.derived);
  const { shown, done, mode } = columnsFrom(projection);
  const targets: readonly Step[] = shown.flatMap((c) => (c.step === null ? [] : [c.step]));

  const targetOf = (v: string): StepId => {
    const found = targets.find((s) => s.id === v);
    if (found === undefined) throw new Error(`Board: no column ${v}`);
    return found.id;
  };

  const moveTo = (id: ItemId, to: StepId): void => {
    const item = view.plan.items.get(id);
    if (item === undefined) throw new Error(`Board: dragged item ${id} is not in the plan`);
    const current = projection.columnOf.get(id);
    if (current === undefined || current === to) return;
    if (mode === "steps") {
      run({ t: "toStep", items: [id], step: to });
      return;
    }
    if (item.schedule === null) throw new Error(`Board: item ${id} has no schedule`);
    if (item.schedule.start !== null) {
      toast(DATED);
      return;
    }
    run({ t: "schedule", item: id, set: { horizon: horizonOf(to) } });
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
    detail.press({ item: id, x: e.clientX, y: e.clientY, at: performance.now() });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: ItemId): void => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (e.key === "Enter") detail.rename(id);
    else detail.promote(id);
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

  const onDragOver = (e: ReactDragEvent<HTMLElement>, to: StepId): void => {
    if (dragged.current === null) return;
    e.preventDefault();
    if (over !== to) setOver(to);
  };

  const onDragLeave = (e: ReactDragEvent<HTMLElement>): void => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setOver(null);
  };

  const onDrop = (e: ReactDragEvent<HTMLElement>, to: StepId): void => {
    e.preventDefault();
    const id = dragged.current;
    dragged.current = null;
    setOver(null);
    if (id !== null) moveTo(id, to);
  };

  const sub = (c: StepColumn, first: boolean): string => {
    if (mode === "steps") return first ? hiddenLine(done).trim() : "";
    if (c.step === null) throw new Error("Board: a by-dates plan has no No step column");
    return datesSub(c.step.id) + (c.step.id === "now" ? hiddenLine(done) : "");
  };

  const card = (item: Item, c: StepColumn) => {
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
            <select className="move-to" aria-label="Move to" value={colKey(c)} onChange={(e) => moveTo(item.id, targetOf(e.target.value))}>
              {c.step === null && (
                <option value={NO_STEP} disabled>
                  {colTitle(c)}
                </option>
              )}
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name.toLocaleUpperCase()}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    );
  };

  if (shown.length === 0) {
    return (
      <div className="nnl" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        <p className="note" data-empty-board>
          {NO_OPEN_STEP + hiddenLine(done)}
        </p>
      </div>
    );
  }

  return (
    <div className="nnl" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}>
      {shown.map((c, i) => {
        const k = colKey(c);
        const to = c.step === null || p.readOnly ? null : c.step.id;
        return (
          <section
            key={k}
            className={over !== null && over === to ? "col over" : "col"}
            data-col={k}
            onDragOver={to === null ? undefined : (e) => onDragOver(e, to)}
            onDragLeave={to === null ? undefined : onDragLeave}
            onDrop={to === null ? undefined : (e) => onDrop(e, to)}
          >
            <div className="col-head">
              <h2>{colTitle(c)}</h2>
              <span>{c.items.length}</span>
            </div>
            <div className="col-sub">{sub(c, i === 0)}</div>
            <div className="col-body">{c.items.length === 0 ? <p className="note">{NOTHING_HERE}</p> : c.items.map((it) => card(it, c))}</div>
          </section>
        );
      })}
    </div>
  );
}
