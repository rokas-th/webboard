import { afterEach, describe, expect, it } from "vitest";
import { parsePlatform, readPlatform, stampPlatform, type Platform } from "./platform";
import { setPlatform } from "./test/platform";

const SELECTS_STAMP = /data-(os|idiom)\b/;
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

describe("the stamp is not styled yet", () => {
  it("finds the stylesheets it pins", () => {
    expect(Object.keys(STYLES).length).toBeGreaterThan(10);
  });

  it("the pin catches a selector on either attribute", () => {
    expect(SELECTS_STAMP.test('html[data-os="ios"] .toolbar { gap: 0; }')).toBe(true);
    expect(SELECTS_STAMP.test("html[data-idiom='pad'] .toolbar { gap: 0; }")).toBe(true);
    expect(SELECTS_STAMP.test("html[data-form='phone'] .toolbar { gap: 0; }")).toBe(false);
  });

  it("no stylesheet selects on data-os or data-idiom", () => {
    const styled = Object.entries(STYLES)
      .filter(([, css]) => SELECTS_STAMP.test(css))
      .map(([file]) => file);
    expect(styled).toEqual([]);
  });
});
