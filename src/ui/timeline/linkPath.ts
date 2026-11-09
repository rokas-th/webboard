import type { LinkType } from "../../domain/model";
import { ROW } from "./geometry";

export interface End {
  x0: number;
  x1: number;
  y: number;
}

export function linkPath(type: LinkType, pred: End, succ: End): string {
  const fromX = type === "FS" || type === "FF" ? pred.x1 : pred.x0;
  const toEnd = type === "FF" || type === "SF";
  const toX = toEnd ? succ.x1 : succ.x0;
  const out = type === "SS" || type === "SF" ? -8 : 8;
  const y1 = pred.y;
  const y2 = succ.y;
  if (!toEnd && toX - fromX >= 16 && out > 0) return `M${fromX},${y1} H${fromX + 8} V${y2} H${toX - 2}`;
  if (toEnd) {
    const xr = Math.max(fromX + out, toX + 10);
    return `M${fromX},${y1} H${out > 0 ? xr : fromX - 8} V${y2} H${toX + 2}`;
  }
  const mid = y2 > y1 ? y2 - ROW / 2 : y2 + ROW / 2;
  return `M${fromX},${y1} H${fromX + out} V${mid} H${toX - 12} V${y2} H${toX - 2}`;
}
