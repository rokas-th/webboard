import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPAD, LINUX, MAC, setPlatform } from "../../test/platform";
import { resetTauri, tauri } from "../../test/tauriMock";
import { PaneDivider } from "./PaneDivider";
import type { PaneState } from "./panes";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const MIN = 200;
const MAX = 480;
const DEF = 284;
const START = 260;
const STORED = 260;

const Harness = (p: { onCommit(next: PaneState): void }) => {
  const host = useRef<HTMLDivElement>(null);
  return (
    <div ref={host} className="app-body">
      <PaneDivider
        pane="list"
        side="start"
        label="Resize the plan list"
        controls="plan-list"
        className="sidebar-resizer"
        draggingClass="sidebar-dragging"
        cssVar="--sidebar-w"
        host={host}
        width={START}
        stored={STORED}
        min={MIN}
        max={MAX}
        def={DEF}
        onCommit={p.onCommit}
      />
    </div>
  );
};

const mount = () => {
  const onCommit = vi.fn<(next: PaneState) => void>();
  render(<Harness onCommit={onCommit} />);
  const handle = document.querySelector('[data-pane-divider="list"]');
  const host = document.querySelector(".app-body");
  if (!(handle instanceof HTMLElement) || !(host instanceof HTMLElement)) throw new Error("the divider or its host did not mount");
  return { onCommit, handle, host };
};

const press = (el: HTMLElement, x: number, pointerType = "mouse"): void => {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: x, clientY: 300, pointerType });
};
const move = (el: HTMLElement, x: number, pointerType = "mouse"): void => {
  fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: 300, pointerType });
};
const lift = (el: HTMLElement, x: number, pointerType = "mouse"): void => {
  fireEvent.pointerUp(el, { pointerId: 1, button: 0, clientX: x, clientY: 300, pointerType });
};
const tap = (el: HTMLElement): void => {
  press(el, 500, "touch");
  lift(el, 500, "touch");
};

const haptics = (): unknown[] => tauri.calls.filter((c) => c.cmd === "haptic").map((c) => c.args);

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  resetTauri({ haptic: () => null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setPlatform(MAC);
  document.documentElement.classList.remove("sidebar-dragging");
});

