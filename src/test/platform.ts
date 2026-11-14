import type { Platform } from "../platform";

export const MAC: Platform = { os: "macos", idiom: null };
export const LINUX: Platform = { os: "linux", idiom: null };
export const IPHONE: Platform = { os: "ios", idiom: "phone" };
export const IPAD: Platform = { os: "ios", idiom: "pad" };

export function stubVisualViewport(): () => void {
  Object.defineProperty(window, "visualViewport", { configurable: true, writable: true, value: { offsetLeft: 0, offsetTop: 0, scale: 1 } });
  return () => {
    Reflect.deleteProperty(window, "visualViewport");
  };
}

export function setPlatform(p: Platform): void {
  Object.defineProperty(window, "__WEBBOARD_PLATFORM__", { configurable: true, writable: true, value: Object.freeze({ ...p }) });
}
