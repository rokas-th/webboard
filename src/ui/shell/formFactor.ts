import { useLayoutEffect, useState } from "react";

export type FormFactor = "full" | "compact" | "phone";

export const FULL_MIN_WIDTH = 1180;
export const PHONE_MAX_SCREEN_SHORT = 600;

export function formFactor(m: { width: number; screenShort: number }): FormFactor {
  if (m.screenShort < PHONE_MAX_SCREEN_SHORT) return "phone";
  return m.width >= FULL_MIN_WIDTH ? "full" : "compact";
}

export const measuredForm = (): FormFactor => formFactor({ width: window.innerWidth, screenShort: Math.min(window.screen.width, window.screen.height) });

export function useWindowValue<T>(read: () => T, same: (a: T, b: T) => boolean): T {
  const [value, setValue] = useState<T>(read);
  useLayoutEffect(() => {
    const update = (): void => {
      const next = read();
      setValue((was) => (same(was, next) ? was : next));
    };
    update();
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, [read, same]);
  return value;
}

export function useStampForm(form: FormFactor): void {
  useLayoutEffect(() => {
    document.documentElement.dataset.form = form;
  }, [form]);
}
