import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { AppError } from "../../services/ipc";
import { anchorOf, dismissNativeMenu, showNativeMenu, type NativeMenuSection } from "../../services/nativeMenu";
import { detailsOf } from "./errorText";
import { toast } from "./Toast";

export function moved(key: string, at: number, n: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  if (key === "ArrowDown") return at < 0 ? 0 : (at + 1) % n;
  if (key === "ArrowUp") return at < 0 ? n - 1 : (at - 1 + n) % n;
  return null;
}

export const MENU_LIST = "plan-menu-list";

export const OPEN_MENU = '[aria-haspopup="menu"][aria-expanded="true"]';

export interface Menu {
  open: boolean;
  close(): void;
  onToggle(): void;
  toggle: RefObject<HTMLButtonElement | null>;
  list: RefObject<HTMLDivElement | null>;
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
    box: { ref: box, onKeyDown, onBlur, onMouseDown: (e) => e.preventDefault() },
  };
}

export interface NativeMenu {
  open: boolean;
  show(toggle: HTMLElement | null, sections: readonly NativeMenuSection[], onChosen: (id: string) => void): void;
  dismiss(): void;
}

interface Asked {
  token: string | null;
  withdrawn: boolean;
  ended: boolean;
  replaced: boolean;
}

function failed(e: unknown): void {
  if (!(e instanceof AppError)) throw e;
  console.error(e);
  toast(e.message, "bad", `${e.code}\n${detailsOf(e)}`);
}

function withdraw(asked: Asked): void {
  if (asked.withdrawn || asked.ended) return;
  asked.withdrawn = true;
  if (asked.token !== null) dismissNativeMenu(asked.token).catch(failed);
}

export function useNativeMenu(name: string): NativeMenu {
  const [open, setOpen] = useState(false);
  const live = useRef<Asked | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const asked = live.current;
      if (asked !== null) withdraw(asked);
    };
  }, []);
  const show = useCallback(
    (toggle: HTMLElement | null, sections: readonly NativeMenuSection[], onChosen: (id: string) => void): void => {
      if (toggle === null) throw new Error(`${name}: shown without its toggle`);
      const view = window.visualViewport ?? null;
      if (view === null) throw new Error(`${name}: the window has no visual viewport to place the menu in`);
      const prior = live.current;
      if (prior !== null) {
        prior.withdrawn = true;
        prior.ended = true;
        prior.replaced = true;
      }
      const asked: Asked = { token: null, withdrawn: false, ended: false, replaced: false };
      live.current = asked;
      setOpen(true);
      const settle = (): void => {
        if (live.current !== asked) return;
        live.current = null;
        if (mounted.current) setOpen(false);
      };
      showNativeMenu(sections, anchorOf(toggle.getBoundingClientRect(), view), {
        chosen: (id) => {
          if (asked.withdrawn || !mounted.current) {
            console.info(`${name}: dropped the native choice ${id}, the menu was withdrawn`);
            return;
          }
          onChosen(id);
        },
        ended: () => {
          asked.ended = true;
          settle();
        },
      }).then(
        (token) => {
          asked.token = token;
          if (asked.withdrawn && !asked.ended) dismissNativeMenu(token).catch(failed);
        },
        (e: unknown) => {
          asked.ended = true;
          if (asked.replaced && e instanceof AppError) {
            console.info(`${name}: a menu replaced by a newer one was not shown`, e);
            return;
          }
          settle();
          failed(e);
        },
      );
    },
    [name],
  );
  const dismiss = useCallback((): void => {
    const asked = live.current;
    if (asked !== null) withdraw(asked);
  }, []);
  return { open, show, dismiss };
}
