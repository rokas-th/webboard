import { describe, expect, it } from "vitest";
import brandMark from "../assets/brand/logo-mark.svg?raw";
import publicMark from "../public/logo-mark.svg?raw";
import indexHtml from "../index.html?raw";
import tauriConf from "../src-tauri/tauri.conf.json";
import appIcon from "../src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/Contents.json";

const ICONS = Object.keys(import.meta.glob("/src-tauri/icons/**/*"));
const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const CATALOG = Object.keys(import.meta.glob("/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/*.png"));

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
    expect(CATALOG.map(base).sort()).toEqual(listed);
    expect(ICONS.filter((p) => p.startsWith("/src-tauri/icons/ios/")).map(base).sort()).toEqual(listed);
  });
});
