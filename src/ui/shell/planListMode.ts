import { readPlatform, type Platform } from "../../platform";
import { useLayoutEffect } from "react";
import { measuredForm, useStampForm, useWindowValue, type FormFactor } from "./formFactor";

export type PlanListMode = "column" | "overlay" | "sheet" | "phone";

export const REGULAR_MIN_WIDTH = 700;

export type ToolbarTier = "roomy" | "medium" | "narrow";

export const ROOMY_MIN = 1010;
export const MEDIUM_MIN = 830;

export function planListMode(m: { form: FormFactor; width: number; platform: Platform }): PlanListMode {
  if (m.form === "phone") return "phone";
  if (m.form === "full") return "column";
  return m.platform.os === "ios" && m.platform.idiom === "pad" && m.width >= REGULAR_MIN_WIDTH ? "overlay" : "sheet";
}

export function toolbarTier(m: { form: FormFactor; width: number; platform: Platform }): ToolbarTier | null {
  if (m.platform.os !== "ios" || m.platform.idiom !== "pad" || m.form !== "compact") return null;
  if (m.width >= ROOMY_MIN) return "roomy";
  return m.width >= MEDIUM_MIN ? "medium" : "narrow";
}

type WidthClass = "regular" | "compact";

interface Shape {
  form: FormFactor;
  width: WidthClass;
  mode: PlanListMode;
  tier: ToolbarTier | null;
}

const readShape = (): Shape => {
  const form = measuredForm();
  const width = window.innerWidth;
  const platform = readPlatform(window);
  return { form, width: width >= REGULAR_MIN_WIDTH ? "regular" : "compact", mode: planListMode({ form, width, platform }), tier: toolbarTier({ form, width, platform }) };
};

const sameShape = (a: Shape, b: Shape): boolean => a.form === b.form && a.width === b.width && a.mode === b.mode && a.tier === b.tier;

export function useShellShape(): { mode: PlanListMode; tier: ToolbarTier | null } {
  const { form, width, mode, tier } = useWindowValue(readShape, sameShape);
  useStampForm(form);
  useLayoutEffect(() => {
    document.documentElement.dataset.width = width;
  }, [width]);
  return { mode, tier };
}
