import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../../platform";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../../test/platform";
import { TextField } from "../panel/TextField";
import { Dialog } from "./Dialog";

afterEach(() => {
  cleanup();
});

const dialog = (): HTMLElement => screen.getByRole("dialog");

const overlay = (): HTMLElement => {
  const el = dialog().parentElement;
  if (el === null || !el.classList.contains("overlay")) throw new Error("the dialog has no overlay");
  return el;
};

const head = (): HTMLElement => {
  const el = dialog().querySelector(".modal-head");
  if (!(el instanceof HTMLElement)) throw new Error("no dialog head");
  return el;
};

const tap = (down: Element, up: Element): void => {
  const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(up);
  fireEvent.pointerDown(down, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
  fireEvent.pointerUp(up, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
  fireEvent.click(down === up ? up : overlay(), { button: 0, clientX: 10, clientY: 10 });
  under.mockRestore();
};

const typed = (value: string): void => {
  const el = screen.getByRole("textbox", { name: "Name" });
  act(() => el.focus());
  fireEvent.change(el, { target: { value } });
};

describe("the dialog's close control", () => {
  it.each<Platform>([MAC, LINUX, IPHONE, IPAD])("leads with a ✕ before the title on %o", (platform) => {
    setPlatform(platform);
    const onClose = vi.fn();
    render(
      <Dialog label="Revert this action" onClose={onClose}>
        <button type="button">Revert</button>
      </Dialog>,
    );
    const kids = [...head().children];
    expect(kids.map((k) => [k.tagName.toLowerCase(), k.className, k.textContent])).toEqual([
      ["button", "modal-close", ""],
      ["h3", "", "Revert this action"],
    ]);
    const close = within(head()).getByRole("button", { name: "Close" });
    expect(close.querySelector("svg")).not.toBeNull();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sizes an item dialog with its own class and marker, and keeps the ✕", () => {
    render(
      <Dialog label="Tracking" size="item" onClose={vi.fn()}>
        <p>body</p>
      </Dialog>,
    );
    expect([dialog().className, dialog().hasAttribute("data-item-modal"), head().querySelectorAll(".modal-close").length]).toEqual(["modal modal-item", true, 1]);
    cleanup();
    render(
      <Dialog label="Plain" wide onClose={vi.fn()}>
        <p>body</p>
      </Dialog>,
    );
    expect([dialog().className, dialog().hasAttribute("data-item-modal")]).toEqual(["modal modal-wide", false]);
  });

  it("the ✕ commits a focused field first", () => {
    setPlatform(MAC);
    const onCommit = vi.fn(() => true);
    const onClose = vi.fn();
    render(
      <Dialog label="Rename" onClose={onClose}>
        <TextField className="title-input" label="Name" value="Review" readOnly={false} onCommit={onCommit} />
      </Dialog>,
    );
    typed("Final review");
    fireEvent.click(within(head()).getByRole("button", { name: "Close" }));
    expect([onCommit.mock.calls, onClose.mock.calls.length]).toEqual([[["Final review"]], 1]);
  });

  it("stays open when the commit throws", () => {
    setPlatform(MAC);
    const onClose = vi.fn();
    const reported: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      reported.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    render(
      <Dialog label="Rename" onClose={onClose}>
        <TextField
          className="title-input"
          label="Name"
          value="Review"
          readOnly={false}
          onCommit={() => {
            throw new Error("the plan refused the name");
          }}
        />
      </Dialog>,
    );
    typed("Final review");
    try {
      fireEvent.click(within(head()).getByRole("button", { name: "Close" }));
    } catch (e) {
      reported.push(e);
    } finally {
      window.removeEventListener("error", onError);
    }
    expect([reported.map((e) => (e instanceof Error ? e.message : String(e))), onClose.mock.calls.length, screen.queryByRole("dialog") !== null]).toEqual([
      ["the plan refused the name"],
      0,
      true,
    ]);
  });

  it("closes on a scrim press, not one ending inside", () => {
    setPlatform(MAC);
    const onClose = vi.fn();
    render(
      <Dialog label="Revert this action" onClose={onClose}>
        <button type="button">Revert</button>
      </Dialog>,
    );
    tap(overlay(), dialog());
    tap(dialog(), overlay());
    expect(onClose).not.toHaveBeenCalled();
    tap(overlay(), overlay());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without committing the focused field", () => {
    setPlatform(MAC);
    const onCommit = vi.fn(() => true);
    const onClose = vi.fn();
    render(
      <Dialog label="Rename" onClose={onClose}>
        <TextField className="title-input" label="Name" value="Review" readOnly={false} onCommit={onCommit} />
      </Dialog>,
    );
    typed("Final review");
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect([onCommit.mock.calls.length, onClose.mock.calls.length]).toEqual([0, 1]);
  });
});
