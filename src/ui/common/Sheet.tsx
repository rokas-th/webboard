import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { readPlatform } from "../../platform";
import { modalKeyDown, useModalFocus } from "./Dialog";
import { CloseButton, useOverlayEntry, useRequestClose, useScrimPress, type CloseReason } from "./dismiss";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export const SWIPE_SHARE = 0.25;

export const FLICK_DISTANCE = 40;

export const FLICK_SPEED = 0.6;

export const SNAP_MS = 200;

export const SWIPE_SLOP = 8;

export const RELEASE_MS = 100;

interface Sample {
  y: number;
  at: number;
}

interface Drag {
  id: number;
  start: Sample;
  moves: Sample[];
  moving: boolean;
}

function sheetOf(ref: { current: HTMLDivElement | null }): HTMLDivElement {
  const el = ref.current;
  if (el === null) throw new Error("Sheet swiped without its element");
  return el;
}

function releaseSpeed(d: Drag, y: number, now: number): number {
  const before = [d.start, ...d.moves].filter((s) => s.at < now);
  const recent = before.filter((s) => s.at >= now - RELEASE_MS);
  const base = recent[0] ?? before[before.length - 1] ?? d.start;
  return (y - base.y) / Math.max(1, now - base.at);
}

function useSwipeDown(ref: { current: HTMLDivElement | null }, close: (reason: CloseReason) => void) {
  const drag = useRef<Drag | null>(null);
  const place = (dy: number): void => {
    const el = sheetOf(ref);
    el.style.transition = "none";
    el.style.transform = `translateY(${Math.max(0, dy)}px)`;
  };
  const snapBack = (): void => {
    const el = sheetOf(ref);
    el.style.transition = window.matchMedia(REDUCED_MOTION).matches ? "none" : `transform ${SNAP_MS}ms ease-out`;
    el.style.transform = "";
  };
  const end = (e: ReactPointerEvent<HTMLElement>): Drag | null => {
    const d = drag.current;
    if (d === null || d.id !== e.pointerId) return null;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    return d;
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>): void => {
      if (e.pointerType !== "touch" || readPlatform(window).os !== "ios" || drag.current !== null) return;
      if (e.target instanceof Element && e.target.closest("button") !== null) return;
      drag.current = { id: e.pointerId, start: { y: e.clientY, at: performance.now() }, moves: [], moving: false };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>): void => {
      const d = drag.current;
      if (d === null || d.id !== e.pointerId) return;
      const dy = e.clientY - d.start.y;
      if (!d.moving) {
        if (Math.abs(dy) < SWIPE_SLOP) return;
        d.moving = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      d.moves.push({ y: e.clientY, at: performance.now() });
      place(dy);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>): void => {
      const d = end(e);
      if (d === null || !d.moving) return;
      const dy = e.clientY - d.start.y;
      const height = sheetOf(ref).getBoundingClientRect().height;
      if (height <= 0) throw new Error("Sheet measured no height to swipe against");
      const closing = dy > SWIPE_SHARE * height || (dy > FLICK_DISTANCE && releaseSpeed(d, e.clientY, performance.now()) > FLICK_SPEED);
      snapBack();
      if (closing) close("swipe");
    },
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>): void => {
      const d = end(e);
      if (d !== null && d.moving) snapBack();
    },
  };
}

function OpenSheet(p: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const ios = readPlatform(window).os === "ios";
  useModalFocus(ref, "Sheet", ios);
  const { close, scope } = useRequestClose(ref, p.onClose, "Sheet");
  useOverlayEntry(ref, close);
  const scrim = useScrimPress(() => close("scrim"));
  const swipe = useSwipeDown(ref, close);
  return (
    <div className="overlay sheet-overlay" {...scrim}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={p.title} tabIndex={-1} onKeyDown={(e) => modalKeyDown(e, () => close("escape"))}>
        {ios && <span className="sheet-grabber" aria-hidden="true" />}
        <div className="sheet-head" {...swipe}>
          <CloseButton className="sheet-close" onPress={() => close("x")} />
          <h3 className="sheet-title">{p.title}</h3>
          <span className="sheet-head-end" aria-hidden="true" />
        </div>
        <div className="sheet-body">{scope(p.children)}</div>
      </div>
    </div>
  );
}

export function Sheet(p: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!p.open) return null;
  return (
    <OpenSheet title={p.title} onClose={p.onClose}>
      {p.children}
    </OpenSheet>
  );
}
