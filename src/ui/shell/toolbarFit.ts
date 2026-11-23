import { useLayoutEffect, useRef, useState, type RefObject } from "react";

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

export interface SearchFit {
  start: number;
  middle: number;
  end: number;
  gap: number;
  room: number;
  glass: number;
  field: number;
}

export const SEARCH_FIELD_PX = 180;

export const SEARCH_FIELD_SLACK = 8;

export const SEARCH_FIELD_MIN_WINDOW = 900;

export function searchFieldFits(shown: boolean, m: SearchFit): boolean {
  const sides = m.middle + 2 * m.gap;
  if (shown) return 2 * Math.max(m.start, m.end) + sides <= m.room;
  return 2 * Math.max(m.start, m.end - m.glass + m.field) + sides + SEARCH_FIELD_SLACK <= m.room;
}

const glassWidth = (seen: number | null): number => {
  if (seen === null) throw new Error("toolbar: the search field is shown, but the glass it replaced was never measured");
  return seen;
};

function rowWidth(group: Element, gap: number): number {
  const css = getComputedStyle(group);
  const kids = Array.from(group.children).filter((el) => shown(el) && !el.classList.contains("toolbar-spacer"));
  const widths = kids.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
  const cut = Array.from(group.querySelectorAll(".sync-chip-text")).reduce((sum, el) => sum + el.scrollWidth - el.clientWidth, 0);
  const pad = css.display === "contents" ? 0 : px(css.paddingLeft) + px(css.paddingRight);
  return pad + widths + cut + gap * Math.max(kids.length - 1, 0);
}

export function searchFit(bar: Element, glassSeen: number | null): SearchFit | null {
  const css = getComputedStyle(bar);
  if (css.display !== "grid" && css.display !== "flex") return null;
  const start = part(bar, ".toolbar-start");
  const end = part(bar, ".toolbar-end");
  const gapOf = (group: Element): number => {
    const own = getComputedStyle(group);
    return px(own.display === "contents" ? css.columnGap : own.columnGap);
  };
  const tabs = bar.querySelector(":scope > .seg-modes");
  const glass = end.querySelector(':scope > [data-tb="search"]');
  const field = end.querySelector(":scope > .search-field");
  return {
    start: rowWidth(start, gapOf(start)),
    middle: tabs === null ? 0 : tabs.getBoundingClientRect().width,
    end: rowWidth(end, gapOf(end)),
    gap: px(css.columnGap),
    room: bar.clientWidth - px(css.paddingLeft) - px(css.paddingRight),
    glass: glass === null ? glassWidth(glassSeen) : glass.getBoundingClientRect().width,
    field: field === null ? SEARCH_FIELD_PX : field.getBoundingClientRect().width,
  };
}

export function useSearchField(ref: RefObject<HTMLElement | null>, allowed: boolean): boolean {
  const [field, setField] = useState(false);
  const glassSeen = useRef<number | null>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (bar === null) throw new Error("toolbar: the toolbar is not mounted");
    const check = (): void => {
      const fieldNow = bar.querySelector(":scope > .toolbar-end > .search-field") !== null;
      const glass = bar.querySelector(':scope > .toolbar-end > [data-tb="search"]');
      const glassNow = glass !== null;
      if (glass !== null) glassSeen.current = glass.getBoundingClientRect().width;
      if (!allowed || window.innerWidth < SEARCH_FIELD_MIN_WINDOW || (!fieldNow && !glassNow)) {
        setField(false);
        return;
      }
      const fit = searchFit(bar, glassSeen.current);
      setField(fit !== null && searchFieldFits(fieldNow, fit));
    };
    check();
    const observer = new ResizeObserver(check);
    [bar, ...Array.from(bar.querySelectorAll(".toolbar-group > *, .seg-modes"))].forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  });
  return field;
}
