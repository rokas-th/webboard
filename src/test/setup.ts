import { afterEach, beforeEach, vi } from "vitest";
import { installMatchMedia, resetMediaQueries } from "./matchMedia";
import { setPlatform } from "./platform";

vi.mock("../theme/apply", async (importOriginal) => {
  const real = await importOriginal<typeof import("../theme/apply")>();
  return { ...real, paintNative: vi.fn(async () => undefined) };
});

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (window.PointerEvent === undefined) Object.defineProperty(window, "PointerEvent", { configurable: true, writable: true, value: TestPointerEvent });
if (window.ResizeObserver === undefined) Object.defineProperty(window, "ResizeObserver", { configurable: true, writable: true, value: TestResizeObserver });
const captured = new WeakMap<Element, Set<number>>();
const capturedBy = (el: Element): Set<number> => {
  const ids = captured.get(el) ?? new Set<number>();
  captured.set(el, ids);
  return ids;
};
if (Element.prototype.setPointerCapture === undefined) {
  Element.prototype.setPointerCapture = function setPointerCapture(this: Element, id: number): void {
    capturedBy(this).add(id);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(this: Element, id: number): void {
    capturedBy(this).delete(id);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(this: Element, id: number): boolean {
    return capturedBy(this).has(id);
  };
}
const scrollIntoView = vi.fn<(this: Element, arg?: boolean | ScrollIntoViewOptions) => void>();
Element.prototype.scrollIntoView = scrollIntoView;

export function setScreen(w: number, h: number): void {
  Object.defineProperty(window.screen, "width", { configurable: true, value: w });
  Object.defineProperty(window.screen, "height", { configurable: true, value: h });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: h });
  window.dispatchEvent(new Event("resize"));
}

installMatchMedia();
setPlatform({ os: "macos", idiom: null });

beforeEach(() => {
  setPlatform({ os: "macos", idiom: null });
  scrollIntoView.mockClear();
  document.documentElement.style.setProperty("--sidebar-w", "284px");
  setScreen(1440, 900);
  resetMediaQueries();
});

afterEach(() => {
  window.localStorage.removeItem("webboard.theme");
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.scheme;
});
if (!("isContentEditable" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement): boolean {
      const state = this.getAttribute("contenteditable");
      const mode = state === null ? null : state.toLowerCase();
      if (mode === "" || mode === "true" || mode === "plaintext-only") return true;
      if (mode === "false") return false;
      const up = this.parentElement;
      return up !== null && up.isContentEditable;
    },
  });
}
if (Document.prototype.elementFromPoint === undefined) {
  Document.prototype.elementFromPoint = function elementFromPoint(): Element | null {
    throw new Error("elementFromPoint is not stubbed in this test");
  };
}
