import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusal } from "../../actions/copy";
import type { StepColour } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { stepModeOf, stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { IPAD, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { TEST_PLAN, testSession, type SeedItem, type TestSession } from "../../test/session";
import { shellFor } from "../../test/shell";
import { emitFromRust, resetTauri, tauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { clearToasts } from "../common/Toast";
import { STEP_DRAG } from "./Board";
import { deleteRefusal } from "./DeleteStep";
import { boardKey } from "./prefs";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));

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
  setPlatform(MAC);
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const made = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return t;
};

const board = async (t: TestSession): Promise<void> => {
  render(withSync(shellFor(t).ui));
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: "Board" }));
};

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const all = (sel: string, root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

const col = (h: string): HTMLElement => one(`[data-col="${h}"]`);
const card = (id: string): HTMLElement => one(`[data-card="${id}"]`);
const cardsIn = (h: string): (string | undefined)[] => all("[data-card]", col(h)).map((c) => c.dataset.card);
const cols = (): string[] => all(".nnl > *").map((e) => `${e.dataset.col ?? "?"}${e.dataset.strip === undefined ? "" : `:${e.dataset.strip}`}`);
const stored = (): unknown => JSON.parse(window.localStorage.getItem(boardKey(TEST_PLAN)) ?? "null");

const dragTo = (id: string, target: HTMLElement): void => {
  const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
  act(() => {
    fireEvent.dragStart(card(id), { dataTransfer });
  });
  act(() => {
    fireEvent.dragOver(target, { dataTransfer });
  });
  act(() => {
    fireEvent.drop(target, { dataTransfer });
  });
};

const stepId = (t: TestSession, name: string): string => {
  const found = stepsOf(t.session.view().plan).find((s) => s.name === name);
  if (found === undefined) throw new Error("no step " + name);
  return found.id;
};

const CREW: readonly (readonly [string, string, StepColour])[] = [
  ["Mira Okafor", "MO", "violet"],
  ["Ole Berg", "OB", "lime"],
  ["Ana Ruiz", "AR", "coral"],
];

const addPeople = (t: TestSession, crew: readonly (readonly [string, string, StepColour])[]): Record<string, string> => {
  act(() => {
    crew.forEach(([name, initials, colour]) => {
      const known = peopleOf(t.session.view().plan);
      t.session.apply({ t: "person", op: "add", name, initials, colour, after: known.length === 0 ? null : known[known.length - 1].id });
    });
  });
  return Object.fromEntries(peopleOf(t.session.view().plan).map((p) => [p.initials, p.id]));
};

const SEED: SeedItem[] = [
  { name: "soon", start: "2026-11-20", dur: 2 },
  { name: "mid", start: "2026-12-15", dur: 2 },
  { name: "d1", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  { name: "u", horizon: "next" },
  { name: "w" },
];

describe("Board drops", () => {
  it("switches a by-dates plan to steps with one undoable action when a dated card is dropped", async () => {
    const t = await made(SEED);
    await board(t);
    expect(one("[data-by-dates]").textContent).toBe("Columns follow dates. Edit a step or drag a card to use your own steps.");
    const apply = vi.spyOn(t.session, "apply");
    dragTo("soon", col("next"));
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["soon"], step: "next" }]]);
    expect(stepModeOf(t.session.view().plan)).toBe("steps");
    expect(document.querySelector("[data-by-dates]")).toBeNull();
    expect(cardsIn("next")).toEqual(["soon", "mid", "u"]);
    act(() => {
      t.session.undo();
    });
    expect(stepModeOf(t.session.view().plan)).toBe("dates");
    expect(document.querySelector("[data-by-dates]")).not.toBeNull();
    expect(cardsIn("now")).toEqual(["soon"]);
    expect(cardsIn("next")).toEqual(["mid", "u"]);
  });

  it("marks a card done when it is dropped on the Done strip", async () => {
    const t = await made(SEED);
    await board(t);
    const strip = one('[data-strip="done"]');
    expect(strip.dataset.drop).toBe("done");
    const apply = vi.spyOn(t.session, "apply");
    dragTo("w", strip);
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["w"], step: "done" }]]);
    expect(document.querySelector('[data-card="w"]')).toBeNull();
    expect(t.session.view().derived.status.get("w")).toBe("done");
    expect(one('[data-strip="done"] .strip-count').textContent).toBe("2");
  });

  it("moves a card onto a hidden step's strip, and shows the step again on a click", async () => {
    window.localStorage.setItem(boardKey(TEST_PLAN), JSON.stringify({ v: 1, hidden: ["next"], doneOpen: false }));
    const t = await made(SEED);
    await board(t);
    expect(cols()).toEqual(["now", "next:hidden", "later", "done:done"]);
    const strip = one('[data-strip="hidden"]');
    expect(strip.getAttribute("aria-label")).toBe("Next, hidden on this device, 2 items. Show");
    expect(strip.classList.contains("strip-hidden")).toBe(true);
    const apply = vi.spyOn(t.session, "apply");
    dragTo("w", strip);
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["w"], step: "next" }]]);
    expect(one('[data-strip="hidden"] .strip-count').textContent).toBe("3");
    act(() => {
      fireEvent.click(one('[data-strip="hidden"]'));
    });
    expect(cols()).toEqual(["now", "next", "later", "done:done"]);
    expect(cardsIn("next")).toEqual(["mid", "u", "w"]);
    expect(stored()).toEqual({ v: 1, hidden: [], doneOpen: false });
  });

  it("does nothing for a drop on No step", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    const qa = stepId(t, "QA");
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "toStep", items: ["w"], step: qa });
    t.session.apply({ t: "step", op: "delete", step: qa, to: null });
    phone.sync();
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    dragTo("soon", col("no-step"));
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("Board Done strip", () => {
  it("expands on a click into a column of done cards, and Collapse Done folds it back", async () => {
    const t = await made(SEED);
    await board(t);
    act(() => {
      fireEvent.click(one('[data-strip="done"]'));
    });
    expect(stored()).toEqual({ v: 1, hidden: [], doneOpen: true });
    expect(cols()).toEqual(["now", "next", "later", "done"]);
    expect(cardsIn("done")).toEqual(["d1"]);
    expect(one(".col-head h2", col("done")).textContent).toBe("DONE");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse Done" }));
    });
    expect(stored()).toEqual({ v: 1, hidden: [], doneOpen: false });
    expect(cols()).toEqual(["now", "next", "later", "done:done"]);
  });

  it("asks for a drop in an empty open Done", async () => {
    window.localStorage.setItem(boardKey(TEST_PLAN), JSON.stringify({ v: 1, hidden: [], doneOpen: true }));
    const t = await made([{ name: "a", start: "2026-11-20" }]);
    await board(t);
    expect(one(".col-body", col("done")).textContent).toBe("Drop here to mark done.");
  });

  it("lists done items as hidden on the line when no step completes", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "completes", step: "done", completes: false });
    await board(t);
    expect(one("[data-done-hidden]").textContent).toBe("1 done item is hidden.");
    expect(document.querySelector("[data-strip]")).toBeNull();
  });
});

