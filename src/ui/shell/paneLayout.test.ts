import { describe, expect, it } from "vitest";
import {
  CONTENT_MIN,
  DRAWER_SHARE,
  PANE_LIMITS,
  PHONE_OUTLINE,
  SNAP,
  paneLayout,
  paneMax,
  paneWidthForKey,
  type PaneBase,
  type PaneLayout,
} from "./paneLayout";
import type { PaneSet, PaneState } from "./panes";

const OPEN: PaneState = { open: true, w: null };
const ALL_OPEN: PaneSet = { list: OPEN, outline: OPEN, inspector: OPEN };

const listDefaultAt = (window: number): number => (window <= 1240 ? 236 : 284);

const at = (window: number, panes: PaneSet = ALL_OPEN, timeline = true, base: PaneBase = "column"): PaneLayout =>
  paneLayout({ window, base, timeline, panes, listDefault: listDefaultAt(window) });

const modes = (l: PaneLayout): readonly [string, string] => [l.list.mode, l.inspector.mode];

describe("the pane numbers", () => {
  it("hold the design's limits", () => {
    expect([CONTENT_MIN, SNAP, DRAWER_SHARE, PHONE_OUTLINE]).toEqual([480, 48, 0.85, 132]);
    expect(PANE_LIMITS).toEqual({ list: { min: 200 }, outline: { min: 160, def: 300 }, inspector: { min: 300, def: 360 } });
  });

  it("paneMax", () => {
    expect([paneMax("list", { window: 1180, timeline: 0 }), paneMax("list", { window: 1440, timeline: 0 }), paneMax("list", { window: 400, timeline: 0 })]).toEqual([472, 480, 200]);
    expect([600, 1024, 1180, 1440, 1920].map((w) => paneMax("inspector", { window: w, timeline: 0 }))).toEqual([300, 460, 531, 640, 640]);
    expect([200, 319, 500, 1000].map((t) => paneMax("outline", { window: 1440, timeline: t }))).toEqual([160, 160, 250, 500]);
  });
});

