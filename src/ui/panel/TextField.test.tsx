import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextField } from "./TextField";

afterEach(() => {
  cleanup();
});

const field = (): HTMLInputElement => {
  const el = screen.getByRole("textbox", { name: "Name" });
  if (!(el instanceof HTMLInputElement)) throw new Error("no name input");
  return el;
};

const shown = (value: string, onCommit: (next: string) => boolean) => {
  const r = render(<TextField value={value} label="Name" className="title-input" readOnly={false} onCommit={onCommit} />);
  return (next: string): void => r.rerender(<TextField value={next} label="Name" className="title-input" readOnly={false} onCommit={onCommit} />);
};

describe("TextField under a remote change", () => {
  it("keeps the focused draft through a remote change and commits the draft", () => {
    const onCommit = vi.fn((_: string) => true);
    const remote = shown("Design review", onCommit);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "Design revi" } });
    remote("Design sync");
    expect(field().value).toBe("Design revi");
    fireEvent.change(field(), { target: { value: "Design revisit" } });
    fireEvent.blur(field());
    expect(onCommit.mock.calls).toEqual([["Design revisit"]]);
  });

  it("commits the focused draft on Enter after a remote change", () => {
    const onCommit = vi.fn((_: string) => true);
    const remote = shown("Design review", onCommit);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "Mine" } });
    remote("Theirs");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCommit.mock.calls).toEqual([["Mine"]]);
  });

  it("follows a remote change in a focused field the user has not edited, and writes nothing on blur", () => {
    const onCommit = vi.fn((_: string) => true);
    const remote = shown("Design review", onCommit);
    act(() => field().focus());
    remote("Design sync");
    expect(field().value).toBe("Design sync");
    fireEvent.blur(field());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits once on Enter and leaves the field, then shows the stored value", () => {
    const onCommit = vi.fn((_: string) => true);
    const remote = shown("Design review", onCommit);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: " Design  sync " } });
    act(() => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(onCommit.mock.calls).toEqual([["Design  sync"]]);
    expect(document.activeElement).not.toBe(field());
    remote("Design sync");
    expect(field().value).toBe("Design sync");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("takes a remote change while the field is not focused", () => {
    const onCommit = vi.fn((_: string) => true);
    const remote = shown("Design review", onCommit);
    fireEvent.change(field(), { target: { value: "Design revi" } });
    remote("Design sync");
    expect(field().value).toBe("Design sync");
  });
});

describe("TextField keys", () => {
  const dateField = (): HTMLInputElement => {
    const el = screen.getByLabelText("Start");
    if (!(el instanceof HTMLInputElement)) throw new Error("no date input");
    return el;
  };

  it("puts the stored text back on Escape, leaves the field and writes nothing", () => {
    const onCommit = vi.fn((_: string) => true);
    shown("Design review", onCommit);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "Design typo" } });
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      field().dispatchEvent(esc);
    });
    expect([field().value, document.activeElement === field(), esc.defaultPrevented]).toEqual(["Design review", false, true]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits a date on Enter and puts it back on Escape, leaving the field both times", () => {
    const onCommit = vi.fn((_: string) => true);
    render(<TextField type="date" value="2026-11-16" label="Start" className="date-input" readOnly={false} onCommit={onCommit} />);
    act(() => dateField().focus());
    fireEvent.change(dateField(), { target: { value: "2026-11-18" } });
    act(() => {
      fireEvent.keyDown(dateField(), { key: "Enter" });
    });
    expect([onCommit.mock.calls, document.activeElement === dateField()]).toEqual([[["2026-11-18"]], false]);
    act(() => dateField().focus());
    fireEvent.change(dateField(), { target: { value: "2026-12-01" } });
    act(() => {
      fireEvent.keyDown(dateField(), { key: "Escape" });
    });
    expect([dateField().value, document.activeElement === dateField(), onCommit.mock.calls.length]).toEqual(["2026-11-16", false, 1]);
  });

  it("inside a dialog, Escape and Enter hand focus to the dialog so the next Escape can close it", () => {
    const onCommit = vi.fn((_: string) => true);
    render(
      <div role="dialog" aria-modal="true" tabIndex={-1} aria-label="Sheet">
        <TextField value="Design review" label="Name" className="title-input" readOnly={false} onCommit={onCommit} />
      </div>,
    );
    const box = screen.getByRole("dialog");
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "Other" } });
    act(() => {
      fireEvent.keyDown(field(), { key: "Escape" });
    });
    expect([field().value, document.activeElement === box]).toEqual(["Design review", true]);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "Other" } });
    act(() => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect([onCommit.mock.calls, document.activeElement === box]).toEqual([[["Other"]], true]);
  });

  it("puts the stored value back when the commit is refused on Enter, and leaves the field", () => {
    const onCommit = vi.fn((_: string) => false);
    shown("Design review", onCommit);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "Bad" } });
    act(() => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect([onCommit.mock.calls, field().value, document.activeElement === field()]).toEqual([[["Bad"]], "Design review", false]);
  });

  it("is a number field with its own bounds", () => {
    const onCommit = vi.fn((_: string) => true);
    render(<TextField type="number" min="1" max="3650" value="3" label="Duration" className="num-input" readOnly={false} onCommit={onCommit} />);
    const el = screen.getByRole("spinbutton", { name: "Duration" });
    if (!(el instanceof HTMLInputElement)) throw new Error("no number input");
    expect([el.min, el.max, el.value]).toEqual(["1", "3650", "3"]);
    act(() => el.focus());
    fireEvent.change(el, { target: { value: "5" } });
    act(() => {
      fireEvent.keyDown(el, { key: "Enter" });
    });
    expect(onCommit.mock.calls).toEqual([["5"]]);
  });
});
