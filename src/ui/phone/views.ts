import type { UiState, ViewKind } from "../state";

export const PHONE_VIEWS: readonly (readonly [ViewKind, string])[] = [
  ["timeline", "Timeline"],
  ["board", "Board"],
  ["list", "List"],
];

export function phoneViewPatch(from: ViewKind, to: ViewKind): Partial<UiState> | null {
  if (from === to) return null;
  return to === "timeline" ? { view: to, query: "" } : { view: to };
}

function found<T extends Element>(view: ViewKind, named: string, el: T | null | undefined): T {
  if (el === null || el === undefined) throw new Error(`scrollToStart(${view}) found no ${named}`);
  return el;
}

function boardScroller(doc: Document): Element | null {
  const pages = Array.from(doc.querySelectorAll<HTMLElement>(".phone-main .board-page[data-page]"));
  if (pages.length === 0) return null;
  const step = found("board", '.phone-main .step-tab[aria-selected="true"]', doc.querySelector<HTMLElement>('.phone-main .step-tab[aria-selected="true"]'));
  const key = step.dataset.page;
  if (key === undefined) throw new Error(`scrollToStart(board) found the selected step tab ${JSON.stringify(step.textContent)} without a data-page`);
  return found("board", `.phone-main .board-page[data-page=${JSON.stringify(key)}]`, pages.find((p) => p.dataset.page === key));
}

function scrollerOf(doc: Document, view: ViewKind): Element | null {
  if (view === "timeline") return found(view, ".phone-main .tl-scroll", doc.querySelector(".phone-main .tl-scroll"));
  if (view === "list") return found(view, ".phone-main", doc.querySelector(".phone-main"));
  return boardScroller(doc);
}

export function scrollToStart(doc: Document, view: ViewKind, smooth: boolean): void {
  scrollerOf(doc, view)?.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
}