describe("paneLayout in the column base", () => {
  it("all columns at 1440 on Timeline", () => {
    const l = at(1440);
    expect(l.list).toEqual({ mode: "column", w: 284 });
    expect(l.inspector).toEqual({ mode: "column", w: 360 });
    expect(l.outline).toEqual({ open: true, w: 300, squeezed: false });
    expect(l.content).toBe(1440 - 285 - 361);
  });

  it("the list yields first at 1180", () => {
    const l = at(1180);
    expect(l.list).toEqual({ mode: "overlay", w: 320 });
    expect(l.inspector).toEqual({ mode: "column", w: 360 });
    expect(l.content).toBe(819);
    expect(l.outline).toEqual({ open: true, w: 300, squeezed: false });
  });

  it("the outline shrinks to 183 at 1024 first", () => {
    const l = at(1024);
    expect(modes(l)).toEqual(["overlay", "column"]);
    expect(l.content).toBe(663);
    expect(l.outline).toEqual({ open: true, w: 183, squeezed: true });
    expect(l.content - l.outline.w).toBe(CONTENT_MIN);
  });

  it("the inspector yields last, drawer clamped to 85 %", () => {
    const wide = at(1024, { ...ALL_OPEN, inspector: { open: true, w: 900 } });
    expect(wide.list).toEqual({ mode: "overlay", w: 320 });
    expect(wide.inspector).toEqual({ mode: "overlay", w: Math.floor(0.85 * 1024) });
    expect(wide.content).toBe(1024);
    expect(wide.outline).toEqual({ open: true, w: 300, squeezed: false });
    const kept = at(1024, { ...ALL_OPEN, inspector: { open: true, w: 640 } });
    expect(kept.inspector).toEqual({ mode: "overlay", w: 640 });
    const narrow = at(1024, { ...ALL_OPEN, inspector: { open: true, w: 120 } });
    expect(narrow.inspector).toEqual({ mode: "column", w: 300 });
  });

  it("Board at 1180 keeps both columns", () => {
    const l = at(1180, ALL_OPEN, false);
    expect(l.list).toEqual({ mode: "column", w: 236 });
    expect(l.inspector).toEqual({ mode: "column", w: 360 });
    expect(l.content).toBe(582);
  });

  it("off Timeline the content still keeps 480, counting no outline", () => {
    const l = at(1024, ALL_OPEN, false);
    expect(modes(l)).toEqual(["overlay", "column"]);
    expect(l.content).toBe(663);
  });

  it("a closed outline counts nothing, so the list stays a column at 1180", () => {
    const l = at(1180, { ...ALL_OPEN, outline: { open: false, w: 250 } });
    expect(modes(l)).toEqual(["column", "column"]);
    expect(l.content).toBe(582);
    expect([l.outline.open, l.outline.squeezed]).toEqual([false, false]);
  });

  it("closed panes stay closed and give their room to the content", () => {
    const l = at(1024, { list: { open: false, w: 300 }, outline: OPEN, inspector: { open: false, w: 400 } });
    expect(l.list).toEqual({ mode: "closed", w: null });
    expect(l.inspector).toEqual({ mode: "closed", w: null });
    expect(l.content).toBe(1024);
    expect(l.outline).toEqual({ open: true, w: 300, squeezed: false });
  });

  it("clamps stored widths to the limits on use", () => {
    const l = at(1920, { list: { open: true, w: 9000 }, outline: { open: true, w: 20 }, inspector: { open: true, w: 9000 } });
    expect([l.list.w, l.inspector.w, l.outline.w]).toEqual([480, 640, 160]);
    expect(at(1920, { ...ALL_OPEN, list: { open: true, w: 150 } }).list.w).toBe(200);
    expect(at(1920, { ...ALL_OPEN, outline: { open: true, w: 5000 } }).outline).toEqual({ open: true, w: Math.floor((1920 - 285 - 361) / 2), squeezed: true });
    expect(modes(at(1920, { ...ALL_OPEN, outline: { open: true, w: 5000 } }))).toEqual(["column", "column"]);
  });

  it("counts a stored outline at most 479 px when the list decides to yield, so a wide outline is squeezed, not the list", () => {
    const panes: PaneSet = { ...ALL_OPEN, outline: { open: true, w: 600 } };
    const l = at(1700, panes);
    expect(l.content).toBe(1700 - 285 - 361);
    expect(l.content - 600).toBeLessThan(CONTENT_MIN);
    expect(modes(l)).toEqual(["column", "column"]);
    expect(l.outline).toEqual({ open: true, w: Math.floor(l.content / 2), squeezed: true });
    expect(modes(at(958, { ...panes, inspector: { open: false, w: null } }))).toEqual(["overlay", "closed"]);
    expect(modes(at(1024 + 285 + 1, { ...panes, inspector: { open: false, w: null } }))).toEqual(["column", "closed"]);
  });

  it("widening restores", () => {
    const panes: PaneSet = { list: { open: true, w: 300 }, outline: { open: true, w: 280 }, inspector: { open: true, w: 400 } };
    const narrow = at(1024, panes);
    expect(modes(narrow)).toEqual(["overlay", "overlay"]);
    const wide = at(1600, panes);
    expect(wide.list).toEqual({ mode: "column", w: 300 });
    expect(wide.inspector).toEqual({ mode: "column", w: 400 });
    expect(wide.outline).toEqual({ open: true, w: 280, squeezed: false });
  });

  it("keeps the chart at 480 or more on every desk width", () => {
    const widths = Array.from({ length: 90 }, (_, i) => 1024 + i * 10);
    const chart = widths.flatMap((w) => [ALL_OPEN, { ...ALL_OPEN, inspector: { open: true, w: 640 } }].map((p) => at(w, p))).map((l) => l.content - (l.outline.open ? l.outline.w : 0));
    expect(chart.filter((c) => c < CONTENT_MIN)).toEqual([]);
  });

  it("caps never force a yield", () => {
    const stored: readonly PaneSet[] = [
      ALL_OPEN,
      { list: { open: true, w: 260 }, outline: { open: true, w: 220 }, inspector: { open: true, w: 330 } },
      { list: { open: true, w: 200 }, outline: { open: false, w: null }, inspector: { open: true, w: 300 } },
      { list: { open: true, w: null }, outline: { open: true, w: 400 }, inspector: { open: false, w: null } },
      { list: { open: true, w: 240 }, outline: { open: true, w: 700 }, inspector: { open: true, w: 320 } },
    ];
    const cases = Array.from({ length: 46 }, (_, i) => 1024 + i * 20).flatMap((w) => stored.flatMap((p) => [true, false].map((timeline) => ({ w, p, timeline }))));
    const broken = cases.flatMap(({ w, p, timeline }) => {
      const before = at(w, p, timeline);
      const tries: readonly (readonly [string, PaneSet])[] = [
        ["list", before.list.mode === "column" ? { ...p, list: { open: true, w: before.caps.list } } : p],
        ["inspector", before.inspector.mode === "column" ? { ...p, inspector: { open: true, w: before.caps.inspector } } : p],
        ["outline", { ...p, outline: { open: p.outline.open, w: before.caps.outline } }],
      ];
      return tries
        .map(([key, next]) => ({ key, after: at(w, next, timeline) }))
        .filter(({ after }) => after.list.mode !== before.list.mode || after.inspector.mode !== before.inspector.mode)
        .map(({ key }) => `${w} ${timeline ? "timeline" : "board"} ${key}`);
    });
    expect(broken).toEqual([]);
  });

  it("caps stop a divider where the next pixel would yield", () => {
    const l = at(1440);
    expect(l.caps).toEqual({ list: 1440 - 361 - 300 - 481, inspector: 1440 - 285 - 300 - 481, outline: Math.min(Math.floor(794 / 2), 794 - 480) });
    expect(at(1440, { ...ALL_OPEN, list: { open: true, w: l.caps.list + 1 } }).list.mode).toBe("overlay");
    expect(at(1440, { ...ALL_OPEN, inspector: { open: true, w: l.caps.inspector + 1 } }).list.mode).toBe("overlay");
  });

  it("caps never go below a pane's minimum", () => {
    const l = at(1024);
    expect(l.caps.list).toBeGreaterThanOrEqual(200);
    expect(l.caps.inspector).toBeGreaterThanOrEqual(300);
    expect(l.caps.outline).toBeGreaterThanOrEqual(160);
    expect(at(1920, ALL_OPEN, false).caps).toEqual({ list: 480, inspector: 640, outline: Math.min(Math.floor((1920 - 285 - 361) / 2), 1920 - 285 - 361 - 480) });
  });
});

