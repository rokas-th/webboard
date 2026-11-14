export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_STEP = 16;
const SIDEBAR_SHARE = 0.4;

export const sidebarMax = (windowWidth: number): number => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(windowWidth * SIDEBAR_SHARE)));

export function clampToMax(width: number, max: number): number {
  if (!Number.isFinite(width)) throw new Error(`sidebar: width ${width} is not a finite number`);
  return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(width)));
}

export const clampWidth = (width: number, windowWidth: number): number => clampToMax(width, sidebarMax(windowWidth));

export const appliedWidth = (stored: number | null, max: number): number | null => (stored === null ? null : clampToMax(stored, max));

const STEPS: Readonly<Record<string, number>> = { ArrowLeft: -SIDEBAR_STEP, ArrowRight: SIDEBAR_STEP };

export function widthForKey(key: string, current: number, windowWidth: number): { width: number | null } | null {
  if (key === "Enter") return { width: null };
  if (key === "Home") return { width: SIDEBAR_MIN };
  if (key === "End") return { width: sidebarMax(windowWidth) };
  const step = STEPS[key];
  return step === undefined ? null : { width: clampWidth(current + step, windowWidth) };
}
