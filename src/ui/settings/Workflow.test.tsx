import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusal } from "../../actions/copy";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { stepModeOf, stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { IPAD, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { resetTauri, tauri } from "../../test/tauriMock";
import { toast } from "../common/Toast";
import { OpenChoice } from "../run";
import { Workflow, type WorkflowForm } from "./Workflow";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
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

const mount = (session: PlanSession, readOnly = false, form: WorkflowForm = { kind: "table" }): HTMLElement => {
  const view = render(
    <OpenChoice.Provider value={vi.fn()}>
      <div className="host">
        <Workflow session={session} readOnly={readOnly} form={form} />
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

const row = (step: string): HTMLElement => one(`li.workflow-row[data-step="${step}"]`);
const rowIds = (root: HTMLElement): (string | undefined)[] => [...root.querySelectorAll<HTMLElement>("li.workflow-row")].map((r) => r.dataset.step);

const stepId = (t: TestSession, name: string): string => {
  const found = stepsOf(t.session.view().plan).find((s) => s.name === name);
  if (found === undefined) throw new Error("no step " + name);
  return found.id;
};

const commit = (el: HTMLInputElement, value: string): void => {
  act(() => {
    el.focus();
  });
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: "Enter" });
};

describe("Settings > Workflow", () => {
  it("lists every step with its swatch, name, count, limit, Completes radio and Delete…", async () => {
    const t = await made();
    const root = mount(t.session);
    expect(rowIds(root)).toEqual(["now", "next", "later", "done"]);
    expect([one(".workflow-head", root).getAttribute("aria-hidden"), [...root.querySelectorAll(".workflow-head span")].map((s) => s.textContent)]).toEqual(["true", ["", "", "Name", "Items", "Limit", "Completes", ""]]);
    const shape = ["now", "next", "later", "done"].map((id) => {
      const r = row(id);
      return [
        one("button.workflow-grip", r).getAttribute("aria-label"),
        one("button.workflow-swatch", r).getAttribute("aria-label"),
        r.style.getPropertyValue("--step"),
        input("input.workflow-name", r).value,
        input("input.workflow-name", r).getAttribute("aria-label"),
        one(".workflow-count", r).textContent,
        input("input.workflow-limit", r).value,
        input("input.workflow-limit", r).placeholder,
        one("button.workflow-completes", r).getAttribute("aria-checked"),
        within(r).getByRole("button", { name: "Delete…" }).className,
      ];
    });
    expect(shape).toEqual([
      ["Reorder Now", "Colour · Now", "var(--s-cyan)", "Now", "Name of Now", "1 item", "", "None", "false", "workflow-delete"],
      ["Reorder Next", "Colour · Next", "var(--s-violet)", "Next", "Name of Next", "2 items", "", "None", "false", "workflow-delete"],
      ["Reorder Later", "Colour · Later", "var(--s-slate)", "Later", "Name of Later", "1 item", "", "None", "false", "workflow-delete"],
      ["Reorder Done", "Colour · Done", "var(--s-lime)", "Done", "Name of Done", "1 item", "", "None", "true", "workflow-delete"],
    ]);
    expect([one("button.workflow-none", root).textContent, one("button.workflow-none", root).getAttribute("aria-checked"), one("button.workflow-add", root).textContent]).toEqual([
      "No step completes items",
      "false",
      "+ Add step",
    ]);
    expect([one("[data-by-dates]", root).textContent, one(".workflow-new", root).textContent, root.querySelectorAll(".board-problem").length]).toEqual([
      "Columns follow dates. Edit a step or drag a card to use your own steps.",
      "New undated items go to “Later” until this plan uses steps.",
      0,
    ]);
  });

  it("renames a step, which switches a by-dates plan; a taken name toasts and the field goes back", async () => {
    const t = await made();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    commit(input("input.workflow-name", row("next")), "Review");
    expect([apply.mock.calls, stepModeOf(t.session.view().plan)]).toEqual([[[{ t: "step", op: "rename", step: "next", name: "Review" }]], "steps"]);
    expect([input("input.workflow-name", row("next")).value, root.querySelector("[data-by-dates]"), one(".workflow-new", root).textContent]).toEqual([
      "Review",
      null,
      "New undated items go to “Now”, the first step that does not complete items.",
    ]);
    commit(input("input.workflow-name", row("later")), "now");
    expect([last(vi.mocked(toast).mock.calls), input("input.workflow-name", row("later")).value, stepsOf(t.session.view().plan).map((s) => s.name)]).toEqual([
      [refusal.stepNameTaken("Now"), "bad"],
      "Later",
      ["Now", "Review", "Later", "Done"],
    ]);
  });

  it("picks the step for new undated items in the New items row once the plan uses steps, and only names Later by dates", async () => {
    const t = await made();
    const root = mount(t.session);
    const newItems = (): HTMLElement => one('[data-settings-row="workflow.new-items"]', root);
    expect([newItems().querySelector("button.defaults-pick"), one(".workflow-new", newItems()).textContent]).toEqual([null, "New undated items go to “Later” until this plan uses steps."]);
    act(() => {
      t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
    });
    const picker = one('button.defaults-pick[data-pick="step"]', newItems());
    expect([picker.textContent, one(".workflow-new", newItems()).textContent]).toEqual(["First open step", "New undated items go to “Now”, the first step that does not complete items."]);
    act(() => {
      fireEvent.click(picker);
    });
    expect([...document.querySelectorAll('.context-menu [role^="menuitem"]')].map((e) => [e.textContent, e.getAttribute("aria-checked")])).toEqual([
      ["First open step", "true"],
      ["Now", "false"],
      ["Review", "false"],
      ["Later", "false"],
    ]);
    const apply = vi.spyOn(t.session, "apply");
    const review = [...document.querySelectorAll<HTMLElement>('.context-menu [role^="menuitem"]')].find((e) => e.textContent === "Review");
    if (review === undefined) throw new Error("no Review row");
    act(() => {
      fireEvent.click(review);
    });
    expect([apply.mock.calls, one('button.defaults-pick[data-pick="step"]', newItems()).textContent, one(".workflow-new", newItems()).textContent]).toEqual([
      [[{ t: "defaults", field: "step", value: "next" }]],
      "Review",
      "New undated items go to “Review”.",
    ]);
  });

  it("sets and clears a limit, shows the count over it in amber, and refuses a bad one", async () => {
    const t = await made();
    mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    commit(input("input.workflow-limit", row("next")), "1");
    const count = one(".workflow-count", row("next"));
    expect([apply.mock.calls, input("input.workflow-limit", row("next")).value, count.className, count.title]).toEqual([
      [[{ t: "step", op: "limit", step: "next", limit: 1 }]],
      "1",
      "workflow-count over",
      "Over the limit of 1",
    ]);
    commit(input("input.workflow-limit", row("next")), "12x");
    expect([last(vi.mocked(toast).mock.calls), input("input.workflow-limit", row("next")).value, apply.mock.calls.length]).toEqual([[refusal.stepLimit, "bad"], "1", 2]);
    commit(input("input.workflow-limit", row("next")), "");
    expect([last(apply.mock.calls), one(".workflow-count", row("next")).className, input("input.workflow-limit", row("next")).value]).toEqual([
      [{ t: "step", op: "limit", step: "next", limit: null }],
      "workflow-count",
      "",
    ]);
  });

  it("moves Completes with the radios, and toasts when a step still holds open items", async () => {
    const t = await made();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.workflow-completes", row("done")));
    expect(apply.mock.calls).toEqual([]);
    fireEvent.click(one("button.workflow-none", root));
    expect([apply.mock.calls, one("button.workflow-none", root).getAttribute("aria-checked"), one("button.workflow-completes", row("done")).getAttribute("aria-checked")]).toEqual([
      [[{ t: "step", op: "noneCompletes" }]],
      "true",
      "false",
    ]);
    fireEvent.click(one("button.workflow-none", root));
    expect(apply.mock.calls.length).toBe(1);
    fireEvent.click(one("button.workflow-completes", row("next")));
    expect([last(apply.mock.calls), last(vi.mocked(toast).mock.calls), one("button.workflow-completes", row("next")).getAttribute("aria-checked")]).toEqual([
      [{ t: "step", op: "completes", step: "next", completes: true }],
      [refusal.stepHoldsOpen("Next", 2), "bad"],
      "false",
    ]);
    fireEvent.click(one("button.workflow-completes", row("done")));
    expect([last(apply.mock.calls), one("button.workflow-completes", row("done")).getAttribute("aria-checked"), one("button.workflow-none", root).getAttribute("aria-checked")]).toEqual([
      [{ t: "step", op: "completes", step: "done", completes: true }],
      "true",
      "false",
    ]);
  });

  it("adds a step after the last one in the first unused colour and focuses its name", async () => {
    const t = await made();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.workflow-add", root));
    const id = stepId(t, "New step");
    expect([apply.mock.calls, rowIds(root)]).toEqual([[[{ t: "step", op: "add", name: "New step", colour: "magenta", after: "done" }]], ["now", "next", "later", "done", id]]);
    expect([document.activeElement, one(".workflow-count", row(id)).textContent]).toEqual([input("input.workflow-name", row(id)), "0 items"]);
    fireEvent.click(one("button.workflow-add", root));
    expect(last(apply.mock.calls)).toEqual([{ t: "step", op: "add", name: "New step 2", colour: "amber", after: id }]);
  });

  it("recolours a step through the colour popover, which has its close control", async () => {
    const t = await made();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.workflow-swatch", row("now")));
    const pop = within(root).getByRole("dialog", { name: "Colour · Now" });
    expect([within(pop).getAllByRole("radio").length, within(pop).getByRole("radio", { name: "Cyan" }).getAttribute("aria-checked"), within(pop).getByRole("button", { name: "Close" }) !== null]).toEqual([
      8,
      "true",
      true,
    ]);
    fireEvent.click(within(pop).getByRole("radio", { name: "Amber" }));
    expect([apply.mock.calls, within(root).queryByRole("dialog"), row("now").style.getPropertyValue("--step")]).toEqual([
      [[{ t: "step", op: "colour", step: "now", colour: "amber" }]],
      null,
      "var(--s-amber)",
    ]);
    fireEvent.click(one("button.workflow-swatch", row("now")));
    const again = within(root).getByRole("dialog", { name: "Colour · Now" });
    const esc = fireEvent.keyDown(within(again).getByRole("radio", { name: "Amber" }), { key: "Escape" });
    expect([esc, within(root).queryByRole("dialog"), apply.mock.calls.length]).toEqual([false, null, 1]);
  });

  it("deletes through DeleteStep: a step with items asks where they go, an empty one asks to confirm, the last open one toasts", async () => {
    const t = await made();
    const root = mount(t.session);
    fireEvent.click(within(row("later")).getByRole("button", { name: "Delete…" }));
    const move = within(root).getByRole("dialog", { name: "Move 2 items from Later to…" });
    expect(move.querySelector(".delete-step-hidden")?.textContent).toBe("1 of them is done or in the Trash.");
    fireEvent.click(within(move).getByRole("button", { name: "Cancel" }));
    expect(within(root).queryByRole("dialog")).toBeNull();
    fireEvent.click(one("button.workflow-add", root));
    const id = stepId(t, "New step");
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(row(id)).getByRole("button", { name: "Delete…" }));
    const ask = within(root).getByRole("dialog", { name: "Delete step" });
    expect(ask.querySelector(".delete-step-text")?.textContent).toBe("Delete the step “New step”? It holds no items.");
    fireEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    expect([apply.mock.calls, rowIds(root)]).toEqual([[[{ t: "step", op: "delete", step: id, to: null }]], ["now", "next", "later", "done"]]);
    const only = await made([{ name: "a", horizon: "now" }]);
    act(() => {
      only.session.apply({ t: "step", op: "delete", step: "next", to: null });
      only.session.apply({ t: "step", op: "delete", step: "later", to: null });
    });
    cleanup();
    mount(only.session);
    fireEvent.click(within(row("now")).getByRole("button", { name: "Delete…" }));
    expect([last(vi.mocked(toast).mock.calls), document.querySelector('[role="dialog"]')]).toEqual([[refusal.lastOpenStep, "bad"], null]);
  });

  it("reorders with ⌥↑ and ⌥↓ on the grip, which keeps focus, and not past either end", async () => {
    const t = await made();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    const grip = (id: string): HTMLElement => one("button.workflow-grip", row(id));
    act(() => {
      grip("now").focus();
    });
    fireEvent.keyDown(grip("now"), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(grip("now"), { key: "ArrowDown" });
    expect(apply.mock.calls).toEqual([]);
    fireEvent.keyDown(grip("now"), { key: "ArrowDown", altKey: true });
    expect([apply.mock.calls, rowIds(root), document.activeElement]).toEqual([[[{ t: "step", op: "reorder", step: "now", after: "next" }]], ["next", "now", "later", "done"], grip("now")]);
    fireEvent.keyDown(grip("later"), { key: "ArrowUp", altKey: true });
    expect([last(apply.mock.calls), rowIds(root)]).toEqual([[{ t: "step", op: "reorder", step: "later", after: "next" }], ["next", "later", "now", "done"]]);
    fireEvent.keyDown(grip("next"), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(grip("done"), { key: "ArrowDown", altKey: true });
    expect(apply.mock.calls.length).toBe(2);
  });

  it("reorders by dragging a grip at once onto another row", async () => {
    const t = await made();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    const drag = (from: string, onto: string): void => {
      const target = row(onto);
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
      try {
        fireEvent.pointerDown(one("button.workflow-grip", row(from)), { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
        expect(row(from).classList.contains("dragging")).toBe(true);
        fireEvent.pointerMove(document, { clientX: 5, clientY: 80, pointerId: 1 });
        expect(target.classList.contains("drop-over")).toBe(from !== onto);
        fireEvent.pointerUp(document, { clientX: 5, clientY: 80, pointerId: 1 });
      } finally {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    };
    drag("done", "now");
    expect([apply.mock.calls, rowIds(root), root.querySelectorAll(".drop-over, .dragging").length]).toEqual([[[{ t: "step", op: "reorder", step: "done", after: null }]], ["done", "now", "next", "later"], 0]);
    drag("now", "later");
    expect([last(apply.mock.calls), rowIds(root)]).toEqual([[{ t: "step", op: "reorder", step: "now", after: "later" }], ["done", "next", "later", "now"]]);
    drag("next", "next");
    expect(apply.mock.calls.length).toBe(2);
  });

  it("shows each step problem in amber, and No step completes items clears every completing step", async () => {
    const t = await made();
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "Shipped", colour: "sky", after: "done" });
    });
    const shipped = stepId(t, "Shipped");
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "Archived", colour: "coral", after: shipped });
      t.session.apply({ t: "step", op: "completes", step: "done", completes: false });
    });
    const archived = stepId(t, "Archived");
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    act(() => {
      t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
      t.session.apply({ t: "step", op: "completes", step: shipped, completes: true });
      peer.session.apply({ t: "step", op: "rename", step: "later", name: "Review" });
      peer.session.apply({ t: "step", op: "completes", step: archived, completes: true });
    });
    act(() => {
      peer.sync();
    });
    const root = mount(t.session);
    expect([...root.querySelectorAll(".board-problem")].map((p) => p.textContent)).toEqual([
      "Several steps complete items: “Shipped”, “Archived”. Only “Shipped” does; clear Completes items on the others.",
      "More than one step is named “Review”. Rename one.",
    ]);
    expect([row(shipped), row(archived)].map((r) => one("button.workflow-completes", r).getAttribute("aria-checked"))).toEqual(["true", "true"]);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.workflow-none", root));
    expect([apply.mock.calls, root.querySelectorAll(".board-problem").length, one("button.workflow-none", root).getAttribute("aria-checked")]).toEqual([
      [[{ t: "step", op: "noneCompletes" }]],
      1,
      "true",
    ]);
    act(() => {
      t.session.undo();
    });
    expect([row(shipped), row(archived)].map((r) => one("button.workflow-completes", r).getAttribute("aria-checked"))).toEqual(["true", "true"]);
  });

  it("disables every control when the plan is read-only", async () => {
    const t = await made();
    const root = mount(t.session, true);
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")];
    expect([controls.length, controls.filter((c) => !c.disabled).map((c) => c.className)]).toEqual([4 * 6 + 2, []]);
    expect([input("input.workflow-name", row("now")).value, input("input.workflow-limit", row("now")).placeholder]).toEqual(["Now", "None"]);
  });

  it("refuses limit text that is not one or two digits", async () => {
    const t = await made();
    mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    ["0x10", "1e1", "+5", "5."].forEach((typed) => commit(input("input.workflow-limit", row("next")), typed));
    expect(apply.mock.calls.map((c) => c[0])).toEqual(["0x10", "1e1", "+5", "5."].map(() => ({ t: "step", op: "limit", step: "next", limit: Number.NaN })));
    expect(vi.mocked(toast).mock.calls).toEqual(["0x10", "1e1", "+5", "5."].map(() => [refusal.stepLimit, "bad"]));
    expect(stepsOf(t.session.view().plan).find((s) => s.id === "next")?.limit).toBeNull();
  });

  it("closes the colour popover with a toast when its step is deleted elsewhere", async () => {
    const t = await made();
    const root = mount(t.session);
    fireEvent.click(one("button.workflow-swatch", row("next")));
    expect(within(root).getByRole("dialog", { name: "Colour · Next" })).not.toBeNull();
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: "next", to: "now" });
    });
    expect([within(root).queryByRole("dialog"), last(vi.mocked(toast).mock.calls)]).toEqual([null, [STALE_CONFIRM, "bad"]]);
    act(() => {
      t.session.undo();
    });
    expect(within(root).queryByRole("dialog")).toBeNull();
  });

  it("groups the Completes radios with No step completes items: one tab stop, arrow keys move, nothing is written", async () => {
    const t = await made();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    const group = within(root).getByRole("radiogroup", { name: "Step that completes items" });
    const radios = [...["now", "next", "later", "done"].map((id) => one("button.workflow-completes", row(id))), one("button.workflow-none", root)];
    expect(group.getAttribute("aria-owns")).toBe(radios.map((r) => r.id).join(" "));
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
    act(() => {
      radios[3].focus();
    });
    fireEvent.keyDown(radios[3], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[4]);
    fireEvent.keyDown(radios[4], { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(radios[4]);
    fireEvent.keyDown(radios[4], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios[3]);
    expect(apply).not.toHaveBeenCalled();
  });
});

