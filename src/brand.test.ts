import { describe, expect, it } from "vitest";
import brandMark from "../assets/brand/logo-mark.svg?raw";
import publicMark from "../public/logo-mark.svg?raw";
import indexHtml from "../index.html?raw";
import tauriConf from "../src-tauri/tauri.conf.json";
import appIcon from "../src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/Contents.json";

const ICONS = Object.keys(import.meta.glob("/src-tauri/icons/**/*"));
const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const CATALOG = Object.keys(import.meta.glob("/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/*.png"));
const IOS_PNGS: Record<string, string> = {
  ...import.meta.glob<string>("/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/*.png", { query: "?inline", import: "default", eager: true }),
  ...import.meta.glob<string>("/src-tauri/icons/ios/*.png", { query: "?inline", import: "default", eager: true }),
};

const bytesOf = (dataUrl: string): Uint8Array => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));

const chunkTypes = (png: Uint8Array, at = 8): string[] => {
  if (at >= png.length) return [];
  const length = new DataView(png.buffer, png.byteOffset + at, 4).getUint32(0);
  const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
  return [type, ...chunkTypes(png, at + 12 + length)];
};

describe("brand assets", () => {
  it("serves the brand mark unchanged from public/", () => {
    expect(publicMark).toBe(brandMark);
  });

  it("uses the mark as the favicon", () => {
    expect(indexHtml).toContain('<link rel="icon" type="image/svg+xml" href="/logo-mark.svg" />');
  });

  it("bundles only icons that exist", () => {
    expect(tauriConf.bundle.icon.length).toBeGreaterThan(0);
    expect(tauriConf.bundle.icon.filter((p) => !ICONS.includes(`/src-tauri/${p}`))).toEqual([]);
  });

  it("keeps the iOS catalog and src-tauri/icons/ios in step with Contents.json", () => {
    const listed = appIcon.images.map((i) => i.filename).sort();
    expect(listed).not.toEqual([]);
    expect(CATALOG.map(base).sort()).toEqual(listed);
    expect(ICONS.filter((p) => p.startsWith("/src-tauri/icons/ios/")).map(base).sort()).toEqual(listed);
  });

  it("ships every iOS icon as opaque RGB with no tRNS chunk", () => {
    const pngs = Object.entries(IOS_PNGS).map(([path, url]) => ({ path, png: bytesOf(url) }));
    expect(pngs.length).toBe(2 * appIcon.images.length);
    expect(pngs.filter(({ png }) => String.fromCharCode(...png.subarray(12, 16)) !== "IHDR").map(({ path }) => path)).toEqual([]);
    expect(pngs.filter(({ png }) => png[25] !== 2).map(({ path, png }) => `${path}: colour type ${png[25]}`)).toEqual([]);
    expect(pngs.filter(({ png }) => chunkTypes(png).includes("tRNS")).map(({ path }) => path)).toEqual([]);
    expect(pngs.filter(({ png }) => chunkTypes(png).slice(-1)[0] !== "IEND").map(({ path }) => path)).toEqual([]);
  });
});
