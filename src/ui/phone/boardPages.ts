import type { Item, ItemId } from "../../domain/model";
import type { Step } from "../../domain/steps";
import { NO_STEP_KEY, type BoardColumn, type BoardLayout } from "../board/layout";

export interface BoardPage {
  key: string;
  kind: "noStep" | "step" | "folded" | "hidden";
  step: Step | null;
  count: number;
  limit: number | null;
  items: readonly Item[];
  shown: readonly Item[];
  completing: boolean;
}

export const NO_STEP_PAGE = NO_STEP_KEY;

const pageOf = (c: BoardColumn): BoardPage => {
  switch (c.kind) {
    case "noStep":
      return { key: NO_STEP_PAGE, kind: "noStep", step: null, count: c.items.length, limit: null, items: c.items, shown: c.shown, completing: false };
    case "step":
      return { key: c.step.id, kind: "step", step: c.step, count: c.items.length, limit: c.step.limit, items: c.items, shown: c.shown, completing: c.completing };
    case "doneStrip":
      return { key: c.step.id, kind: "folded", step: c.step, count: c.count, limit: c.step.limit, items: [], shown: [], completing: true };
    case "hiddenStrip":
      return { key: c.step.id, kind: "hidden", step: c.step, count: c.count, limit: c.step.limit, items: [], shown: [], completing: false };
  }
};

export function boardPages(layout: BoardLayout): readonly BoardPage[] {
  return layout.columns.map(pageOf);
}

const clamp = (n: number, pages: number): number => Math.min(Math.max(n, 0), pages - 1);

export function pageAt(scrollLeft: number, width: number, pages: readonly BoardPage[]): number {
  if (width <= 0) throw new Error(`boardPages: a pager of width ${width} has no page position`);
  if (pages.length <= 0) throw new Error("boardPages: a pager with no pages has no page position");
  return clamp(Math.round(scrollLeft / width), pages.length);
}

export function keptPage(pages: readonly BoardPage[], key: string | null, index: number): string {
  if (pages.length <= 0) throw new Error("boardPages: no page to keep");
  if (key !== null && pages.some((p) => p.key === key)) return key;
  return pages[clamp(index, pages.length)].key;
}

export function pageOfItem(pages: readonly BoardPage[], item: ItemId): string | null {
  const found = pages.find((p) => p.shown.some((i) => i.id === item));
  return found === undefined ? null : found.key;
}
