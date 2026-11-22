import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../../test/platform";
import { resetTauri, tauri } from "../../test/tauriMock";
import { ASK_WAIT_MS, closeTopOverlay, commitFocus, requestCloseOf, useCloseGuard, useOverlayEntry, useRequestClose, useScrimPress, type CloseReason, type DraftGuard } from "./dismiss";
import { clearToasts, Toasts } from "./Toast";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

beforeEach(() => {
  resetTauri({});
  clearToasts();
});

afterEach(() => {
  cleanup();
  clearToasts();
});

const tap = (down: Element, up: Element): void => {
  const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(up);
  fireEvent.pointerDown(down, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
  fireEvent.pointerUp(up, { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
  fireEvent.click(down === up ? up : scrim(), { button: 0, clientX: 10, clientY: 10 });
  under.mockRestore();
};

function Scrim(p: { onPress(): void; ignore?: () => boolean }) {
  const press = useScrimPress(p.onPress, p.ignore);
  return (
    <div data-testid="scrim" {...press}>
      <button type="button">Inside</button>
    </div>
  );
}

const scrim = (): HTMLElement => screen.getByTestId("scrim");
const inside = (): HTMLElement => screen.getByRole("button", { name: "Inside" });

describe("a scrim press", () => {
  it("presses only when it starts and ends on the scrim", () => {
    const onPress = vi.fn();
    render(<Scrim onPress={onPress} />);
    tap(inside(), scrim());
    tap(scrim(), inside());
    tap(inside(), inside());
    expect(onPress).not.toHaveBeenCalled();
    tap(scrim(), scrim());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not press after a cancelled press, or on a click with no press before it", () => {
    const onPress = vi.fn();
    render(<Scrim onPress={onPress} />);
    fireEvent.pointerDown(scrim(), { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(scrim(), { pointerType: "touch" });
    fireEvent.click(scrim(), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(scrim(), { button: 0, clientX: 10, clientY: 10 });
    expect(onPress).not.toHaveBeenCalled();
  });

  it("does not press while it is told to ignore the scrim", () => {
    const onPress = vi.fn();
    render(<Scrim onPress={onPress} ignore={() => true} />);
    tap(scrim(), scrim());
    expect(onPress).not.toHaveBeenCalled();
  });

  it("asks whether to ignore the scrim when the press starts, so a menu that closes on that press still keeps it", () => {
    const onPress = vi.fn();
    let menuOpen = true;
    render(<Scrim onPress={onPress} ignore={() => menuOpen} />);
    const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(scrim());
    fireEvent.pointerDown(scrim(), { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
    menuOpen = false;
    fireEvent.pointerUp(scrim(), { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
    fireEvent.click(scrim(), { button: 0, clientX: 10, clientY: 10 });
    under.mockRestore();
    expect(onPress).not.toHaveBeenCalled();
    tap(scrim(), scrim());
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

function Form(p: { onBlur(): void }) {
  return (
    <div data-testid="root" tabIndex={-1}>
      <input aria-label="Name" onBlur={p.onBlur} />
    </div>
  );
}

const root = (): HTMLElement => screen.getByTestId("root");
const field = (): HTMLElement => screen.getByRole("textbox", { name: "Name" });

describe("commitFocus", () => {
  it("leaves focus alone and reports success when no field inside holds it", () => {
    const onBlur = vi.fn();
    render(<Form onBlur={onBlur} />);
    expect([commitFocus(root(), "Form"), onBlur.mock.calls.length, document.activeElement]).toEqual([true, 0, document.body]);
  });

  it("moves focus to the root, so the field commits, and reports success", () => {
    const onBlur = vi.fn();
    render(<Form onBlur={onBlur} />);
    act(() => field().focus());
    expect([commitFocus(root(), "Form"), onBlur.mock.calls.length, document.activeElement]).toEqual([true, 1, root()]);
  });

  it("reports failure when the field's commit reported an error", () => {
    const reported: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      reported.push(e.error);
      e.preventDefault();
    };
    render(
      <Form
        onBlur={() => {
          throw new Error("the plan refused the name");
        }}
      />,
    );
    act(() => field().focus());
    window.addEventListener("error", onError);
    let committed: boolean | null = null;
    try {
      committed = commitFocus(root(), "Form");
    } catch (e) {
      reported.push(e);
    } finally {
      window.removeEventListener("error", onError);
    }
    expect([committed, reported.map((e) => (e instanceof Error ? e.message : String(e)))]).toEqual([false, ["the plan refused the name"]]);
  });

  it("throws when the root cannot take focus from the field", () => {
    render(<Form onBlur={() => undefined} />);
    act(() => field().focus());
    const stuck = vi.spyOn(root(), "focus").mockImplementation(() => undefined);
    try {
      expect(() => commitFocus(root(), "Form")).toThrow("Form could not take focus from its field to commit it");
    } finally {
      stuck.mockRestore();
    }
  });
});

function Layer(p: { onClose(reason: CloseReason): void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlayEntry(ref, (reason) => {
    p.onClose(reason);
    return true;
  });
  return <div ref={ref}>{p.children}</div>;
}

describe("the overlay stack", () => {
  it("closes only the top of two open overlays, with Escape", () => {
    const lower = vi.fn();
    const upper = vi.fn();
    const { rerender } = render(
      <>
        <Layer key="lower" onClose={lower} />
      </>,
    );
    rerender(
      <>
        <Layer key="lower" onClose={lower} />
        <Layer key="upper" onClose={upper} />
      </>,
    );
    expect([closeTopOverlay(), lower.mock.calls, upper.mock.calls]).toEqual([true, [], [["escape"]]]);
  });

  it("takes the inner of two overlays that open in one commit as the top, though the outer registers last", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Layer onClose={outer}>
        <Layer onClose={inner} />
      </Layer>,
    );
    expect([closeTopOverlay(), outer.mock.calls, inner.mock.calls]).toEqual([true, [], [["escape"]]]);
  });

  it("says when there is nothing to close", () => {
    const lower = vi.fn();
    const { unmount } = render(<Layer onClose={lower} />);
    unmount();
    expect([closeTopOverlay(), lower.mock.calls.length]).toEqual([false, 0]);
  });
});

const GUARD: DraftGuard = { title: "Discard calendar changes?", message: "Your calendar changes are not applied yet." };

function Guard(p: { guard: DraftGuard | null }) {
  useCloseGuard(p.guard);
  return null;
}

function Host(p: { guard: DraftGuard | null; onClose(): void; body?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const request = useRequestClose(ref, p.onClose, "Host");
  return (
    <div ref={ref} data-testid="host" tabIndex={-1}>
      {request.scope(
        <>
          {p.body ?? (
            <>
              <Guard guard={p.guard} />
              <input aria-label="Name" />
            </>
          )}
          <button type="button" onClick={() => request.close("x")}>
            Shut
          </button>
          <button type="button" onClick={() => request.close("escape")}>
            Escape
          </button>
        </>,
      )}
    </div>
  );
}

const shut = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Shut" }));
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const ask = (): HTMLElement | null => screen.queryByRole("alertdialog");

const badToasts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast.bad")).map((e) => e.textContent);

describe("useCloseGuard", () => {
  it("throws without a Dialog or Sheet around it", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => render(<Guard guard={GUARD} />)).toThrow("useCloseGuard needs a Dialog or Sheet around it");
    } finally {
      quiet.mockRestore();
    }
  });

  it("throws when a second guard joins one Dialog or Sheet", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        render(
          <Host
            guard={null}
            onClose={vi.fn()}
            body={
              <>
                <Guard guard={GUARD} />
                <Guard guard={null} />
              </>
            }
          />,
        ),
      ).toThrow("useCloseGuard: a second guard under one Dialog or Sheet");
    } finally {
      quiet.mockRestore();
    }
  });

  it("reads a guard that the field's blur commit turned on, so the close asks", () => {
    setPlatform(MAC);
    const onClose = vi.fn();
    function BlurGuarded() {
      const [name, setName] = useState("Review");
      useCloseGuard(name === "Review" ? null : GUARD);
      return <input aria-label="Draft" defaultValue={name} onBlur={(e) => setName(e.currentTarget.value)} />;
    }
    render(<Host guard={null} onClose={onClose} body={<BlurGuarded />} />);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    act(() => draft.focus());
    fireEvent.change(draft, { target: { value: "Final review" } });
    shut();
    expect([onClose.mock.calls.length, ask() !== null]).toEqual([0, true]);
  });

  it.each([MAC, IPHONE])("closes at once on %o with no guard set", (platform) => {
    setPlatform(platform);
    const onClose = vi.fn();
    render(<Host guard={null} onClose={onClose} />);
    shut();
    expect([onClose.mock.calls.length, ask(), tauri.calls]).toEqual([1, null, []]);
  });
});

describe("a close request", () => {
  function Reporting(p: { guard: DraftGuard | null; onClose(): void; said(closed: boolean): void; body?: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    const request = useRequestClose(ref, p.onClose, "Reporting");
    useOverlayEntry(ref, request.close);
    return (
      <div ref={ref} data-testid="reporting" tabIndex={-1}>
        {request.scope(
          <>
            {p.body ?? <Guard guard={p.guard} />}
            <button type="button" onClick={() => p.said(request.close("x"))}>
              Shut
            </button>
          </>,
        )}
      </div>
    );
  }

  function Refusing() {
    return (
      <input
        aria-label="Refused"
        onBlur={() => {
          throw new Error("the plan refused the name");
        }}
      />
    );
  }

  it("close reports whether it closed", async () => {
    setPlatform(MAC);
    const said: boolean[] = [];
    const onClose = vi.fn();
    const report = (c: boolean): void => {
      said.push(c);
    };
    const first = render(<Reporting guard={null} onClose={onClose} said={report} />);
    shut();
    first.unmount();
    const second = render(<Reporting guard={GUARD} onClose={onClose} said={report} />);
    shut();
    shut();
    second.unmount();
    const third = render(<Reporting guard={null} onClose={onClose} said={report} body={<Refusing />} />);
    act(() => screen.getByRole("textbox", { name: "Refused" }).focus());
    const onError = (e: ErrorEvent): void => e.preventDefault();
    window.addEventListener("error", onError);
    try {
      shut();
    } finally {
      window.removeEventListener("error", onError);
    }
    third.unmount();
    setPlatform(IPHONE);
    resetTauri({ alert_ask: () => new Promise(() => undefined) });
    render(<Reporting guard={GUARD} onClose={onClose} said={report} />);
    shut();
    shut();
    await settle();
    expect([said, onClose.mock.calls.length]).toEqual([[true, false, false, false, false, false], 1]);
  });

  it("requestCloseOf closes an open overlay by its element, and reports it", () => {
    const onClose = vi.fn();
    render(<Reporting guard={null} onClose={onClose} said={() => undefined} />);
    expect([requestCloseOf(screen.getByTestId("reporting"), "x"), onClose.mock.calls.length]).toEqual([true, 1]);
  });

  it("requestCloseOf reports false while the close asks first", () => {
    setPlatform(MAC);
    const onClose = vi.fn();
    render(<Reporting guard={GUARD} onClose={onClose} said={() => undefined} />);
    let closed: boolean | null = null;
    act(() => {
      closed = requestCloseOf(screen.getByTestId("reporting"), "x");
    });
    expect([closed, onClose.mock.calls.length, ask() !== null]).toEqual([false, 0, true]);
  });

  it("requestCloseOf throws for an element that is no open overlay", () => {
    render(<div data-testid="plain" />);
    expect(() => requestCloseOf(screen.getByTestId("plain"), "x")).toThrow("requestCloseOf: the element is no open overlay");
  });
});

describe("the inline discard ask", () => {
  it.each([MAC, LINUX])("on %o asks with Keep editing focused, and Keep editing keeps the draft", (platform) => {
    setPlatform(platform);
    const onClose = vi.fn();
    render(<Host guard={GUARD} onClose={onClose} />);
    shut();
    const box = ask();
    if (box === null) throw new Error("no discard ask");
    expect([box.getAttribute("aria-modal"), box.textContent, [...box.querySelectorAll("button")].map((b) => [b.textContent, b.className])]).toEqual([
      "true",
      "Discard calendar changes?Your calendar changes are not applied yet.Keep editingDiscard",
      [
        ["Keep editing", ""],
        ["Discard", "button-danger"],
      ],
    ]);
    expect(screen.getByRole("alertdialog", { name: GUARD.title })).toBe(box);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect([onClose.mock.calls.length, ask(), tauri.calls]).toEqual([0, null, []]);
  });

  it("Discard closes", () => {
    const onClose = vi.fn();
    render(<Host guard={GUARD} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Escape" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect([onClose.mock.calls.length, ask()]).toEqual([1, null]);
  });

  it("Escape inside the ask keeps the dialog and goes no further", () => {
    const onClose = vi.fn();
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    try {
      render(<Host guard={GUARD} onClose={onClose} />);
      shut();
      const box = ask();
      if (box === null) throw new Error("no discard ask");
      fireEvent.keyDown(screen.getByRole("button", { name: "Keep editing" }), { key: "Escape" });
      expect([onClose.mock.calls.length, ask(), outside.mock.calls.length]).toEqual([0, null, 0]);
    } finally {
      window.removeEventListener("keydown", outside);
    }
  });

  it("is the top overlay while it shows, so a window Escape keeps editing", () => {
    const onClose = vi.fn();
    function Stacked() {
      const ref = useRef<HTMLDivElement>(null);
      useOverlayEntry(ref, () => false);
      return (
        <div ref={ref}>
          <Host guard={GUARD} onClose={onClose} />
        </div>
      );
    }
    render(<Stacked />);
    shut();
    expect(ask()).not.toBeNull();
    act(() => {
      expect(closeTopOverlay()).toBe(true);
    });
    expect([onClose.mock.calls.length, ask()]).toEqual([0, null]);
  });

  it("gives Keep editing's focus back to the field that held it when the ✕ was pressed", () => {
    setPlatform(MAC);
    render(<Host guard={GUARD} onClose={vi.fn()} />);
    const name = screen.getByRole("textbox", { name: "Name" });
    act(() => name.focus());
    shut();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect([ask(), document.activeElement]).toEqual([null, name]);
  });

  it("keeps focus inside itself when a press on its scrim or anything behind it takes focus away", () => {
    setPlatform(LINUX);
    render(<Host guard={GUARD} onClose={vi.fn()} />);
    shut();
    const keep = screen.getByRole("button", { name: "Keep editing" });
    const discard = screen.getByRole("button", { name: "Discard" });
    const backdrop = document.querySelector(".discard-scrim");
    if (!(backdrop instanceof HTMLElement)) throw new Error("no discard scrim");
    expect(fireEvent.mouseDown(backdrop)).toBe(false);
    act(() => screen.getByTestId("host").focus());
    expect(document.activeElement).toBe(keep);
    act(() => screen.getByRole("button", { name: "Shut" }).focus());
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(keep, { key: "Tab" });
    expect(document.activeElement).toBe(discard);
  });

  it("keeps Tab between its two buttons", () => {
    render(<Host guard={GUARD} onClose={vi.fn()} />);
    shut();
    const keep = screen.getByRole("button", { name: "Keep editing" });
    const discard = screen.getByRole("button", { name: "Discard" });
    fireEvent.keyDown(keep, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(discard);
    fireEvent.keyDown(discard, { key: "Tab" });
    expect(document.activeElement).toBe(keep);
  });
});

describe("the native discard ask", () => {
  it.each([IPHONE, IPAD])("on %o asks UIKit with Keep editing and a destructive Discard, and Discard closes", async (platform) => {
    setPlatform(platform);
    resetTauri({ alert_ask: () => "confirm" });
    const onClose = vi.fn();
    render(<Host guard={GUARD} onClose={onClose} />);
    shut();
    await settle();
    expect(tauri.calls).toEqual([
      { cmd: "alert_ask", args: { ask: { title: GUARD.title, message: GUARD.message, confirm: { label: "Discard", destructive: true }, cancel: "Keep editing" } }, options: undefined },
    ]);
    expect([onClose.mock.calls.length, ask()]).toEqual([1, null]);
  });

  it("Keep editing leaves it open and asks again on the next close", async () => {
    setPlatform(IPHONE);
    resetTauri({ alert_ask: () => "cancel" });
    const onClose = vi.fn();
    render(<Host guard={GUARD} onClose={onClose} />);
    shut();
    await settle();
    shut();
    await settle();
    expect([onClose.mock.calls.length, tauri.calls.length, ask()]).toEqual([0, 2, null]);
  });

  it("asks once while the answer is pending", async () => {
    setPlatform(IPHONE);
    resetTauri({ alert_ask: () => new Promise(() => undefined) });
    render(<Host guard={GUARD} onClose={vi.fn()} />);
    shut();
    shut();
    await settle();
    expect(tauri.calls.length).toBe(1);
  });

  it("toasts an AppError and stays open", async () => {
    setPlatform(IPHONE);
    resetTauri({
      alert_ask: () => {
        throw { code: "alert.busy", message: "The alert cannot be shown: something else is already presented over the window." };
      },
    });
    const onClose = vi.fn();
    render(
      <>
        <Toasts />
        <Host guard={GUARD} onClose={onClose} />
      </>,
    );
    shut();
    await settle();
    expect([onClose.mock.calls.length, badToasts(), screen.getByTestId("host").isConnected]).toEqual([
      0,
      ["The alert cannot be shown: something else is already presented over the window."],
      true,
    ]);
    expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
  });

  it("throws when an ask stays unanswered past the wait, and asks again on the next close", async () => {
    setPlatform(IPHONE);
    resetTauri({ alert_ask: () => new Promise(() => undefined) });
    const clock = vi.spyOn(performance, "now").mockReturnValue(5000);
    const reported: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      reported.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      render(<Host guard={GUARD} onClose={vi.fn()} />);
      shut();
      await settle();
      clock.mockReturnValue(5000 + ASK_WAIT_MS);
      try {
        shut();
      } catch (e) {
        reported.push(e);
      }
      await settle();
      shut();
      await settle();
    } finally {
      window.removeEventListener("error", onError);
      clock.mockRestore();
    }
    expect([reported.map((e) => (e instanceof Error ? e.message : String(e))), tauri.calls.length]).toEqual([[`Host's discard ask got no answer from iOS within ${ASK_WAIT_MS} ms`], 2]);
  });
});
