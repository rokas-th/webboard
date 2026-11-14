import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { readPlatform } from "../../platform";

export function moved(key: string, at: number, n: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  if (key === "ArrowDown") return at < 0 ? 0 : (at + 1) % n;
  if (key === "ArrowUp") return at < 0 ? n - 1 : (at - 1 + n) % n;
  return null;
}

const MENU_LIST = "plan-menu-list";
const MENU_LIST_START = "plan-menu-list plan-menu-list-start";

export function useMenuList(open: boolean, toggle: RefObject<HTMLElement | null>): string {
  const [start, setStart] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const button = toggle.current;
    if (button === null) throw new Error("menu: open without its toggle");
    const p = readPlatform(window);
    const box = button.getBoundingClientRect();
    setStart(p.os === "ios" && p.idiom === "pad" && box.left + box.right < window.innerWidth);
  }, [open, toggle]);
  return start ? MENU_LIST_START : MENU_LIST;
}

export const OPEN_MENU = '[aria-haspopup="menu"][aria-expanded="true"]';

export interface Menu {
  open: boolean;
  close(): void;
  onToggle(): void;
  toggle: RefObject<HTMLButtonElement | null>;
  list: RefObject<HTMLDivElement | null>;
  listClass: string;
  box: {
    ref: RefObject<HTMLDivElement | null>;
    onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
    onBlur(e: FocusEvent<HTMLDivElement>): void;
    onMouseDown(e: MouseEvent<HTMLDivElement>): void;
  };
}

export function useMenu(name: string, rows: string, enabled: boolean): Menu {
  const [asked, setAsked] = useState(false);
  const open = asked && enabled;
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listClass = useMenuList(open, toggle);
  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelector<HTMLElement>(rows) ?? null;
    if (first === null) throw new Error(`${name}: open without a row`);
    first.focus();
  }, [open, name, rows]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => {
      if (e.target instanceof Node && box.current !== null && box.current.contains(e.target)) return;
      setAsked(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = useCallback((): void => {
    setAsked(false);
    toggle.current?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (list.current === null) throw new Error(`${name}: open without its list`);
    const items = [...list.current.querySelectorAll<HTMLElement>(rows)];
    const to = moved(e.key, items.findIndex((b) => b === document.activeElement), items.length);
    if (to === null) return;
    e.preventDefault();
    items[to].focus();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>): void => {
    const next = e.relatedTarget;
    if (next instanceof Node && box.current?.contains(next)) return;
    setAsked(false);
  };
  return {
    open,
    close,
    onToggle: () => (open ? close() : setAsked(true)),
    toggle,
    list,
    listClass,
    box: { ref: box, onKeyDown, onBlur, onMouseDown: (e) => e.preventDefault() },
  };
}
