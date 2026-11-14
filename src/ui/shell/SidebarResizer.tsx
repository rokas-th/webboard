import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { PLAN_LIST_ID } from "./Sidebar";
import { clampWidth, SIDEBAR_MIN, sidebarMax, widthForKey } from "./sidebarWidth";

const DRAGGING_CLASS = "sidebar-dragging";

const subscribeResize = (cb: () => void): (() => void) => {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
};

const windowMax = (): number => sidebarMax(window.innerWidth);

export function useSidebarMax(): number {
  return useSyncExternalStore(subscribeResize, windowMax);
}

function defaultSidebarWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w").trim();
  const px = /^(\d+(?:\.\d+)?)px$/.exec(raw);
  if (px === null) throw new Error(`sidebar: the stylesheet's --sidebar-w is ${JSON.stringify(raw)}, not a px length`);
  return Number(px[1]);
}

const showWidth = (body: HTMLElement, width: number | null): void => {
  if (width === null) body.style.removeProperty("--sidebar-w");
  else body.style.setProperty("--sidebar-w", `${width}px`);
};

interface Drag {
  pointer: number;
  startX: number;
  startWidth: number;
  width: number;
}

interface ResizerProps {
  width: number | null;
  max: number;
  body: RefObject<HTMLDivElement | null>;
  onCommit(width: number | null): void;
}

export function SidebarResizer(p: ResizerProps) {
  const stylesheetWidth = useSyncExternalStore(subscribeResize, defaultSidebarWidth);
  const now = p.width ?? stylesheetWidth;
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const bodyOf = (): HTMLDivElement => {
    const el = p.body.current;
    if (el === null) throw new Error("sidebar: the resize handle has no .app-body to size");
    return el;
  };

  const handleOf = (): HTMLDivElement => {
    const el = handle.current;
    if (el === null) throw new Error("sidebar: the resize handle is not mounted");
    return el;
  };

  const show = (width: number | null, valueNow: number): void => {
    showWidth(bodyOf(), width);
    handleOf().setAttribute("aria-valuenow", String(valueNow));
  };

  const stop = (): Drag | null => {
    const d = drag.current;
    drag.current = null;
    document.documentElement.classList.remove(DRAGGING_CLASS);
    return d;
  };

  const end = (): Drag | null => {
    const d = stop();
    if (d === null) return null;
    const h = handleOf();
    if (h.hasPointerCapture(d.pointer)) h.releasePointerCapture(d.pointer);
    return d;
  };

  const restore = (): void => show(p.width, now);

  const cancel = (): void => {
    if (end() === null) return;
    restore();
  };
  const cancelRef = useRef(cancel);
  const stopRef = useRef(stop);
  useEffect(() => {
    cancelRef.current = cancel;
    stopRef.current = stop;
  });

  useEffect(() => {
    const body = p.body.current;
    if (body === null) throw new Error("sidebar: the resize handle mounted without an .app-body");
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "Escape" || drag.current === null) return;
      e.preventDefault();
      cancelRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (stopRef.current() !== null) showWidth(body, null);
    };
  }, [p.body]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || drag.current !== null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, startX: e.clientX, startWidth: now, width: now };
    document.documentElement.classList.add(DRAGGING_CLASS);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || d.pointer !== e.pointerId) return;
    d.width = clampWidth(d.startWidth + e.clientX - d.startX, window.innerWidth);
    show(d.width, d.width);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || d.pointer !== e.pointerId) return;
    end();
    if (d.width === d.startWidth) restore();
    else p.onCommit(d.width);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (drag.current !== null) return;
    const step = widthForKey(e.key, now, window.innerWidth);
    if (step === null) return;
    e.preventDefault();
    p.onCommit(step.width);
  };

  return (
    <div
      ref={handle}
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the plan list"
      aria-controls={PLAN_LIST_ID}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={p.max}
      aria-valuenow={now}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={() => p.onCommit(null)}
      onKeyDown={onKeyDown}
    />
  );
}
