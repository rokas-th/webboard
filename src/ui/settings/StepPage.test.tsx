import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusal } from "../../actions/copy";
import { stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { IPAD, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { resetTauri, tauri } from "../../test/tauriMock";
import { STEP_GONE } from "../board/text";
import { toast } from "../common/Toast";
import { OpenChoice } from "../run";
import { StepPage } from "./StepPage";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));
vi.mock("../common/Toast", () => ({ toast: vi.fn() }));

const sessions: PlanSession[] = [];

const last = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

beforeEach(() => {
  setPlatform(MAC);
});

afterEach(async () => {
  cleanup();
  vi.mocked(toast).mockClear();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  setPlatform(MAC);
});

const SEED: SeedItem[] = [
  { name: "soon", start: "2026-11-20", dur: 2 },
  { name: "mid", start: "2026-12-15", dur: 2 },
  { name: "d1", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  { name: "u", horizon: "next" },
  { name: "w" },
];

const made = async (seed: readonly SeedItem[] = SEED): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return t;
};

const mount = (session: PlanSession, step: string, o: { readOnly?: boolean; select?: boolean } = {}): HTMLElement => {
  const view = render(
    <OpenChoice.Provider value={vi.fn()}>
      <div className="host">
        <StepPage session={session} readOnly={o.readOnly ?? false} step={step} select={o.select ?? false} />
      </div>
    </OpenChoice.Provider>,
  );
  const host = view.container.querySelector<HTMLElement>(".host");
  if (host === null) throw new Error("no host");
  return host;
};

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const input = (sel: string, root: ParentNode = document): HTMLInputElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLInputElement)) throw new Error("no input " + sel);
  return el;
};

const commit = (el: HTMLInputElement, value: string): void => {
  act(() => {
    el.focus();
  });
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: "Enter" });
};

const labels = (root: HTMLElement): (string | null)[] => [...root.querySelectorAll<HTMLElement>(".settings-detail-row .settings-detail-label")].map((l) => l.textContent);

const switchOf = (root: HTMLElement): HTMLElement => one('button.switch[role="switch"]', root);

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

