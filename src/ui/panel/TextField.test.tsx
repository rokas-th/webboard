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

  it("shows the stored value after its own Enter commit while it keeps focus", () => {
    const onCommit = vi.fn((_: string) => true);
    const remote = shown("Design review", onCommit);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: " Design  sync " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCommit.mock.calls).toEqual([["Design  sync"]]);
    remote("Design sync");
    expect(field().value).toBe("Design sync");
    fireEvent.blur(field());
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
