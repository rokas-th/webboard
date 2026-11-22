import { LONG_PRESS_MS, SLOP_PX, type Sample } from "../timeline/touch";

export type HoldEvent = { k: "tap" } | { k: "held" } | { k: "drag"; x: number; y: number } | { k: "drop"; x: number; y: number } | { k: "menu" } | { k: "cancel" };

export interface HoldOptions {
  schedule: (ms: number, fn: () => void) => () => void;
  emit: (events: readonly HoldEvent[]) => void;
}

type Mode =
  | { k: "idle" }
  | { k: "pending"; pointer: number; from: Sample }
  | { k: "held"; pointer: number; from: Sample; dragging: boolean }
  | { k: "dead" };

const far = (a: Sample, b: Sample): boolean => Math.hypot(b.x - a.x, b.y - a.y) > SLOP_PX;

export class HoldGesture {
  private readonly opts: HoldOptions;
  private readonly touching = new Set<number>();
  private mode: Mode = { k: "idle" };
  private stopTimer: (() => void) | null = null;

  constructor(opts: HoldOptions) {
    this.opts = opts;
  }

  down(s: Sample): HoldEvent[] {
    const m = this.mode;
    this.touching.add(s.pointer);
    if (m.k === "idle") {
      this.mode = { k: "pending", pointer: s.pointer, from: s };
      this.stopTimer = this.opts.schedule(LONG_PRESS_MS, () => this.hold());
      return [];
    }
    this.clearTimer();
    this.mode = { k: "dead" };
    return m.k === "held" ? [{ k: "cancel" }] : [];
  }

  move(s: Sample): HoldEvent[] {
    const m = this.mode;
    if (m.k === "pending" && s.pointer === m.pointer) {
      if (far(m.from, s)) {
        this.clearTimer();
        this.mode = { k: "dead" };
      }
      return [];
    }
    if (m.k !== "held" || s.pointer !== m.pointer) return [];
    if (!m.dragging && !far(m.from, s)) return [];
    m.dragging = true;
    return [{ k: "drag", x: s.x, y: s.y }];
  }

  up(s: Sample): HoldEvent[] {
    if (!this.touching.has(s.pointer)) return [];
    const m = this.mode;
    const out: HoldEvent[] =
      m.k === "pending" && m.pointer === s.pointer
        ? [{ k: "tap" }]
        : m.k === "held" && m.pointer === s.pointer
          ? [m.dragging ? { k: "drop", x: s.x, y: s.y } : { k: "menu" }]
          : [];
    this.release(s.pointer);
    return out;
  }

  cancel(pointer: number): HoldEvent[] {
    if (!this.touching.has(pointer)) return [];
    const held = this.mode.k === "held";
    this.release(pointer);
    return held ? [{ k: "cancel" }] : [];
  }

  cancelAll(): HoldEvent[] {
    const held = this.mode.k === "held";
    this.clearTimer();
    this.touching.clear();
    this.mode = { k: "idle" };
    return held ? [{ k: "cancel" }] : [];
  }

  private hold(): void {
    this.stopTimer = null;
    const m = this.mode;
    if (m.k !== "pending") throw new Error("HoldGesture: a hold fired outside a pending touch");
    this.mode = { k: "held", pointer: m.pointer, from: m.from, dragging: false };
    this.opts.emit([{ k: "held" }]);
  }

  private release(pointer: number): void {
    this.clearTimer();
    this.touching.delete(pointer);
    this.mode = this.touching.size === 0 ? { k: "idle" } : { k: "dead" };
  }

  private clearTimer(): void {
    if (this.stopTimer === null) return;
    this.stopTimer();
    this.stopTimer = null;
  }
}
