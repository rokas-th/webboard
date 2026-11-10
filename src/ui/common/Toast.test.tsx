import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, COPY_DETAILS, DETAILS_COPIED, DISMISS, TOAST_MS, toast, Toasts } from "./Toast";

beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const texts = (): (string | null)[] => Array.from(document.querySelectorAll(".toasts .toast")).map((e) => e.textContent);

describe("Toasts", () => {
  it("drops an ok or plain toast after TOAST_MS", () => {
    render(<Toasts />);
    act(() => {
      toast("Saved", "ok");
      toast("Moved");
    });
    expect(screen.getAllByRole("status").map((e) => e.textContent)).toEqual(["Saved", "Moved"]);
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(texts()).toEqual([]);
  });

  it("keeps a bad toast as an alert until it is dismissed", () => {
    render(<Toasts />);
    act(() => toast("Import failed: bad file", "bad"));
    act(() => {
      vi.advanceTimersByTime(TOAST_MS * 10);
    });
    const alert = screen.getByRole("alert");
    expect([alert.textContent, alert.className]).toEqual(["Import failed: bad file", "toast bad"]);
    expect(screen.queryAllByRole("status")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: DISMISS }));
    expect(texts()).toEqual([]);
  });

  it("dismisses only the toast whose button was pressed", () => {
    render(<Toasts />);
    act(() => {
      toast("First", "bad");
      toast("Second", "bad");
    });
    fireEvent.click(screen.getAllByRole("button", { name: DISMISS })[0]);
    expect(texts()).toEqual(["Second"]);
  });

  it("offers Copy details only when the toast carries details, and copies them", async () => {
    const writeText = vi.fn((_: string) => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Toasts />);
    act(() => {
      toast("Plain failure", "bad");
      toast("Boom", "bad", "Error: Boom\n    at render (Shell.tsx:1:1)");
    });
    const copies = screen.getAllByRole("button", { name: COPY_DETAILS });
    expect(copies.length).toBe(1);
    await act(async () => {
      fireEvent.click(copies[0]);
      await Promise.resolve();
    });
    expect(writeText.mock.calls).toEqual([["Error: Boom\n    at render (Shell.tsx:1:1)"]]);
    expect(texts()).toEqual(["Plain failure", "Boom", DETAILS_COPIED]);
  });

  it("shows a failed copy as its own bad toast", async () => {
    const writeText = vi.fn((_: string) => Promise.reject(new Error("Clipboard refused")));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Toasts />);
    act(() => toast("Boom", "bad", "stack"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: COPY_DETAILS }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByRole("alert").map((e) => e.textContent)).toEqual(["Boom", "Clipboard refused"]);
  });
});