describe("StepPage", () => {
  it("shows Name, Colour, Limit, Completes items and the items of the step", async () => {
    const t = await made();
    act(() => {
      t.session.apply({ t: "step", op: "limit", step: "next", limit: 1 });
    });
    const root = mount(t.session, "next");
    expect([
      labels(root),
      one(".settings-detail", root).dataset.step,
      one(".settings-detail", root).style.getPropertyValue("--step"),
      input("input.workflow-name", root).value,
      input("input.workflow-name", root).getAttribute("aria-label"),
      one("button.workflow-swatch", root).getAttribute("aria-label"),
      one("button.workflow-swatch", root).querySelectorAll(".swatch").length,
      input("input.workflow-limit", root).value,
      input("input.workflow-limit", root).placeholder,
      input("input.workflow-limit", root).getAttribute("aria-label"),
      switchOf(root).getAttribute("aria-label"),
      switchOf(root).getAttribute("aria-checked"),
      one(".settings-detail-value", root).textContent,
      one(".settings-detail-value", root).className,
      one(".settings-detail-value", root).title,
      one("button.settings-detail-danger", root).textContent,
      root.querySelector("p.settings-line"),
    ]).toEqual([
      ["Name", "Colour", "Limit", "Completes items", "Items"],
      "next",
      "var(--s-violet)",
      "Next",
      "Name of Next",
      "Colour · Next",
      1,
      "1",
      "None",
      "Limit of Next",
      "Next completes items",
      "false",
      "2 items",
      "settings-detail-value over",
      "Over the limit of 1",
      "Delete step",
      null,
    ]);
  });

  it("renames, refusing a taken name, and sets and clears the limit, refusing a bad one", async () => {
    const t = await made();
    const root = mount(t.session, "next");
    const apply = vi.spyOn(t.session, "apply");
    commit(input("input.workflow-name", root), "Review");
    expect([apply.mock.calls, input("input.workflow-name", root).getAttribute("aria-label"), switchOf(root).getAttribute("aria-label")]).toEqual([
      [[{ t: "step", op: "rename", step: "next", name: "Review" }]],
      "Name of Review",
      "Review completes items",
    ]);
    commit(input("input.workflow-name", root), "now");
    expect([last(vi.mocked(toast).mock.calls), input("input.workflow-name", root).value]).toEqual([[refusal.stepNameTaken("Now"), "bad"], "Review"]);
    commit(input("input.workflow-limit", root), "3");
    expect([last(apply.mock.calls), input("input.workflow-limit", root).value, one(".settings-detail-value", root).textContent]).toEqual([[{ t: "step", op: "limit", step: "next", limit: 3 }], "3", "2 items"]);
    commit(input("input.workflow-limit", root), "12x");
    expect([last(vi.mocked(toast).mock.calls), input("input.workflow-limit", root).value]).toEqual([[refusal.stepLimit, "bad"], "3"]);
    commit(input("input.workflow-limit", root), "");
    expect([last(apply.mock.calls), input("input.workflow-limit", root).value]).toEqual([[{ t: "step", op: "limit", step: "next", limit: null }], ""]);
  });

  it("turns Completes items on for this step and off for every step", async () => {
    const t = await made();
    const root = mount(t.session, "done");
    const apply = vi.spyOn(t.session, "apply");
    expect(switchOf(root).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(switchOf(root));
    expect([apply.mock.calls, switchOf(root).getAttribute("aria-checked"), stepsOf(t.session.view().plan).some((s) => s.completes)]).toEqual([[[{ t: "step", op: "noneCompletes" }]], "false", false]);
    fireEvent.click(switchOf(root));
    expect([last(apply.mock.calls), switchOf(root).getAttribute("aria-checked")]).toEqual([[{ t: "step", op: "completes", step: "done", completes: true }], "true"]);
  });

  it("toasts when a step that still holds open items is switched to complete them", async () => {
    const t = await made();
    const root = mount(t.session, "next");
    fireEvent.click(switchOf(root));
    expect([last(vi.mocked(toast).mock.calls), switchOf(root).getAttribute("aria-checked")]).toEqual([[refusal.stepHoldsOpen("Next", 2), "bad"], "false"]);
  });

  it("recolours through the colour popover, which has its close control", async () => {
    const t = await made();
    const root = mount(t.session, "now");
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.workflow-swatch", root));
    const pop = within(root).getByRole("dialog", { name: "Colour · Now" });
    expect([one("button.workflow-swatch", root).getAttribute("aria-expanded"), within(pop).getByRole("button", { name: "Close" }) !== null]).toEqual(["true", true]);
    fireEvent.click(within(pop).getByRole("radio", { name: "Amber" }));
    expect([apply.mock.calls, within(root).queryByRole("dialog"), one(".settings-detail", root).style.getPropertyValue("--step")]).toEqual([
      [[{ t: "step", op: "colour", step: "now", colour: "amber" }]],
      null,
      "var(--s-amber)",
    ]);
  });

  it("selects the name when opened for a new step", async () => {
    const t = await made();
    const root = mount(t.session, "later", { select: true });
    const name = input("input.workflow-name", root);
    expect([document.activeElement, name.selectionStart, name.selectionEnd]).toEqual([name, 0, 5]);
  });

  it("asks before Delete step: items ask where they go, an empty step asks to confirm, and a deleted step leaves the line", async () => {
    const t = await made();
    const root = mount(t.session, "later");
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.settings-detail-danger", root));
    const move = within(root).getByRole("dialog", { name: "Move 2 items from Later to…" });
    fireEvent.click(within(move).getByRole("button", { name: "Cancel" }));
    expect([apply.mock.calls, within(root).queryByRole("dialog")]).toEqual([[], null]);
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "Spare", colour: "sky", after: "done" });
    });
    const spare = stepsOf(t.session.view().plan).find((s) => s.name === "Spare");
    if (spare === undefined) throw new Error("no Spare");
    cleanup();
    const page = mount(t.session, spare.id);
    fireEvent.click(one("button.settings-detail-danger", page));
    const ask = within(page).getByRole("dialog", { name: "Delete step" });
    fireEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    expect([last(apply.mock.calls), one("p.settings-line", page).textContent, page.querySelectorAll("input, button").length]).toEqual([[{ t: "step", op: "delete", step: spare.id, to: null }], STEP_GONE, 0]);
  });

  it("toasts instead of asking when the step is the last open one", async () => {
    const t = await made([{ name: "a", horizon: "now" }]);
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: "next", to: null });
      t.session.apply({ t: "step", op: "delete", step: "later", to: null });
    });
    const root = mount(t.session, "now");
    fireEvent.click(one("button.settings-detail-danger", root));
    expect([last(vi.mocked(toast).mock.calls), root.querySelector('[role="dialog"]')]).toEqual([[refusal.lastOpenStep, "bad"], null]);
  });

  it("shows a line, and no fields, when the step is deleted elsewhere", async () => {
    const t = await made();
    const root = mount(t.session, "next");
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: "next", to: "now" });
    });
    expect([one("p.settings-line", root).textContent, root.querySelectorAll("input, button").length]).toEqual([STEP_GONE, 0]);
    expect(STEP_GONE).toBe("This step is no longer in this plan.");
  });

  it("disables every field, the switch and Delete step when the plan is read-only", async () => {
    const t = await made();
    const root = mount(t.session, "done", { readOnly: true });
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")];
    expect([controls.length, controls.filter((c) => !c.disabled).map((c) => c.className), input("input.workflow-name", root).value, switchOf(root).getAttribute("aria-checked")]).toEqual([
      5,
      [],
      "Done",
      "true",
    ]);
  });
});

describe("StepPage on iPad", () => {
  it("asks Delete step of an empty step through the native alert", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const t = await made();
      act(() => {
        t.session.apply({ t: "step", op: "add", name: "Spare", colour: "sky", after: "done" });
      });
      const spare = stepsOf(t.session.view().plan).find((s) => s.name === "Spare");
      if (spare === undefined) throw new Error("no Spare");
      const root = mount(t.session, spare.id);
      tauri.answers.alert_ask = () => "confirm";
      fireEvent.click(one("button.settings-detail-danger", root));
      await settle();
      expect([tauri.calls.filter((c) => c.cmd === "alert_ask").length, within(root).queryByRole("dialog"), one("p.settings-line", root).textContent]).toEqual([1, null, STEP_GONE]);
    } finally {
      unstub();
    }
  });
});
