import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Built } from "../../actions/intents";
import { fixedClock } from "../../services/clock";
import { Registry } from "../../store/registry";
import type { UpdateState, Updates } from "../../store/updates";
import type { PlanSession } from "../../store/session";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { seededStore, shellFor } from "../../test/shell";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { useUi } from "../state";
import { Shell } from "./Shell";
import { UpdatesContext } from "./UpdateLine";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const sessions: PlanSession[] = [];
const registries: Registry[] = [];

beforeEach(() => {
  window.localStorage.clear();
  setScreen(820, 1180);
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(registries.splice(0).map((r) => r.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const made = async (): Promise<TestSession> => {
  const t = await testSession([...MESA_SEED, { id: "T", name: "T" }]);
  sessions.push(t.session);
  return t;
};

const lastUi = () => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value;
};

const toolbar = (): HTMLElement => {
  const bar = document.querySelector("header.toolbar");
  if (!(bar instanceof HTMLElement)) throw new Error("no toolbar");
  return bar;
};

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const plans = (): HTMLElement | null => screen.queryByRole("navigation", { name: "Plans" });

const shown = async (t: TestSession): Promise<void> => {
  render(withSync(shellFor(t).ui));
  await settle();
};

const planSheet = (): HTMLElement => {
  const all = screen.getAllByRole("dialog");
  expect(all.map((d) => d.getAttribute("aria-label"))).toEqual(["Plan"]);
  return all[0];
};

describe('compact shell, data-form="compact"', () => {
  it("keeps the sidebar and the panel out of the layout", async () => {
    const t = await made();
    await shown(t);
    expect(document.documentElement.dataset.form).toBe("compact");
    expect(plans()).toBeNull();
    expect(document.querySelector('[data-slot="panel"]')).toBeNull();
    expect(document.querySelectorAll(".tl-scroll")).toHaveLength(1);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plans" }));
    const sheet = screen.getByRole("dialog", { name: "Plans" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(within(sheet).getByRole("navigation", { name: "Plans" })).toBeTruthy();
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(plans()).toBeNull();
  });

  it("opens the selected item in a modal sheet, and Esc returns focus to the opener", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(within(toolbar()).getByRole("tab", { name: "List" }));
    const row = document.querySelector('[data-lrow="t3"]');
    if (!(row instanceof HTMLElement)) throw new Error("no t3 row");
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    const sheet = screen.getByRole("dialog", { name: "Tracking: review results" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.querySelector(".panel .kind")?.textContent).toBe("TASK");
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lastUi()[0].selected).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("Duplicate in the item sheet keeps focus in the sheet, and the shortcuts behind it stay off", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(within(toolbar()).getByRole("tab", { name: "List" }));
    const row = document.querySelector('[data-lrow="t3"]');
    if (!(row instanceof HTMLElement)) throw new Error("no t3 row");
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    const count = t.session.view().plan.items.size;
    const duplicate = within(screen.getByRole("dialog")).getByRole("button", { name: "Duplicate" });
    duplicate.focus();
    fireEvent.click(duplicate);
    await settle();
    const copy = lastUi()[0].selected;
    if (copy === null || copy === "t3") throw new Error("the copy is not selected");
    expect(t.session.view().plan.items.size).toBe(count + 1);
    const sheet = screen.getByRole("dialog");
    expect(sheet.contains(document.activeElement)).toBe(true);
    const before = t.session.view().plan.items.get(copy);
    [{ key: "ArrowLeft" }, { key: "Backspace" }, { key: "n" }].forEach((k) =>
      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, k);
      }),
    );
    act(() => {
      fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    });
    await settle();
    expect(t.session.view().plan.items.get(copy)).toEqual(before);
    expect(t.session.view().plan.items.size).toBe(count + 1);
    expect(lastUi()[0].selected).toBe(copy);
  });

  it("New task from + New names the new item in its sheet; Esc leaves the name, a second Esc closes the sheet and returns focus to + New", async () => {
    const t = await made();
    await shown(t);
    const add = within(toolbar()).getByRole("button", { name: "+ New" });
    add.focus();
    fireEvent.click(add);
    fireEvent.click(within(toolbar()).getByRole("menuitem", { name: "New task" }));
    await settle();
    const sheet = screen.getByRole("dialog");
    const input = sheet.querySelector(".title-input");
    if (!(input instanceof HTMLInputElement)) throw new Error("no title input in the sheet");
    expect(document.activeElement).toBe(input);
    expect(input.value.length).toBeGreaterThan(0);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    fireEvent.keyDown(input, { key: "Escape" });
    expect([screen.queryByRole("dialog"), document.activeElement]).toEqual([sheet, sheet]);
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(add);
  });

  it("drops an open sheet when the window leaves compact", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plan" }));
    expect(planSheet()).toBeTruthy();
    act(() => setScreen(1440, 900));
    expect(document.documentElement.dataset.form).toBe("full");
    act(() => setScreen(820, 1180));
    expect(document.documentElement.dataset.form).toBe("compact");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switches the form factor live", async () => {
    const t = await made();
    setScreen(1440, 900);
    await shown(t);
    expect(document.documentElement.dataset.form).toBe("full");
    expect(plans()).not.toBeNull();
    act(() => setScreen(820, 1180));
    expect(document.documentElement.dataset.form).toBe("compact");
    expect(plans()).toBeNull();
    expect(within(toolbar()).getByRole("button", { name: "Plans" })).toBeTruthy();
    act(() => setScreen(390, 844));
    await settle();
    expect(document.documentElement.dataset.form).toBe("phone");
    expect(document.querySelector(".app.phone")).not.toBeNull();
    expect(document.querySelector("header.toolbar")).toBeNull();
    act(() => setScreen(1440, 900));
    await settle();
    expect(document.documentElement.dataset.form).toBe("full");
    expect(document.querySelector(".app.phone")).toBeNull();
    expect(plans()).not.toBeNull();
    expect(within(toolbar()).queryByRole("button", { name: "Plans" })).toBeNull();
  });

  it("opens the palette from the toolbar's ⌘K with its input focused", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "⌘K" }));
    expect(lastUi()[0].dialog).toEqual({ t: "palette" });
    const palette = screen.getByRole("dialog");
    expect(document.activeElement instanceof HTMLInputElement && palette.contains(document.activeElement)).toBe(true);
  });

  it("plan sheet", async () => {
    const t = await made();
    t.session.apply({ t: "trash", items: ["T"] });
    t.session.apply({ t: "baseline", op: "save", name: "Before" });
    const moved = t.session.apply({ t: "move", items: ["t3"], days: 1 });
    const apply = vi.spyOn(t.session, "apply");
    const revert = vi.spyOn(t.session, "revert");
    await shown(t);
    expect(within(toolbar()).getByRole("button", { name: "Plan" })).toBeTruthy();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plan" }));
    const sheet = planSheet();
    expect(within(sheet).getAllByRole("heading").map((h) => h.textContent)).toEqual(expect.arrayContaining(["History", "Trash", "Baselines"]));
    expect(within(sheet).getByRole("button", { name: "Change calendar…" })).toBeTruthy();

    const entry = sheet.querySelector(`.history li[data-action="${moved.action.id}"]`);
    if (!(entry instanceof HTMLElement)) throw new Error("no history entry for the move");
    fireEvent.click(within(entry).getByRole("button", { name: "Revert this action" }));
    const dialog = screen.getByRole("dialog", { name: "Revert this action" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(revert.mock.calls).toEqual([[moved.action.id]]);
    const reverted = revert.mock.results[0];
    if (reverted === undefined || reverted.type !== "return") throw new Error("revert did not return");
    const revertBuilt: Built = reverted.value;
    expect(toastTexts()).toEqual([revertBuilt.toast]);
    clearToasts();

    fireEvent.click(within(planSheet()).getByRole("button", { name: "Restore" }));
    expect(apply.mock.calls).toEqual([[{ t: "restore", items: ["T"] }]]);
    const restoreBuilt = apply.mock.results[0];
    if (restoreBuilt === undefined || restoreBuilt.type !== "return") throw new Error("restore did not return");
    expect(toastTexts()).toEqual([restoreBuilt.value.toast]);
    clearToasts();

    const id = [...t.session.view().plan.baselines.keys()][0];
    const name = within(planSheet()).getByRole("textbox", { name: "Baseline name" });
    fireEvent.change(name, { target: { value: "Kickoff" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(apply.mock.calls[1]).toEqual([{ t: "baseline", op: "rename", id, name: "Kickoff" }]);
    expect(apply).toHaveBeenCalledTimes(2);
    const renameBuilt = apply.mock.results[1];
    if (renameBuilt === undefined || renameBuilt.type !== "return") throw new Error("rename did not return");
    expect(toastTexts()).toEqual([renameBuilt.value.toast]);

    fireEvent.keyDown(planSheet(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => lastUi()[1]({ selected: "t3" }));
    expect(screen.getByRole("dialog", { name: "Tracking: review results" })).toBeTruthy();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plan" }));
    expect(within(planSheet()).getByRole("button", { name: "Change calendar…" })).toBeTruthy();
  });

  it("plan sheet read-only", async () => {
    const t = await made();
    t.session.apply({ t: "trash", items: ["T"] });
    t.session.apply({ t: "baseline", op: "save", name: "Before" });
    t.session.apply({ t: "move", items: ["t3"], days: 1 });
    const apply = vi.spyOn(t.session, "apply");
    const revert = vi.spyOn(t.session, "revert");
    await shown(t);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plan" }));
    expect(within(planSheet()).getAllByRole("button", { name: "Revert this action" }).length).toBeGreaterThan(0);
    act(() => t.session.setReadOnly(true));
    const sheet = planSheet();
    expect(sheet.querySelector("input")).toBeNull();
    expect(within(sheet).queryByLabelText("Plan name")).toBeNull();
    const heading = document.querySelector(".plan-head h1");
    if (!(heading instanceof HTMLElement)) throw new Error("no plan heading");
    expect([heading.querySelector("input"), within(heading).getByLabelText("Plan name").textContent]).toEqual([null, "Plan"]);
    ["Save baseline", "Remove", "Restore", "Change calendar…", "Revert this action", "Bring this action back"].forEach((n) =>
      expect([n, within(sheet).queryByRole("button", { name: n })]).toEqual([n, null]),
    );
    expect(within(sheet).getByRole("button", { name: "Show" })).toBeTruthy();
    expect([apply.mock.calls.length, revert.mock.calls.length]).toEqual([0, 0]);
  });

  it("compact empty state", async () => {
    const s = await seededStore(["Alpha", "Beta"], { trash: [0, 1] });
    const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
    registries.push(registry);
    const restorePlan = vi.spyOn(registry, "restorePlan");
    render(withSync(<Shell registry={registry} clock={fixedClock("2026-11-09")} />));
    await settle();
    const main = document.querySelector("main.main");
    if (!(main instanceof HTMLElement)) throw new Error("no main");
    ["New plan", "Show an example plan", "Import plan…", "Join with a code", "Set up sync"].forEach((n) => expect(within(main).getByRole("button", { name: n })).toBeTruthy());
    expect(within(toolbar()).getByRole("button", { name: "Local only" })).toBeTruthy();
    expect(within(toolbar()).getByRole("button", { name: "Plans" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plans" }));
    const nav = plans();
    if (nav === null) throw new Error("no Plans navigation");
    const trash = within(nav).getByRole("region", { name: "Trash" });
    expect(within(trash).getByText("Alpha")).toBeTruthy();
    expect(within(trash).getByText("Beta")).toBeTruthy();
    const beta = within(trash).getByText("Beta").closest("li");
    if (beta === null) throw new Error("no Beta entry");
    fireEvent.click(within(beta).getByRole("button", { name: "Restore" }));
    expect(restorePlan.mock.calls).toEqual([[s.ids[1]]]);
    expect(toastTexts()).toEqual(["Restored “Beta” from the Trash."]);
    await settle();
    const after = plans();
    if (after === null) throw new Error("the Plans sheet closed after Restore");
    expect(after.querySelector('[aria-current="page"]')?.textContent).toBe("Beta");
    expect(within(toolbar()).getByRole("button", { name: "Plan" })).toBeTruthy();
  });

  it("Plans → New plan closes the sheet and focuses the new plan's name in the heading", async () => {
    await seededStore(["Alpha"]);
    const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
    registries.push(registry);
    render(withSync(<Shell registry={registry} clock={fixedClock("2026-11-09")} />));
    await settle();
    const opener = within(toolbar()).getByRole("button", { name: "Plans" });
    fireEvent.click(opener);
    const nav = plans();
    if (nav === null) throw new Error("no Plans navigation");
    const box = nav.querySelector(".sidebar-new");
    if (!(box instanceof HTMLElement)) throw new Error("no sidebar New plan");
    fireEvent.click(within(box).getByRole("button"));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    const name = document.querySelector('.plan-head h1 input[aria-label="Plan name"]');
    if (!(name instanceof HTMLInputElement)) throw new Error("no Plan name field in the heading");
    expect([name.value, document.activeElement === name, name.selectionStart, name.selectionEnd]).toEqual(["New plan", true, 0, "New plan".length]);
  });

  it("Plans → a plan closes the sheet and shows that plan", async () => {
    await seededStore(["Alpha", "Beta"]);
    const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
    registries.push(registry);
    render(withSync(<Shell registry={registry} clock={fixedClock("2026-11-09")} />));
    await settle();
    const before = document.querySelector(".plan-head h1 input");
    if (!(before instanceof HTMLInputElement)) throw new Error("no plan open");
    const other = before.value === "Alpha" ? "Beta" : "Alpha";
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plans" }));
    const nav = plans();
    if (nav === null) throw new Error("no Plans navigation");
    fireEvent.click(within(nav).getByRole("button", { name: other }));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    const after = document.querySelector(".plan-head h1 input");
    if (!(after instanceof HTMLInputElement)) throw new Error("no plan open");
    expect(after.value).toBe(other);
  });

  it("shows the update line in the Plans sheet only with an update store", async () => {
    const t = await made();
    const state: UpdateState = { k: "current", at: 0 };
    const updates: Updates = {
      state: () => state,
      subscribe: () => () => undefined,
      start: () => undefined,
      stop: () => undefined,
      check: () => Promise.reject(new Error("compact stub: check not used")),
      install: () => Promise.reject(new Error("compact stub: install not used")),
    };
    render(<UpdatesContext.Provider value={updates}>{withSync(shellFor(t).ui)}</UpdatesContext.Provider>);
    await settle();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plans" }));
    expect(screen.getByRole("dialog", { name: "Plans" }).querySelector(".update-line")).not.toBeNull();
    cleanup();
    render(<UpdatesContext.Provider value={null}>{withSync(shellFor(t).ui)}</UpdatesContext.Provider>);
    await settle();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plans" }));
    expect(screen.getByRole("dialog", { name: "Plans" }).querySelector(".update-line")).toBeNull();
    expect(document.querySelector(".update-line")).toBeNull();
  });
});

describe("the theme sheet on compact", () => {
  it("opens Theme as a sheet from the Plan sheet, closing the Plan sheet, and Close discards a draft", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Plan" }));
    fireEvent.click(within(planSheet()).getByRole("button", { name: "Theme…" }));
    const sheets = screen.getAllByRole("dialog");
    expect(sheets.map((d) => d.getAttribute("aria-label"))).toEqual(["Theme"]);
    expect(sheets[0].getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector('[data-slot="panel"]')).toBeNull();
    const field = within(sheets[0]).getByRole("textbox", { name: "Accent hex" });
    fireEvent.change(field, { target: { value: "#335577" } });
    fireEvent.blur(field);
    fireEvent.click(within(sheets[0]).getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lastUi()[0].theme).toBe(false);
    expect(toastTexts()).toContain("Unsaved colours discarded.");
  });

  it("opens Theme as a sheet from the toolbar's Settings button", async () => {
    const t = await made();
    await shown(t);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Settings" }));
    expect(lastUi()[0].theme).toBe(true);
    const sheets = screen.getAllByRole("dialog");
    expect(sheets.map((d) => d.getAttribute("aria-label"))).toEqual(["Theme"]);
    expect(sheets[0].getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector('[data-slot="panel"]')).toBeNull();
  });

  it("shows the Theme sheet over a selected item's sheet and returns to it on Escape", async () => {
    const t = await made();
    await shown(t);
    act(() => lastUi()[1]({ selected: "t3" }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Tracking: review results"]);
    act(() => lastUi()[1]({ theme: true }));
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Theme"]);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Theme" }), { key: "Escape" });
    expect(lastUi()[0].theme).toBe(false);
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual(["Tracking: review results"]);
  });
});
