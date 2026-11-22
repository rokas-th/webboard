import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, COPY_DETAILS, Toasts } from "../common/Toast";
import { boardKey, EMPTY_BOARD_PREFS, parseBoardPrefs, readBoardPrefs, useBoardPrefs, writeBoardPrefs, type BoardPrefs } from "./prefs";
import { HIDE_LIMIT, PREFS_UNREADABLE } from "./text";

const PLAN = "planMesa001";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  clearToasts();
  window.localStorage.clear();
});

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

describe("board prefs", () => {
  it("keys a plan's record by its id", () => {
    expect(boardKey(PLAN)).toBe("webboard.board.planMesa001");
    expect(EMPTY_BOARD_PREFS).toEqual({ v: 1, hidden: [], doneOpen: false });
  });

  it("reads a full record", () => {
    expect(parseBoardPrefs(JSON.stringify({ v: 1, hidden: ["next", "stepQa00001"], doneOpen: true }))).toEqual({ v: 1, hidden: ["next", "stepQa00001"], doneOpen: true });
    expect(parseBoardPrefs(JSON.stringify({ doneOpen: false, hidden: [], v: 1 }))).toEqual(EMPTY_BOARD_PREFS);
  });

  it.each([
    ["not JSON", "{v:1"],
    ["an array", "[]"],
    ["null", "null"],
    ["a missing key", JSON.stringify({ v: 1, hidden: [] })],
    ["an extra key", JSON.stringify({ v: 1, hidden: [], doneOpen: false, x: 1 })],
    ["v 2", JSON.stringify({ v: 2, hidden: [], doneOpen: false })],
    ["v as a string", JSON.stringify({ v: "1", hidden: [], doneOpen: false })],
    ["hidden not a list", JSON.stringify({ v: 1, hidden: "next", doneOpen: false })],
    ["a number in hidden", JSON.stringify({ v: 1, hidden: [3], doneOpen: false })],
    ["an id with a space", JSON.stringify({ v: 1, hidden: ["a b"], doneOpen: false })],
    ["an empty id", JSON.stringify({ v: 1, hidden: [""], doneOpen: false })],
    ["a repeated id", JSON.stringify({ v: 1, hidden: ["next", "next"], doneOpen: false })],
    ["65 ids", JSON.stringify({ v: 1, hidden: Array.from({ length: 65 }, (_, i) => `s${i}`), doneOpen: false })],
    ["doneOpen not a boolean", JSON.stringify({ v: 1, hidden: [], doneOpen: 1 })],
  ])("rejects %s", (_, raw) => {
    expect(parseBoardPrefs(raw)).toBeNull();
  });

  it("takes 64 ids", () => {
    const hidden = Array.from({ length: 64 }, (_, i) => `s${i}`);
    expect(parseBoardPrefs(JSON.stringify({ v: 1, hidden, doneOpen: false }))).toEqual({ v: 1, hidden, doneOpen: false });
  });

  it("reads nothing stored as the empty record and writes nothing", () => {
    expect(readBoardPrefs(window.localStorage, PLAN)).toEqual(EMPTY_BOARD_PREFS);
    expect(window.localStorage.length).toBe(0);
  });

  it("resets a bad record once, removing only this plan's key, and says so", () => {
    render(<Toasts />);
    window.localStorage.setItem(boardKey(PLAN), JSON.stringify({ v: 1, hidden: ["a b"], doneOpen: false }));
    window.localStorage.setItem(boardKey("planOther01"), JSON.stringify({ v: 1, hidden: ["next"], doneOpen: true }));
    window.localStorage.setItem("webboard.place", "{}");
    act(() => {
      expect(readBoardPrefs(window.localStorage, PLAN)).toEqual(EMPTY_BOARD_PREFS);
      expect(readBoardPrefs(window.localStorage, PLAN)).toEqual(EMPTY_BOARD_PREFS);
    });
    expect(window.localStorage.getItem(boardKey(PLAN))).toBeNull();
    expect(window.localStorage.getItem(boardKey("planOther01"))).not.toBeNull();
    expect(window.localStorage.getItem("webboard.place")).toBe("{}");
    expect(toastTexts()).toEqual([PREFS_UNREADABLE]);
  });

  it("drops dead ids on write", () => {
    const next: BoardPrefs = { v: 1, hidden: ["next", "gone0000001", "later"], doneOpen: true };
    writeBoardPrefs(window.localStorage, PLAN, next, new Set(["now", "next", "later", "done"]));
    expect(JSON.parse(window.localStorage.getItem(boardKey(PLAN)) ?? "null")).toEqual({ v: 1, hidden: ["next", "later"], doneOpen: true });
    expect(readBoardPrefs(window.localStorage, PLAN)).toEqual({ v: 1, hidden: ["next", "later"], doneOpen: true });
  });

  it("re-renders a hook reader on write, with the same object while nothing changes", () => {
    const seen: BoardPrefs[] = [];
    function Probe() {
      seen.push(useBoardPrefs(PLAN));
      return null;
    }
    const view = render(<Probe />);
    view.rerender(<Probe />);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toEqual(EMPTY_BOARD_PREFS);
    act(() => {
      writeBoardPrefs(window.localStorage, PLAN, { v: 1, hidden: ["next"], doneOpen: false }, new Set(["next"]));
    });
    expect(seen[seen.length - 1]).toEqual({ v: 1, hidden: ["next"], doneOpen: false });
  });

  it("resets a bad record from the hook once, with one toast", () => {
    window.localStorage.setItem(boardKey(PLAN), "{");
    function Probe() {
      const prefs = useBoardPrefs(PLAN);
      return <span data-open={String(prefs.doneOpen)} />;
    }
    render(
      <>
        <Toasts />
        <Probe />
      </>,
    );
    expect(window.localStorage.getItem(boardKey(PLAN))).toBeNull();
    expect(toastTexts()).toEqual([PREFS_UNREADABLE]);
  });

  it("refuses to write a 65th hidden step, keeping the record it had, so its own record always reads back", () => {
    render(<Toasts />);
    const ids = Array.from({ length: 65 }, (_, i) => `s${i}`);
    const live = new Set(ids);
    act(() => {
      writeBoardPrefs(window.localStorage, PLAN, { v: 1, hidden: ids.slice(0, 64), doneOpen: false }, live);
    });
    const kept = window.localStorage.getItem(boardKey(PLAN));
    act(() => {
      writeBoardPrefs(window.localStorage, PLAN, { v: 1, hidden: ids, doneOpen: false }, live);
    });
    expect(window.localStorage.getItem(boardKey(PLAN))).toBe(kept);
    expect(toastTexts()).toEqual([HIDE_LIMIT]);
    expect(readBoardPrefs(window.localStorage, PLAN).hidden).toHaveLength(64);
    expect(toastTexts()).toEqual([HIDE_LIMIT]);
  });

  it("shows at most the first 200 characters of a bad record in the reset toast", () => {
    render(<Toasts />);
    const raw = `{"v":1,"hidden":[${'"x",'.repeat(400)}`;
    window.localStorage.setItem(boardKey(PLAN), raw);
    act(() => {
      readBoardPrefs(window.localStorage, PLAN);
    });
    expect(toastTexts()).toEqual([PREFS_UNREADABLE]);
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      fireEvent.click(screen.getByRole("button", { name: COPY_DETAILS }));
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    expect(writeText.mock.calls).toEqual([[`The record was: ${raw.slice(0, 200)}… (${raw.length} characters)`]]);
  });

  it("resets a record that turns unreadable while the hook is mounted, with one toast", () => {
    window.localStorage.setItem(boardKey(PLAN), JSON.stringify({ v: 1, hidden: ["next"], doneOpen: true }));
    function Probe() {
      const prefs = useBoardPrefs(PLAN);
      return <span data-open={String(prefs.doneOpen)} />;
    }
    const view = render(
      <>
        <Toasts />
        <Probe />
      </>,
    );
    expect(document.querySelector("[data-open]")?.getAttribute("data-open")).toBe("true");
    expect(toastTexts()).toEqual([]);
    window.localStorage.setItem(boardKey(PLAN), "{");
    view.rerender(
      <>
        <Toasts />
        <Probe />
      </>,
    );
    expect(window.localStorage.getItem(boardKey(PLAN))).toBeNull();
    expect(toastTexts()).toEqual([PREFS_UNREADABLE]);
    expect(document.querySelector("[data-open]")?.getAttribute("data-open")).toBe("false");
  });
});
