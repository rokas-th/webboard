import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { toIso } from "../../domain/dates";
import type { ItemId } from "../../domain/model";
import type { PlanSession } from "../../store/session";
import { usePlanView } from "../../store/session";
import { useRun } from "../run";
import { useUiValue } from "../state";
import { geometry } from "../timeline/geometry";
import { isClick } from "../timeline/gesture";

interface ChipDrag {
  id: ItemId;
  down: { x: number; y: number };
}

export function Tray(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const { ui, setUi } = useUiValue();
  const { run } = useRun(p.session);
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
    if (e.button !== 0 || e.pointerType === "touch") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id, down: { x: e.clientX, y: e.clientY } };
  };

  const onMove = (e: ReactPointerEvent<HTMLSpanElement>, name: string): void => {
    const d = drag.current;
    if (d === null || p.readOnly || isClick(d.down, { x: e.clientX, y: e.clientY })) return;
    setFloating({ name, x: e.clientX + 12, y: e.clientY + 10 });
  };

  const onUp = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    const d = end();
    if (d === null) return;
    if (isClick(d.down, { x: e.clientX, y: e.clientY })) {
      setUi({ selected: d.id });
      return;
    }
    if (p.readOnly) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const chart = hit === null ? null : hit.closest(".tl-chart");
    if (chart === null) return;
    const day = geometry(view, ui.zoom).dayAt(e.clientX - chart.getBoundingClientRect().left);
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
        >
          {i.name}
        </span>
      ))}
      {!p.readOnly && <span className="tray-hint">{unscheduled.length > 0 ? "Drag one onto the timeline to give it dates." : "Everything has dates."}</span>}
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
