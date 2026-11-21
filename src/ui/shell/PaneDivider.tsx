import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { haptic } from "../../services/haptics";
import { SNAP, paneWidthForKey } from "./paneLayout";
import type { PaneKey, PaneState } from "./panes";

const DOUBLE_TAP_MS = 400;
const SNAP_ATTR = "data-pane-snap";

export interface PaneDividerProps {
  pane: PaneKey;
  side: "start" | "end";
  label: string;
  controls: string;
  className: string;
  draggingClass: string;
  cssVar: string;
  host: RefObject<HTMLElement | null>;
  width: number;
  stored: number | null;
  min: number;
  max: number;
  def: number;
  onCommit(next: PaneState): void;
}

interface Drag {
  pointer: number;
  startX: number;
  startWidth: number;
  inline: string;
  width: number;
  snapped: boolean;
  moved: boolean;
}

export function PaneDivider(p: PaneDividerProps) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const lastTap = useRef<number | null>(null);

  const hostOf = (): HTMLElement => {
    const el = p.host.current;
    if (el === null) throw new Error(`${p.pane} divider: no host element to size`);
    return el;
  };

  const handleOf = (): HTMLDivElement => {
    const el = handle.current;
    if (el === null) throw new Error(`${p.pane} divider: the handle is not mounted`);
    return el;
  };

  const showWidth = (width: number | null, valueNow: number): void => {
    const host = hostOf();
    if (width === null) host.style.removeProperty(p.cssVar);
    else host.style.setProperty(p.cssVar, `${width}px`);
    handleOf().setAttribute("aria-valuenow", String(valueNow));
  };

  const setSnap = (on: boolean): void => {
    const host = hostOf();
    if (on) host.setAttribute(SNAP_ATTR, p.pane);
    else host.removeAttribute(SNAP_ATTR);
  };

  const stop = (): Drag | null => {
    const d = drag.current;
    drag.current = null;
    document.documentElement.classList.remove(p.draggingClass);
    return d;
  };

  const end = (): Drag | null => {
    const d = stop();
    if (d === null) return null;
    const h = handleOf();
    if (h.hasPointerCapture(d.pointer)) h.releasePointerCapture(d.pointer);
    return d;
  };

  const restore = (d: Drag): void => {
    setSnap(false);
    showWidth(null, p.width);
    if (d.inline !== "") hostOf().style.setProperty(p.cssVar, d.inline);
  };

  const cancel = (): void => {
    const d = end();
    if (d === null) return;
    restore(d);
  };

  const latest = useRef({ cancel, stop, pane: p.pane, cssVar: p.cssVar });
  useEffect(() => {
    latest.current = { cancel, stop, pane: p.pane, cssVar: p.cssVar };
  });

  const mountedHost = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const host = p.host.current;
    if (host === null) throw new Error(`${latest.current.pane} divider: mounted without its host element`);
    mountedHost.current = host;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "Escape" || drag.current === null) return;
      e.preventDefault();
      latest.current.cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [p.host]);

  useLayoutEffect(
    () => () => {
      const d = latest.current.stop();
      const host = mountedHost.current;
      if (d === null) return;
      if (host === null) throw new Error(`${latest.current.pane} divider: unmounted mid-drag with no host to restore`);
      host.removeAttribute(SNAP_ATTR);
      if (d.inline === "") host.style.removeProperty(latest.current.cssVar);
      else host.style.setProperty(latest.current.cssVar, d.inline);
    },
    [],
  );

  const reset = (): void => p.onCommit({ open: true, w: null });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || drag.current !== null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointer: e.pointerId,
      startX: e.clientX,
      startWidth: p.width,
      inline: hostOf().style.getPropertyValue(p.cssVar),
      width: p.width,
      snapped: false,
      moved: false,
    };
    document.documentElement.classList.add(p.draggingClass);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    if (dx !== 0) d.moved = true;
    const raw = d.startWidth + (p.side === "start" ? dx : -dx);
    const snapped = raw < p.min - SNAP;
    if (snapped !== d.snapped) {
      d.snapped = snapped;
      setSnap(snapped);
      if (snapped) haptic("light");
    }
    if (snapped) {
      handleOf().setAttribute("aria-valuenow", String(p.min));
      return;
    }
    d.width = Math.min(p.max, Math.max(p.min, Math.round(raw)));
    showWidth(d.width, d.width);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || d.pointer !== e.pointerId) return;
    end();
    if (d.snapped) {
      restore(d);
      p.onCommit({ open: false, w: p.stored });
      return;
    }
    if (d.width !== d.startWidth) {
      p.onCommit({ open: true, w: d.width });
      return;
    }
    restore(d);
    if (e.pointerType !== "touch" || d.moved) return;
    const now = e.timeStamp;
    const last = lastTap.current;
    if (last !== null && now - last <= DOUBLE_TAP_MS) {
      lastTap.current = null;
      reset();
      return;
    }
    lastTap.current = now;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (drag.current !== null) return;
    const next = paneWidthForKey(e, p.width, { min: p.min, max: p.max, def: p.def }, p.side);
    if (next === null) return;
    e.preventDefault();
    p.onCommit(next);
  };

  return (
    <div
      ref={handle}
      className={p.className}
      data-pane-divider={p.pane}
      role="separator"
      aria-orientation="vertical"
      aria-label={p.label}
      aria-controls={p.controls}
      aria-valuemin={p.min}
      aria-valuemax={p.max}
      aria-valuenow={p.width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  );
}
