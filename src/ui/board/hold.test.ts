import { describe, expect, it } from "vitest";
import { LONG_PRESS_MS, SLOP_PX } from "../timeline/touch";
import { HoldGesture, type HoldEvent } from "./hold";

function rig() {
  const emitted: HoldEvent[] = [];
  const timers: { ms: number; fn: () => void; live: boolean }[] = [];
  const g = new HoldGesture({
    schedule: (ms, fn) => {
      const t = { ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    emit: (events) => emitted.push(...events),
  });
  const fire = (): void => {
    const live = timers.filter((t) => t.live);
    expect(live).toHaveLength(1);
    live[0].live = false;
    live[0].fn();
  };
  return { g, emitted, timers, fire };
}

const at = (x: number, y: number, pointer = 1) => ({ pointer, x, y, t: 0 });

describe("HoldGesture", () => {
  it("a quick press and release is a tap, and arms one hold timer of the Timeline's length", () => {
    const { g, timers } = rig();
    expect(g.down(at(10, 10))).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([LONG_PRESS_MS]);
    expect(g.move(at(10 + SLOP_PX, 10))).toEqual([]);
    expect(g.up(at(10 + SLOP_PX, 10))).toEqual([{ k: "tap" }]);
    expect(timers.every((t) => !t.live)).toBe(true);
  });

  it("moving past the slop before the hold gives up: no hold, no tap", () => {
    const { g, timers, emitted } = rig();
    g.down(at(10, 10));
    expect(g.move(at(10, 10 + SLOP_PX + 1))).toEqual([]);
    expect(timers.every((t) => !t.live)).toBe(true);
    expect(g.move(at(10, 80))).toEqual([]);
    expect(g.up(at(10, 80))).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("a hold released in place opens the menu", () => {
    const { g, emitted, fire } = rig();
    g.down(at(10, 10));
    fire();
    expect(emitted).toEqual([{ k: "held" }]);
    expect(g.move(at(12, 11))).toEqual([]);
    expect(g.up(at(12, 11))).toEqual([{ k: "menu" }]);
  });

  it("a hold then a move drags and drops where the finger lifts", () => {
    const { g, fire } = rig();
    g.down(at(10, 10));
    fire();
    expect(g.move(at(40, 12))).toEqual([{ k: "drag", x: 40, y: 12 }]);
    expect(g.move(at(41, 12))).toEqual([{ k: "drag", x: 41, y: 12 }]);
    expect(g.move(at(60, 14, 2))).toEqual([]);
    expect(g.up(at(70, 15))).toEqual([{ k: "drop", x: 70, y: 15 }]);
    expect(g.down(at(5, 5))).toEqual([]);
  });

  it("a cancelled or second-finger touch after the hold cancels, and before it gives up quietly", () => {
    const held = rig();
    held.g.down(at(10, 10));
    held.fire();
    expect(held.g.cancel(1)).toEqual([{ k: "cancel" }]);
    expect(held.g.cancel(1)).toEqual([]);
    held.g.down(at(10, 10));
    held.fire();
    expect(held.g.down(at(50, 50, 2))).toEqual([{ k: "cancel" }]);
    expect(held.g.up(at(10, 10))).toEqual([]);
    expect(held.g.up(at(50, 50, 2))).toEqual([]);
    const early = rig();
    early.g.down(at(10, 10));
    expect(early.g.cancel(1)).toEqual([]);
    expect(early.timers.every((t) => !t.live)).toBe(true);
    early.g.down(at(10, 10));
    expect(early.g.down(at(50, 50, 2))).toEqual([]);
    expect(early.timers.every((t) => !t.live)).toBe(true);
  });

  it("cancelAll forgets every touch and the timer, so the next press starts fresh", () => {
    const pending = rig();
    pending.g.down(at(10, 10));
    expect(pending.g.cancelAll()).toEqual([]);
    expect(pending.timers.every((t) => !t.live)).toBe(true);
    expect(pending.g.down(at(10, 10))).toEqual([]);
    expect(pending.g.up(at(10, 10))).toEqual([{ k: "tap" }]);
    const held = rig();
    held.g.down(at(10, 10));
    held.fire();
    expect(held.g.cancelAll()).toEqual([{ k: "cancel" }]);
    expect(held.g.up(at(10, 10))).toEqual([]);
    expect(held.g.down(at(20, 20, 3))).toEqual([]);
    expect(held.g.up(at(20, 20, 3))).toEqual([{ k: "tap" }]);
  });
});
