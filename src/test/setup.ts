import { beforeEach, vi } from "vitest";

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (window.PointerEvent === undefined) Object.defineProperty(window, "PointerEvent", { configurable: true, writable: true, value: TestPointerEvent });
if (window.ResizeObserver === undefined) Object.defineProperty(window, "ResizeObserver", { configurable: true, writable: true, value: TestResizeObserver });
if (Element.prototype.setPointerCapture === undefined) {
  Element.prototype.setPointerCapture = function setPointerCapture(): void {};
  Element.prototype.releasePointerCapture = function releasePointerCapture(): void {};
  Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return false;
  };
}
const scrollIntoView = vi.fn<(this: Element, arg?: boolean | ScrollIntoViewOptions) => void>();
Element.prototype.scrollIntoView = scrollIntoView;
beforeEach(() => {
  scrollIntoView.mockClear();
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
