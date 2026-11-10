import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GanttReport } from "../../import/gantt";
import { CONVERTED_TITLE, ConvertedReport, closeConverted, OPEN_PLAN, showConverted, shownConverted } from "./ConvertedReport";

const REPORT: GanttReport = {
  fileName: "Fixture Plan 20260901.gantt",
  name: "Fixture Plan",
  counts: { groups: 1, tasks: 2, milestones: 1, links: 1, notes: 0 },
  dropped: ["TaskID on 4 items", "color on 4 items", "advanced.workTime"],
};

afterEach(() => {
  cleanup();
  if (shownConverted() !== null) closeConverted();
});

const settled = (p: Promise<void>): { done: () => boolean } => {
  let done = false;
  void p.then(() => {
    done = true;
  });
  return { done: () => done };
};

const textOf = (root: HTMLElement): string[] => [...root.querySelectorAll("p, li")].map((e) => e.textContent ?? "");

describe("ConvertedReport", () => {
  it("renders nothing until a conversion is shown", () => {
    const { queryByRole } = render(<ConvertedReport />);
    expect(queryByRole("dialog")).toBeNull();
  });

  it("shows the plan name, the counts and every dropped field, and settles when Open plan is pressed", async () => {
    const { getByRole, queryByRole } = render(<ConvertedReport />);
    let shown: Promise<void> = Promise.resolve();
    act(() => {
      shown = showConverted(REPORT);
    });
    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe(CONVERTED_TITLE);
    expect(textOf(dialog)).toEqual([
      "Plan “Fixture Plan” from Fixture Plan 20260901.gantt",
      "1 group, 2 tasks, 1 milestone, 1 link, 0 notes",
      "Not carried over:",
      "TaskID on 4 items",
      "color on 4 items",
      "advanced.workTime",
    ]);
    const state = settled(shown);
    await act(async () => {
      fireEvent.click(getByRole("button", { name: OPEN_PLAN }));
      await shown;
    });
    expect(state.done()).toBe(true);
    expect(queryByRole("dialog")).toBeNull();
    expect(shownConverted()).toBeNull();
  });

  it("settles on Escape the same way", async () => {
    const { getByRole, queryByRole } = render(<ConvertedReport />);
    let shown: Promise<void> = Promise.resolve();
    act(() => {
      shown = showConverted(REPORT);
    });
    await act(async () => {
      fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
      await shown;
    });
    expect(queryByRole("dialog")).toBeNull();
  });

  it("shows the same report in the phone sheet", () => {
    const { getByRole } = render(<ConvertedReport frame="sheet" />);
    act(() => {
      void showConverted(REPORT);
    });
    const sheet = getByRole("dialog");
    expect(sheet.getAttribute("aria-label")).toBe(CONVERTED_TITLE);
    expect(textOf(sheet)).toContain("Plan “Fixture Plan” from Fixture Plan 20260901.gantt");
    expect(getByRole("button", { name: OPEN_PLAN })).toBeTruthy();
  });

  it("refuses a second report while one is open, and a close with none open", () => {
    void showConverted(REPORT);
    expect(() => showConverted(REPORT)).toThrow("A conversion report is already open");
    closeConverted();
    expect(() => closeConverted()).toThrow("No conversion report is open");
  });
});
