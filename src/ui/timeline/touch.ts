import type { ItemId } from "../../domain/model";

export const LONG_PRESS_MS = 500;
export const SLOP_PX = 10;
export const PINCH_RATIO = 1.4;

export type Handle = "body" | "start" | "end" | "link";

export interface Sample {
  pointer: number;
  x: number;
  y: number;
  t: number;
}

export type GestureEvent =
  | { k: "tap"; item: ItemId | null }
  | { k: "pickup"; item: ItemId; handle: Handle }
  | { k: "drag"; item: ItemId; handle: Handle; dx: number }
  | { k: "drop"; item: ItemId; handle: Handle; dx: number; target: ItemId | null }
  | { k: "cancel" }
  | { k: "zoom"; step: 1 | -1 };

type Hit = { item: ItemId; handle: Handle } | null;

type Mode =
  | { k: "idle" }
  | { k: "pending"; pointer: number; from: Sample; hit: Hit }
  | { k: "scroll" }
  | { k: "held"; pointer: number; from: Sample; item: ItemId; handle: Handle }
  | { k: "pinch"; a: number; b: number; base: number; zoomed: boolean }
  | { k: "dead" };

export interface TouchGestureOptions {
  allowPickup: boolean;
  schedule: (ms: number, fn: () => void) => () => void;
  emit: (events: readonly GestureEvent[]) => void;
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(b.x - a.x, b.y - a.y);

export class TouchGesture {
  private readonly opts: TouchGestureOptions;
  private readonly at = new Map<number, Sample>();
  private mode: Mode = { k: "idle" };
  private stopTimer: (() => void) | null = null;

  constructor(opts: TouchGestureOptions) {
    this.opts = opts;
  }

  down(s: Sample, hit: Hit): GestureEvent[] {
    const m = this.mode;
    if (m.k === "idle") {
      this.at.set(s.pointer, s);
      this.mode = { k: "pending", pointer: s.pointer, from: s, hit };
      if (hit !== null && this.opts.allowPickup) this.stopTimer = this.opts.schedule(LONG_PRESS_MS, () => this.hold());
      return [];
    }
    if (m.k === "pending" || m.k === "scroll") {
      const first = [...this.at.values()][0];
      this.clearTimer();
      this.at.set(s.pointer, s);
      this.mode = { k: "pinch", a: first.pointer, b: s.pointer, base: Math.max(1, distance(first, s)), zoomed: false };
      return [];
    }
    this.at.set(s.pointer, s);
    if (m.k === "held") {
      this.mode = { k: "dead" };
      return [{ k: "cancel" }];
    }
    return [];
  }

  move(s: Sample): GestureEvent[] {
    if (!this.at.has(s.pointer)) return [];
    this.at.set(s.pointer, s);
    const m = this.mode;
    if (m.k === "pending") {
      if (distance(m.from, s) > SLOP_PX) {
        this.clearTimer();
        this.mode = { k: "scroll" };
      }
      return [];
    }
    if (m.k === "held") return s.pointer === m.pointer ? [{ k: "drag", item: m.item, handle: m.handle, dx: s.x - m.from.x }] : [];
    if (m.k === "pinch" && !m.zoomed) {
      const a = this.at.get(m.a);
      const b = this.at.get(m.b);
      if (a === undefined || b === undefined) throw new Error(`TouchGesture: pinch pointer ${m.a}/${m.b} is not tracked`);
      const ratio = distance(a, b) / m.base;
      if (ratio >= PINCH_RATIO) {
        m.zoomed = true;
        return [{ k: "zoom", step: 1 }];
      }
      if (ratio <= 1 / PINCH_RATIO) {
        m.zoomed = true;
        return [{ k: "zoom", step: -1 }];
      }
    }
    return [];
  }

  up(s: Sample, over: ItemId | null): GestureEvent[] {
    if (!this.at.has(s.pointer)) return [];
    const m = this.mode;
    const out: GestureEvent[] =
      m.k === "pending"
        ? [{ k: "tap", item: m.hit === null ? null : m.hit.item }]
        : m.k === "held"
          ? [{ k: "drop", item: m.item, handle: m.handle, dx: s.x - m.from.x, target: over }]
          : [];
    this.release(s.pointer);
    return out;
  }

  cancel(pointer: number): GestureEvent[] {
    if (!this.at.has(pointer)) return [];
    const held = this.mode.k === "held";
    this.release(pointer);
    return held ? [{ k: "cancel" }] : [];
  }

  private hold(): void {
    this.stopTimer = null;
    const m = this.mode;
    if (m.k !== "pending" || m.hit === null) throw new Error("TouchGesture: a hold fired outside a pending touch");
    this.mode = { k: "held", pointer: m.pointer, from: m.from, item: m.hit.item, handle: m.hit.handle };
    this.opts.emit([{ k: "pickup", item: m.hit.item, handle: m.hit.handle }]);
  }

  private release(pointer: number): void {
    this.clearTimer();
    this.at.delete(pointer);
    this.mode = this.at.size === 0 ? { k: "idle" } : { k: "dead" };
  }

  private clearTimer(): void {
    if (this.stopTimer === null) return;
    this.stopTimer();
    this.stopTimer = null;
  }
}
