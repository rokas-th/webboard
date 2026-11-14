export type Os = "macos" | "linux" | "ios";
export type Idiom = "phone" | "pad";

export type Platform = { os: "macos" | "linux"; idiom: null } | { os: "ios"; idiom: Idiom };

declare global {
  interface Window {
    __WEBBOARD_PLATFORM__?: unknown;
  }
}

const GLOBAL = "window.__WEBBOARD_PLATFORM__";
const OSES: readonly Os[] = ["macos", "linux", "ios"];
const KEYS = ["os", "idiom"];

const shown = (v: unknown): string => {
  if (v === undefined) return "undefined";
  if (typeof v === "bigint") return `${String(v)}n`;
  if (typeof v === "symbol" || typeof v === "function") return String(v);
  return JSON.stringify(v);
};

const kindOf = (v: unknown): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v} (${shown(v)})`;
};

const isOs = (v: unknown): v is Os => OSES.some((os) => os === v);

export function parsePlatform(raw: unknown): Platform {
  if (raw === undefined) throw new Error(`${GLOBAL} is missing: the native shell or the harness did not inject the platform before the page ran`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${GLOBAL} is ${kindOf(raw)}, not an object`);
  if (!Object.isFrozen(raw)) throw new Error(`${GLOBAL} is not frozen`);
  const extra = Object.keys(raw).filter((k) => !KEYS.includes(k));
  if (extra.length > 0) throw new Error(`${GLOBAL} carries an unknown key: ${extra.join(", ")}`);
  if (!("os" in raw)) throw new Error(`${GLOBAL} has no os`);
  if (!("idiom" in raw)) throw new Error(`${GLOBAL} has no idiom`);
  const { os, idiom } = raw;
  if (!isOs(os)) throw new Error(`${GLOBAL}.os is ${shown(os)}, not one of ${OSES.join(", ")}`);
  if (os === "ios") {
    if (idiom === "phone" || idiom === "pad") return { os, idiom };
    throw new Error(`${GLOBAL}.idiom is ${shown(idiom)} on ios, not phone or pad`);
  }
  if (idiom !== null) throw new Error(`${GLOBAL}.idiom is ${shown(idiom)} on ${os}, where it must be null`);
  return { os, idiom };
}

export function readPlatform(w: Window): Platform {
  return parsePlatform(w.__WEBBOARD_PLATFORM__);
}

export function stampPlatform(html: HTMLElement, p: Platform): void {
  html.dataset.os = p.os;
  if (p.idiom === null) delete html.dataset.idiom;
  else html.dataset.idiom = p.idiom;
}
