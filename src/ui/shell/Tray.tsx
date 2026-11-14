import { useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { toIso } from "../../domain/dates";
import type { ItemId } from "../../domain/model";
import type { PlanSession } from "../../store/session";
import { usePlanView } from "../../store/session";
import { useRun } from "../run";
import { useUiValue } from "../state";
import { geometry } from "../timeline/geometry";
import { isClick } from "../timeline/gesture";
import { chartWidth } from "../timeline/Timeline";

export const DRAG_HINT = "Drag one onto the timeline to give it dates.";
export const TAP_HINT = "Tap one to open it and give it dates.";

const COARSE_QUERY = "(pointer: coarse)";

const isCoarse = (): boolean => window.matchMedia(COARSE_QUERY).matches;

const onCoarseChange = (cb: () => void): (() => void) => {
  const list = window.matchMedia(COARSE_QUERY);
  list.addEventListener("change", cb);
  return () => list.removeEventListener("change", cb);
};

interface ChipDrag {
  id: ItemId;
  down: { x: number; y: number };
  touch: boolean;
}

export function Tray(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const { ui, setUi } = useUiValue();
  const { run } = useRun(p.session);
  const coarse = useSyncExternalStore(onCoarseChange, isCoarse);
  const drag = useRef<ChipDrag | null>(null);
  const [floating, setFloating] = useState<{ name: string; x: number; y: number } | null>(null);
  const unscheduled = [...view.plan.items.values()].filter((i) => !i.trashed && i.schedule !== null && i.schedule.start === null);

  const end = (): ChipDrag | null => {
    const d = drag.current;
    drag.current = null;
    setFloating(null);
    return d;
  };

  const onDown = (e: ReactPointerEvent<HTMLSpanElement>, id: ItemId): void => {
    if (e.button !== 0) return;
    const touch = e.pointerType === "touch";
    drag.current = { id, down: { x: e.clientX, y: e.clientY }, touch };
    if (touch) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onMove = (e: ReactPointerEvent<HTMLSpanElement>, name: string): void => {
    const d = drag.current;
    if (d === null || d.touch || p.readOnly || isClick(d.down, { x: e.clientX, y: e.clientY })) return;
    setFloating({ name, x: e.clientX + 12, y: e.clientY + 10 });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLSpanElement>, id: ItemId): void => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    setUi({ selected: id });
  };

  const onUp = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    const d = end();
    if (d === null) return;
    if (isClick(d.down, { x: e.clientX, y: e.clientY })) {
      setUi({ selected: d.id });
      return;
    }
    if (d.touch || p.readOnly) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const chart = hit === null ? null : hit.closest(".tl-chart");
    if (chart === null) return;
    const scroller = chart.closest(".tl-scroll");
    if (!(scroller instanceof HTMLElement)) throw new Error("Tray: a chart outside the timeline scroller");
    const day = geometry(view, ui.zoom, chartWidth(scroller)).dayAt(e.clientX - chart.getBoundingClientRect().left);
    run({ t: "schedule", item: d.id, set: { start: toIso(day) } });
  };

  return (
    <div className="tray">
      <span className="tray-title">Unscheduled · {unscheduled.length}</span>
      {unscheduled.map((i) => (
        <span
          key={i.id}
          className={ui.selected === i.id ? "tray-chip selected" : "tray-chip"}
          data-chip={i.id}
          tabIndex={0}
          onPointerDown={(e) => onDown(e, i.id)}
          onPointerMove={(e) => onMove(e, i.name)}
          onPointerUp={onUp}
          onPointerCancel={() => void end()}
          onKeyDown={(e) => onKey(e, i.id)}
        >
          {i.name}
        </span>
      ))}
      {!p.readOnly && <span className="tray-hint">{unscheduled.length > 0 ? (coarse ? TAP_HINT : DRAG_HINT) : "Everything has dates."}</span>}
      <span className="tray-spacer" />
      <span className="legend">
        <span>
          <i className="lb" />
          task
        </span>
        <span>
          <i className="lm" />
          milestone
        </span>
        <span>
          <i className="ll" />
          late
        </span>
        <span>
          <i className="lc" />
          conflict
        </span>
        <span>
          <i className="lh" />
          held
        </span>
      </span>
      {floating !== null && (
        <div className="drag-ghost" style={{ left: floating.x, top: floating.y }}>
          {floating.name}
        </div>
      )}
    </div>
  );
}
