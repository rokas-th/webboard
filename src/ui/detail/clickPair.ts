import type { ItemId } from "../../domain/model";

export const PAIR_MS = 400;
export const PAIR_PX = 6;

export interface ClickMark {
  item: ItemId;
  x: number;
  y: number;
  at: number;
}

export interface ClickPair {
  press(m: ClickMark): "single" | "double";
  reset(): void;
}

const pairs = (a: ClickMark, b: ClickMark): boolean => a.item === b.item && b.at >= a.at && b.at - a.at <= PAIR_MS && Math.hypot(b.x - a.x, b.y - a.y) <= PAIR_PX;

export function createClickPair(): ClickPair {
  let last: ClickMark | null = null;
  return {
    press: (m) => {
      if (last !== null && pairs(last, m)) {
        last = null;
        return "double";
      }
      last = m;
      return "single";
    },
    reset: () => {
      last = null;
    },
  };
}
