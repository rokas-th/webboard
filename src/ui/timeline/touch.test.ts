import { describe, expect, it } from "vitest";
import { LONG_PRESS_MS, PINCH_RATIO, SLOP_PX, TouchGesture, type GestureEvent, type Handle, type Sample } from "./touch";

interface Rig {
  g: TouchGesture;
  out: GestureEvent[];
  fire(): void;
  pending(): number;
}

function rig(allowPickup = true): Rig {
  const timers: { ms: number; fn: () => void; live: boolean }[] = [];
  const out: GestureEvent[] = [];
  const g = new TouchGesture({
    allowPickup,
    schedule: (ms, fn) => {
      const t = { ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    emit: (events) => out.push(...events),
  });
  return {
    g,
    out,
    fire: () => {
      const due = timers.filter((t) => t.live);
      due.forEach((t) => {
        t.live = false;
        expect(t.ms).toBe(LONG_PRESS_MS);
        t.fn();
      });
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

const at = (pointer: number, x: number, t: number, y = 0): Sample => ({ pointer, x, y, t });
const BODY: { item: string; handle: Handle } = { item: "Review", handle: "body" };

describe("TouchGesture", () => {
  it("exports the agreed constants", () => {
    expect([LONG_PRESS_MS, SLOP_PX, PINCH_RATIO]).toEqual([500, 10, 1.4]);
  });

  it("a still hold picks up, drags preview and one drop lands", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 100, 0), BODY));
    expect(r.out).toEqual([]);
    r.fire();
    r.out.push(...r.g.move(at(1, 140, 600)));
    r.out.push(...r.g.move(at(1, 180, 650)));
    r.out.push(...r.g.up(at(1, 180, 700), "Ship"));
    expect(r.out).toEqual([
      { k: "pickup", item: "Review", handle: "body" },
      { k: "drag", item: "Review", handle: "body", dx: 40 },
      { k: "drag", item: "Review", handle: "body", dx: 80 },
      { k: "drop", item: "Review", handle: "body", dx: 80, target: "Ship" },
    ]);
  });

  it("a move past the slop before the hold is a scroll: nothing, also on up", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 100, 0), BODY));
    r.out.push(...r.g.move(at(1, 115, 200)));
    expect(r.pending()).toBe(0);
    r.out.push(...r.g.move(at(1, 200, 600)));
    r.out.push(...r.g.up(at(1, 200, 700), null));
    expect(r.out).toEqual([]);
  });

  it("a move within the slop keeps the hold", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 100, 0), BODY));
    r.out.push(...r.g.move(at(1, 106, 100, 6)));
    expect(r.pending()).toBe(1);
    r.fire();
    expect(r.out).toEqual([{ k: "pickup", item: "Review", handle: "body" }]);
  });

  it("an early unmoved lift is a tap", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 100, 0), { item: "Review", handle: "end" }));
    r.out.push(...r.g.up(at(1, 102, 120), null));
    expect(r.out).toEqual([{ k: "tap", item: "Review" }]);
    expect(r.pending()).toBe(0);
  });

  it("a lift on empty chart is a tap on nothing, and a held one too", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 100, 0), null));
    expect(r.pending()).toBe(0);
    r.out.push(...r.g.up(at(1, 100, 120), null));
    r.out.push(...r.g.down(at(1, 100, 1000), null));
    r.out.push(...r.g.up(at(1, 101, 1800), null));
    expect(r.out).toEqual([
      { k: "tap", item: null },
      { k: "tap", item: null },
    ]);
  });

  it("a swipe on empty chart is nothing", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 100, 0), null));
    r.out.push(...r.g.move(at(1, 140, 100)));
    r.out.push(...r.g.up(at(1, 140, 200), null));
    expect(r.out).toEqual([]);
  });

  it("a second pointer after pickup cancels, and the first pointer's up is nothing", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 100, 0), BODY));
    r.fire();
    r.out.push(...r.g.move(at(1, 120, 600)));
    r.out.push(...r.g.down(at(2, 300, 650), null));
    r.out.push(...r.g.move(at(2, 400, 660)));
    r.out.push(...r.g.up(at(2, 400, 670), null));
    r.out.push(...r.g.up(at(1, 200, 700), "Ship"));
    expect(r.out).toEqual([
      { k: "pickup", item: "Review", handle: "body" },
      { k: "drag", item: "Review", handle: "body", dx: 20 },
      { k: "cancel" },
    ]);
  });

  it("cancel(pointer) after pickup cancels; before it, nothing", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 100, 0), BODY));
    r.out.push(...r.g.cancel(1));
    expect(r.pending()).toBe(0);
    expect(r.out).toEqual([]);
    r.out.push(...r.g.down(at(1, 100, 1000), BODY));
    r.fire();
    r.out.push(...r.g.cancel(1));
    r.out.push(...r.g.up(at(1, 100, 1700), null));
    expect(r.out).toEqual([{ k: "pickup", item: "Review", handle: "body" }, { k: "cancel" }]);
  });

  it("a pinch out zooms once towards W", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 0, 0), BODY));
    r.out.push(...r.g.down(at(2, 100, 10), null));
    expect(r.pending()).toBe(0);
    r.out.push(...r.g.move(at(2, 160, 40)));
    r.out.push(...r.g.move(at(2, 300, 80)));
    r.out.push(...r.g.move(at(2, 100, 120)));
    r.out.push(...r.g.move(at(2, 40, 160)));
    r.out.push(...r.g.up(at(2, 40, 200), null));
    r.out.push(...r.g.up(at(1, 0, 210), null));
    expect(r.out).toEqual([{ k: "zoom", step: 1 }]);
  });

  it("a pinch in zooms once towards Q", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 0, 0), null));
    r.out.push(...r.g.down(at(2, 100, 10), null));
    r.out.push(...r.g.move(at(2, 80, 40)));
    expect(r.out).toEqual([]);
    r.out.push(...r.g.move(at(2, 60, 80)));
    r.out.push(...r.g.move(at(2, 10, 120)));
    r.out.push(...r.g.cancel(2));
    r.out.push(...r.g.up(at(1, 0, 210), null));
    expect(r.out).toEqual([{ k: "zoom", step: -1 }]);
  });

  it("a new gesture starts clean after a pinch", () => {
    const r = rig();
    r.out.push(...r.g.down(at(1, 0, 0), null));
    r.out.push(...r.g.down(at(2, 100, 10), null));
    r.out.push(...r.g.up(at(1, 0, 20), null));
    r.out.push(...r.g.up(at(2, 100, 30), null));
    r.out.push(...r.g.down(at(3, 50, 100), BODY));
    r.out.push(...r.g.up(at(3, 50, 150), null));
    expect(r.out).toEqual([{ k: "tap", item: "Review" }]);
  });

  it("with allowPickup false a hold is a tap", () => {
    const r = rig(false);
    r.out.push(...r.g.down(at(1, 100, 0), BODY));
    expect(r.pending()).toBe(0);
    r.out.push(...r.g.up(at(1, 101, 800), null));
    expect(r.out).toEqual([{ k: "tap", item: "Review" }]);
  });

  it("with allowPickup false a pinch still zooms", () => {
    const r = rig(false);
    r.out.push(...r.g.down(at(1, 0, 0), BODY));
    r.out.push(...r.g.down(at(2, 100, 10), null));
    r.out.push(...r.g.move(at(2, 160, 40)));
    expect(r.out).toEqual([{ k: "zoom", step: 1 }]);
  });

  it("ignores pointers it does not track", () => {
    const r = rig();
    expect(r.g.move(at(7, 10, 0))).toEqual([]);
    expect(r.g.up(at(7, 10, 0), null)).toEqual([]);
    expect(r.g.cancel(7)).toEqual([]);
  });
});
