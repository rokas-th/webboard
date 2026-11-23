import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { shellFor } from "../../test/shell";
import { clearToasts } from "../common/Toast";
import { useUi, type UiState } from "../state";
import { withSync } from "../../test/withSync";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
};

const board = async (t: TestSession): Promise<void> => {
  render(withSync(shellFor(t).ui));
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: "Board" }));
};

const uiNow = (): UiState => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value[0];
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
const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const pointer = (el: Element, kind: "down" | "up", x: number, y: number): void => {
  const init = { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" };
  act(() => {
    if (kind === "down") fireEvent.pointerDown(el, init);
    else fireEvent.pointerUp(el, init);
  });
};

const dragTo = (id: string, h: string): void => {
  const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
  act(() => {
    fireEvent.dragStart(card(id), { dataTransfer });
  });
  act(() => {
    fireEvent.dragOver(col(h), { dataTransfer });
  });
  act(() => {
    fireEvent.drop(col(h), { dataTransfer });
  });
};

const menuRows = (): [string | null, string | null][] => all('.context-menu [role^="menuitem"]').map((e) => [e.textContent, e.getAttribute("aria-checked")]);

const moveToRows = (): [string | null, string | null][] =>
  all('[role^="menuitem"]', screen.getByRole("group", { name: "Move to" })).map((e) => [e.textContent, e.getAttribute("aria-checked")]);

const openCardMenu = (id: string): void => {
  act(() => {
    fireEvent.contextMenu(card(id), { clientX: 40, clientY: 40 });
  });
  expect(screen.getByRole("menu", { name: "Card options" })).toBeTruthy();
};

const chooseRow = (title: string): void => {
  const el = all('.context-menu [role^="menuitem"]').find((e) => e.textContent === title);
  if (el === undefined) throw new Error("no menu row " + title);
  act(() => {
    fireEvent.click(el);
  });
};

const MOVED_U ="Moved “u” to “Next”. Cards now keep their steps. Undo goes back to dates.";

describe("Board columns", () => {
  const SEED: SeedItem[] = [
    { name: "soon", start: "2026-11-20", dur: 2 },
    { name: "mid", start: "2026-12-15", dur: 2 },
    { name: "far", start: "2027-03-01", dur: 2, status: "doing" },
    { name: "d1", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
    { name: "d2", start: "2026-11-03", dur: 1, status: "done", progress: 100 },
    { name: "u", horizon: "next" },
    { name: "w" },
  ];

  it("sorts items into NOW, NEXT and LATER by their dates under one quiet line, and folds done ones into the Done strip", async () => {
    const t = await made(SEED);
    await board(t);
    expect(all(".col-head h2").map((e) => e.textContent)).toEqual(["NOW", "NEXT", "LATER"]);
    expect(cardsIn("now")).toEqual(["soon", "far"]);
    expect(cardsIn("next")).toEqual(["mid", "u"]);
    expect(cardsIn("later")).toEqual(["w"]);
    expect(all(".col-head .col-count").map((e) => e.textContent)).toEqual(["2", "2", "1"]);
    expect(all(".col-sub")).toEqual([]);
    expect(one(".board-line [data-by-dates]").textContent).toBe("Columns follow dates. Edit a step or drag a card to use your own steps.");
    expect(document.querySelector("[data-done-hidden]")).toBeNull();
    expect(one('[data-strip="done"]').getAttribute("aria-label")).toBe("Done, 2 items. Expand");
    expect(one('[data-strip="done"] .strip-count').textContent).toBe("2");
    expect(document.querySelector('[data-card="d1"]')).toBeNull();
    expect(one(".card-name", card("soon")).textContent).toBe("soon");
    expect(one(".card-meta .when", card("soon")).textContent).toBe("20 Nov – 23 Nov");
    expect(one(".card-meta .unsched", card("u")).textContent).toBe("unscheduled");
  });

  it("moves a card to NOW when the day rolls over, without a remount (Review Focus 3)", async () => {
    const t = await made(SEED);
    await board(t);
    const slot = one('[data-slot="board"]').firstElementChild;
    expect(cardsIn("next")).toContain("mid");
    act(() => t.clock.set("2026-12-01"));
    expect(cardsIn("now")).toContain("mid");
    expect(cardsIn("next")).not.toContain("mid");
    expect(one('[data-slot="board"]').firstElementChild).toBe(slot);
  });

  it("counts one done item on the Done strip", async () => {
    const t = await made([
      { name: "a", start: "2026-11-20" },
      { name: "d", start: "2026-11-02", status: "done", progress: 100 },
    ]);
    await board(t);
    expect(one('[data-strip="done"]').getAttribute("aria-label")).toBe("Done, 1 item. Expand");
    expect(one('[data-strip="done"] .strip-count').textContent).toBe("1");
  });

  it("leaves out trashed items and the subtree of a trashed group, and names a card's group", async () => {
    const t = await made([
      { name: "G", kind: "group" },
      { name: "g", parent: "G", start: "2026-11-20" },
      { name: "H", kind: "group" },
      { name: "h", parent: "H", start: "2026-11-20" },
      { name: "x", start: "2026-11-20" },
    ]);
    t.session.apply({ t: "trash", items: ["H"] });
    t.session.apply({ t: "trash", items: ["x"] });
    await board(t);
    expect(cardsIn("now")).toEqual(["g"]);
    expect(all(".card-meta span", card("g")).map((e) => e.textContent)).toEqual(["20 Nov – 24 Nov", "G"]);
  });
});

describe("Board group names", () => {
  it("names a card's nested group by its path, as the List does", async () => {
    const t = await made([
      { name: "G", kind: "group" },
      { name: "H", kind: "group", parent: "G" },
      { name: "h", parent: "H", start: "2026-11-20" },
    ]);
    await board(t);
    expect(all(".card-meta span", card("h")).map((e) => e.textContent)).toEqual(["20 Nov – 24 Nov", "G › H"]);
    expect(one(".card-meta .card-group", card("h")).textContent).toBe("G › H");
  });
});

describe("Board markers (refinement 50)", () => {
  it("carries one status marker per card, by the List's precedence", async () => {
    const t = await made(
      [
        { name: "L", start: "2026-11-02", dur: 2 },
        { name: "P", start: "2026-11-10", dur: 3, status: "doing" },
        { name: "C", start: "2026-11-11", dur: 1, deps: [fs("P")] },
        { name: "D", start: "2026-11-03", status: "done", progress: 100 },
        { name: "U" },
        { name: "X", start: "2026-11-20", dur: 2 },
      ],
      { clashes: [{ unit: "s:X", mac: ["2026-11-20", 2, "todo", 0, "now"], iphone: ["2026-11-23", 2, "todo", 0, "now"] }] },
    );
    await board(t);
    const dot = (id: string): string[] => [...one(".dot", card(id)).classList];
    expect(dot("X")).toEqual(["dot", "held"]);
    expect(dot("L")).toEqual(["dot", "late"]);
    expect(dot("C")).toEqual(["dot", "conflict"]);
    expect(dot("P")).toEqual(["dot", "doing"]);
    expect(dot("U")).toEqual(["dot"]);
  });
});

describe("Board moves", () => {
  const SEED: SeedItem[] = [
    { name: "u", horizon: "later" },
    { name: "dated", start: "2026-11-20", dur: 2 },
  ];

  it("gives an unscheduled card dropped on NEXT one step move", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    pointer(card("u"), "down", 10, 10);
    dragTo("u", "next");
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["u"], step: "next" }]]);
    expect(cardsIn("next")).toEqual(["u"]);
    expect(uiNow().selected).toBeNull();
    expect(toastTexts()).toEqual([MOVED_U]);
  });

  it("moves a dated card too, by its step", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    dragTo("dated", "next");
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["dated"], step: "next" }]]);
    expect(cardsIn("now")).toEqual([]);
    expect(cardsIn("next")).toEqual(["dated"]);
  });

  it("does nothing for a drop on the card's own column", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    dragTo("u", "later");
    dragTo("dated", "now");
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });

  it("does the same through Move to in each card's menu", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    openCardMenu("u");
    expect(moveToRows()).toEqual([
      ["Now", "false"],
      ["Next", "false"],
      ["Later", "true"],
      ["Done", "false"],
    ]);
    chooseRow("Later");
    expect(apply).not.toHaveBeenCalled();
    openCardMenu("u");
    chooseRow("Next");
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["u"], step: "next" }]]);
    openCardMenu("dated");
    chooseRow("Later");
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["u"], step: "next" }], [{ t: "toStep", items: ["dated"], step: "later" }]]);
    expect(cardsIn("later")).toEqual(["dated"]);
    expect(toastTexts()).toEqual([MOVED_U, "Moved “dated” to “Later”."]);
    expect(uiNow().selected).toBeNull();
  });

  it("cancels a drag whose item is trashed mid-gesture, with no write", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
    act(() => {
      fireEvent.dragStart(card("u"), { dataTransfer });
    });
    act(() => {
      t.session.apply({ t: "trash", items: ["u"] });
    });
    apply.mockClear();
    act(() => {
      fireEvent.drop(col("next"), { dataTransfer });
    });
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector('[data-card="u"]')).toBeNull();
  });
  it("keeps a column lit while the pointer moves onto its children, and clears it on leaving", async () => {
    const t = await made(SEED);
    await board(t);
    const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
    act(() => {
      fireEvent.dragStart(card("u"), { dataTransfer });
    });
    act(() => {
      fireEvent.dragOver(col("next"), { dataTransfer });
    });
    expect(col("next").classList.contains("over")).toBe(true);
    const leave = (to: Element): void => {
      act(() => {
        col("next").dispatchEvent(new MouseEvent("dragleave", { bubbles: true, relatedTarget: to }));
      });
    };
    leave(one(".col-body", col("next")));
    expect(col("next").classList.contains("over")).toBe(true);
    leave(col("later"));
    expect(col("next").classList.contains("over")).toBe(false);
  });

  it("fails loudly when the dragged item is not in the plan at all", async () => {
    const t = await made(SEED);
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
    act(() => {
      fireEvent.dragStart(card("u"), { dataTransfer });
    });
    const real = t.session.view();
    const stripped = { ...real, plan: { ...real.plan, items: new Map([...real.plan.items].filter(([id]) => id !== "u")) } };
    vi.spyOn(t.session, "view").mockReturnValue(stripped);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    act(() => t.session.setReadOnly(false));
    expect(document.querySelector('[data-card="u"]')).toBeNull();
    act(() => {
      fireEvent.drop(col("next"), { dataTransfer });
    });
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual(["Board: dragged item u is not in the plan"]);
  });
});

