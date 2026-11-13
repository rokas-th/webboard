import { useLayoutEffect, useState, type RefObject } from "react";

export const TIGHT_SLACK = 2;

export function nextTight(tight: boolean, need: number, room: number): boolean {
  return tight ? need > room - TIGHT_SLACK + 0.5 : need > room + 0.5;
}

const px = (value: string): number => {
  const n = parseFloat(value);
  if (Number.isNaN(n)) throw new Error(`toolbar: ${JSON.stringify(value)} is not a length`);
  return n;
};

const shown = (el: Element): boolean => getComputedStyle(el).display !== "none";

function natural(group: Element): number {
  const css = getComputedStyle(group);
  const kids = Array.from(group.children).filter(shown);
  const widths = kids.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
  const cut = Array.from(group.querySelectorAll(".sync-chip-text")).reduce((sum, el) => sum + el.scrollWidth - el.clientWidth, 0);
  return px(css.paddingLeft) + px(css.paddingRight) + widths + cut + px(css.columnGap) * Math.max(kids.length - 1, 0);
}

function part(bar: Element, selector: string): Element {
  const el = bar.querySelector(`:scope > ${selector}`);
  if (el === null) throw new Error(`toolbar: no ${selector} in the toolbar`);
  return el;
}

export function toolbarFit(bar: Element): { need: number; room: number } | null {
  const css = getComputedStyle(bar);
  if (css.display !== "grid") return null;
  const tabs = bar.querySelector(":scope > .seg-modes");
  const middle = tabs === null ? 0 : tabs.getBoundingClientRect().width;
  return {
    need: natural(part(bar, ".toolbar-start")) + middle + natural(part(bar, ".toolbar-end")) + 2 * px(css.columnGap),
    room: bar.clientWidth - px(css.paddingLeft) - px(css.paddingRight),
  };
}

export function useToolbarTight(ref: RefObject<HTMLElement | null>): boolean {
  const [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (bar === null) throw new Error("toolbar: the toolbar is not mounted");
    const check = (): void => {
      const fit = toolbarFit(bar);
      setTight((was) => (fit === null ? false : nextTight(was, fit.need, fit.room)));
    };
    check();
    const observer = new ResizeObserver(check);
    [bar, ...Array.from(bar.querySelectorAll(".toolbar-group > *, .seg-modes"))].forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  });
  return tight;
}