describe("paneLayout in the overlay and sheet bases", () => {
  it("overlay and sheet bases", () => {
    const overlay = at(834, { ...ALL_OPEN, inspector: { open: true, w: 900 } }, true, "overlay");
    expect(overlay.list).toEqual({ mode: "overlay", w: 320 });
    expect(overlay.inspector).toEqual({ mode: "overlay", w: Math.floor(0.85 * 834) });
    expect(overlay.content).toBe(834);
    expect(overlay.outline).toEqual({ open: true, w: 300, squeezed: false });
    expect(at(700, ALL_OPEN, true, "overlay").outline).toEqual({ open: true, w: 220, squeezed: true });
    expect(at(320, { list: { open: false, w: null }, outline: OPEN, inspector: { open: false, w: null } }, true, "overlay").list).toEqual({ mode: "overlay", w: 272 });
    const sheet = at(820, ALL_OPEN, true, "sheet");
    expect(sheet.list).toEqual({ mode: "sheet", w: null });
    expect(sheet.inspector).toEqual({ mode: "sheet", w: null });
    expect(sheet.content).toBe(820);
    expect(sheet.outline).toEqual({ open: true, w: 300, squeezed: false });
    expect(at(600, ALL_OPEN, true, "sheet").outline).toEqual({ open: true, w: 160, squeezed: true });
  });

  it("drawer caps follow the drawer widths", () => {
    expect(at(834, ALL_OPEN, true, "overlay").caps).toEqual({ list: 320, inspector: Math.floor(0.85 * 834), outline: Math.min(417, 834 - 480) });
  });

  it("with the list a drawer, the inspector's cap keeps the outline's minimum", () => {
    const l = at(1024);
    expect(l.caps.inspector).toBe(1024 - 160 - 481);
    expect(at(1024, { ...ALL_OPEN, inspector: { open: true, w: l.caps.inspector } }).inspector.mode).toBe("column");
    expect(at(1024, { ...ALL_OPEN, inspector: { open: true, w: l.caps.inspector + 1 } }).inspector.mode).toBe("overlay");
  });
});