describe("Board headers", () => {
  it("shows the count, and count/limit in amber with a title once it passes the limit", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "limit", step: "next", limit: 2 });
    t.session.apply({ t: "step", op: "limit", step: "later", limit: 3 });
    await board(t);
    const count = (h: string): HTMLElement => one(".col-count", col(h));
    expect(count("now").textContent).toBe("1");
    expect(count("next").textContent).toBe("2/2");
    expect(count("next").classList.contains("over")).toBe(false);
    act(() => {
      t.session.apply({ t: "toStep", items: ["w"], step: "next" });
    });
    expect(count("next").textContent).toBe("3/2");
    expect(count("next").classList.contains("over")).toBe(true);
    expect(count("next").title).toBe("Over the limit of 2");
    expect(count("later").textContent).toBe("0/3");
    expect(count("later").title).toBe("");
    expect(one(".swatch", col("next")).parentElement?.className).toBe("col-head");
    expect(col("next").style.getPropertyValue("--step")).toBe("var(--s-violet)");
  });
});

describe("Board No step", () => {
  it("moves every No step card to the chosen step with Move all to…", async () => {
    const t = await made([...SEED, { name: "x" }]);
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    const qa = stepId(t, "QA");
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "toStep", items: ["w", "x"], step: qa });
    t.session.apply({ t: "step", op: "delete", step: qa, to: null });
    phone.sync();
    await board(t);
    expect(cardsIn("no-step")).toEqual(["w", "x"]);
    expect(one(".col-badge", col("no-step")).textContent).toBe("2");
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Move all to…" }));
    });
    expect(all('[role="menu"] [role="menuitem"]').map((e) => e.textContent)).toEqual(["Now", "Next", "Later", "Done"]);
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Later" }));
    });
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["w", "x"], step: "later" }]]);
    expect(document.querySelector('[data-col="no-step"]')).toBeNull();
    expect(cardsIn("later")).toEqual(["w", "x"]);
  });
});

describe("Board card badges", () => {
  it("marks late and soon cards by steps, and none by dates", async () => {
    const t = await made([
      { name: "late", start: "2026-11-02", dur: 2 },
      { name: "soon", start: "2026-11-12", dur: 2 },
      { name: "far", start: "2026-11-30", dur: 2 },
    ]);
    await board(t);
    expect(all(".badge")).toEqual([]);
    act(() => {
      t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
    });
    expect(one(".badge.late", card("late")).textContent).toBe("late");
    expect(one(".badge.soon", card("soon")).textContent).toBe("starts in 3 d");
    expect(card("far").querySelector(".badge")).toBeNull();
  });
});

describe("Board read-only", () => {
  it("takes no drops on columns or strips and offers no Move all to…, but strips still expand", async () => {
    const t = await made(SEED);
    act(() => t.session.setReadOnly(true));
    await board(t);
    expect(all("[data-drop]")).toEqual([]);
    const apply = vi.spyOn(t.session, "apply");
    dragTo("w", one('[data-strip="done"]'));
    expect(apply).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(one('[data-strip="done"]'));
    });
    expect(cols()).toEqual(["now", "next", "later", "done"]);
  });
});

const toastTexts = (): (string | null)[] => all(".toasts .toast").map((e) => e.textContent);
const heads = (): (string | null)[] => all(".col-head h2").map((e) => e.textContent);
const menuRows = (): [string | null, string | null][] => all('.context-menu [role^="menuitem"]').map((e) => [e.textContent, e.getAttribute("aria-checked")]);

const openMenu = (step: string): void => {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: `${step} options` }));
  });
};

const choose = (row: string): void => {
  const el = all('.context-menu [role^="menuitem"]').find((e) => e.textContent === row);
  if (el === undefined) throw new Error("no menu row " + row);
  act(() => {
    fireEvent.click(el);
  });
};

const dragHead = (from: HTMLElement, to: HTMLElement): ReturnType<typeof vi.fn> => {
  const setData = vi.fn();
  const dataTransfer = { setData, effectAllowed: "none" };
  act(() => {
    fireEvent.dragStart(from, { dataTransfer });
  });
  act(() => {
    fireEvent.dragOver(to, { dataTransfer });
  });
  act(() => {
    fireEvent.drop(to, { dataTransfer });
  });
  act(() => {
    fireEvent.dragEnd(from, { dataTransfer });
  });
  return setData;
};

const head = (h: string): HTMLElement => one(".col-head", col(h));

const valueOf = (el: HTMLElement): string => {
  if (!(el instanceof HTMLInputElement)) throw new Error("not an input");
  return el.value;
};

const checkedOf = (el: HTMLElement): boolean => {
  const input = el.querySelector("input");
  if (input === null) throw new Error("no input in " + el.className);
  return input.checked;
};

describe("Board +", () => {
  it("opens a draft atop the column that Return turns into a selected task in that step", async () => {
    const t = await made(SEED);
    await board(t);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Add a task to Next" }));
    });
    const input = screen.getByRole("textbox", { name: "Name of the new task in Next" });
    expect(input.getAttribute("placeholder")).toBe("New task");
    expect(document.activeElement).toBe(input);
    expect(one(".col-body", col("next")).firstElementChild?.className).toBe("card card-draft");
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.change(input, { target: { value: "  Polish mirror " } });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(apply.mock.calls).toEqual([[{ t: "create", kind: "task", name: "Polish mirror", parent: null, after: null, start: null, step: "next" }]]);
    expect(document.querySelector(".card-draft")).toBeNull();
    const added = [...t.session.view().plan.items.values()].find((i) => i.name === "Polish mirror");
    if (added === undefined) throw new Error("no new task");
    expect(card(added.id).classList.contains("selected")).toBe(true);
    expect(stepModeOf(t.session.view().plan)).toBe("steps");
    expect(cardsIn("next")).toContain(added.id);
  });

  it("writes nothing for Esc, an empty Return or an empty blur, and commits a named blur", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    const draft = (): HTMLElement => screen.getByRole("textbox", { name: "Name of the new task in Now" });
    const add = (): void => {
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Add a task to Now" }));
      });
    };
    add();
    fireEvent.change(draft(), { target: { value: "Typed" } });
    const page = vi.fn();
    document.addEventListener("keydown", page);
    act(() => {
      fireEvent.keyDown(draft(), { key: "Escape" });
    });
    document.removeEventListener("keydown", page);
    expect(page).not.toHaveBeenCalled();
    expect(document.querySelector(".card-draft")).toBeNull();
    add();
    act(() => {
      fireEvent.keyDown(draft(), { key: "Enter" });
    });
    expect(document.querySelector(".card-draft")).toBeNull();
    add();
    act(() => {
      fireEvent.blur(draft());
    });
    expect(document.querySelector(".card-draft")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    add();
    fireEvent.change(draft(), { target: { value: "Blurred" } });
    act(() => {
      fireEvent.blur(draft());
    });
    expect(apply.mock.calls).toEqual([[{ t: "create", kind: "task", name: "Blurred", parent: null, after: null, start: null, step: "now" }]]);
    expect(document.querySelector(".card-draft")).toBeNull();
  });
});

