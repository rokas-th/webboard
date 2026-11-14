import type { Platform } from "../platform";

export const MAC: Platform = { os: "macos", idiom: null };
export const LINUX: Platform = { os: "linux", idiom: null };
export const IPHONE: Platform = { os: "ios", idiom: "phone" };
export const IPAD: Platform = { os: "ios", idiom: "pad" };

export function setPlatform(p: Platform): void {
  Object.defineProperty(window, "__WEBBOARD_PLATFORM__", { configurable: true, writable: true, value: Object.freeze({ ...p }) });
}
