import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampedAt, ContextMenu, nativeSections, type PickSection, type Point } from "./ContextMenu";
import { pointBelowEnd } from "./pickMenu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const SECTIONS: readonly PickSection[] = [
  {
    title: null,
    rows: [
      { id: "rename", title: "Rename", checked: false, checkable: false },
      { id: "completes", title: "Completes items", checked: true, checkable: true },
      { id: "hide", title: "Hide on this device", checked: false, checkable: true },
    ],
  },
  { title: "Move to", rows: [{ id: "later", title: "Later", checked: false, checkable: false }] },
];

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.context-menu [role^="menuitem"]')];

function shown(at: Point = { x: 40, y: 50 }, sections: readonly PickSection[] = SECTIONS) {
  const chosen = vi.fn<(id: string) => void>();
  const closed = vi.fn<() => void>();
  const anchor = document.createElement("button");
  anchor.textContent = "anchor";
  document.body.append(anchor);
  render(
    <>
      <button type="button">outside</button>
      <ContextMenu label="Now options" at={at} anchor={anchor} sections={sections} onChosen={chosen} onClose={closed} />
    </>,
  );
  return { chosen, closed, anchor };
}

describe("ContextMenu", () => {
  it("renders a fixed menu at the point with titled sections and a checked row, focuses the first row, and has no X", () => {
    shown();
    const menu = screen.getByRole("menu", { name: "Now options" });
    expect(menu.className).toBe("context-menu");
    expect(menu.style.left).toBe("40px");
    expect(menu.style.top).toBe("50px");
    expect(rows().map((r) => [r.getAttribute("role"), r.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["menuitem", "Rename", null],
      ["menuitemcheckbox", "Completes items", "true"],
      ["menuitemcheckbox", "Hide on this device", "false"],
      ["menuitem", "Later", null],
    ]);
    expect(screen.getByRole("group", { name: "Move to" }).querySelector(".context-menu-title")?.textContent).toBe("Move to");
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(document.activeElement).toBe(rows()[0]);
    expect(menu.querySelector(".popover-close, .modal-close")).toBeNull();
  });

  it("moves focus with the arrow keys, Home and End, wrapping at the ends", () => {
    shown();
    const menu = screen.getByRole("menu");
    const press = (key: string): void => {
      fireEvent.keyDown(document.activeElement ?? menu, { key });
    };
    press("ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(rows()[3]);
    press("Home");
    expect(document.activeElement).toBe(rows()[0]);
    press("End");
    expect(document.activeElement).toBe(rows()[3]);
  });

  it("closes, then reports the row, on a choice", () => {
    const { chosen, closed } = shown();
    const order: string[] = [];
    closed.mockImplementation(() => order.push("close"));
    chosen.mockImplementation((id) => order.push(id));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Completes items" }));
    expect(order).toEqual(["close", "completes"]);
  });

  it("closes on Esc without letting it reach the page, and chooses nothing", () => {
    const { chosen, closed } = shown();
    const page = vi.fn();
    document.addEventListener("keydown", page);
    fireEvent.keyDown(rows()[0], { key: "Escape" });
    document.removeEventListener("keydown", page);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
    expect(chosen).not.toHaveBeenCalled();
  });

  it("closes on a press outside it, and not on a press inside it", () => {
    const { chosen, closed } = shown();
    fireEvent.pointerDown(rows()[1]);
    expect(closed).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(chosen).not.toHaveBeenCalled();
  });

  it("leaves a press on its opener to the opener, so the opener can toggle it", () => {
    const { closed, anchor } = shown();
    fireEvent.pointerDown(anchor);
    expect(closed).not.toHaveBeenCalled();
  });

  it("closes when the page scrolls or the window resizes, and not when the menu itself scrolls", () => {
    const first = shown();
    fireEvent.scroll(screen.getByRole("menu"));
    expect(first.closed).not.toHaveBeenCalled();
    fireEvent.scroll(screen.getByRole("button", { name: "outside" }));
    expect(first.closed).toHaveBeenCalledTimes(1);
    cleanup();
    const second = shown();
    fireEvent(window, new Event("resize"));
    expect(second.closed).toHaveBeenCalledTimes(1);
  });

  it("throws for a checked row that is not checkable, and strips checkable for the native menu", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => shown({ x: 0, y: 0 }, [{ title: null, rows: [{ id: "x", title: "X", checked: true, checkable: false }] }])).toThrow("Now options: the row x is checked but cannot be");
    expect(nativeSections(SECTIONS)[0].rows[1]).toEqual({ id: "completes", title: "Completes items", checked: true });
  });

  it("clamps itself into the window", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 120));
    act(() => {
      window.innerWidth = 1024;
      window.innerHeight = 700;
    });
    shown({ x: 1000, y: 690 });
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("816px");
    expect(menu.style.top).toBe("572px");
  });

  it("ends at a point marked as its end edge, measured at its own width, so a wide menu does not overhang the opener", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 260, 120));
    act(() => {
      window.innerWidth = 1024;
      window.innerHeight = 700;
    });
    shown({ x: 500, y: 50, edge: "end" });
    const menu = screen.getByRole("menu");
    expect([menu.style.left, menu.style.top]).toEqual(["240px", "50px"]);
  });

  it("pointBelowEnd marks the opener's right edge as the menu's end, below the opener", () => {
    const anchor = document.createElement("button");
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(420, 100, 180, 28));
    expect(pointBelowEnd(anchor)).toEqual({ x: 600, y: 132, edge: "end" });
  });

  it("an end-edge point that would leave the window is clamped back in", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 260, 120));
    act(() => {
      window.innerWidth = 1024;
      window.innerHeight = 700;
    });
    shown({ x: 100, y: 50, edge: "end" });
    expect(screen.getByRole("menu").style.left).toBe("8px");
  });

  it("clampedAt keeps a point that fits and pulls one that does not back by the margin", () => {
    const view = { width: 1024, height: 700 };
    expect(clampedAt({ x: 40, y: 50 }, { width: 200, height: 120 }, view)).toEqual({ x: 40, y: 50 });
    expect(clampedAt({ x: 1000, y: 690 }, { width: 200, height: 120 }, view)).toEqual({ x: 816, y: 572 });
    expect(clampedAt({ x: -20, y: -5 }, { width: 200, height: 120 }, view)).toEqual({ x: 8, y: 8 });
    expect(clampedAt({ x: 500, y: 300 }, { width: 2000, height: 900 }, view)).toEqual({ x: 8, y: 8 });
  });
});
