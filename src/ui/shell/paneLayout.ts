import type { PlanListMode } from "./planListMode";
import type { PaneKey, PaneSet, PaneState } from "./panes";
import { clampToMax, sidebarMax } from "./sidebarWidth";

export const CONTENT_MIN = 480;
export const SNAP = 48;
export const DRAWER_SHARE = 0.85;
export const PHONE_OUTLINE = 132;

export interface PaneLimits {
  list: { min: number };
  outline: { min: number; def: number };
  inspector: { min: number; def: number };
}

export const PANE_LIMITS: Readonly<PaneLimits> = { list: { min: 200 }, outline: { min: 160, def: 300 }, inspector: { min: 300, def: 360 } };

const LIST_DRAWER = 320;
const INSPECTOR_MAX = 640;
const INSPECTOR_SHARE = 0.45;
const OUTLINE_SHARE = 0.5;
const DIVIDER = 1;
const STEP = 16;
const SHIFT_STEP = 64;

export type PaneBase = Exclude<PlanListMode, "phone">;

export type PaneSlot = { mode: "column" | "overlay"; w: number } | { mode: "closed" | "sheet"; w: null };

export interface OutlineLayout {
  open: boolean;
  w: number;
  squeezed: boolean;
}

export interface PaneLayout {
  list: PaneSlot;
  inspector: PaneSlot;
  outline: OutlineLayout;
  content: number;
  caps: Record<PaneKey, number>;
}

const clamp = (w: number, min: number, max: number): number => {
  if (!Number.isFinite(w)) throw new Error(`pane: width ${w} is not a finite number`);
  return Math.min(max, Math.max(min, Math.round(w)));
};

export function paneMax(key: PaneKey, m: { window: number; timeline: number }): number {
  if (key === "list") return sidebarMax(m.window);
  if (key === "inspector") return Math.max(PANE_LIMITS.inspector.min, Math.min(INSPECTOR_MAX, Math.floor(INSPECTOR_SHARE * m.window)));
  return Math.max(PANE_LIMITS.outline.min, Math.floor(OUTLINE_SHARE * m.timeline));
}

const listDrawer = (window: number): number => Math.min(LIST_DRAWER, Math.floor(DRAWER_SHARE * window));

const inspectorDrawer = (stored: number | null, window: number): number =>
  clamp(stored ?? PANE_LIMITS.inspector.def, PANE_LIMITS.inspector.min, Math.max(PANE_LIMITS.inspector.min, Math.floor(DRAWER_SHARE * window)));

const outlineUpper = (content: number): number => Math.min(Math.floor(OUTLINE_SHARE * content), content - CONTENT_MIN);

const outlineCap = (content: number): number => Math.max(PANE_LIMITS.outline.min, outlineUpper(content));

function outlineIn(content: number, want: number, open: boolean): OutlineLayout {
  const w = Math.max(PANE_LIMITS.outline.min, Math.min(want, outlineUpper(content)));
  return { open, w, squeezed: open && w < want };
}

export function paneLayout(m: { window: number; base: PaneBase; timeline: boolean; panes: PaneSet; listDefault: number }): PaneLayout {
  const { window, base, timeline, panes } = m;
  const outlineWant = Math.max(PANE_LIMITS.outline.min, Math.round(panes.outline.w ?? PANE_LIMITS.outline.def));
  const outlineShown = timeline && panes.outline.open;
  const outlineReserve = outlineShown ? Math.min(outlineWant, CONTENT_MIN - 1) : 0;
  if (base !== "column") {
    const outline = outlineIn(window, outlineWant, panes.outline.open);
    if (base === "sheet") return { list: { mode: "sheet", w: null }, inspector: { mode: "sheet", w: null }, outline, content: window, caps: { list: PANE_LIMITS.list.min, inspector: PANE_LIMITS.inspector.min, outline: outlineCap(window) } };
    const list = listDrawer(window);
    const inspector = inspectorDrawer(panes.inspector.w, window);
    return { list: { mode: "overlay", w: list }, inspector: { mode: "overlay", w: inspector }, outline, content: window, caps: { list, inspector: Math.max(PANE_LIMITS.inspector.min, Math.floor(DRAWER_SHARE * window)), outline: outlineCap(window) } };
  }
  const listMax = paneMax("list", { window, timeline: 0 });
  const inspectorMax = paneMax("inspector", { window, timeline: 0 });
  const listW = clampToMax(panes.list.w ?? m.listDefault, listMax);
  const inspectorW = clamp(panes.inspector.w ?? PANE_LIMITS.inspector.def, PANE_LIMITS.inspector.min, inspectorMax);
  const contentOf = (list: boolean, inspector: boolean): number => window - (list ? listW + DIVIDER : 0) - (inspector ? inspectorW + DIVIDER : 0);
  const listFits = !panes.list.open || contentOf(true, panes.inspector.open) - outlineReserve >= CONTENT_MIN;
  const listColumn = panes.list.open && listFits;
  const inspectorFits = !panes.inspector.open || contentOf(listColumn, true) - (outlineShown ? PANE_LIMITS.outline.min : 0) >= CONTENT_MIN;
  const inspectorColumn = panes.inspector.open && inspectorFits;
  const content = contentOf(listColumn, inspectorColumn);
  const list: PaneSlot = !panes.list.open ? { mode: "closed", w: null } : listColumn ? { mode: "column", w: listW } : { mode: "overlay", w: listDrawer(window) };
  const inspector: PaneSlot = !panes.inspector.open ? { mode: "closed", w: null } : inspectorColumn ? { mode: "column", w: inspectorW } : { mode: "overlay", w: inspectorDrawer(panes.inspector.w, window) };
  const withoutList = window - (inspectorColumn ? inspectorW + DIVIDER : 0);
  const withoutInspector = window - (listColumn ? listW + DIVIDER : 0);
  const inspectorReserve = listColumn ? outlineReserve : outlineShown ? PANE_LIMITS.outline.min : 0;
  const caps: Record<PaneKey, number> = {
    list: list.mode === "overlay" ? list.w : Math.max(PANE_LIMITS.list.min, Math.min(listMax, withoutList - outlineReserve - CONTENT_MIN - DIVIDER)),
    inspector: inspector.mode === "overlay" ? Math.max(PANE_LIMITS.inspector.min, Math.floor(DRAWER_SHARE * window)) : Math.max(PANE_LIMITS.inspector.min, Math.min(inspectorMax, withoutInspector - inspectorReserve - CONTENT_MIN - DIVIDER)),
    outline: outlineCap(content),
  };
  return { list, inspector, outline: outlineIn(content, outlineWant, panes.outline.open), content, caps };
}

export function paneWidthForKey(
  e: { key: string; shiftKey: boolean },
  current: number | null,
  limits: { min: number; max: number; def: number },
  side: "start" | "end",
): PaneState | null {
  if (e.key === "Enter") return { open: true, w: null };
  if (e.key === "Home") return { open: true, w: limits.min };
  if (e.key === "End") return { open: true, w: limits.max };
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return null;
  const grows = (e.key === "ArrowRight") === (side === "start");
  const step = (e.shiftKey ? SHIFT_STEP : STEP) * (grows ? 1 : -1);
  return { open: true, w: clamp((current ?? limits.def) + step, limits.min, limits.max) };
}
