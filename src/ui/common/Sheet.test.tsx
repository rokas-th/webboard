import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../../platform";
import { setReducedMotion } from "../../test/matchMedia";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../../test/platform";
import { resetTauri, tauri } from "../../test/tauriMock";
import { TextField } from "../panel/TextField";
import { Dialog } from "./Dialog";
import { useCloseGuard } from "./dismiss";
import { Sheet, type SheetDetent } from "./Sheet";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it.each<Platform>([MAC, LINUX])("on %o leads with a ✕ like iOS", (platform) => {
    setPlatform(platform);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    expect([...head().children].map((k) => [k.tagName.toLowerCase(), k.className, k.textContent])).toEqual([
      ["button", "sheet-close", ""],
      ["h3", "sheet-title", "Plans"],
      ["span", "sheet-head-end", ""],
    ]);
    const close = within(head()).getByRole("button", { name: "Close" });
    expect(close.querySelector("svg")).not.toBeNull();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it.each<Platform>([MAC, LINUX])("closes on %o on a scrim press", (platform) => {
    setPlatform(platform);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    tap(overlay(), dialog());
    expect(onClose).not.toHaveBeenCalled();
    tap(overlay(), overlay());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes a centred dialog on a scrim press", () => {
    setPlatform(IPAD);
    const onClose = vi.fn();
    render(
      <Dialog label="Revert this action" onClose={onClose}>
        <button type="button">Revert</button>
      </Dialog>,
    );
    tap(overlay(), overlay());
    expect(onClose).toHaveBeenCalledTimes(1);
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
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "First" }));
  });
});

