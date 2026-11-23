import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyLook, applyTokens, paintNative, zoomNative } from "./apply";
import { PRESETS, tokensOf } from "./presets";

const windowSet = vi.fn<(c: string) => Promise<void>>();
const webviewSet = vi.fn<(c: string) => Promise<void>>();
const webviewZoom = vi.fn<(f: number) => Promise<void>>();

vi.unmock("./apply");
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBackgroundColor: windowSet }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setBackgroundColor: webviewSet, setZoom: webviewZoom }) }));

const preset = (id: string) => {
  const t = PRESETS.find((p) => p.id === id);
  if (t === undefined) throw new Error(`no preset ${id}`);
  return t;
};

describe("applyTokens", () => {
  it("writes every token, channel token and the scheme for Cyberdeck", () => {
    const el = document.createElement("div");
    applyTokens(el, tokensOf(preset("cyberdeck")));
    expect(el.style.getPropertyValue("--amber")).toBe("#FFB000");
    expect(el.style.getPropertyValue("--amber-rgb")).toBe("255, 176, 0");
    expect(el.style.getPropertyValue("--void")).toBe("#0A0A14");
    expect(el.style.getPropertyValue("--on-accent-rgb")).toBe("0, 0, 0");
    expect(el.style.getPropertyValue("--scrim")).toBe("rgba(4, 4, 10, 0.72)");
    expect(el.style.getPropertyValue("--hover")).toBe("rgba(36, 224, 255, 0.06)");
    expect(el.style.getPropertyValue("--scheme")).toBe("");
    expect(el.dataset.scheme).toBe("dark");
    expect(el.style.colorScheme).toBe("dark");
  });

  it("marks Paper as light", () => {
    const el = document.createElement("div");
    applyTokens(el, tokensOf(preset("paper")));
    expect(el.dataset.scheme).toBe("light");
    expect(el.style.colorScheme).toBe("light");
    expect(el.style.getPropertyValue("--void")).toBe("#FFFFFF");
  });
});

describe("paintNative", () => {
  beforeEach(() => {
    windowSet.mockReset();
    webviewSet.mockReset();
  });

  it("sets the window and webview background to the ground", async () => {
    windowSet.mockResolvedValue(undefined);
    webviewSet.mockResolvedValue(undefined);
    await paintNative("#FFFFFF");
    expect(windowSet).toHaveBeenCalledWith("#FFFFFF");
    expect(webviewSet).toHaveBeenCalledWith("#FFFFFF");
  });

  it("rejects when one setter rejects", async () => {
    windowSet.mockResolvedValue(undefined);
    webviewSet.mockRejectedValue(new Error("not allowed"));
    await expect(paintNative("#0A0A14")).rejects.toThrow("not allowed");
  });
});

describe("applyLook", () => {
  it("stamps density, text size and glow on the root", () => {
    const el = document.createElement("html");
    applyLook(el, { density: "compact", text: "small", glow: "reduced" });
    expect([el.dataset.density, el.dataset.textSize, el.dataset.glow]).toEqual(["compact", "small", "reduced"]);
    applyLook(el, { density: "comfortable", text: "default", glow: "full" });
    expect([el.getAttribute("data-density"), el.getAttribute("data-text-size"), el.getAttribute("data-glow")]).toEqual(["comfortable", "default", "full"]);
  });
});

describe("zoomNative", () => {
  beforeEach(() => {
    webviewZoom.mockReset();
  });

  it("sets the webview zoom to the factor", async () => {
    webviewZoom.mockResolvedValue(undefined);
    await zoomNative(1.15);
    expect(webviewZoom.mock.calls).toEqual([[1.15]]);
  });

  it("rejects when the webview refuses", async () => {
    webviewZoom.mockRejectedValue(new Error("not allowed"));
    await expect(zoomNative(0.92)).rejects.toThrow("not allowed");
  });
});
