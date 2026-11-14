import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_PLAN_KEY, PLACE_KEY } from "../state";
import { OPEN_WITHOUT_PLAN, RELOAD, RootBoundary } from "./RootBoundary";

function Broken(): never {
  throw new Error("Shell: plan has no item abc");
}

const reload = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  reload.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("RootBoundary", () => {
  it("renders its children while nothing throws", () => {
    render(
      <RootBoundary reload={reload}>
        <p>plan is open</p>
      </RootBoundary>,
    );
    expect(screen.getByText("plan is open")).toBeTruthy();
  });

  it("shows and logs a render error with Reload and Open without the last plan", () => {
    const log = quiet();
    render(
      <RootBoundary reload={reload}>
        <Broken />
      </RootBoundary>,
    );
    const shown = document.querySelector(".start-failed .start-bad");
    expect(shown?.textContent).toBe("Shell: plan has no item abc");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([RELOAD, OPEN_WITHOUT_PLAN]);
    const logged = log.mock.calls.flat().filter((a): a is Error => a instanceof Error);
    expect(logged.map((e) => e.message)).toContain("Shell: plan has no item abc");
    fireEvent.click(screen.getByRole("button", { name: RELOAD }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("Open without the last plan clears the plan in the stored place and keeps the rest, then reloads", () => {
    quiet();
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: "AAAAAAAAAAA", view: "list", zoom: "M", collapsed: ["g1"] }));
    render(
      <RootBoundary reload={reload}>
        <Broken />
      </RootBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: OPEN_WITHOUT_PLAN }));
    expect(JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? "")).toEqual({ plan: null, view: "list", zoom: "M", collapsed: ["g1"], sidebarOpen: true, sidebarWidth: null });
    expect(window.localStorage.getItem(NO_PLAN_KEY)).not.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("Open without the last plan leaves an unreadable or missing place alone and still asks the next start to open no plan", () => {
    quiet();
    window.localStorage.setItem(PLACE_KEY, "{not json");
    render(
      <RootBoundary reload={reload}>
        <Broken />
      </RootBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: OPEN_WITHOUT_PLAN }));
    expect(window.localStorage.getItem(PLACE_KEY)).toBe("{not json");
    expect(window.localStorage.getItem(NO_PLAN_KEY)).not.toBeNull();
    window.localStorage.clear();
    fireEvent.click(screen.getByRole("button", { name: OPEN_WITHOUT_PLAN }));
    expect(window.localStorage.getItem(PLACE_KEY)).toBeNull();
    expect(window.localStorage.getItem(NO_PLAN_KEY)).not.toBeNull();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
