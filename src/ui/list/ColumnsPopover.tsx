import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { readPlatform, shortcutsUseCommand } from "../../platform";
import { Popover } from "../common/Popover";
import { dropIndex, hideColumn, moveColumn, resetColumns, showColumn } from "./columnOps";
import { COLUMNS, columnById } from "./columns";
import type { ColumnId, ListPrefs } from "./prefs";
import { COLUMNS_TITLE, handleTitle, moveLabel, PINNED, RESET_COLUMNS } from "./text";

const POP_GAP = 6;
const EDGE_GAP = 8;
const DRAG_PX = 4;

interface Place {
  top: number;
  right: number;
  max: number;
}

interface Press {
  id: ColumnId;
  pointer: number;
  y: number;
  moved: boolean;
  to: number;
}

interface Drag {
  id: ColumnId;
  to: number;
}

interface Refocus {
  id: ColumnId;
  part: "handle" | "check";
}

const FOCUS_PART: Readonly<Record<Refocus["part"], string>> = { handle: ".cols-handle", check: ".cols-check input" };

const placeBelow = (anchor: HTMLElement): Place => {
  const box = anchor.getBoundingClientRect();
  const top = box.bottom + POP_GAP;
  return { top, right: Math.max(document.documentElement.clientWidth - box.right, 0), max: Math.max(window.innerHeight - top - EDGE_GAP, 0) };
};

const rowClass = (shown: boolean, dragging: boolean, mark: "above" | "below" | null): string =>
  ["cols-row", shown ? "" : "off", dragging ? "dragging" : "", mark === null ? "" : `drop-${mark}`].filter((c) => c !== "").join(" ");

function Grip() {
  return (
    <svg viewBox="0 0 10 16" aria-hidden="true" fill="currentColor">
      <circle cx="3" cy="4" r="1.2" />
      <circle cx="7" cy="4" r="1.2" />
      <circle cx="3" cy="8" r="1.2" />
      <circle cx="7" cy="8" r="1.2" />
      <circle cx="3" cy="12" r="1.2" />
      <circle cx="7" cy="12" r="1.2" />
    </svg>
  );
}