describe("a swipe down from the sheet head on iOS", () => {
  const SHEET_HEIGHT = 600;
  let now = 0;

  const measured = (): void => {
    vi.spyOn(dialog(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 200, 390, SHEET_HEIGHT));
    vi.spyOn(performance, "now").mockImplementation(() => now);
  };

  const swipe = (to: number, ms: number, pointerType = "touch", end: "up" | "cancel" = "up"): string => {
    now = 1000;
    fireEvent.pointerDown(head(), { button: 0, pointerId: 7, pointerType, clientX: 100, clientY: 220 });
    now = 1000 + ms / 2;
    fireEvent.pointerMove(head(), { pointerId: 7, pointerType, clientX: 100, clientY: 220 + to / 2 });
    now = 1000 + ms;
    fireEvent.pointerMove(head(), { pointerId: 7, pointerType, clientX: 100, clientY: 220 + to });
    const during = dialog().style.transform;
    if (end === "up") fireEvent.pointerUp(head(), { pointerId: 7, pointerType, clientX: 100, clientY: 220 + to });
    else fireEvent.pointerCancel(head(), { pointerId: 7, pointerType });
    return during;
  };

  it("shows a grabber at the top of the sheet on iOS only, outside the head", () => {
    setPlatform(IPHONE);
    const { unmount } = render(
      <Sheet open title="Plans" onClose={() => undefined}>
        <p>Body</p>
      </Sheet>,
    );
    const grabber = dialog().querySelector(".sheet-grabber");
    expect([grabber?.parentElement === dialog(), grabber?.getAttribute("aria-hidden"), dialog().firstElementChild === grabber]).toEqual([true, "true", true]);
    unmount();
    setPlatform(MAC);
    render(
      <Sheet open title="Plans" onClose={() => undefined}>
        <p>Body</p>
      </Sheet>,
    );
    expect(dialog().querySelector(".sheet-grabber")).toBeNull();
  });

  it("swipe past a quarter closes, committing the field", () => {
    setPlatform(IPHONE);
    const onRename = vi.fn();
    const onClosed = vi.fn();
    render(<Named onRename={onRename} onClosed={onClosed} />);
    typed("Final review");
    measured();
    const during = swipe(SHEET_HEIGHT * 0.25 + 10, 2000);
    expect([during, onRename.mock.calls, onClosed.mock.calls.length, stored(), screen.queryByRole("dialog")]).toEqual([
      `translateY(${SHEET_HEIGHT * 0.25 + 10}px)`,
      [["Final review"]],
      1,
      "Final review",
      null,
    ]);
  });

  it("a short swipe snaps back, and so does a cancelled one", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    expect(swipe(120, 1000)).toBe("translateY(120px)");
    expect([onClose.mock.calls.length, dialog().style.transform, dialog().style.transition]).toEqual([0, "", "transform 200ms ease-out"]);
    expect(swipe(400, 100, "touch", "cancel")).toBe("translateY(400px)");
    expect([onClose.mock.calls.length, dialog().style.transform]).toEqual([0, ""]);
    expect(swipe(-80, 100)).toBe("translateY(0px)");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("snaps back at once under reduced motion", () => {
    setPlatform(IPHONE);
    setReducedMotion(true);
    render(
      <Sheet open title="Plans" onClose={() => undefined}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    swipe(100, 1000);
    expect([dialog().style.transform, dialog().style.transition]).toEqual(["", "none"]);
  });

  it("a fast flick closes", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    swipe(41, 50);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a slow drag that ends in a quick flick closes, by the speed at release", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    now = 1000;
    fireEvent.pointerDown(head(), { button: 0, pointerId: 7, pointerType: "touch", clientX: 100, clientY: 220 });
    now = 3000;
    fireEvent.pointerMove(head(), { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 240 });
    now = 3050;
    fireEvent.pointerMove(head(), { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 280 });
    fireEvent.pointerUp(head(), { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 280 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a touch tap on the ✕ closes once and never takes the pointer for a swipe", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    const capture = vi.spyOn(head(), "setPointerCapture");
    const x = within(head()).getByRole("button", { name: "Close" });
    fireEvent.pointerDown(x, { button: 0, pointerId: 4, pointerType: "touch", clientX: 30, clientY: 220 });
    fireEvent.pointerUp(x, { button: 0, pointerId: 4, pointerType: "touch", clientX: 30, clientY: 220 });
    fireEvent.click(x, { button: 0, clientX: 30, clientY: 220 });
    expect([onClose.mock.calls.length, capture.mock.calls.length]).toEqual([1, 0]);
  });

  it("a tap on the title leaves the sheet's style alone", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    const capture = vi.spyOn(head(), "setPointerCapture");
    const title = within(head()).getByRole("heading", { name: "Plans" });
    fireEvent.pointerDown(title, { button: 0, pointerId: 5, pointerType: "touch", clientX: 190, clientY: 220 });
    fireEvent.pointerMove(title, { pointerId: 5, pointerType: "touch", clientX: 191, clientY: 223 });
    fireEvent.pointerUp(title, { button: 0, pointerId: 5, pointerType: "touch", clientX: 191, clientY: 223 });
    expect([onClose.mock.calls.length, capture.mock.calls.length, dialog().style.transform, dialog().style.transition]).toEqual([0, 0, "", ""]);
  });

  it("a slow or short flick does not close", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    swipe(40, 10);
    swipe(100, 200);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each<[string, Platform, string]>([
    ["a mouse drag on iOS", IPAD, "mouse"],
    ["a pen drag on iOS", IPHONE, "pen"],
    ["a touch drag on macOS", MAC, "touch"],
  ])("%s does not swipe", (_, platform, pointerType) => {
    setPlatform(platform);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    expect([swipe(400, 100, pointerType), onClose.mock.calls.length, dialog().style.transform]).toEqual(["", 0, ""]);
  });

  it("a drag that starts in the body does not swipe", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    render(
      <Sheet open title="Plans" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    const body = screen.getByText("Body");
    fireEvent.pointerDown(body, { pointerId: 3, pointerType: "touch", clientY: 300 });
    fireEvent.pointerMove(body, { pointerId: 3, pointerType: "touch", clientY: 600 });
    fireEvent.pointerUp(body, { pointerId: 3, pointerType: "touch", clientY: 600 });
    expect([onClose.mock.calls.length, dialog().style.transform]).toEqual([0, ""]);
  });

  it("detents: up to large, down to medium, down again closes", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    const onDetent = vi.fn();
    function Detented() {
      const [detent, setDetent] = useState<SheetDetent>("medium");
      return (
        <Sheet
          open
          title="Review"
          detent={detent}
          onDetent={(d) => {
            onDetent(d);
            setDetent(d);
          }}
          onClose={onClose}
        >
          <p>Body</p>
        </Sheet>
      );
    }
    render(<Detented />);
    measured();
    expect(dialog().dataset.detent).toBe("medium");
    swipe(-40, 1000);
    expect([dialog().dataset.detent, onDetent.mock.calls, onClose.mock.calls.length]).toEqual(["medium", [], 0]);
    swipe(-49, 1000);
    expect([dialog().dataset.detent, onDetent.mock.calls, onClose.mock.calls.length, dialog().style.transform]).toEqual(["large", [["large"]], 0, ""]);
    swipe(-200, 100);
    expect([dialog().dataset.detent, onDetent.mock.calls.length]).toEqual(["large", 1]);
    swipe(120, 1000);
    expect([dialog().dataset.detent, onDetent.mock.calls.length, onClose.mock.calls.length]).toEqual(["large", 1, 0]);
    swipe(SHEET_HEIGHT * 0.25 + 10, 2000);
    expect([dialog().dataset.detent, onDetent.mock.calls, onClose.mock.calls.length]).toEqual(["medium", [["large"], ["medium"]], 0]);
    swipe(SHEET_HEIGHT * 0.25 + 10, 2000);
    expect([onDetent.mock.calls.length, onClose.mock.calls.length]).toEqual([2, 1]);
  });

  it("a fast upward flick from medium reaches large", () => {
    setPlatform(IPHONE);
    const onDetent = vi.fn();
    render(
      <Sheet open title="Review" detent="medium" onDetent={onDetent} onClose={() => undefined}>
        <p>Body</p>
      </Sheet>,
    );
    measured();
    swipe(-41, 50);
    expect(onDetent.mock.calls).toEqual([["large"]]);
  });

  it("puts its actions in place of the empty end slot, and marks no detent without one", () => {
    setPlatform(IPHONE);
    render(
      <Sheet open title="Review" onClose={() => undefined} actions={<button type="button">Done</button>}>
        <p>Body</p>
      </Sheet>,
    );
    expect([head().className, [...head().children].map((k) => k.className), within(head()).getByRole("button", { name: "Done" }).parentElement?.className, dialog().dataset.detent]).toEqual([
      "sheet-head sheet-head-bar",
      ["sheet-start", "sheet-title", "sheet-actions"],
      "sheet-actions",
      undefined,
    ]);
    measured();
    swipe(-200, 100);
    expect(dialog().style.transform).toBe("");
  });

  it("keeps its label while the bar title changes", () => {
    setPlatform(IPHONE);
    const shown = (title: string) => (
      <Sheet open title={title} label="Settings" onClose={() => undefined}>
        <p>Body</p>
      </Sheet>
    );
    const view = render(shown("Settings"));
    expect([dialog().getAttribute("aria-label"), head().querySelector(".sheet-title")?.textContent]).toEqual(["Settings", "Settings"]);
    view.rerender(shown("People"));
    expect([screen.getByRole("dialog", { name: "Settings" }) === dialog(), head().querySelector(".sheet-title")?.textContent]).toEqual([true, "People"]);
  });

  it("names its kind in data-sheet, apart from its label, and leaves it off without one", () => {
    const view = render(
      <Sheet open title="People" label="Réglages" kind="settings" onClose={() => undefined}>
        <p>Body</p>
      </Sheet>,
    );
    expect([dialog().getAttribute("data-sheet"), dialog().getAttribute("aria-label")]).toEqual(["settings", "Réglages"]);
    view.rerender(
      <Sheet open title="People" onClose={() => undefined}>
        <p>Body</p>
      </Sheet>,
    );
    expect(dialog().hasAttribute("data-sheet")).toBe(false);
  });

  it("puts the lead after the X in the bar head, before the title and the end", () => {
    setPlatform(IPHONE);
    const onClose = vi.fn();
    const onBack = vi.fn();
    render(
      <Sheet
        open
        title="People"
        label="Settings"
        lead={
          <button type="button" aria-label="Back to Settings" onClick={onBack}>
            ‹
          </button>
        }
        onClose={onClose}
      >
        <p>Body</p>
      </Sheet>,
    );
    const start = head().querySelector(".sheet-start");
    if (!(start instanceof HTMLElement)) throw new Error("no sheet start");
    expect([
      head().className,
      [...head().children].map((k) => [k.tagName, k.className]),
      [...start.children].map((k) => k.className),
      start.querySelector(".sheet-lead")?.firstElementChild?.getAttribute("aria-label"),
      head().querySelector(".sheet-head-end")?.getAttribute("aria-hidden"),
    ]).toEqual([
      "sheet-head sheet-head-bar",
      [
        ["SPAN", "sheet-start"],
        ["H3", "sheet-title"],
        ["SPAN", "sheet-head-end"],
      ],
      ["sheet-close", "sheet-lead"],
      "Back to Settings",
      "true",
    ]);
    fireEvent.click(within(head()).getByRole("button", { name: "Back to Settings" }));
    expect([onBack.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 0]);
    fireEvent.click(within(head()).getByRole("button", { name: "Close" }));
    expect(onClose.mock.calls.length).toBe(1);
  });

  it("keeps the plain head without a lead or actions", () => {
    render(
      <Sheet open title="Plans" onClose={() => undefined}>
        <p>Body</p>
      </Sheet>,
    );
    expect([head().className, [...head().children].map((k) => k.className), dialog().getAttribute("aria-label")]).toEqual(["sheet-head", ["sheet-close", "sheet-title", "sheet-head-end"], "Plans"]);
  });

  it("a kept guarded swipe snaps back", async () => {
    setPlatform(IPHONE);
    resetTauri({ alert_ask: () => "cancel" });
    const onClose = vi.fn();
    function Guarded() {
      useCloseGuard({ title: "Discard calendar changes?", message: "Your calendar changes are not applied yet." });
      return <p>Body</p>;
    }
    render(
      <Sheet open title="Calendar" onClose={onClose}>
        <Guarded />
      </Sheet>,
    );
    measured();
    swipe(400, 1000);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect([tauri.calls.map((c) => c.cmd), onClose.mock.calls.length, screen.queryByRole("dialog") !== null, dialog().style.transform]).toEqual([["alert_ask"], 0, true, ""]);
  });
});