describe("Board header menu", () => {
  it("lists Rename, Colour…, Limit…, Completes items, Insert left and right, Hide and Delete… from ⋯ and from a right-click", async () => {
    const t = await made(SEED);
    await board(t);
    openMenu("Now");
    const menu = screen.getByRole("menu", { name: "Step options" });
    expect(menuRows()).toEqual([
      ["Rename", null],
      ["Colour…", null],
      ["Limit…", null],
      ["Completes items", "false"],
      ["Insert left", null],
      ["Insert right", null],
      ["Hide on this device", "false"],
      ["Delete…", null],
    ]);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(2);
    act(() => {
      fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    });
    expect(document.querySelector(".context-menu")).toBeNull();
    act(() => {
      fireEvent.contextMenu(head("next"), { clientX: 300, clientY: 120 });
    });
    expect(one(".context-menu").style.left).toBe("300px");
    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(document.querySelector(".context-menu")).toBeNull();
    act(() => {
      fireEvent.contextMenu(one('[data-strip="done"]'), { clientX: 900, clientY: 80 });
    });
    expect(menuRows()[3]).toEqual(["Completes items", "true"]);
  });

  it("renames in place: Return commits, a refusal toasts and keeps the field, Esc cancels", async () => {
    const t = await made(SEED);
    await board(t);
    openMenu("Now");
    choose("Rename");
    const field = screen.getByRole("textbox", { name: "Name of Now" });
    expect(field.className).toBe("col-rename");
    expect(document.activeElement).toBe(field);
    expect(valueOf(field)).toBe("Now");
    fireEvent.change(field, { target: { value: "next" } });
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(toastTexts()).toEqual(["There is already a step named “Next”."]);
    expect(screen.getByRole("textbox", { name: "Name of Now" })).toBe(field);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.change(field, { target: { value: "Today" } });
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(apply.mock.calls).toEqual([[{ t: "step", op: "rename", step: "now", name: "Today" }]]);
    expect(heads()).toEqual(["TODAY", "NEXT", "LATER"]);
    openMenu("Next");
    choose("Rename");
    const next = screen.getByRole("textbox", { name: "Name of Next" });
    fireEvent.change(next, { target: { value: "Gone" } });
    act(() => {
      fireEvent.keyDown(next, { key: "Escape" });
    });
    expect(heads()).toEqual(["TODAY", "NEXT", "LATER"]);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("renames a hidden step by showing it first", async () => {
    window.localStorage.setItem(boardKey(TEST_PLAN), JSON.stringify({ v: 1, hidden: ["next"], doneOpen: false }));
    const t = await made(SEED);
    await board(t);
    act(() => {
      fireEvent.contextMenu(one('[data-strip="hidden"]'), { clientX: 300, clientY: 120 });
    });
    expect(menuRows()[6]).toEqual(["Hide on this device", "true"]);
    choose("Rename");
    expect(stored()).toEqual({ v: 1, hidden: [], doneOpen: false });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name of Next" }));
  });

  it("recolours from the Colour popover, which has eight swatches and an X", async () => {
    const t = await made(SEED);
    await board(t);
    openMenu("Next");
    choose("Colour…");
    const pop = screen.getByRole("dialog", { name: "Colour · Next" });
    expect(pop.className).toBe("popover colour-pop");
    expect(all('[role="radio"]', pop).map((r) => [r.getAttribute("aria-label"), r.getAttribute("aria-checked")])).toEqual([
      ["Cyan", "false"],
      ["Violet", "true"],
      ["Magenta", "false"],
      ["Lime", "false"],
      ["Amber", "false"],
      ["Coral", "false"],
      ["Sky", "false"],
      ["Slate", "false"],
    ]);
    expect(pop.querySelectorAll(".popover-close")).toHaveLength(1);
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.click(screen.getByRole("radio", { name: "Lime" }));
    });
    expect(apply.mock.calls).toEqual([[{ t: "step", op: "colour", step: "next", colour: "lime" }]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(col("next").style.getPropertyValue("--step")).toBe("var(--s-lime)");
    openMenu("Next");
    choose("Colour…");
    act(() => {
      fireEvent.click(one(".colour-pop .popover-close"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("sets and clears a limit from the Limit popover, and keeps it open on a bad number", async () => {
    const t = await made(SEED);
    await board(t);
    openMenu("Next");
    choose("Limit…");
    const pop = screen.getByRole("dialog", { name: "Limit · Next" });
    expect(pop.className).toBe("popover limit-pop");
    expect(one(".pop-note", pop).textContent).toBe("Shown as count/limit in amber when passed. A limit never blocks a drop.");
    expect(pop.querySelectorAll(".popover-close")).toHaveLength(1);
    const input = screen.getByRole("textbox", { name: "Limit" });
    expect(input.getAttribute("placeholder")).toBe("None");
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.change(input, { target: { value: "0" } });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(toastTexts()).toEqual(["A limit is a whole number from 1 to 99."]);
    expect(screen.getByRole("dialog", { name: "Limit · Next" })).toBe(pop);
    fireEvent.change(input, { target: { value: "1" } });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(one(".col-count", col("next")).textContent).toBe("2/1");
    expect(one(".col-count", col("next")).classList.contains("over")).toBe(true);
    openMenu("Next");
    choose("Limit…");
    expect(valueOf(screen.getByRole("textbox", { name: "Limit" }))).toBe("1");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });
    expect(apply.mock.calls).toEqual([
      [{ t: "step", op: "limit", step: "next", limit: 0 }],
      [{ t: "step", op: "limit", step: "next", limit: 1 }],
      [{ t: "step", op: "limit", step: "next", limit: null }],
    ]);
    expect(one(".col-count", col("next")).textContent).toBe("2");
  });

  it("toggles Completes items, and toasts the refusal for a step that holds open items", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openMenu("Now");
    choose("Completes items");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(toastTexts()).toEqual(["“Now” holds 1 item that is not done. Move it to another step first."]);
    expect(stepModeOf(t.session.view().plan)).toBe("dates");
    act(() => {
      fireEvent.click(one('[data-strip="done"]'));
    });
    openMenu("Done");
    choose("Completes items");
    expect(apply.mock.calls[1]).toEqual([{ t: "step", op: "completes", step: "done", completes: false }]);
    expect(document.querySelector("[data-done-hidden]")?.textContent).toBe("1 done item is hidden.");
  });

  it("inserts a New step left or right with the first unused colour and opens its rename", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openMenu("Next");
    choose("Insert right");
    expect(apply.mock.calls).toEqual([[{ t: "step", op: "add", name: "New step", colour: "magenta", after: "next" }]]);
    const added = stepId(t, "New step");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name of New step" }));
    act(() => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Name of New step" }), { key: "Escape" });
    });
    expect(heads()).toEqual(["NOW", "NEXT", "NEW STEP", "LATER"]);
    expect(col(added).style.getPropertyValue("--step")).toBe("var(--s-magenta)");
    openMenu("Now");
    choose("Insert left");
    expect(apply.mock.calls[1]).toEqual([{ t: "step", op: "add", name: "New step 2", colour: "amber", after: null }]);
    act(() => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Name of New step 2" }), { key: "Escape" });
    });
    expect(heads()).toEqual(["NEW STEP 2", "NOW", "NEXT", "NEW STEP", "LATER"]);
  });

  it("hides a step on this device into a strip", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openMenu("Next");
    choose("Hide on this device");
    expect(stored()).toEqual({ v: 1, hidden: ["next"], doneOpen: false });
    expect(cols()).toEqual(["now", "next:hidden", "later", "done:done"]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("reorders by dragging a header: to the right lands after the target, to the left after its left neighbour", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    expect(head("now").getAttribute("draggable")).toBe("true");
    const setData = dragHead(head("now"), col("later"));
    expect(setData.mock.calls).toEqual([[STEP_DRAG, "now"]]);
    expect(apply.mock.calls).toEqual([[{ t: "step", op: "reorder", step: "now", after: "later" }]]);
    expect(heads()).toEqual(["NEXT", "LATER", "NOW"]);
    dragHead(head("now"), col("later"));
    expect(apply.mock.calls[1]).toEqual([{ t: "step", op: "reorder", step: "now", after: "next" }]);
    expect(heads()).toEqual(["NEXT", "NOW", "LATER"]);
    dragHead(head("now"), col("next"));
    expect(apply.mock.calls[2]).toEqual([{ t: "step", op: "reorder", step: "now", after: null }]);
    dragHead(head("now"), col("now"));
    expect(apply).toHaveBeenCalledTimes(3);
    expect(heads()).toEqual(["NOW", "NEXT", "LATER"]);
  });
});

describe("Board step delete", () => {
  it("asks to delete a step that holds nothing, and Cancel writes nothing", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    const qa = stepId(t, "QA");
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openMenu("QA");
    choose("Delete…");
    const dialog = screen.getByRole("dialog", { name: "Delete step" });
    expect(one("p", dialog).textContent).toBe("Delete the step “QA”? It holds no items.");
    expect(dialog.querySelectorAll(".modal-close")).toHaveLength(1);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    openMenu("QA");
    choose("Delete…");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(apply.mock.calls).toEqual([[{ t: "step", op: "delete", step: qa, to: null }]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(heads()).toEqual(["NOW", "NEXT", "LATER"]);
  });

  it("asks where the items go for a step that holds some, the first open step chosen, and moves them", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openMenu("Later");
    choose("Delete…");
    const dialog = screen.getByRole("dialog", { name: "Move 2 items from Later to…" });
    expect(one(".delete-step-hidden", dialog).textContent).toBe("1 of them is done or in the Trash.");
    const group = screen.getByRole("radiogroup", { name: "Move items to" });
    expect(all(".step-pick-row", group).map((r) => [r.textContent, checkedOf(r)])).toEqual([
      ["Now", true],
      ["Next", false],
      ["Donemarks them done", false],
    ]);
    act(() => {
      fireEvent.click(screen.getByRole("radio", { name: "Next" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete and move" }));
    });
    expect(apply.mock.calls).toEqual([[{ t: "step", op: "delete", step: "later", to: "next" }]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(heads()).toEqual(["NOW", "NEXT"]);
    expect(cardsIn("next")).toContain("w");
  });

  it("toasts the refusal without a dialog when the step is the last open one", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "delete", step: "now", to: "later" });
    t.session.apply({ t: "step", op: "delete", step: "next", to: "later" });
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openMenu("Later");
    choose("Delete…");
    expect(toastTexts()).toEqual(["A plan keeps at least one step that does not complete items."]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("Board read-only headers", () => {
  it("offers no + and only Hide on this device in the header menu, and headers do not drag", async () => {
    const t = await made(SEED);
    act(() => t.session.setReadOnly(true));
    await board(t);
    expect(screen.queryByRole("button", { name: "Add a task to Now" })).toBeNull();
    expect(head("now").getAttribute("draggable")).toBe("false");
    openMenu("Now");
    expect(menuRows()).toEqual([["Hide on this device", "false"]]);
    choose("Hide on this device");
    expect(stored()).toEqual({ v: 1, hidden: ["now"], doneOpen: false });
  });
});

describe("Board card menu", () => {
  const openCardMenu = (id: string): void => {
    act(() => {
      fireEvent.contextMenu(card(id), { clientX: 200, clientY: 150 });
    });
  };

  it("offers Open, Move to with the live steps and the current one checked, Duplicate and Delete on a right-click", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    });
    await board(t);
    openCardMenu("u");
    const menu = screen.getByRole("menu", { name: "Card options" });
    expect(menuRows()).toEqual([
      ["Open", null],
      ["Now", "false"],
      ["Next", "true"],
      ["Later", "false"],
      ["QA", "false"],
      ["Done", "false"],
      ["Duplicate", null],
      ["Delete", null],
    ]);
    expect(all('[role^="menuitem"]', screen.getByRole("group", { name: "Move to" })).map((e) => e.textContent)).toEqual(["Now", "Next", "Later", "QA", "Done"]);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(2);
    expect(menu.style.left).toBe("200px");
    const apply = vi.spyOn(t.session, "apply");
    choose("QA");
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["u"], step: stepId(t, "QA") }]]);
    expect(cardsIn(stepId(t, "QA"))).toEqual(["u"]);
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("opens the card as the item modal from Open", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openCardMenu("mid");
    choose("Open");
    expect(document.querySelector("[data-item-modal] [data-detail]")?.getAttribute("data-detail-item")).toBe("mid");
    expect(apply).not.toHaveBeenCalled();
  });

  it("duplicates a card and selects the copy, and moves a card to the Trash", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openCardMenu("u");
    choose("Duplicate");
    expect(apply.mock.calls).toEqual([[{ t: "duplicate", item: "u" }]]);
    const copy = one(".card.selected");
    expect(copy.dataset.card).not.toBe("u");
    expect(one(".card-name", copy).textContent).toBe(t.session.view().plan.items.get(copy.dataset.card ?? "")?.name);
    openCardMenu("w");
    choose("Delete");
    expect(apply.mock.calls[1]).toEqual([{ t: "trash", items: ["w"] }]);
    expect(document.querySelector('[data-card="w"]')).toBeNull();
  });
});

describe("Board after review", () => {
  it("returns focus to the column's ⋯ when the Colour or Limit popover closes, and ⋯ says when its menu is open", async () => {
    const t = await made(SEED);
    await board(t);
    const more = screen.getByRole("button", { name: "Next options" });
    act(() => {
      more.focus();
    });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    openMenu("Next");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    choose("Colour…");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement?.getAttribute("data-colour")).toBe("violet");
    act(() => {
      fireEvent.click(one(".colour-pop .popover-close"));
    });
    expect(document.activeElement).toBe(more);
    act(() => {
      fireEvent.contextMenu(head("next"), { clientX: 300, clientY: 120 });
    });
    choose("Limit…");
    act(() => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Limit" }), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("toggles the header menu with a second press on ⋯", async () => {
    const t = await made(SEED);
    await board(t);
    const more = screen.getByRole("button", { name: "Now options" });
    const press = (): void => {
      act(() => {
        fireEvent.pointerDown(more);
      });
      act(() => {
        fireEvent.click(more);
      });
    };
    press();
    expect(document.querySelectorAll(".context-menu")).toHaveLength(1);
    press();
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    press();
    expect(document.querySelectorAll(".context-menu")).toHaveLength(1);
  });

  it("moves focus between colour swatches with the arrow keys, one tab stop, writing nothing", async () => {
    const t = await made(SEED);
    await board(t);
    openMenu("Next");
    choose("Colour…");
    const apply = vi.spyOn(t.session, "apply");
    const stops = (): (string | undefined)[] => all('.colour-pop [role="radio"]').filter((r) => r.tabIndex === 0).map((r) => r.dataset.colour);
    const key = (k: string): void => {
      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key: k });
      });
    };
    expect(stops()).toEqual(["violet"]);
    key("ArrowRight");
    expect([document.activeElement?.getAttribute("data-colour"), stops()]).toEqual(["magenta", ["magenta"]]);
    key("ArrowDown");
    expect(document.activeElement?.getAttribute("data-colour")).toBe("sky");
    key("ArrowUp");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(document.activeElement?.getAttribute("data-colour")).toBe("cyan");
    key("ArrowLeft");
    expect([document.activeElement?.getAttribute("data-colour"), stops()]).toEqual(["slate", ["slate"]]);
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Colour · Next" })).not.toBeNull();
  });

  it("refuses limit text that is not one or two digits, keeping the popover open", async () => {
    const t = await made(SEED);
    await board(t);
    openMenu("Next");
    choose("Limit…");
    const apply = vi.spyOn(t.session, "apply");
    const input = screen.getByRole("textbox", { name: "Limit" });
    ["+5", "5."].forEach((typed) => {
      fireEvent.change(input, { target: { value: typed } });
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      });
    });
    expect(apply.mock.calls).toEqual([[{ t: "step", op: "limit", step: "next", limit: Number.NaN }], [{ t: "step", op: "limit", step: "next", limit: Number.NaN }]]);
    expect(toastTexts()).toEqual([refusal.stepLimit, refusal.stepLimit]);
    expect(screen.getByRole("dialog", { name: "Limit · Next" })).not.toBeNull();
    expect(one(".col-count", col("next")).textContent).toBe("2");
  });

  it("says so and keeps the user's choice visible when the picked target of a delete is deleted elsewhere", async () => {
    const t = await made(SEED);
    await board(t);
    openMenu("Later");
    choose("Delete…");
    act(() => {
      fireEvent.click(screen.getByRole("radio", { name: "Next" }));
    });
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: "next", to: "now" });
    });
    expect(toastTexts()).toEqual([STALE_CONFIRM]);
    const group = screen.getByRole("radiogroup", { name: "Move items to" });
    expect(all(".step-pick-row", group).map((r) => [r.textContent, checkedOf(r)])).toEqual([
      ["Now", true],
      ["Donemarks them done", false],
    ]);
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete and move" }));
    });
    expect(apply.mock.calls).toEqual([[{ t: "step", op: "delete", step: "later", to: "now" }]]);
  });

  it("closes the delete dialog with the refusal when every other step comes to complete items while it is open", async () => {
    const t = await made(SEED);
    await board(t);
    openMenu("Later");
    choose("Delete…");
    expect(screen.getByRole("dialog", { name: "Move 2 items from Later to…" })).not.toBeNull();
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: "now", to: "later" });
      t.session.apply({ t: "step", op: "delete", step: "next", to: "later" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual([refusal.lastOpenStep]);
  });

  it("refuses to delete the last step, from the dialog's guard and from the menu", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: "done", to: "now" });
      t.session.apply({ t: "step", op: "delete", step: "next", to: "now" });
      t.session.apply({ t: "step", op: "delete", step: "later", to: "now" });
    });
    const only = stepsOf(t.session.view().plan);
    expect([only.map((s) => s.id), deleteRefusal(only, "now")]).toEqual([["now"], refusal.lastStep]);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openMenu("Now");
    choose("Delete…");
    expect(toastTexts()).toEqual([refusal.lastStep]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops an open rename or draft with a toast when its step is deleted elsewhere", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
      t.session.apply({ t: "step", op: "add", name: "Ops", colour: "coral", after: "later" });
    });
    const qa = stepId(t, "QA");
    const ops = stepId(t, "Ops");
    await board(t);
    openMenu("QA");
    choose("Rename");
    fireEvent.change(screen.getByRole("textbox", { name: "Name of QA" }), { target: { value: "Typed" } });
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: qa, to: null });
    });
    expect([toastTexts(), document.querySelector(".col-rename")]).toEqual([[STALE_CONFIRM], null]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Add a task to Ops" }));
    });
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: ops, to: null });
    });
    expect([toastTexts(), document.querySelector(".card-draft")]).toEqual([[STALE_CONFIRM, STALE_CONFIRM], null]);
  });

  it("commits nothing when a draft or rename loses focus in the same moment its step is deleted elsewhere", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
      t.session.apply({ t: "step", op: "add", name: "Ops", colour: "coral", after: "later" });
    });
    const qa = stepId(t, "QA");
    const ops = stepId(t, "Ops");
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Add a task to QA" }));
    });
    const draft = screen.getByRole("textbox", { name: "Name of the new task in QA" });
    fireEvent.change(draft, { target: { value: "Typed" } });
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: qa, to: null });
      fireEvent.blur(draft);
    });
    openMenu("Ops");
    choose("Rename");
    const rename = screen.getByRole("textbox", { name: "Name of Ops" });
    fireEvent.change(rename, { target: { value: "Renamed" } });
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: ops, to: null });
      fireEvent.blur(rename);
    });
    expect(apply.mock.calls).toEqual([[{ t: "step", op: "delete", step: qa, to: null }], [{ t: "step", op: "delete", step: ops, to: null }]]);
    expect(toastTexts()).toEqual([STALE_CONFIRM, STALE_CONFIRM]);
  });

  it("says so when Move to picks a card that went to the Trash while its menu was open", async () => {
    const t = await made(SEED);
    await board(t);
    act(() => {
      fireEvent.contextMenu(card("u"), { clientX: 200, clientY: 150 });
    });
    act(() => {
      t.session.apply({ t: "trash", items: ["u"] });
    });
    const apply = vi.spyOn(t.session, "apply");
    choose("Later");
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([STALE_CONFIRM]);
  });

  it("treats a Control-click on macOS as the context click only: no select and no open", async () => {
    const t = await made(SEED);
    await board(t);
    const ctrlClick = (): void => {
      act(() => {
        fireEvent.pointerDown(card("u"), { button: 0, ctrlKey: true, clientX: 10, clientY: 10 });
      });
      act(() => {
        fireEvent.pointerUp(card("u"), { button: 0, ctrlKey: true, clientX: 10, clientY: 10 });
      });
    };
    ctrlClick();
    ctrlClick();
    expect(card("u").classList.contains("selected")).toBe(false);
    expect(document.querySelector("[data-item-modal]")).toBeNull();
    act(() => {
      fireEvent.pointerDown(card("u"), { button: 0, clientX: 10, clientY: 10 });
    });
    act(() => {
      fireEvent.pointerUp(card("u"), { button: 0, clientX: 10, clientY: 10 });
    });
    expect(card("u").classList.contains("selected")).toBe(true);
  });

  it("keeps the selection when Esc discards a draft or cancels a rename", async () => {
    const t = await made(SEED);
    await board(t);
    act(() => {
      fireEvent.pointerDown(card("u"), { button: 0, clientX: 10, clientY: 10 });
    });
    act(() => {
      fireEvent.pointerUp(card("u"), { button: 0, clientX: 10, clientY: 10 });
    });
    expect(card("u").classList.contains("selected")).toBe(true);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Add a task to Now" }));
    });
    act(() => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Name of the new task in Now" }), { key: "Escape" });
    });
    openMenu("Next");
    choose("Rename");
    act(() => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Name of Next" }), { key: "Escape" });
    });
    expect([document.querySelector(".card-draft, .col-rename"), card("u").classList.contains("selected")]).toEqual([null, true]);
  });
});

