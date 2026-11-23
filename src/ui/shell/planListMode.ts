import { readPlatform, type Platform } from "../../platform";
import { useLayoutEffect } from "react";
import { measuredForm, useStampForm, useWindowValue, type FormFactor } from "./formFactor";

export type PlanListMode = "column" | "overlay" | "sheet" | "phone";

export const REGULAR_MIN_WIDTH = 700;

export const DESK_MIN_WIDTH = 1024;

export type ToolbarTier = "roomy" | "medium" | "narrow";

export const ROOMY_MIN = 960;
export const MEDIUM_MIN = 870;

export function planListMode(m: { form: FormFactor; width: number; platform: Platform }): PlanListMode {
  if (m.form === "phone") return "phone";
  if (m.platform.os !== "ios") return m.width >= DESK_MIN_WIDTH ? "column" : "sheet";
  if (m.form === "full") return "column";
  return m.platform.idiom === "pad" && m.width >= REGULAR_MIN_WIDTH ? "overlay" : "sheet";
}

export const DESK_ROOMY_BELOW = 1180;

export function toolbarTier(m: { form: FormFactor; width: number; platform: Platform }): ToolbarTier | null {
  if (m.platform.os !== "ios") return m.width >= DESK_MIN_WIDTH && m.width < DESK_ROOMY_BELOW ? "roomy" : null;
  if (m.platform.idiom !== "pad" || m.form !== "compact") return null;
  if (m.width >= ROOMY_MIN) return "roomy";
  return m.width >= MEDIUM_MIN ? "medium" : "narrow";
}

type WidthClass = "regular" | "compact";

interface Shape {
  form: FormFactor;
  width: WidthClass;
  mode: PlanListMode;
  tier: ToolbarTier | null;
  window: { w: number; h: number };
}

const readShape = (): Shape => {
  const form = measuredForm();
  const width = window.innerWidth;
  const platform = readPlatform(window);
  return { form, width: width >= REGULAR_MIN_WIDTH ? "regular" : "compact", mode: planListMode({ form, width, platform }), tier: toolbarTier({ form, width, platform }), window: { w: width, h: window.innerHeight } };
};

const sameShape = (a: Shape, b: Shape): boolean => a.form === b.form && a.width === b.width && a.mode === b.mode && a.tier === b.tier && a.window.w === b.window.w && a.window.h === b.window.h;

export function useShellShape(): { mode: PlanListMode; tier: ToolbarTier | null; window: { w: number; h: number } } {
  const { form, width, mode, tier, window: size } = useWindowValue(readShape, sameShape);
  useStampForm(form);
  useLayoutEffect(() => {
    document.documentElement.dataset.width = width;
  }, [width]);
  return { mode, tier, window: size };
}