type OnOpen = (id: string, select: boolean) => void;

const listed = (t: TestSession, editing: boolean, readOnly = false): { root: HTMLElement; onOpen: ReturnType<typeof vi.fn<OnOpen>> } => {
  const onOpen = vi.fn<OnOpen>();
  const root = mount(t.session, readOnly, { kind: "list", editing, onOpen });
  return { root, onOpen };
};

const iosRow = (id: string): HTMLElement => one(`ul.ios-list[data-list="workflow"] > li.ios-row[data-step="${id}"]`);

const iosIds = (root: HTMLElement): (string | undefined)[] => [...root.querySelectorAll<HTMLElement>("ul.ios-list > li.ios-row[data-step]")].map((r) => r.dataset.step);

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

describe("Settings > Workflow in the list form", () => {
  it("lists each step with its swatch, name, completes flag, count and a chevron; a tap opens the step", async () => {
    const t = await made();
    const { root, onOpen } = listed(t, false);
    expect(iosIds(root)).toEqual(["now", "next", "later", "done"]);
    const shape = ["now", "next", "later", "done"].map((id) => {
      const r = iosRow(id);
      const main = one("button.ios-row-main", r);
      return [
        r.style.getPropertyValue("--step"),
        main.hasAttribute("disabled"),
        main.querySelectorAll("span.swatch").length,
        one("span.ios-row-name", main).textContent,
        main.querySelector("span.ios-flag")?.textContent ?? null,
        one("span.ios-row-count", main).textContent,
        one("span.ios-row-count", main).className,
        one("span.settings-chev", main).getAttribute("aria-hidden"),
        r.querySelector("button.ios-minus"),
        r.querySelector("button.ios-grip"),
      ];
    });
    expect(shape).toEqual([
      ["var(--s-cyan)", false, 1, "Now", null, "1", "ios-row-count", "true", null, null],
      ["var(--s-violet)", false, 1, "Next", null, "2", "ios-row-count", "true", null, null],
      ["var(--s-slate)", false, 1, "Later", null, "1", "ios-row-count", "true", null, null],
      ["var(--s-lime)", false, 1, "Done", "completes", "1", "ios-row-count", "true", null, null],
    ]);
    const add = one("ul.ios-list > li:last-child button.ios-add", root);
    expect([
      add.textContent,
      one("span.ios-plus", add).getAttribute("aria-hidden"),
      add.closest("li")?.getAttribute("data-settings-row"),
      one('[data-settings-row="workflow.steps"] ul.ios-list', root) !== null,
      one("p.settings-foot", root).textContent,
      one(".workflow-line[role=status] [data-by-dates]", root).textContent,
      one('[data-settings-row="workflow.new-items"] .workflow-new', root).textContent,
      root.querySelector(".workflow-head, li.workflow-row, .workflow-radios, .workflow-add, input"),
    ]).toEqual([
      "+Add step",
      "true",
      "workflow.add",
      true,
      "Tap Edit to reorder or delete steps.",
      "Columns follow dates. Edit a step or drag a card to use your own steps.",
      "New undated items go to “Later” until this plan uses steps.",
      null,
    ]);
    fireEvent.click(one("button.ios-row-main", iosRow("next")));
    expect(onOpen.mock.calls).toEqual([["next", false]]);
  });

  it("shows the count against a limit, amber with its title once over", async () => {
    const t = await made();
    act(() => {
      t.session.apply({ t: "step", op: "limit", step: "next", limit: 1 });
      t.session.apply({ t: "step", op: "limit", step: "now", limit: 3 });
    });
    listed(t, false);
    const count = (id: string): HTMLElement => one("span.ios-row-count", iosRow(id));
    expect([count("next").textContent, count("next").className, count("next").title, count("now").textContent, count("now").className, count("now").hasAttribute("title")]).toEqual([
      "2/1",
      "ios-row-count over",
      "Over the limit of 1",
      "1/3",
      "ios-row-count",
      false,
    ]);
  });

  it("in Edit shows a red minus and a grip on each row, disables the row, drops the chevron and keeps Add", async () => {
    const t = await made();
    const { root, onOpen } = listed(t, true);
    const r = iosRow("now");
    expect([
      [...r.children].map((c) => c.className),
      one("button.ios-minus", r).getAttribute("aria-label"),
      one("button.ios-minus", iosRow("done")).hasAttribute("disabled"),
      one("button.ios-grip", r).getAttribute("aria-label"),
      one("button.ios-row-main", r).hasAttribute("disabled"),
      r.querySelector(".settings-chev"),
      one("button.ios-add", root).hasAttribute("disabled"),
      one("p.settings-foot", root).textContent,
    ]).toEqual([["ios-minus", "ios-row-main", "ios-grip"], "Delete Now", false, "Reorder Now", true, null, false, "Drag a handle to reorder, tap the red minus to delete. Tap Done when finished."]);
    fireEvent.click(one("button.ios-row-main", r));
    expect(onOpen.mock.calls).toEqual([]);
  });

  it("asks before a minus deletes a step: items ask where they go, an empty step asks to confirm, the last open step toasts", async () => {
    const t = await made();
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "Spare", colour: "sky", after: "done" });
    });
    const spare = stepId(t, "Spare");
    const { root } = listed(t, true);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.ios-minus", iosRow("later")));
    const move = within(root).getByRole("dialog", { name: "Move 2 items from Later to…" });
    fireEvent.click(within(move).getByRole("button", { name: "Cancel" }));
    expect([apply.mock.calls, within(root).queryByRole("dialog")]).toEqual([[], null]);
    fireEvent.click(one("button.ios-minus", iosRow(spare)));
    const ask = within(root).getByRole("dialog", { name: "Delete step" });
    expect(one(".delete-step-text", ask).textContent).toBe("Delete the step “Spare”? It holds no items.");
    fireEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    expect([apply.mock.calls, iosIds(root)]).toEqual([[[{ t: "step", op: "delete", step: spare, to: null }]], ["now", "next", "later", "done"]]);
    const only = await made([{ name: "a", horizon: "now" }]);
    act(() => {
      only.session.apply({ t: "step", op: "delete", step: "next", to: null });
      only.session.apply({ t: "step", op: "delete", step: "later", to: null });
    });
    cleanup();
    listed(only, true);
    fireEvent.click(one("button.ios-minus", iosRow("now")));
    expect([last(vi.mocked(toast).mock.calls), document.querySelector('[role="dialog"]')]).toEqual([[refusal.lastOpenStep, "bad"], null]);
  });

  it("reorders by dragging a grip onto another row and with ⌥↓ on the grip", async () => {
    const t = await made();
    const { root } = listed(t, true);
    const apply = vi.spyOn(t.session, "apply");
    const grip = (id: string): HTMLElement => one("button.ios-grip", iosRow(id));
    const target = one("span.ios-row-name", iosRow("now"));
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    try {
      fireEvent.pointerDown(grip("done"), { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
      expect(iosRow("done").classList.contains("dragging")).toBe(true);
      fireEvent.pointerMove(document, { clientX: 5, clientY: 80, pointerId: 1 });
      expect(iosRow("now").classList.contains("drop-over")).toBe(true);
      fireEvent.pointerUp(document, { clientX: 5, clientY: 80, pointerId: 1 });
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
    expect([apply.mock.calls, iosIds(root), root.querySelectorAll(".drop-over, .dragging").length]).toEqual([[[{ t: "step", op: "reorder", step: "done", after: null }]], ["done", "now", "next", "later"], 0]);
    act(() => {
      grip("done").focus();
    });
    fireEvent.keyDown(grip("done"), { key: "ArrowDown", altKey: true });
    expect([last(apply.mock.calls), iosIds(root), document.activeElement]).toEqual([[{ t: "step", op: "reorder", step: "done", after: "now" }], ["now", "done", "next", "later"], grip("done")]);
  });

  it("adds a step after the last one and opens it with the name selected", async () => {
    const t = await made();
    const { root, onOpen } = listed(t, false);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.ios-add", root));
    const id = stepId(t, "New step");
    expect([apply.mock.calls, onOpen.mock.calls, iosIds(root), one("span.ios-row-count", iosRow(id)).textContent]).toEqual([
      [[{ t: "step", op: "add", name: "New step", colour: "magenta", after: "done" }]],
      [[id, true]],
      ["now", "next", "later", "done", id],
      "0",
    ]);
  });

  it("disables Add when the plan is read-only and still opens a step to read", async () => {
    const t = await made();
    const { root, onOpen } = listed(t, false, true);
    expect([one("button.ios-add", root).hasAttribute("disabled"), root.querySelectorAll("button.ios-minus, button.ios-grip").length]).toEqual([true, 0]);
    fireEvent.click(one("button.ios-row-main", iosRow("later")));
    expect(onOpen.mock.calls).toEqual([["later", false]]);
  });

  it("shows no Edit controls when read-only even if Edit was on", async () => {
    const t = await made();
    const { root } = listed(t, true, true);
    expect([root.querySelectorAll("button.ios-minus, button.ios-grip").length, one("button.ios-row-main", iosRow("now")).hasAttribute("disabled"), one("p.settings-foot", root).textContent]).toEqual([
      0,
      false,
      "Tap Edit to reorder or delete steps.",
    ]);
  });
});

describe("Settings > Workflow in the list form on iPad", () => {
  it("asks a minus delete of an empty step through the native alert", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const t = await made();
      act(() => {
        t.session.apply({ t: "step", op: "add", name: "Spare", colour: "sky", after: "done" });
      });
      const spare = stepId(t, "Spare");
      const { root } = listed(t, true);
      tauri.answers.alert_ask = () => "confirm";
      fireEvent.click(one("button.ios-minus", iosRow(spare)));
      await settle();
      expect([tauri.calls.filter((c) => c.cmd === "alert_ask").length, within(root).queryByRole("dialog"), iosIds(root)]).toEqual([1, null, ["now", "next", "later", "done"]]);
    } finally {
      unstub();
    }
  });
});
