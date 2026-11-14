import { afterEach, describe, expect, it } from "vitest";
import { parsePlatform, readPlatform, shortcutsUseCommand, stampPlatform, type Platform } from "./platform";
import { setPlatform } from "./test/platform";

const STAMP_SELECTOR = /\[\s*data-(?:os|idiom)\b[^\]]*\]/g;
const ON_IOS = /^\[\s*data-(?:os\s*=\s*(["']?)ios\1|idiom\s*=\s*(["']?)(?:phone|pad)\2)\s*\]$/;
const NOT_OPEN = /:not\(/g;
const depth = (text: string): number => [...text].reduce((d, c) => d + (c === "(" ? 1 : c === ")" ? -1 : 0), 0);
const negated = (css: string, at: number): boolean => {
  const selector = css.slice(Math.max(css.lastIndexOf("{", at), css.lastIndexOf("}", at)) + 1, at);
  return [...selector.matchAll(NOT_OPEN)].some((m) => depth(selector.slice(m.index + ":not".length)) > 0);
};
const stampSelectors = (css: string): string[] => [...css.matchAll(STAMP_SELECTOR)].map((m) => (negated(css, m.index) ? `:not(${m[0]})` : m[0]));
const offIos = (css: string): string[] => stampSelectors(css).filter((sel) => !ON_IOS.test(sel));
const STYLES = import.meta.glob<string>("/src/styles/*.css", { query: "?raw", import: "default", eager: true });

describe("parsePlatform", () => {
  it.each<Platform>([
    { os: "macos", idiom: null },
    { os: "linux", idiom: null },
    { os: "ios", idiom: "phone" },
    { os: "ios", idiom: "pad" },
  ])("accepts %o", (value) => {
    expect(parsePlatform(Object.freeze({ ...value }))).toEqual(value);
  });

  it.each<[string, unknown, string]>([
    ["missing", undefined, "window.__WEBBOARD_PLATFORM__ is missing"],
    ["null", null, "window.__WEBBOARD_PLATFORM__ is null, not an object"],
    ["a string", "macos", 'window.__WEBBOARD_PLATFORM__ is a string ("macos"), not an object'],
    ["an array", Object.freeze(["macos", null]), "window.__WEBBOARD_PLATFORM__ is an array, not an object"],
    ["not frozen", { os: "macos", idiom: null }, "window.__WEBBOARD_PLATFORM__ is not frozen"],
    ["without os", Object.freeze({ idiom: null }), "window.__WEBBOARD_PLATFORM__ has no os"],
    ["without idiom", Object.freeze({ os: "macos" }), "window.__WEBBOARD_PLATFORM__ has no idiom"],
    ["with an extra key", Object.freeze({ os: "macos", idiom: null, ua: "x" }), "window.__WEBBOARD_PLATFORM__ carries an unknown key: ua"],
    ["an unknown os", Object.freeze({ os: "windows", idiom: null }), 'window.__WEBBOARD_PLATFORM__.os is "windows", not one of macos, linux, ios'],
    ["an os of the wrong type", Object.freeze({ os: 1, idiom: null }), "window.__WEBBOARD_PLATFORM__.os is 1, not one of macos, linux, ios"],
    ["a bigint", 1n, "window.__WEBBOARD_PLATFORM__ is a bigint (1n), not an object"],
    ["a symbol", Symbol("macos"), "window.__WEBBOARD_PLATFORM__ is a symbol (Symbol(macos)), not an object"],
    ["an os that is a bigint", Object.freeze({ os: 1n, idiom: null }), "window.__WEBBOARD_PLATFORM__.os is 1n, not one of macos, linux, ios"],
    ["ios with a symbol idiom", Object.freeze({ os: "ios", idiom: Symbol("pad") }), "window.__WEBBOARD_PLATFORM__.idiom is Symbol(pad) on ios, not phone or pad"],
    ["ios without an idiom", Object.freeze({ os: "ios", idiom: null }), "window.__WEBBOARD_PLATFORM__.idiom is null on ios, not phone or pad"],
    ["ios with an unknown idiom", Object.freeze({ os: "ios", idiom: "tv" }), 'window.__WEBBOARD_PLATFORM__.idiom is "tv" on ios, not phone or pad'],
    ["an idiom off ios", Object.freeze({ os: "macos", idiom: "pad" }), 'window.__WEBBOARD_PLATFORM__.idiom is "pad" on macos, where it must be null'],
  ])("refuses a global that is %s and names the fault", (_, raw, message) => {
    expect(() => parsePlatform(raw)).toThrow(message);
  });
});

describe("shortcutsUseCommand", () => {
  it.each([
    ["macos", true],
    ["ios", true],
    ["linux", false],
  ] as const)("on %s is %s", (os, want) => {
    expect(shortcutsUseCommand(os)).toBe(want);
  });
});

describe("readPlatform", () => {
  afterEach(() => setPlatform({ os: "macos", idiom: null }));

  it("reads the global the test setup provides", () => {
    expect(readPlatform(window)).toEqual({ os: "macos", idiom: null });
  });

  it("reads an iPad's global", () => {
    setPlatform({ os: "ios", idiom: "pad" });
    expect(readPlatform(window)).toEqual({ os: "ios", idiom: "pad" });
  });

  it("throws when the global is absent instead of guessing", () => {
    Reflect.deleteProperty(window, "__WEBBOARD_PLATFORM__");
    expect(() => readPlatform(window)).toThrow("window.__WEBBOARD_PLATFORM__ is missing");
  });
});

describe("stampPlatform", () => {
  const html = document.documentElement;
  afterEach(() => {
    delete html.dataset.os;
    delete html.dataset.idiom;
  });

  it("stamps the os and leaves the idiom off a desktop", () => {
    html.dataset.idiom = "stale";
    stampPlatform(html, { os: "linux", idiom: null });
    expect(html.getAttribute("data-os")).toBe("linux");
    expect(html.hasAttribute("data-idiom")).toBe(false);
  });

  it("stamps the os and the idiom on an iPhone", () => {
    stampPlatform(html, { os: "ios", idiom: "phone" });
    expect(html.getAttribute("data-os")).toBe("ios");
    expect(html.getAttribute("data-idiom")).toBe("phone");
  });

  it("stamps the idiom on an iPad", () => {
    stampPlatform(html, { os: "ios", idiom: "pad" });
    expect(html.getAttribute("data-idiom")).toBe("pad");
  });
});

describe("the stamp styles iOS only", () => {
  it("finds the stylesheets it pins, and they select on the stamp", () => {
    expect(Object.keys(STYLES).length).toBeGreaterThan(10);
    expect(Object.values(STYLES).flatMap(stampSelectors).length).toBeGreaterThan(0);
  });

  it("the pin reads every form of the selector and names the ones off iOS", () => {
    expect(offIos('html[data-os="ios"] .toolbar, html[data-idiom=pad] .a, html[data-idiom=\'phone\'] .b { gap: 0; }')).toEqual([]);
    expect(offIos('html[data-os="macos"] .toolbar { gap: 0; }')).toEqual(['[data-os="macos"]']);
    expect(offIos("html[data-os=linux] .toolbar { gap: 0; }")).toEqual(["[data-os=linux]"]);
    expect(offIos("html[data-os] .toolbar { gap: 0; }")).toEqual(["[data-os]"]);
    expect(offIos('html[data-os^="i"] .toolbar { gap: 0; }')).toEqual(['[data-os^="i"]']);
    expect(offIos('html[data-idiom="ios"] .toolbar { gap: 0; }')).toEqual(['[data-idiom="ios"]']);
    expect(offIos('html[data-os="ios" i] .toolbar { gap: 0; }')).toEqual(['[data-os="ios" i]']);
    expect(offIos("html[data-form='phone'] .toolbar { gap: 0; }")).toEqual([]);
    expect(offIos('html:not([data-os="ios"]) .toolbar { gap: 0; }')).toEqual([':not([data-os="ios"])']);
    expect(offIos('html:not(.x, [data-idiom=pad]) .toolbar { gap: 0; }')).toEqual([":not([data-idiom=pad])"]);
    expect(offIos('html:not(.x) .a, html[data-os="ios"] .toolbar:not(:hover) { gap: 0; }')).toEqual([]);
  });

  it("every data-os or data-idiom selector names ios, phone or pad", () => {
    const off = Object.entries(STYLES).flatMap(([file, css]) => offIos(css).map((sel) => `${file}: ${sel}`));
    expect(off).toEqual([]);
  });
});
