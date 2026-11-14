import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../../platform";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../../test/platform";
import { TextField } from "../panel/TextField";
import { Dialog } from "./Dialog";
import { Sheet } from "./Sheet";

afterEach(() => {
  cleanup();
});

const dialog = (): HTMLElement => screen.getByRole("dialog");

const overlay = (): HTMLElement => {
  const el = dialog().parentElement;
  if (el === null || !el.classList.contains("overlay")) throw new Error("the dialog has no overlay");
  return el;
};

const tap = (down: Element, up: Element): void => {
  const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(up);
  fireEvent.pointerDown(down, { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
  fireEvent.pointerUp(down, { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
  fireEvent.click(up, { button: 0, clientX: 10, clientY: 10 });
  under.mockRestore();
};

const head = (): HTMLElement => {
  const el = dialog().querySelector(".sheet-head");
  if (!(el instanceof HTMLElement)) throw new Error("no sheet head");
  return el;
};

function Named(p: { onRename(name: string): void; onClosed(): void }) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("Review");
  return (
    <>
      <span className="stored">{name}</span>
      <Sheet
        open={open}
        title={name}
        onClose={() => {
          setOpen(false);
          p.onClosed();
        }}
      >
        <TextField
          className="title-input"
          label="Name"
          value={name}
          readOnly={false}
          onCommit={(next) => {
            p.onRename(next);
            setName(next);
            return true;
          }}
        />
        <button type="button">Later</button>
      </Sheet>
    </>
  );
}

const typed = (value: string): HTMLInputElement => {
  const el = screen.getByRole("textbox", { name: "Name" });
  if (!(el instanceof HTMLInputElement)) throw new Error("no name field");
  act(() => el.focus());
  fireEvent.change(el, { target: { value } });
  return el;
};

const stored = (): string | null => document.querySelector(".stored")?.textContent ?? null;

describe("the sheet head", () => {
  it.each<Platform>([IPHONE, IPAD])("on %o leads with a ✕ that closes, centres the title and balances it with an empty slot", (platform) => {
    setPlatform(platform);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    const kids = [...head().children];
    expect(kids.map((k) => [k.tagName.toLowerCase(), k.className])).toEqual([
      ["button", "sheet-close"],
      ["h3", "sheet-title"],
      ["span", "sheet-head-end"],
    ]);
    const close = within(head()).getByRole("button", { name: "Close" });
    expect([close.textContent, close.querySelector("svg") !== null, kids[2].getAttribute("aria-hidden"), kids[2].textContent]).toEqual(["", true, "true", ""]);
    expect(kids[1].textContent).toBe("Plans");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each<Platform>([MAC, LINUX])("on %o keeps the title first and a Close text button last", (platform) => {
    setPlatform(platform);
    render(
      <Sheet open title="Plans" onClose={() => undefined}>
        <p>Body</p>
      </Sheet>,
    );
    expect([...head().children].map((k) => [k.tagName.toLowerCase(), k.className, k.textContent])).toEqual([
      ["h3", "sheet-title", "Plans"],
      ["button", "button-small", "Close"],
    ]);
  });
});

describe("a tap outside the sheet", () => {
  it("closes it on iOS when the press starts and ends on the dimmed area", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <button type="button">Inside</button>
      </Sheet>,
    );
    tap(dialog(), overlay());
    tap(overlay(), dialog());
    tap(screen.getByRole("button", { name: "Inside" }), screen.getByRole("button", { name: "Inside" }));
    expect(onClose).not.toHaveBeenCalled();
    tap(overlay(), overlay());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the finger lands on the dimmed area and lifts over the sheet, though touch delivers the release to the overlay", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(dialog());
    fireEvent.pointerDown(overlay(), { button: 0, pointerType: "touch", clientX: 10, clientY: 300 });
    fireEvent.pointerUp(overlay(), { button: 0, pointerType: "touch", clientX: 10, clientY: 300 });
    fireEvent.click(overlay(), { button: 0, clientX: 10, clientY: 300 });
    under.mockRestore();
    expect([onClose.mock.calls.length, screen.queryByRole("dialog") !== null]).toEqual([0, true]);
  });

  it("closes on the tap's click, so no click is left over for the control beneath", () => {
    setPlatform(IPAD);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(overlay());
    fireEvent.pointerDown(overlay(), { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerUp(overlay(), { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
    under.mockRestore();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(overlay(), { button: 0, clientX: 10, clientY: 10 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close after a cancelled press, or on a click with no press before it", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    fireEvent.pointerDown(overlay(), { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(overlay(), { pointerType: "touch" });
    fireEvent.click(overlay(), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(overlay(), { button: 0, clientX: 10, clientY: 10 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each<Platform>([MAC, LINUX])("does nothing on %o", (platform) => {
    setPlatform(platform);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    tap(overlay(), overlay());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("never closes a centred dialog, which is an alert", () => {
    setPlatform(IPAD);
    const onClose = vi.fn();
    render(
      <Dialog label="Revert this action" onClose={onClose}>
        <button type="button">Revert</button>
      </Dialog>,
    );
    tap(overlay(), overlay());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("a typed name survives closing the sheet", () => {
  it("is committed when a tap outside closes the sheet on iOS, and the sheet is gone", () => {
    setPlatform(IPHONE);
    const onRename = vi.fn();
    const onClosed = vi.fn();
    render(<Named onRename={onRename} onClosed={onClosed} />);
    typed("Final review");
    tap(overlay(), overlay());
    expect([onRename.mock.calls, onClosed.mock.calls.length, stored(), screen.queryByRole("dialog")]).toEqual([[["Final review"]], 1, "Final review", null]);
  });

  it.each<Platform>([IPHONE, MAC, LINUX])("is committed when the Close button is pressed while the field keeps focus, on %o", (platform) => {
    setPlatform(platform);
    const onRename = vi.fn();
    render(<Named onRename={onRename} onClosed={() => undefined} />);
    typed("Final review");
    fireEvent.click(within(head()).getByRole("button", { name: "Close" }));
    expect([onRename.mock.calls, stored(), screen.queryByRole("dialog")]).toEqual([[["Final review"]], "Final review", null]);
  });

  it("keeps the sheet open when the field's commit throws, and reports the error", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    const reported: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      reported.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <TextField
          className="title-input"
          label="Name"
          value="Review"
          readOnly={false}
          onCommit={() => {
            throw new Error("the plan refused the name");
          }}
        />
      </Sheet>,
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

  it("throws and stays open when the sheet cannot take focus from the field", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    const reported: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      reported.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    render(<Named onRename={() => undefined} onClosed={onClose} />);
    typed("Final review");
    const stuck = vi.spyOn(dialog(), "focus").mockImplementation(() => undefined);
    try {
      fireEvent.click(within(head()).getByRole("button", { name: "Close" }));
    } catch (e) {
      reported.push(e);
    } finally {
      window.removeEventListener("error", onError);
      stuck.mockRestore();
    }
    expect([reported.map((e) => (e instanceof Error ? e.message : String(e))), onClose.mock.calls.length, screen.queryByRole("dialog") !== null]).toEqual([
      ["Sheet could not take focus from its field to commit it"],
      0,
      true,
    ]);
  });

  it("is still dropped by Escape", () => {
    setPlatform(IPHONE);
    const onRename = vi.fn();
    render(<Named onRename={onRename} onClosed={() => undefined} />);
    typed("Final review");
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect([onRename.mock.calls, stored(), screen.queryByRole("dialog")]).toEqual([[], "Review", null]);
  });
});

describe("focus when a sheet or dialog opens", () => {
  const opened: [string, () => void][] = [
    [
      "sheet",
      () =>
        render(
          <Sheet open title="Plans" onClose={() => undefined}>
            <button type="button">First</button>
            <button type="button">Last</button>
          </Sheet>,
        ),
    ],
    [
      "dialog",
      () =>
        render(
          <Dialog label="Revert this action" onClose={() => undefined}>
            <button type="button">First</button>
            <button type="button">Last</button>
          </Dialog>,
        ),
    ],
  ];

  it.each(opened)("on iOS lands on the %s itself, and Tab and Shift+Tab enter its controls from there", (_, open) => {
    setPlatform(IPAD);
    open();
    expect(document.activeElement).toBe(dialog());
    fireEvent.keyDown(dialog(), { key: "Tab" });
    const all = [...dialog().querySelectorAll("button")];
    expect(document.activeElement).toBe(all[0]);
    act(() => dialog().focus());
    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(all[all.length - 1]);
  });

  it.each(opened)("on macOS leaves Tab and Shift+Tab from the %s element itself to the browser, as before", (_, open) => {
    setPlatform(MAC);
    open();
    act(() => dialog().focus());
    expect([fireEvent.keyDown(dialog(), { key: "Tab" }), fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true }), document.activeElement]).toEqual([true, true, dialog()]);
  });

  it.each(opened)("on macOS lands on the %s's first control", (_, open) => {
    setPlatform(MAC);
    open();
    expect(document.activeElement).toBe(dialog().querySelector("button"));
  });
});