describe("Board headers on iPad", () => {
  interface Sent {
    token: string;
    sections: { title: string | null; rows: { id: string; title: string; checked: boolean }[] }[];
  }
  const asks = (): Sent[] => tauri.calls.filter((c) => c.cmd === "menu_show").map((c) => (c.args as { menu: Sent }).menu);
  const lastAsk = (): Sent => {
    const sent = asks()[asks().length - 1];
    if (sent === undefined) throw new Error("no menu_show was sent");
    return sent;
  };
  const chooseNative = (id: string): void => {
    const { token } = lastAsk();
    act(() => {
      emitFromRust("menu-ended", { token });
      emitFromRust("menu-chosen", { token, id });
    });
  };
  const haptics = (): unknown[] => tauri.calls.filter((c) => c.cmd === "haptic").map((c) => c.args);
  const wait = async (ms: number): Promise<void> => {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, ms));
    });
  };
  const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", el: HTMLElement, x: number, y: number): void => {
    act(() => {
      fireEvent[type](el, { pointerType: "touch", pointerId: 7, clientX: x, clientY: y });
    });
  };

  const ipadBoard = async (): Promise<{ t: TestSession; unstub: () => void }> => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    const t = await made(SEED);
    render(withSync(shellFor(t, { device: { deviceId: "ipad", name: "iPad", platform: "ios" } }).ui));
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    return { t, unstub };
  };

  it("sends the eight header rows to the native menu and renders no HTML menu", async () => {
    const { unstub } = await ipadBoard();
    try {
      openMenu("Now");
      await settle();
      expect(document.querySelector(".context-menu")).toBeNull();
      expect(lastAsk().sections.map((s) => [s.title, s.rows.map((r) => [r.id, r.title, r.checked])])).toEqual([
        [
          null,
          [
            ["rename", "Rename", false],
            ["colour", "Colour…", false],
            ["limit", "Limit…", false],
            ["completes", "Completes items", false],
          ],
        ],
        [
          null,
          [
            ["insert-left", "Insert left", false],
            ["insert-right", "Insert right", false],
            ["hide", "Hide on this device", false],
          ],
        ],
        [null, [["delete", "Delete…", false]]],
      ]);
      chooseNative("hide");
      expect(stored()).toEqual({ v: 1, hidden: ["now"], doneOpen: false });
    } finally {
      unstub();
    }
  });

  it("deletes an empty step through a native alert with a destructive Delete", async () => {
    const { t, unstub } = await ipadBoard();
    try {
      act(() => {
        t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
      });
      const qa = stepId(t, "QA");
      tauri.answers.alert_ask = () => "confirm";
      const apply = vi.spyOn(t.session, "apply");
      openMenu("QA");
      await settle();
      chooseNative("delete");
      await settle();
      expect(tauri.calls.filter((c) => c.cmd === "alert_ask").map((c) => c.args)).toEqual([
        { ask: { title: "Delete step", message: "Delete the step “QA”? It holds no items.", confirm: { label: "Delete", destructive: true }, cancel: "Cancel" } },
      ]);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(apply.mock.calls).toEqual([[{ t: "step", op: "delete", step: qa, to: null }]]);
    } finally {
      unstub();
    }
  });

  it("reports no stale confirmation after a confirmed native step delete when React renders on its own schedule", async () => {
    const { t, unstub } = await ipadBoard();
    const actEnv = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    try {
      act(() => {
        t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
      });
      tauri.answers.alert_ask = () => "confirm";
      openMenu("QA");
      await settle();
      chooseNative("delete");
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
      await new Promise<void>((r) => setTimeout(r, 40));
      expect([stepsOf(t.session.view().plan).some((s) => s.name === "QA"), toastTexts().filter((text) => text === STALE_CONFIRM)]).toEqual([false, []]);
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnv);
      unstub();
    }
  });

  it("reports a step deleted elsewhere once when the native alert is answered afterwards", async () => {
    const { t, unstub } = await ipadBoard();
    try {
      act(() => {
        t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
      });
      const qa = stepId(t, "QA");
      const answer: { send: ((a: string) => void) | null } = { send: null };
      tauri.answers.alert_ask = () => new Promise<string>((r) => (answer.send = r));
      openMenu("QA");
      await settle();
      chooseNative("delete");
      await settle();
      act(() => {
        t.session.apply({ t: "step", op: "delete", step: qa, to: null });
      });
      await settle();
      const send = answer.send;
      if (send === null) throw new Error("the alert was not asked");
      send("confirm");
      await settle();
      expect(toastTexts().filter((text) => text === STALE_CONFIRM)).toHaveLength(1);
    } finally {
      unstub();
    }
  });

  it("a header hold plays one haptic and lifts it; a move reorders and a still release opens the menu", async () => {
    const { t, unstub } = await ipadBoard();
    try {
      const apply = vi.spyOn(t.session, "apply");
      expect(head("later").getAttribute("draggable")).toBe("false");
      touch("pointerDown", head("later"), 600, 20);
      await wait(520);
      expect(haptics()).toEqual([{ kind: "medium" }]);
      expect(col("later").classList.contains("lifted")).toBe(true);
      const target = col("now");
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
      touch("pointerMove", head("later"), 100, 60);
      expect(col("now").classList.contains("over")).toBe(true);
      touch("pointerUp", head("later"), 100, 60);
      Reflect.deleteProperty(document, "elementFromPoint");
      expect(apply.mock.calls).toEqual([[{ t: "step", op: "reorder", step: "later", after: null }]]);
      expect(heads()).toEqual(["LATER", "NOW", "NEXT"]);
      expect(document.querySelector(".lifted")).toBeNull();
      const before = asks().length;
      touch("pointerDown", head("next"), 600, 20);
      await wait(520);
      touch("pointerUp", head("next"), 602, 21);
      await settle();
      expect(asks()).toHaveLength(before + 1);
      expect(lastAsk().sections.flatMap((s) => s.rows.map((r) => r.title))).toHaveLength(8);
      expect(haptics()).toHaveLength(2);
      touch("pointerDown", head("now"), 600, 20);
      touch("pointerUp", head("now"), 600, 20);
      await wait(520);
      expect(haptics()).toHaveLength(2);
      expect(asks()).toHaveLength(before + 1);
    } finally {
      unstub();
    }
  });

  it("cards do not drag; a tap opens one, a hold plays one haptic and lifts it, and a move drops it on a column", async () => {
    const { t, unstub } = await ipadBoard();
    try {
      expect(all("[data-card]").map((c) => c.getAttribute("draggable"))).toEqual(all("[data-card]").map(() => "false"));
      touch("pointerDown", card("u"), 50, 50);
      touch("pointerUp", card("u"), 50, 50);
      expect(card("u").classList.contains("selected")).toBe(true);
      expect(haptics()).toEqual([]);
      const apply = vi.spyOn(t.session, "apply");
      touch("pointerDown", card("w"), 50, 50);
      await wait(520);
      expect(haptics()).toEqual([{ kind: "medium" }]);
      expect(card("w").classList.contains("lifted")).toBe(true);
      const target = col("now");
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
      touch("pointerMove", card("w"), 300, 80);
      expect(col("now").classList.contains("over")).toBe(true);
      touch("pointerUp", card("w"), 300, 80);
      Reflect.deleteProperty(document, "elementFromPoint");
      expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["w"], step: "now" }]]);
      expect(cardsIn("now")).toContain("w");
      expect(document.querySelector(".lifted, .over")).toBeNull();
      expect(haptics()).toEqual([{ kind: "medium" }]);
      expect(asks()).toEqual([]);
    } finally {
      unstub();
    }
  });

  it("a still card hold opens the native card menu; moving before the hold gives up", async () => {
    const { t, unstub } = await ipadBoard();
    try {
      const apply = vi.spyOn(t.session, "apply");
      touch("pointerDown", card("u"), 50, 50);
      await wait(520);
      touch("pointerUp", card("u"), 51, 50);
      await settle();
      expect(document.querySelector(".context-menu")).toBeNull();
      expect(haptics()).toEqual([{ kind: "medium" }]);
      expect(lastAsk().sections.map((s) => [s.title, s.rows.map((r) => [r.id, r.title, r.checked])])).toEqual([
        [null, [["open", "Open", false]]],
        [
          "Move to",
          [
            ["step:now", "Now", false],
            ["step:next", "Next", true],
            ["step:later", "Later", false],
            ["step:done", "Done", false],
          ],
        ],
        [
          null,
          [
            ["duplicate", "Duplicate", false],
            ["delete", "Delete", false],
          ],
        ],
      ]);
      expect(card("u").classList.contains("selected")).toBe(false);
      chooseNative("step:later");
      expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["u"], step: "later" }]]);
      const sent = asks().length;
      touch("pointerDown", card("w"), 50, 50);
      touch("pointerMove", card("w"), 50, 90);
      await wait(520);
      touch("pointerUp", card("w"), 50, 90);
      await settle();
      expect(haptics()).toHaveLength(1);
      expect(asks()).toHaveLength(sent);
      expect(card("w").classList.contains("selected")).toBe(false);
      expect(apply.mock.calls).toHaveLength(1);
    } finally {
      unstub();
    }
  });

  const scrollBlocked = (): boolean => {
    const e = new Event("touchmove", { cancelable: true });
    document.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("blocks page scrolling only while a card is lifted, and frees it and the next tap when the held card moves away mid-gesture", async () => {
    const { t, unstub } = await ipadBoard();
    try {
      expect(scrollBlocked()).toBe(false);
      touch("pointerDown", card("w"), 50, 50);
      expect(scrollBlocked()).toBe(false);
      await wait(520);
      expect(scrollBlocked()).toBe(true);
      act(() => {
        t.session.apply({ t: "toStep", items: ["w"], step: "now" });
      });
      act(() => {
        fireEvent.pointerUp(document.body, { pointerType: "touch", pointerId: 7, clientX: 50, clientY: 50 });
      });
      expect([scrollBlocked(), document.querySelector(".lifted")]).toEqual([false, null]);
      touch("pointerDown", card("u"), 50, 50);
      touch("pointerUp", card("u"), 50, 50);
      expect(card("u").classList.contains("selected")).toBe(true);
    } finally {
      unstub();
    }
  });

  it("plays no haptic and blocks no scrolling when the Board goes away during a hold", async () => {
    const { unstub } = await ipadBoard();
    try {
      touch("pointerDown", card("w"), 50, 50);
      act(() => {
        fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
      });
      await wait(520);
      expect([haptics(), scrollBlocked()]).toEqual([[], false]);
    } finally {
      unstub();
    }
  });

  it("opens the native card and header menus from a trackpad's secondary click, and holds with a pencil", async () => {
    const { unstub } = await ipadBoard();
    try {
      act(() => {
        fireEvent.contextMenu(card("u"), { clientX: 60, clientY: 60 });
      });
      await settle();
      expect(lastAsk().sections.flatMap((s) => s.rows.map((r) => r.title))).toEqual(["Open", "Now", "Next", "Later", "Done", "Duplicate", "Delete"]);
      act(() => {
        fireEvent.contextMenu(head("next"), { clientX: 300, clientY: 20 });
      });
      await settle();
      expect(lastAsk().sections.flatMap((s) => s.rows.map((r) => r.title))).toHaveLength(8);
      expect(document.querySelector(".context-menu")).toBeNull();
      act(() => {
        fireEvent.pointerDown(card("w"), { pointerType: "pen", pointerId: 9, clientX: 50, clientY: 50 });
      });
      await wait(520);
      expect([haptics(), card("w").classList.contains("lifted")]).toEqual([[{ kind: "medium" }], true]);
      act(() => {
        fireEvent.pointerCancel(card("w"), { pointerType: "pen", pointerId: 9 });
      });
      expect(document.querySelector(".lifted")).toBeNull();
    } finally {
      unstub();
    }
  });

  it("stops asking for haptics after the bridge fails once", async () => {
    const { unstub } = await ipadBoard();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      tauri.answers.haptic = () => {
        throw { code: "haptic.no_controller", message: "No haptic controller." };
      };
      const hold = async (id: string): Promise<void> => {
        touch("pointerDown", card(id), 50, 50);
        await wait(520);
        act(() => {
          fireEvent.pointerCancel(card(id), { pointerType: "touch", pointerId: 7 });
        });
        await settle();
      };
      await hold("w");
      await hold("u");
      expect(haptics()).toEqual([{ kind: "medium" }]);
      expect(quiet).toHaveBeenCalledTimes(1);
      expect(card("u").classList.contains("lifted")).toBe(false);
    } finally {
      unstub();
    }
  });

  it("says so when Move all to… picks a step deleted while the native menu was open", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const t = await made([...SEED, { name: "x" }]);
      act(() => {
        t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
      });
      const qa = stepId(t, "QA");
      const phone = await t.peer("iphone");
      sessions.push(phone.session);
      phone.session.apply({ t: "toStep", items: ["w", "x"], step: qa });
      act(() => {
        t.session.apply({ t: "step", op: "delete", step: qa, to: null });
        phone.sync();
      });
      render(withSync(shellFor(t, { device: { deviceId: "ipad", name: "iPad", platform: "ios" } }).ui));
      await settle();
      fireEvent.click(screen.getByRole("tab", { name: "Board" }));
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Move all to…" }));
      });
      await settle();
      expect(lastAsk().sections[0].rows.map((r) => r.id)).toEqual(["now", "next", "later", "done"]);
      act(() => {
        t.session.apply({ t: "step", op: "delete", step: "later", to: "now" });
      });
      const apply = vi.spyOn(t.session, "apply");
      chooseNative("later");
      expect(apply).not.toHaveBeenCalled();
      expect(toastTexts()).toEqual([STALE_CONFIRM]);
    } finally {
      unstub();
    }
  });

  it("sends the Assign section to the native card menu with the people as titles, and a choice assigns", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const t = await made(SEED);
      const ids = addPeople(t, CREW);
      act(() => {
        t.session.apply({ t: "assign", items: ["u"], person: ids.AR });
      });
      render(withSync(shellFor(t, { device: { deviceId: "ipad", name: "iPad", platform: "ios" } }).ui));
      await settle();
      fireEvent.click(screen.getByRole("tab", { name: "Board" }));
      act(() => {
        fireEvent.contextMenu(card("u"), { clientX: 60, clientY: 60 });
      });
      await settle();
      expect(document.querySelector(".context-menu")).toBeNull();
      expect(lastAsk().sections.map((s) => [s.title, s.rows.map((r) => [r.id, r.title, r.checked])])).toEqual([
        [null, [["open", "Open", false]]],
        [
          "Move to",
          [
            ["step:now", "Now", false],
            ["step:next", "Next", true],
            ["step:later", "Later", false],
            ["step:done", "Done", false],
          ],
        ],
        [
          "Assign",
          [
            [`person:${ids.MO}`, "Mira Okafor", false],
            [`person:${ids.OB}`, "Ole Berg", false],
            [`person:${ids.AR}`, "Ana Ruiz", true],
          ],
        ],
        [
          null,
          [
            ["duplicate", "Duplicate", false],
            ["delete", "Delete", false],
          ],
        ],
      ]);
      const apply = vi.spyOn(t.session, "apply");
      chooseNative(`person:${ids.OB}`);
      expect(apply.mock.calls).toEqual([[{ t: "assign", items: ["u"], person: ids.OB }]]);
      expect(one(".card-people", card("u")).getAttribute("aria-label")).toBe("Assignees: Ole Berg, Ana Ruiz");
    } finally {
      unstub();
    }
  });
});

