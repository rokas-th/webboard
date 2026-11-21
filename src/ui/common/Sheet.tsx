import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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

export const DETENT_UP = 48;

export type SheetDetent = "medium" | "large";

type DetentProps = { detent?: undefined; onDetent?: undefined } | { detent: SheetDetent; onDetent(d: SheetDetent): void };

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

function useSwipeDown(ref: { current: HTMLDivElement | null }, close: (reason: CloseReason) => void, detents: DetentProps) {
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
      const speed = releaseSpeed(d, e.clientY, performance.now());
      const down = dy > SWIPE_SHARE * height || (dy > FLICK_DISTANCE && speed > FLICK_SPEED);
      const up = dy < -DETENT_UP || (dy < -FLICK_DISTANCE && speed < -FLICK_SPEED);
      snapBack();
      if (detents.detent === "large" && down) detents.onDetent("medium");
      else if (detents.detent === "medium" && up) detents.onDetent("large");
      else if (down) close("swipe");
    },
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>): void => {
      const d = end(e);
      if (d !== null && d.moving) snapBack();
    },
  };
}

type SheetProps = { title: string; onClose: () => void; actions?: ReactNode; onKeyDown?(e: ReactKeyboardEvent<HTMLDivElement>): void; children: ReactNode } & DetentProps;

function OpenSheet(p: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const ios = readPlatform(window).os === "ios";
  useModalFocus(ref, "Sheet", ios);
  const { close, scope } = useRequestClose(ref, p.onClose, "Sheet");
  useOverlayEntry(ref, close);
  const scrim = useScrimPress(() => close("scrim"));
  const swipe = useSwipeDown(ref, close, p.detent === undefined ? {} : { detent: p.detent, onDetent: p.onDetent });
  return (
    <div className="overlay sheet-overlay" {...scrim}>
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={p.title}
        tabIndex={-1}
        data-detent={p.detent}
        onKeyDown={(e) => {
          p.onKeyDown?.(e);
          if (!e.defaultPrevented) modalKeyDown(e, () => close("escape"));
        }}
      >
        {ios && <span className="sheet-grabber" aria-hidden="true" />}
        <div className="sheet-head" {...swipe}>
          <CloseButton className="sheet-close" onPress={() => close("x")} />
          <h3 className="sheet-title">{p.title}</h3>
          {p.actions === undefined ? <span className="sheet-head-end" aria-hidden="true" /> : <span className="sheet-actions">{p.actions}</span>}
        </div>
        <div className="sheet-body">{scope(p.children)}</div>
      </div>
    </div>
  );
}

export function Sheet(p: { open: boolean } & SheetProps) {
  if (!p.open) return null;
  const detents: DetentProps = p.detent === undefined ? {} : { detent: p.detent, onDetent: p.onDetent };
  return (
    <OpenSheet title={p.title} onClose={p.onClose} actions={p.actions} onKeyDown={p.onKeyDown} {...detents}>
      {p.children}
    </OpenSheet>
  );
}