describe("paneWidthForKey", () => {
  const limits = { min: 200, max: 480, def: 284 };

  it("moves a leading pane's divider with the arrows", () => {
    expect(paneWidthForKey({ key: "ArrowRight", shiftKey: false }, 300, limits, "start")).toEqual({ open: true, w: 316 });
    expect(paneWidthForKey({ key: "ArrowLeft", shiftKey: false }, 300, limits, "start")).toEqual({ open: true, w: 284 });
    expect(paneWidthForKey({ key: "ArrowRight", shiftKey: true }, 300, limits, "start")).toEqual({ open: true, w: 364 });
    expect(paneWidthForKey({ key: "ArrowLeft", shiftKey: true }, 300, limits, "start")).toEqual({ open: true, w: 236 });
  });

  it("moves a trailing pane's divider the other way", () => {
    const insp = { min: 300, max: 640, def: 360 };
    expect(paneWidthForKey({ key: "ArrowLeft", shiftKey: false }, 360, insp, "end")).toEqual({ open: true, w: 376 });
    expect(paneWidthForKey({ key: "ArrowRight", shiftKey: false }, 360, insp, "end")).toEqual({ open: true, w: 344 });
    expect(paneWidthForKey({ key: "ArrowLeft", shiftKey: true }, 360, insp, "end")).toEqual({ open: true, w: 424 });
    expect(paneWidthForKey({ key: "ArrowRight", shiftKey: true }, 360, insp, "end")).toEqual({ open: true, w: 300 });
  });

  it.each<"start" | "end">(["start", "end"])("clamps, jumps and resets on the %s side", (side) => {
    const grow = side === "start" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "start" ? "ArrowLeft" : "ArrowRight";
    expect(paneWidthForKey({ key: grow, shiftKey: true }, 470, limits, side)).toEqual({ open: true, w: 480 });
    expect(paneWidthForKey({ key: shrink, shiftKey: true }, 210, limits, side)).toEqual({ open: true, w: 200 });
    expect(paneWidthForKey({ key: grow, shiftKey: false }, null, limits, side)).toEqual({ open: true, w: 300 });
    expect(paneWidthForKey({ key: "Home", shiftKey: false }, 300, limits, side)).toEqual({ open: true, w: 200 });
    expect(paneWidthForKey({ key: "End", shiftKey: false }, 300, limits, side)).toEqual({ open: true, w: 480 });
    expect(paneWidthForKey({ key: "Enter", shiftKey: false }, 300, limits, side)).toEqual({ open: true, w: null });
    expect(paneWidthForKey({ key: "a", shiftKey: false }, 300, limits, side)).toBeNull();
    expect(paneWidthForKey({ key: "ArrowUp", shiftKey: false }, 300, limits, side)).toBeNull();
  });

  it("throws on a width that is not a finite number", () => {
    expect(() => paneWidthForKey({ key: "ArrowRight", shiftKey: false }, Number.NaN, limits, "start")).toThrow("pane: width NaN is not a finite number");
  });
});