describe("Board people", () => {
  const openCardMenu = (id: string): void => {
    act(() => {
      fireEvent.contextMenu(card(id), { clientX: 200, clientY: 150 });
    });
  };

  it("ends an assigned card's meta with the first avatar and +1, labelled with every name, and leaves unassigned cards bare", async () => {
    const t = await made(SEED);
    const ids = addPeople(t, CREW);
    act(() => {
      t.session.apply({ t: "assign", items: ["u"], person: ids.AR });
      t.session.apply({ t: "assign", items: ["u"], person: ids.MO });
    });
    await board(t);
    const people = one(".card-meta > .card-people:last-child", card("u"));
    expect(people.getAttribute("aria-label")).toBe("Assignees: Mira Okafor, Ana Ruiz");
    expect(people.getAttribute("title")).toBe("Assignees: Mira Okafor, Ana Ruiz");
    expect(all(".avatar", people).map((a) => [a.className, a.textContent, a.style.getPropertyValue("--person")])).toEqual([["avatar", "MO", "var(--s-violet)"]]);
    expect(one(".avatar-more", people).textContent).toBe("+1");
    expect(all("[data-card] .card-people").map((e) => e.closest("[data-card]")?.getAttribute("data-card"))).toEqual(["u"]);
    expect(card("w").querySelector(".card-people, .avatar")).toBeNull();
  });

  it("shows a person removed while a peer assigned them as a former avatar with their initials and no count", async () => {
    const t = await made(SEED);
    const ids = addPeople(t, [["Dana Lee", "DL", "sky"]]);
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "assign", items: ["w"], person: ids.DL });
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.DL, to: null });
      phone.sync();
    });
    await board(t);
    const people = one(".card-people", card("w"));
    expect(people.getAttribute("aria-label")).toBe("Assignees: Former: Dana Lee");
    expect(all(".avatar", people).map((a) => [a.className, a.textContent, a.style.getPropertyValue("--person")])).toEqual([["avatar former", "DL", ""]]);
    expect(people.querySelector(".avatar-more")).toBeNull();
  });

  it("offers Assign between Move to and Duplicate, checks the held people, and a choice toggles one person", async () => {
    const t = await made(SEED);
    const ids = addPeople(t, CREW);
    act(() => {
      t.session.apply({ t: "assign", items: ["u"], person: ids.MO });
    });
    await board(t);
    openCardMenu("u");
    expect(menuRows()).toEqual([
      ["Open", null],
      ["Now", "false"],
      ["Next", "true"],
      ["Later", "false"],
      ["Done", "false"],
      ["Mira Okafor", "true"],
      ["Ole Berg", "false"],
      ["Ana Ruiz", "false"],
      ["Duplicate", null],
      ["Delete", null],
    ]);
    expect(all('[role^="menuitem"]', screen.getByRole("group", { name: "Assign" })).map((e) => e.textContent)).toEqual(["Mira Okafor", "Ole Berg", "Ana Ruiz"]);
    const apply = vi.spyOn(t.session, "apply");
    choose("Ole Berg");
    openCardMenu("u");
    choose("Mira Okafor");
    expect(apply.mock.calls).toEqual([[{ t: "assign", items: ["u"], person: ids.OB }], [{ t: "unassign", items: ["u"], person: ids.MO }]]);
    expect(one(".card-people", card("u")).getAttribute("aria-label")).toBe("Assignees: Ole Berg");
    act(() => {
      t.session.undo();
    });
    expect(one(".card-people", card("u")).getAttribute("aria-label")).toBe("Assignees: Mira Okafor, Ole Berg");
  });

  it("toasts the refusal when a ninth person is assigned", async () => {
    const t = await made(SEED);
    const nine = Array.from({ length: 9 }, (_, i): readonly [string, string, StepColour] => [`Person ${i + 1}`, `P${i + 1}`, "slate"]);
    const ids = addPeople(t, nine);
    act(() => {
      nine.slice(0, 8).forEach(([, initials]) => t.session.apply({ t: "assign", items: ["u"], person: ids[initials] }));
    });
    await board(t);
    expect(one(".avatar-more", card("u")).textContent).toBe("+7");
    openCardMenu("u");
    choose("Person 9");
    expect(toastTexts()).toEqual([refusal.assigneesFull("u")]);
    expect(toastTexts()).toEqual(["“u” already has 8 assignees."]);
  });

  it("says so when a person removed while the menu was open is chosen", async () => {
    const t = await made(SEED);
    const ids = addPeople(t, CREW);
    await board(t);
    openCardMenu("u");
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.OB, to: null });
    });
    const apply = vi.spyOn(t.session, "apply");
    choose("Ole Berg");
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([STALE_CONFIRM]);
  });

  it("says so when an Assign row picks a card that went to the Trash while its menu was open", async () => {
    const t = await made(SEED);
    addPeople(t, CREW);
    await board(t);
    openCardMenu("u");
    act(() => {
      t.session.apply({ t: "trash", items: ["u"] });
    });
    const apply = vi.spyOn(t.session, "apply");
    choose("Ana Ruiz");
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([STALE_CONFIRM]);
  });

  it("offers no Assign section when the plan has no people", async () => {
    const t = await made(SEED);
    await board(t);
    openCardMenu("u");
    expect(screen.queryByRole("group", { name: "Assign" })).toBeNull();
    expect(menuRows().map(([title]) => title)).toEqual(["Open", "Now", "Next", "Later", "Done", "Duplicate", "Delete"]);
  });

  it("offers only Open on a read-only plan, people or not, and still shows the avatars", async () => {
    const t = await made(SEED);
    const ids = addPeople(t, CREW);
    act(() => {
      t.session.apply({ t: "assign", items: ["u"], person: ids.MO });
      t.session.setReadOnly(true);
    });
    await board(t);
    openCardMenu("u");
    expect(menuRows()).toEqual([["Open", null]]);
    expect(one(".card-people .avatar", card("u")).textContent).toBe("MO");
  });
});
