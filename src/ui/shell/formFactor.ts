import { useLayoutEffect, useState } from "react";

export type FormFactor = "full" | "compact" | "phone";

export const FULL_MIN_WIDTH = 1024;
export const PHONE_MAX_SCREEN_SHORT = 600;

export function formFactor(m: { width: number; screenShort: number }): FormFactor {
  if (m.screenShort < PHONE_MAX_SCREEN_SHORT) return "phone";
  return m.width >= FULL_MIN_WIDTH ? "full" : "compact";
}

const measure = (): FormFactor => formFactor({ width: window.innerWidth, screenShort: Math.min(window.screen.width, window.screen.height) });

export function useFormFactor(): FormFactor {
  const [form, setForm] = useState<FormFactor>(measure);
  useLayoutEffect(() => {
    document.documentElement.dataset.form = form;
  }, [form]);
  useLayoutEffect(() => {
    const update = (): void => setForm(measure());
    update();
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, []);
  return form;
}