export function ColumnsPopover(p: { prefs: ListPrefs; anchor: HTMLElement; onPrefs(next: ListPrefs): void; onClose(): void }) {
  const list = useRef<HTMLUListElement>(null);
  const press = useRef<Press | null>(null);
  const refocus = useRef<Refocus | null>(null);
  const [place, setPlace] = useState<Place>(() => placeBelow(p.anchor));
  const [drag, setDrag] = useState<Drag | null>(null);
  const anchor = p.anchor;
  const shown = p.prefs.cols.map((c) => c.id);
  const hidden = COLUMNS.map((c) => c.id).filter((id) => !shown.includes(id));
  const last = shown[shown.length - 1];

  useEffect(() => {
    const onResize = (): void => setPlace(placeBelow(anchor));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [anchor]);

  useLayoutEffect(() => {
    const root = list.current;
    if (root === null) throw new Error("Columns: the list is not rendered");
    const first = root.querySelector<HTMLInputElement>("input:not(:disabled)");
    if (first === null) throw new Error("Columns: no checkbox to focus");
    first.focus();
  }, []);

  useLayoutEffect(() => {
    const want = refocus.current;
    if (want === null) return;
    refocus.current = null;
    const el = list.current?.querySelector<HTMLElement>(`li[data-col="${want.id}"] ${FOCUS_PART[want.part]}`);
    if (el === null || el === undefined) throw new Error(`Columns: no ${want.part} ${want.id} to focus`);
    el.focus();
  }, [p.prefs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const d = press.current;
      if (e.key !== "Escape" || d === null || !d.moved) return;
      e.preventDefault();
      e.stopPropagation();
      press.current = null;
      setDrag(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const rowOf = (id: ColumnId): HTMLElement => {
    const el = list.current?.querySelector<HTMLElement>(`li[data-col="${id}"]`);
    if (el === null || el === undefined) throw new Error(`Columns: no row ${id}`);
    return el;
  };

  const move = (id: ColumnId, to: number): void => {
    const from = shown.indexOf(id);
    if (from < 0) throw new Error(`Columns: ${id} is not a shown column`);
    if (to === from || to === from + 1) return;
    p.onPrefs(moveColumn(p.prefs, id, to));
  };

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>, id: ColumnId): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { id, pointer: e.pointerId, y: e.clientY, moved: false, to: 0 };
  };

  const onMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = press.current;
    if (d === null || d.pointer !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < DRAG_PX) return;
    d.moved = true;
    const mids = shown.slice(1).map((id) => {
      const r = rowOf(id).getBoundingClientRect();
      return r.top + r.height / 2;
    });
    d.to = dropIndex(mids, e.clientY);
    setDrag({ id: d.id, to: d.to });
  };

  const onUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = press.current;
    if (d === null || d.pointer !== e.pointerId) return;
    press.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDrag(null);
    if (d.moved) move(d.id, d.to);
  };

  const onCancel = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = press.current;
    if (d === null || d.pointer !== e.pointerId) return;
    press.current = null;
    setDrag(null);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>, id: ColumnId): void => {
    if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const at = shown.indexOf(id);
    if (at < 0) throw new Error(`Columns: ${id} is not a shown column`);
    const to = e.key === "ArrowUp" ? at - 1 : at + 2;
    if (to < 1 || to > shown.length) return;
    refocus.current = { id, part: "handle" };
    p.onPrefs(moveColumn(p.prefs, id, to));
  };

  const markOf = (id: ColumnId): "above" | "below" | null => {
    if (drag === null) return null;
    if (drag.to < shown.length) return shown[drag.to] === id ? "above" : null;
    return id === last ? "below" : null;
  };

  const toggle = (id: ColumnId, on: boolean): void => {
    refocus.current = { id, part: "check" };
    p.onPrefs(on ? hideColumn(p.prefs, id) : showColumn(p.prefs, id));
  };

  const title = handleTitle(shortcutsUseCommand(readPlatform(window).os));

  const row = (id: ColumnId, on: boolean) => {
    const spec = columnById(id);
    return (
      <li key={id} className={rowClass(on, drag !== null && drag.id === id, markOf(id))} data-col={id}>
        {id === "name" ? (
          <span className="cols-handle-gap" aria-hidden="true" />
        ) : (
          <button
            type="button"
            className="cols-handle"
            aria-label={moveLabel(spec.title)}
            title={title}
            disabled={!on}
            onPointerDown={(e) => onDown(e, id)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onCancel}
            onKeyDown={(e) => onKey(e, id)}
          >
            <Grip />
          </button>
        )}
        <label className="cols-check">
          <input type="checkbox" checked={on} disabled={id === "name"} onChange={() => toggle(id, on)} />
          <span className="cols-title">{spec.title}</span>
        </label>
        {id === "name" && <span className="pin-tag">{PINNED}</span>}
      </li>
    );
  };

  const hostStyle: CSSProperties = { top: place.top, right: place.right };

  return createPortal(
    <div className="cols-pop-host" style={hostStyle}>
      <Popover label={COLUMNS_TITLE} className="cols-pop" returnFocus={anchor} onClose={p.onClose}>
        <div className="cols-body" style={{ maxHeight: place.max }}>
          <h3 className="cols-head-title">{COLUMNS_TITLE}</h3>
          <ul ref={list} className="cols-list">
            {shown.map((id) => row(id, true))}
            {hidden.map((id) => row(id, false))}
          </ul>
          <div className="cols-foot">
            <button type="button" className="link-button cols-reset" onClick={() => p.onPrefs(resetColumns(p.prefs))}>
              {RESET_COLUMNS}
            </button>
          </div>
        </div>
      </Popover>
    </div>,
    document.body,
  );
}
