import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";
import { Popover } from "./Popover";

afterEach(() => {
  cleanup();
});

const popover = (): HTMLElement => screen.getByRole("dialog", { name: "Open choices" });

const scrim = (): HTMLElement => {
  const el = document.querySelector(".popover-scrim");
  if (!(el instanceof HTMLElement)) throw new Error("no popover scrim");
  return el;
};

const tap = (down: Element, up: Element): void => {
  const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(up);
  fireEvent.pointerDown(down, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
  fireEvent.pointerUp(down, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
  fireEvent.click(down, { button: 0, clientX: 10, clientY: 10 });
  under.mockRestore();
};

const shown = (onClose: () => void) =>
  render(
    <div>
      <button type="button">Choose…</button>
      <Popover label="Open choices" className="choice-popover" onClose={onClose}>
        <ul className="choice-list" aria-label="Open choices">
          <li>
            <button type="button">Mac or iPhone</button>
          </li>
        </ul>
      </Popover>
    </div>,
  );

describe("the popover", () => {
  it("ends with a quiet ✕ outside its content, which closes it", () => {
    const onClose = vi.fn();
    shown(onClose);
    const box = popover();
    expect([box.className, box.hasAttribute("aria-modal")]).toEqual(["popover choice-popover", false]);
    const kids = [...box.children];
    expect(kids.map((k) => [k.tagName.toLowerCase(), k.className])).toEqual([
      ["ul", "choice-list"],
      ["button", "popover-close"],
    ]);
    const close = within(box).getByRole("button", { name: "Close" });
    expect(close).toBe(kids[1]);
    expect(close.querySelector("svg")).not.toBeNull();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sits behind a transparent scrim that comes first", () => {
    shown(vi.fn());
    expect(scrim().nextElementSibling).toBe(popover());
  });

  it("closes on Escape, and not on one already taken", () => {
    const onClose = vi.fn();
    shown(onClose);
    const taken = (e: KeyboardEvent): void => e.preventDefault();
    document.addEventListener("keydown", taken, { capture: true });
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.removeEventListener("keydown", taken, { capture: true });
    expect(onClose).toHaveBeenCalledTimes(0);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(e);
    });
    expect([onClose.mock.calls.length, e.defaultPrevented]).toEqual([1, true]);
  });

  it("leaves Escape to a modal dialog that holds focus", () => {
    const onClose = vi.fn();
    const onDialogClose = vi.fn();
    render(
      <div>
        <Popover label="Open choices" className="choice-popover" onClose={onClose}>
          <p>Two choices</p>
        </Popover>
        <Dialog label="Revert this action" onClose={onDialogClose}>
          <button type="button">Revert</button>
        </Dialog>
      </div>,
    );
    const revert = screen.getByRole("button", { name: "Revert" });
    act(() => revert.focus());
    fireEvent.keyDown(revert, { key: "Escape" });
    expect([onClose.mock.calls.length, onDialogClose.mock.calls.length]).toEqual([0, 1]);
  });

  it("closes on a scrim press, not one that ends on the popover or starts inside it", () => {
    const onClose = vi.fn();
    shown(onClose);
    tap(scrim(), popover());
    tap(popover(), scrim());
    expect(onClose).toHaveBeenCalledTimes(0);
    tap(scrim(), scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a mouse press on its scrim from taking focus off the opener", () => {
    shown(vi.fn());
    expect(fireEvent.mouseDown(scrim(), { button: 0 })).toBe(false);
  });

  it("takes no focus when it opens, and leaves it where it was", () => {
    const { rerender } = render(
      <div>
        <button type="button">Choose…</button>
      </div>,
    );
    const opener = screen.getByRole("button", { name: "Choose…" });
    act(() => opener.focus());
    rerender(
      <div>
        <button type="button">Choose…</button>
        <Popover label="Open choices" className="choice-popover" onClose={vi.fn()}>
          <button type="button">Mac or iPhone</button>
        </Popover>
      </div>,
    );
    expect(document.activeElement).toBe(opener);
  });

  it("gives focus back to its opener when it closes holding focus", () => {
    const { rerender } = render(
      <div>
        <button type="button">Choose…</button>
      </div>,
    );
    const opener = screen.getByRole("button", { name: "Choose…" });
    act(() => opener.focus());
    const withPopover = (
      <div>
        <button type="button">Choose…</button>
        <Popover label="Open choices" className="choice-popover" onClose={vi.fn()}>
          <button type="button">Mac or iPhone</button>
        </Popover>
      </div>
    );
    rerender(withPopover);
    act(() => within(popover()).getByRole("button", { name: "Close" }).focus());
    rerender(
      <div>
        <button type="button">Choose…</button>
      </div>,
    );
    expect(document.activeElement).toBe(opener);
  });
});
