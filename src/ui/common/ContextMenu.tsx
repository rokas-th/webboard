import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NativeMenuRow, NativeMenuSection } from "../../services/nativeMenu";
import { moved } from "./menu";

export interface Point {
  x: number;
  y: number;
}

export interface PickRow extends NativeMenuRow {
  checkable: boolean;
}

export interface PickSection {
  title: string | null;
  rows: readonly PickRow[];
}

export const nativeSections = (sections: readonly PickSection[]): readonly NativeMenuSection[] =>
  sections.map((s) => ({ title: s.title, rows: s.rows.map((r) => ({ id: r.id, title: r.title, checked: r.checked })) }));

const MARGIN = 8;

const ROWS = '[role="menuitem"], [role="menuitemcheckbox"]';

export function clampedAt(at: Point, size: { width: number; height: number }, view: { width: number; height: number }): Point {
  const fit = (v: number, extent: number, room: number): number => Math.max(MARGIN, Math.min(v, room - extent - MARGIN));
  return { x: fit(at.x, size.width, view.width), y: fit(at.y, size.height, view.height) };
}

export function ContextMenu(p: { label: string; at: Point; anchor: HTMLElement; sections: readonly PickSection[]; onChosen(id: string): void; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Point>(p.at);
  const [opener] = useState(() => document.activeElement);
  const onClose = useRef(p.onClose);
  const anchor = useRef(p.anchor);
  useLayoutEffect(() => {
    onClose.current = p.onClose;
    anchor.current = p.anchor;
  });

  useLayoutEffect(() => {
    const root = box.current;
    if (root === null) throw new Error(`${p.label}: the menu rendered without its element`);
    const r = root.getBoundingClientRect();
    setPlaced(clampedAt(p.at, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [p.at, p.label]);

  useLayoutEffect(() => {
    const root = box.current;
    if (root === null) throw new Error(`${p.label}: the menu rendered without its element`);
    const first = root.querySelector<HTMLElement>(ROWS);
    if (first === null) throw new Error(`${p.label}: the menu has no row`);
    first.focus({ preventScroll: true });
    return () => {
      if (!root.contains(document.activeElement)) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [p.label, opener]);

  useEffect(() => {
    const inMenu = (t: EventTarget | null): boolean => t instanceof Node && box.current !== null && box.current.contains(t);
    const away = (e: PointerEvent): void => {
      if (inMenu(e.target)) return;
      if (e.target instanceof Node && anchor.current.contains(e.target)) return;
      onClose.current();
    };
    const scrolled = (e: Event): void => {
      if (inMenu(e.target)) return;
      onClose.current();
    };
    const resized = (): void => onClose.current();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", resized);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose.current();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      onClose.current();
      return;
    }
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ROWS)];
    const to = moved(e.key, items.findIndex((b) => b === document.activeElement), items.length);
    if (to === null) return;
    e.preventDefault();
    items[to].focus();
  };

  const loose = p.sections.flatMap((s) => s.rows).find((r) => r.checked && !r.checkable);
  if (loose !== undefined) throw new Error(`${p.label}: the row ${loose.id} is checked but cannot be`);

  const choose = (id: string): void => {
    onClose.current();
    p.onChosen(id);
  };

  return (
    <div
      ref={box}
      className="context-menu"
      role="menu"
      aria-label={p.label}
      style={{ left: `${placed.x}px`, top: `${placed.y}px` }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {p.sections.map((s, i) => (
        <Fragment key={`${i}:${s.title ?? ""}`}>
          {i > 0 && <div className="context-menu-sep" role="separator" />}
          <div role="group" aria-label={s.title ?? undefined}>
            {s.title !== null && (
              <div className="context-menu-title" aria-hidden="true">
                {s.title}
              </div>
            )}
            {s.rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className={r.checked ? "context-menu-row checked" : "context-menu-row"}
                role={r.checkable ? "menuitemcheckbox" : "menuitem"}
                aria-checked={r.checkable ? r.checked : undefined}
                data-row={r.id}
                tabIndex={-1}
                onClick={() => choose(r.id)}
              >
                {r.title}
              </button>
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
