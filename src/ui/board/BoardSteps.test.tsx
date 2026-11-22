import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { shellFor } from "../../test/shell";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { tabOrder } from "../detail/order";
import type { UiState } from "../state";

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

const made = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return t;
};

const board = async (t: TestSession): Promise<void> => {
  render(withSync(shellFor(t).ui));
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: "Now · Next · Later" }));
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
const heads = (): (string | null)[] => all(".col-head h2").map((e) => e.textContent);
const cols = (): (string | undefined)[] => all(".nnl > .col").map((e) => e.dataset.col);

const moveSelect = (id: string): HTMLSelectElement => {
  const el = card(id).querySelector('select[aria-label="Move to"]');
  if (!(el instanceof HTMLSelectElement)) throw new Error("no Move to on " + id);
  return el;
};

const offered = (id: string): (string | null)[] => [...moveSelect(id).options].filter((o) => !o.disabled).map((o) => o.textContent);

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

const stepId = (t: TestSession, name: string): string => {
  const found = stepsOf(t.session.view().plan).find((s) => s.name === name);
  if (found === undefined) throw new Error("no step " + name);
  return found.id;
};

const SEED: SeedItem[] = [
  { name: "soon", start: "2026-11-20", dur: 2 },
  { name: "mid", start: "2026-12-15", dur: 2 },
  { name: "d1", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  { name: "u", horizon: "next" },
  { name: "w" },
];

const BOARD: Pick<UiState, "view" | "collapsed"> = { view: "board", collapsed: new Set() };

describe("Board by steps", () => {
  it("heads columns with the renamed step, keeps three columns and the hidden-done line, and offers the steps in Move to", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
    await board(t);
    expect(heads()).toEqual(["NOW", "REVIEW", "LATER"]);
    expect(cols()).toEqual(["now", "next", "later"]);
    expect(cardsIn("now")).toEqual(["soon"]);
    expect(cardsIn("next")).toEqual(["mid", "u"]);
    expect(cardsIn("later")).toEqual(["w"]);
    expect(all(".col-sub").map((e) => e.textContent)).toEqual(["1 done item is hidden.", "", ""]);
    expect(offered("u")).toEqual(["NOW", "REVIEW", "LATER"]);
    expect(moveSelect("mid").value).toBe("next");
    expect(one(".nnl").style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
    expect(tabOrder(t.session.view(), BOARD)).toEqual(["soon", "mid", "u", "w"]);
  });

  it("moves no card when a date changes", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
    await board(t);
    act(() => {
      t.session.apply({ t: "schedule", item: "mid", set: { start: "2026-11-12" } });
    });
    expect(cardsIn("next")).toEqual(["mid", "u"]);
    expect(cardsIn("now")).toEqual(["soon"]);
  });

  it("sizes the grid to the shown steps and leaves the completing step out", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    await board(t);
    expect(heads()).toEqual(["NOW", "NEXT", "LATER", "QA"]);
    expect(one(".nnl").style.gridTemplateColumns).toBe("repeat(4, minmax(0, 1fr))");
    expect(document.querySelector('[data-col="done"]')).toBeNull();
  });

  it("lists No step first when an item points at a deleted step, and never offers it in Move to", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    const qa = stepId(t, "QA");
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "toStep", items: ["w"], step: qa });
    t.session.apply({ t: "step", op: "delete", step: qa, to: null });
    phone.sync();
    await board(t);
    expect(heads()).toEqual(["NO STEP", "NOW", "NEXT", "LATER"]);
    expect(cols()).toEqual(["no-step", "now", "next", "later"]);
    expect(cardsIn("no-step")).toEqual(["w"]);
    expect(all(".col-sub").map((e) => e.textContent)).toEqual(["1 done item is hidden.", "", "", ""]);
    expect(offered("w")).toEqual(["NOW", "NEXT", "LATER"]);
    expect(offered("soon")).toEqual(["NOW", "NEXT", "LATER"]);
    expect(one(".nnl").style.gridTemplateColumns).toBe("repeat(4, minmax(0, 1fr))");
    expect(tabOrder(t.session.view(), BOARD)).toEqual(["w", "soon", "mid", "u"]);
    const apply = vi.spyOn(t.session, "apply");
    dragTo("soon", "no-step");
    expect(apply).not.toHaveBeenCalled();
    act(() => {
      fireEvent.change(moveSelect("w"), { target: { value: "later" } });
    });
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["w"], step: "later" }]]);
    expect(cols()).toEqual(["now", "next", "later"]);
    expect(cardsIn("later")).toEqual(["w"]);
  });

  it("runs toStep from Move to and from a drag, for dated cards too", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
    await board(t);
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.change(moveSelect("mid"), { target: { value: "next" } });
    });
    expect(apply).not.toHaveBeenCalled();
    act(() => {
      fireEvent.change(moveSelect("mid"), { target: { value: "later" } });
    });
    dragTo("soon", "next");
    dragTo("u", "next");
    expect(apply.mock.calls).toEqual([
      [{ t: "toStep", items: ["mid"], step: "later" }],
      [{ t: "toStep", items: ["soon"], step: "next" }],
    ]);
    expect(cardsIn("now")).toEqual([]);
    expect(cardsIn("next")).toEqual(["soon", "u"]);
    expect(cardsIn("later")).toEqual(["mid", "w"]);
    expect(toastTexts()).toEqual(["Moved “mid” to “Later”.", "Moved “soon” to “Review”."]);
  });

  it("shows an open card whose step completes in that step's column and leaves it out of the hidden-done count", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
    t.session.apply({ t: "toStep", items: ["w"], step: "done" });
    t.session.apply({ t: "step", op: "completes", step: "later", completes: true });
    t.session.apply({ t: "schedule", item: "w", set: { status: "todo", progress: 0 } });
    await board(t);
    expect(heads()).toEqual(["NOW", "REVIEW", "LATER", "DONE"]);
    expect(cardsIn("later")).toEqual(["w"]);
    expect(cardsIn("done")).toEqual([]);
    expect(all(".col-sub").map((e) => e.textContent)).toEqual(["1 done item is hidden.", "", "", ""]);
    expect(one(".nnl").style.gridTemplateColumns).toBe("repeat(4, minmax(0, 1fr))");
    expect(tabOrder(t.session.view(), BOARD)).toEqual(["soon", "mid", "u", "w"]);
    act(() => {
      fireEvent.change(moveSelect("w"), { target: { value: "now" } });
    });
    expect(cardsIn("now")).toEqual(["soon", "w"]);
    expect(cols()).toEqual(["now", "next", "done"]);
  });

  it("says so when every live step completes items, with the hidden-done count", async () => {
    const t = await made([{ name: "d1", start: "2026-11-02", dur: 1, status: "done", progress: 100 }]);
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "step", op: "delete", step: "now", to: null });
    phone.session.apply({ t: "step", op: "delete", step: "next", to: null });
    t.session.apply({ t: "step", op: "delete", step: "later", to: "done" });
    phone.sync();
    expect(stepsOf(t.session.view().plan).map((s) => s.id)).toEqual(["done"]);
    await board(t);
    expect(all(".nnl > .col")).toEqual([]);
    expect(one("[data-empty-board]").textContent).toBe("Every step in this plan completes items, so no open card has a column. 1 done item is hidden.");
    expect(one(".nnl").style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });

  it("shows the Horizon field by dates and hides it by steps", async () => {
    const t = await made(SEED);
    await board(t);
    act(() => {
      card("u").focus();
      fireEvent.keyDown(card("u"), { key: "Enter" });
    });
    expect(document.querySelector('#inspector [data-detail-field="horizon"]')).not.toBeNull();
    act(() => {
      t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
    });
    expect(document.querySelector('#inspector [data-detail-field="horizon"]')).toBeNull();
    expect(document.querySelector('#inspector [data-detail-field="name"]')).not.toBeNull();
  });
});