describe("PaneDivider", () => {
  it("snaps closed 48 px past min, keeping the stored width", () => {
    const { onCommit, handle, host } = mount();
    press(handle, 500);
    move(handle, 500 - (START - MIN) - 48);
    expect(host.getAttribute("data-pane-snap")).toBeNull();
    expect(host.style.getPropertyValue("--sidebar-w")).toBe(`${MIN}px`);
    move(handle, 500 - (START - MIN) - 49);
    expect(host.getAttribute("data-pane-snap")).toBe("list");
    lift(handle, 500 - (START - MIN) - 49);
    expect(onCommit.mock.calls).toEqual([[{ open: false, w: STORED }]]);
    expect(host.getAttribute("data-pane-snap")).toBeNull();
    expect(document.documentElement.classList.contains("sidebar-dragging")).toBe(false);
  });

  it("a drag back out of the snap zone commits the width, open", () => {
    const { onCommit, handle, host } = mount();
    press(handle, 500);
    move(handle, 300);
    expect(host.getAttribute("data-pane-snap")).toBe("list");
    move(handle, 480);
    expect(host.getAttribute("data-pane-snap")).toBeNull();
    lift(handle, 480);
    expect(onCommit.mock.calls).toEqual([[{ open: true, w: 240 }]]);
  });

  it("haptic once per entry, iOS only", async () => {
    setPlatform(IPAD);
    const pad = mount();
    press(pad.handle, 500, "touch");
    move(pad.handle, 300, "touch");
    move(pad.handle, 290, "touch");
    move(pad.handle, 280, "touch");
    await flush();
    expect(haptics()).toEqual([{ kind: "light" }]);
    move(pad.handle, 480, "touch");
    move(pad.handle, 300, "touch");
    await flush();
    expect(haptics()).toEqual([{ kind: "light" }, { kind: "light" }]);
    lift(pad.handle, 300, "touch");
    cleanup();

    [MAC, LINUX].forEach((platform) => {
      setPlatform(platform);
      const desk = mount();
      press(desk.handle, 500);
      move(desk.handle, 300);
      move(desk.handle, 480);
      move(desk.handle, 300);
      lift(desk.handle, 300);
      cleanup();
    });
    await flush();
    expect(haptics()).toEqual([{ kind: "light" }, { kind: "light" }]);
  });

  it("double tap resets", () => {
    setPlatform(IPAD);
    const { onCommit, handle, host } = mount();
    tap(handle);
    expect(onCommit).not.toHaveBeenCalled();
    tap(handle);
    expect(onCommit.mock.calls).toEqual([[{ open: true, w: null }]]);
    expect(host.style.getPropertyValue("--sidebar-w")).toBe("");
  });

  it("a tap after a drag is not half of a double tap", () => {
    setPlatform(IPAD);
    const { onCommit, handle } = mount();
    press(handle, 500, "touch");
    move(handle, 510, "touch");
    move(handle, 500, "touch");
    lift(handle, 500, "touch");
    tap(handle);
    expect(onCommit).not.toHaveBeenCalled();
    tap(handle);
    expect(onCommit.mock.calls).toEqual([[{ open: true, w: null }]]);
  });

  it("two mouse clicks are not a double tap; a double click resets", () => {
    const { onCommit, handle } = mount();
    press(handle, 500);
    lift(handle, 500);
    press(handle, 500);
    lift(handle, 500);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.doubleClick(handle);
    expect(onCommit.mock.calls).toEqual([[{ open: true, w: null }]]);
  });

  it("two touch taps more than 400 ms apart are not a double tap", () => {
    setPlatform(IPAD);
    const now = vi.spyOn(Date, "now");
    const { onCommit, handle } = mount();
    now.mockReturnValue(10_000);
    tap(handle);
    now.mockReturnValue(10_401);
    tap(handle);
    expect(onCommit).not.toHaveBeenCalled();
    now.mockReturnValue(10_800);
    tap(handle);
    expect(onCommit.mock.calls).toEqual([[{ open: true, w: null }]]);
  });

  it("reports the minimum as its value while a drag is snapped, and the width again past it", () => {
    const { handle } = mount();
    press(handle, 500);
    move(handle, 300);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(MIN));
    move(handle, 480);
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    move(handle, 300);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(START));
  });

  it("restores the width the host had before the drag when it unmounts mid-drag", () => {
    const Toggle = (p: { shown: boolean }) => {
      const host = useRef<HTMLDivElement>(null);
      return (
        <div ref={host} className="app-body" style={{ "--sidebar-w": "260px" }}>
          {p.shown && (
            <PaneDivider
              pane="list"
              side="start"
              label="Resize the plan list"
              controls="plan-list"
              className="sidebar-resizer"
              draggingClass="sidebar-dragging"
              cssVar="--sidebar-w"
              host={host}
              width={START}
              stored={STORED}
              min={MIN}
              max={MAX}
              def={DEF}
              onCommit={() => {
                throw new Error("no commit expected");
              }}
            />
          )}
        </div>
      );
    };
    const { rerender } = render(<Toggle shown />);
    const handle = document.querySelector('[data-pane-divider="list"]');
    const host = document.querySelector(".app-body");
    if (!(handle instanceof HTMLElement) || !(host instanceof HTMLElement)) throw new Error("the divider or its host did not mount");
    press(handle, 500);
    move(handle, 300);
    expect([host.getAttribute("data-pane-snap"), document.documentElement.classList.contains("sidebar-dragging")]).toEqual(["list", true]);
    rerender(<Toggle shown={false} />);
    expect([host.style.getPropertyValue("--sidebar-w"), host.getAttribute("data-pane-snap"), document.documentElement.classList.contains("sidebar-dragging")]).toEqual([
      "260px",
      null,
      false,
    ]);
  });

  it("throws, naming the pane, when it mounts without its host", () => {
    const Hostless = () => {
      const host = useRef<HTMLDivElement>(null);
      return (
        <PaneDivider
          pane="list"
          side="start"
          label="Resize the plan list"
          controls="plan-list"
          className="sidebar-resizer"
          draggingClass="sidebar-dragging"
          cssVar="--sidebar-w"
          host={host}
          width={START}
          stored={STORED}
          min={MIN}
          max={MAX}
          def={DEF}
          onCommit={() => undefined}
        />
      );
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Hostless />)).toThrow("list divider: mounted without its host element");
  });

  it("an unmoved press commits nothing and leaves the width as it was", () => {
    const { onCommit, handle, host } = mount();
    host.style.setProperty("--sidebar-w", "260px");
    press(handle, 500);
    lift(handle, 500);
    expect(onCommit).not.toHaveBeenCalled();
    expect(host.style.getPropertyValue("--sidebar-w")).toBe("260px");
  });
});
