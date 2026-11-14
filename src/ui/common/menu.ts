import { useLayoutEffect, useState, type RefObject } from "react";
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
