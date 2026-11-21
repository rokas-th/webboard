import { useRef, type PointerEvent } from "react";

export const EDGE_SWIPE = 24;

interface Swipe {
  pointer: number;
  x: number;
  y: number;
}

export function ListEdge(p: { onOpen(): void }) {
  const swipe = useRef<Swipe | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType !== "touch") return;
    swipe.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const s = swipe.current;
    if (s === null || s.pointer !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (dx < EDGE_SWIPE || dx <= Math.abs(dy)) return;
    swipe.current = null;
    p.onOpen();
  };

  const forget = (e: PointerEvent<HTMLDivElement>): void => {
    if (swipe.current?.pointer === e.pointerId) swipe.current = null;
  };

  return <div className="list-edge" aria-hidden="true" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={forget} onPointerCancel={forget} />;
}
