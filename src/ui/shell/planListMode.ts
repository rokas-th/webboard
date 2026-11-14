import { readPlatform, type Platform } from "../../platform";
import { useLayoutEffect } from "react";
import { measuredForm, useStampForm, useWindowValue, type FormFactor } from "./formFactor";

export type PlanListMode = "column" | "overlay" | "sheet" | "phone";

export const REGULAR_MIN_WIDTH = 700;

export function planListMode(m: { form: FormFactor; width: number; platform: Platform }): PlanListMode {
  if (m.form === "phone") return "phone";
  if (m.form === "full") return "column";
  return m.platform.os === "ios" && m.platform.idiom === "pad" && m.width >= REGULAR_MIN_WIDTH ? "overlay" : "sheet";
}

type WidthClass = "regular" | "compact";

interface Shape {
  form: FormFactor;
  width: WidthClass;
  mode: PlanListMode;
}

const readShape = (): Shape => {
  const form = measuredForm();
  const width = window.innerWidth;
  return { form, width: width >= REGULAR_MIN_WIDTH ? "regular" : "compact", mode: planListMode({ form, width, platform: readPlatform(window) }) };
};

const sameShape = (a: Shape, b: Shape): boolean => a.form === b.form && a.width === b.width && a.mode === b.mode;

export function usePlanListMode(): PlanListMode {
  const { form, width, mode } = useWindowValue(readShape, sameShape);
  useStampForm(form);
  useLayoutEffect(() => {
    document.documentElement.dataset.width = width;
  }, [width]);
  return mode;
}
