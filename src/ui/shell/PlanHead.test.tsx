import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { testSession, type TestSession } from "../../test/session";
import { shellFor } from "../../test/shell";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { PlanHead } from "./PlanHead";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const made = async (): Promise<TestSession> => {
  const t = await testSession([{ name: "A", start: "2026-11-10", dur: 3 }]);
  sessions.push(t.session);
  return t;
};

const shown = async (t: TestSession): Promise<void> => {
  render(withSync(shellFor(t).ui));
  await settle();
};

const field = (): HTMLInputElement => {
  const el = document.querySelector('.plan-head h1 input[aria-label="Plan name"]');
  if (!(el instanceof HTMLInputElement)) throw new Error("no Plan name field in the heading");
  return el;
};

const type = (el: HTMLInputElement, value: string, key: "Enter" | "Escape"): void => {
  act(() => el.focus());
  act(() => {
    fireEvent.change(el, { target: { value } });
  });
  act(() => {
    fireEvent.keyDown(el, { key });
  });
};

const head = (session: PlanSession, o: { readOnly: boolean; naming: boolean; onNamed(): void }) => (
  <OpenChoice.Provider value={vi.fn()}>
    <PlanHead session={session} local="Mac" readOnly={o.readOnly} naming={o.naming} onNamed={o.onNamed} onChoose={vi.fn()} />
  </OpenChoice.Provider>
);

describe("the plan name in the heading", () => {
  it("renames the plan with one undoable planName, and one undo restores it", async () => {
    const t = await made();
    await shown(t);
    const apply = vi.spyOn(t.session, "apply");
    expect(field().value).toBe("Plan");
    type(field(), "  Launch  ", "Enter");
    expect(apply.mock.calls).toEqual([[{ t: "planName", name: "Launch" }]]);
    expect([t.session.view().plan.name, field().value, document.activeElement === field()]).toEqual(["Launch", "Launch", false]);
    act(() => {
      t.session.undo();
    });
    expect([t.session.view().plan.name, field().value]).toEqual(["Plan", "Plan"]);
  });

  it("restores the name on Escape and changes nothing", async () => {
    const t = await made();
    await shown(t);
    const apply = vi.spyOn(t.session, "apply");
    type(field(), "Draft", "Escape");
    expect(apply).not.toHaveBeenCalled();
    expect([t.session.view().plan.name, field().value]).toEqual(["Plan", "Plan"]);
  });

  it("shows the name as text with no field when the plan is read-only", async () => {
    const t = await made();
    await shown(t);
    act(() => t.session.setReadOnly(true));
    const h1 = document.querySelector(".plan-head h1");
    if (!(h1 instanceof HTMLElement)) throw new Error("no heading");
    expect([h1.querySelector("input"), h1.textContent, within(h1).getByLabelText("Plan name").tagName]).toEqual([null, "Plan", "SPAN"]);
  });

  it("is the only place the plan name is shown or edited: no toolbar copy, no field in the plan panel", async () => {
    const t = await made();
    await shown(t);
    expect(document.querySelector(".toolbar-plan")).toBeNull();
    const panel = document.querySelector(".slot-panel .panel");
    if (!(panel instanceof HTMLElement)) throw new Error("no plan panel");
    expect(panel.querySelector("h2")?.textContent).toBe("Plan");
    expect(within(panel).queryByLabelText("Plan name")).toBeNull();
    expect(document.querySelectorAll('[aria-label="Plan name"]')).toHaveLength(1);
  });

  it("focuses and selects the field when asked to name the plan, and says it did", async () => {
    const t = await made();
    const onNamed = vi.fn();
    render(head(t.session, { readOnly: false, naming: true, onNamed }));
    expect([document.activeElement === field(), field().selectionStart, field().selectionEnd, onNamed.mock.calls.length]).toEqual([true, 0, "Plan".length, 1]);
  });

  it("only clears the naming signal on a read-only plan", async () => {
    const t = await made();
    act(() => t.session.setReadOnly(true));
    const onNamed = vi.fn();
    render(head(t.session, { readOnly: true, naming: true, onNamed }));
    expect([onNamed.mock.calls.length, document.activeElement]).toEqual([1, document.body]);
  });
});