describe("Board clicks (refinement 48)", () => {
  it.each([false, true])("opens a clicked card and issues nothing (read-only %s)", async (readOnly) => {
    const t = await made([{ name: "a", start: "2026-11-20" }]);
    act(() => t.session.setReadOnly(readOnly));
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    pointer(card("a"), "down", 10, 10);
    pointer(card("a"), "up", 12, 11);
    expect(uiNow().selected).toBe("a");
    expect(card("a").classList.contains("selected")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("selects nothing for a pointer that moved 4 px or more", async () => {
    const t = await made([{ name: "a", start: "2026-11-20" }]);
    await board(t);
    pointer(card("a"), "down", 10, 10);
    pointer(card("a"), "up", 14, 10);
    expect(uiNow().selected).toBeNull();
  });

  it("selects a card and renames it on Enter, and opens it as the item modal on Space", async () => {
    const t = await made([{ name: "a", start: "2026-11-20" }]);
    await board(t);
    act(() => {
      card("a").focus();
      fireEvent.keyDown(card("a"), { key: "Enter" });
    });
    const name = document.querySelector('#inspector [data-detail-field="name"]');
    expect([uiNow().selected, uiNow().dialog, document.activeElement === name && name !== null]).toEqual(["a", null, true]);
    act(() => {
      card("a").focus();
      fireEvent.keyDown(card("a"), { key: " " });
    });
    expect([uiNow().selected, uiNow().dialog, document.querySelector("[data-item-modal] [data-detail]")?.getAttribute("data-detail-item")]).toEqual(["a", { t: "item" }, "a"]);
  });
});

describe("Board read-only", () => {
  it("drops every drag, offers only Open in the card menu, and ignores drops", async () => {
    const t = await made([
      { name: "u", horizon: "later" },
      { name: "a", start: "2026-11-20" },
    ]);
    await board(t);
    expect(all("[data-card]").map((c) => c.draggable)).toEqual([true, true]);
    expect(all("select")).toHaveLength(0);
    openCardMenu("u");
    expect(menuRows().map(([title]) => title)).toEqual(["Open", "Now", "Next", "Later", "Done", "Duplicate", "Delete"]);
    act(() => {
      fireEvent.keyDown(one(".context-menu"), { key: "Escape" });
    });
    act(() => t.session.setReadOnly(true));
    const apply = vi.spyOn(t.session, "apply");
    expect(all("[data-card]").map((c) => c.draggable)).toEqual([false, false]);
    openCardMenu("u");
    expect(menuRows()).toEqual([["Open", null]]);
    chooseRow("Open");
    expect(document.querySelector("[data-item-modal] [data-detail]")?.getAttribute("data-detail-item")).toBe("u");
    dragTo("u", "next");
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });
});

describe("Board empty columns (refinement 50)", () => {
  it("reads Nothing here. in every column of an empty plan", async () => {
    const t = await made([]);
    await board(t);
    expect(all(".col-body").map((e) => e.textContent)).toEqual(["Nothing here.", "Nothing here.", "Nothing here."]);
    expect(all(".col-body p.note")).toHaveLength(3);
  });

  it("fills only the column that holds a card", async () => {
    const t = await made([{ name: "a", start: "2026-11-20" }]);
    await board(t);
    expect(cardsIn("now")).toEqual(["a"]);
    expect(one(".col-body", col("now")).querySelector(".note")).toBeNull();
    expect(one(".col-body", col("next")).textContent).toBe("Nothing here.");
    expect(one(".col-body", col("later")).textContent).toBe("Nothing here.");
  });
});

describe("Board under search", () => {
  const SEED: SeedItem[] = [
    { id: "a", name: "Dome A", start: "2026-11-20", dur: 2 },
    { id: "r", name: "Rail", start: "2026-11-19", dur: 2 },
    { id: "b", name: "Dome B", horizon: "next" },
    { id: "w", name: "Wiring" },
    { id: "d", name: "Done dome", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  ];

  const setUiNow = (patch: Partial<UiState>): void => {
    const results = vi.mocked(useUi).mock.results;
    const r = results[results.length - 1];
    if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
    act(() => r.value[1](patch));
  };

  it("drops cards that do not match under a Filtered chip, keeps totals and reads the emptied column", async () => {
    const t = await made(SEED);
    await board(t);
    expect(document.querySelector("[data-filter-chip]")).toBeNull();
    setUiNow({ query: "dome" });
    expect(cardsIn("now")).toEqual(["a"]);
    expect(cardsIn("next")).toEqual(["b"]);
    expect(cardsIn("later")).toEqual([]);
    expect(all(".col-head .col-count").map((e) => e.textContent)).toEqual(["2", "1", "1"]);
    expect(one('[data-strip="done"] .strip-count').textContent).toBe("1");
    expect(one(".col-body", col("later")).textContent).toBe("Nothing here matches “dome”.");
    const chip = one(".board-line span.filter-chip[data-filter-chip]");
    expect(chip.textContent).toBe("Filtered: dome");
    const clear = within(chip).getByRole("button", { name: "Clear search" });
    expect(clear.classList.contains("chip-x")).toBe(true);
    act(() => {
      fireEvent.click(clear);
    });
    expect(uiNow().query).toBe("");
    expect(document.querySelector("[data-filter-chip]")).toBeNull();
    expect(cardsIn("now")).toEqual(["a", "r"]);
    expect(cardsIn("later")).toEqual(["w"]);
  });

  it("trims the query in the chip and the note, and still reads Nothing here. for a column with no cards at all", async () => {
    const t = await made([{ id: "a", name: "Dome A", start: "2026-11-20", dur: 2 }]);
    await board(t);
    setUiNow({ query: "  rail " });
    expect(one("[data-filter-chip]").textContent).toBe("Filtered: rail");
    expect(one(".col-body", col("now")).textContent).toBe("Nothing here matches “rail”.");
    expect(one(".col-body", col("next")).textContent).toBe("Nothing here.");
  });

  it("steps J and K over the matching cards only", async () => {
    const t = await made(SEED);
    await board(t);
    setUiNow({ query: "dome", selected: "a" });
    act(() => {
      fireEvent.keyDown(document.body, { key: "j" });
    });
    expect(uiNow().selected).toBe("b");
    act(() => {
      fireEvent.keyDown(document.body, { key: "j" });
    });
    expect(uiNow().selected).toBe("b");
    act(() => {
      fireEvent.keyDown(document.body, { key: "k" });
    });
    expect(uiNow().selected).toBe("a");
  });
});
