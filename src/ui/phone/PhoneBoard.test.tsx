import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepColour } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { projectBoard, stepModeOf, stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { BareDetail } from "../../test/detail";
import { setReducedMotion } from "../../test/matchMedia";
import { IPHONE, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { TEST_PLAN, testSession, type SeedItem, type TestSession } from "../../test/session";
import { emitFromRust, resetTauri, tauri } from "../../test/tauriMock";
import { themed } from "../../test/theme";
import { CardBody } from "../board/Card";
import { boardLayout } from "../board/layout";
import { boardKey, EMPTY_BOARD_PREFS } from "../board/prefs";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { clearToasts, Toasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { UiContext, type UiState } from "../state";
import { PhoneBoard } from "./PhoneBoard";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];
let unstub: () => void = () => undefined;

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
  setPlatform(IPHONE);
  unstub = stubVisualViewport();
});

afterEach(async () => {
  cleanup();
  clearToasts();
  unstub();
  vi.restoreAllMocks();
  vi.mocked(Element.prototype.scrollTo).mockReset();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
  setPlatform(MAC);
});

const UI: UiState = {
  plan: null,
  view: "board",
  zoom: "W",
  selected: null,
  collapsed: new Set(),
  baseline: null,
  dialog: null,
  reveal: null,
  follow: null,
  naming: null,
  settings: null,
  settingsRow: null,
  syncPane: null,
  sidebarOpen: true,
  sidebarWidth: null,
  query: "",
  searchAsk: 0,
  columnsAsk: 0,
};

interface Live {
  ui: UiState;
  setUi(patch: Partial<UiState>): void;
}

const live: Live = { ui: UI, setUi: () => undefined };

function Harness(p: { session: PlanSession; initial: Partial<UiState> }) {
  const [ui, setState] = useState<UiState>({ ...UI, ...p.initial });
  const setUi = useCallback((patch: Partial<UiState>) => setState((s) => ({ ...s, ...patch })), []);
  live.ui = ui;
  live.setUi = setUi;
  return (
    <UiContext.Provider value={{ ui, setUi }}>
      <BareDetail>
        <PhoneBoard session={p.session} />
      </BareDetail>
    </UiContext.Provider>
  );
}

const made = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return t;
};

const shown = (t: TestSession, initial: Partial<UiState> = {}): void => {
  render(
    themed(
      <OpenChoice.Provider value={vi.fn()}>
        <Harness session={t.session} initial={initial} />
        <Toasts />
      </OpenChoice.Provider>,
    ),
  );
};

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const all = (sel: string, root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

const pager = (): HTMLElement => one(".board-pages");
const tab = (key: string): HTMLElement => one(`.step-tab[data-page="${key}"]`);
const page = (key: string): HTMLElement => one(`.board-page[data-page="${key}"]`);
const card = (id: string): HTMLElement => one(`[data-card="${id}"]`);
const keys = (): (string | undefined)[] => all(".step-tab").map((e) => e.dataset.page);
const selectedTab = (): string | undefined => one('.step-tab[aria-selected="true"]').dataset.page;
const cardsIn = (key: string): (string | undefined)[] => all("[data-card]", page(key)).map((c) => c.dataset.card);
const stored = (): unknown => JSON.parse(window.localStorage.getItem(boardKey(TEST_PLAN)) ?? "null");

const WIDTH = 390;

const rectOf = Element.prototype.getBoundingClientRect;

const laidOut = (): void => {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("board-pages") ? WIDTH : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const parent = this.parentElement;
    if (!this.classList.contains("board-page") || parent === null) return rectOf.call(this);
    return new DOMRect([...parent.children].indexOf(this) * WIDTH - parent.scrollLeft, 0, WIDTH, 600);
  });
  vi.mocked(Element.prototype.scrollTo).mockImplementation(function (this: Element, arg?: ScrollToOptions | number) {
    if (typeof arg === "object" && arg.left !== undefined) this.scrollLeft = arg.left;
  });
};

const sized = (): HTMLElement => {
  laidOut();
  return pager();
};

const scrollAt = (left: number): void => {
  const el = pager();
  el.scrollLeft = left;
  act(() => {
    fireEvent.scroll(el);
  });
};

const scrollCalls = (): unknown[] => vi.mocked(Element.prototype.scrollTo).mock.calls.map((c) => c[0]);
const scrolledOn = (): unknown[] => vi.mocked(Element.prototype.scrollTo).mock.contexts;
const lastIntoView = (): [unknown, unknown] => {
  const m = vi.mocked(Element.prototype.scrollIntoView).mock;
  return [m.contexts[m.contexts.length - 1], m.calls[m.calls.length - 1]?.[0]];
};

const stepId = (t: TestSession, name: string): string => {
  const found = stepsOf(t.session.view().plan).find((s) => s.name === name);
  if (found === undefined) throw new Error("no step " + name);
  return found.id;
};

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
const rowsOf = (sent: Sent): [string | null, [string, string, boolean][]][] => sent.sections.map((x) => [x.title, x.rows.map((r) => [r.id, r.title, r.checked])]);
const haptics = (): unknown[] => tauri.calls.filter((c) => c.cmd === "haptic").map((c) => c.args);
const wait = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, ms));
  });
};
const scrollBlocked = (): boolean => {
  const e = new Event("touchmove", { cancelable: true });
  document.dispatchEvent(e);
  return e.defaultPrevented;
};

const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", el: HTMLElement, x: number, y: number): void => {
  act(() => {
    fireEvent[type](el, { pointerType: "touch", pointerId: 7, button: 0, clientX: x, clientY: y });
  });
};

const CREW: readonly (readonly [string, string, StepColour])[] = [["Mira Okafor", "MO", "violet"]];

const SEED: SeedItem[] = [
  { name: "soon", start: "2026-11-20", dur: 2 },
  { name: "mid", start: "2026-12-15", dur: 2 },
  { name: "d1", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  { name: "u", horizon: "next" },
  { name: "w" },
];

describe("PhoneBoard pages", () => {
  it("gives Now, Next, Later and a folded Done by dates, with the phone's by-dates line", async () => {
    const t = await made(SEED);
    shown(t);
    expect(keys()).toEqual(["now", "next", "later", "done"]);
    expect(all(".step-tab .step-tab-name").map((e) => e.textContent)).toEqual(["Now", "Next", "Later", "Done"]);
    expect(all(".step-tab").map((e) => e.getAttribute("aria-label"))).toEqual(["Now, 1 item", "Next, 2 items", "Later, 1 item", "Done, 1 item, collapsed"]);
    expect(one('.step-bar[role="tablist"]').getAttribute("aria-label")).toBe("Steps");
    expect(one("[data-by-dates]").textContent).toBe("Pages follow dates. Move a card or add one to use your own steps.");
    expect(selectedTab()).toBe("now");
    expect(all(".step-tab").map((e) => e.tabIndex)).toEqual([0, -1, -1, -1]);
    expect([tab("done").dataset.folded, tab("now").dataset.folded]).toEqual(["", undefined]);
    expect(tab("next").getAttribute("aria-controls")).toBe(page("next").id);
    expect(page("next").getAttribute("aria-labelledby")).toBe(tab("next").id);
    expect(one("h2", page("next")).textContent).toBe("NEXT");
    expect(cardsIn("next")).toEqual(["mid", "u"]);
    expect(one(".page-folded", page("done")).textContent).toBe("Collapsed on this device: 1 item.");
    expect(within(page("done")).getByRole("button", { name: "Done, 1 item. Expand" }).textContent).toBe("Expand");
    expect(page("done").querySelector("[data-card]")).toBeNull();
    expect(all(".col-add").map((e) => e.getAttribute("aria-label"))).toEqual(["Add a task to Now", "Add a task to Next", "Add a task to Later"]);
  });

  it("puts No step first, with its line, badge and Move all to…", async () => {
    const t = await made([...SEED, { name: "x" }]);
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    const qa = stepId(t, "QA");
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "toStep", items: ["w", "x"], step: qa });
    t.session.apply({ t: "step", op: "delete", step: qa, to: null });
    phone.sync();
    shown(t);
    expect(keys()[0]).toBe("no-step");
    expect(one(".step-tab-name", tab("no-step")).textContent).toBe("No step");
    expect(tab("no-step").getAttribute("aria-label")).toBe("No step, 2 items");
    expect(tab("no-step").style.getPropertyValue("--step")).toBe("var(--amber)");
    expect(selectedTab()).toBe("no-step");
    expect(one("h2", page("no-step")).textContent).toBe("NO STEP");
    expect(one(".swatch", page("no-step")).classList.contains("warn")).toBe(true);
    expect(one(".col-badge", page("no-step")).textContent).toBe("2");
    expect(one(".col-note", page("no-step")).textContent).toContain("These items point at a step another device deleted.");
    expect(within(page("no-step")).getByRole("button", { name: "Move all to…" })).toBeTruthy();
    expect(page("no-step").querySelector(".col-add")).toBeNull();
    expect(cardsIn("no-step")).toEqual(["w", "x"]);
  });

  it("marks a page over its limit in its tab and head", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "toStep", items: ["w"], step: "next" });
      t.session.apply({ t: "step", op: "limit", step: "next", limit: 1 });
    });
    shown(t);
    expect(tab("next").getAttribute("aria-label")).toMatch(/^Next, \d items, over the limit of 1$/);
    expect(one(".step-tab-count", tab("next")).classList.contains("over")).toBe(true);
    const count = one(".col-count", page("next"));
    expect([count.classList.contains("over"), count.title]).toEqual([true, "Over the limit of 1"]);
  });
});

describe("PhoneBoard paging", () => {
  it("selects a tapped tab and scrolls the pager to its page, instantly under Reduce Motion", async () => {
    const t = await made(SEED);
    shown(t);
    const el = sized();
    act(() => {
      fireEvent.click(tab("later"));
    });
    expect(selectedTab()).toBe("later");
    expect(scrollCalls()).toEqual([{ left: 2 * WIDTH, behavior: "smooth" }]);
    expect(scrolledOn()).toEqual([el]);
    expect(lastIntoView()).toEqual([tab("later"), { block: "nearest", inline: "nearest" }]);
    setReducedMotion(true);
    act(() => {
      fireEvent.click(tab("now"));
    });
    expect(scrollCalls()[1]).toEqual({ left: 0, behavior: "auto" });
  });

  it("does not aim at the page it is on, so a later scroll without a touch still selects", async () => {
    const t = await made(SEED);
    shown(t);
    sized();
    act(() => {
      fireEvent.click(tab("now"));
    });
    expect(scrollCalls()).toEqual([]);
    scrollAt(WIDTH);
    expect(selectedTab()).toBe("next");
  });

  it("ends the aim when the pager's scroll ends short of it, selecting where it stopped", async () => {
    const t = await made(SEED);
    shown(t);
    sized();
    act(() => {
      fireEvent.click(tab("done"));
    });
    scrollAt(WIDTH);
    expect(selectedTab()).toBe("done");
    act(() => {
      fireEvent(pager(), new Event("scrollend"));
    });
    expect(selectedTab()).toBe("next");
    scrollAt(2 * WIDTH);
    expect(selectedTab()).toBe("later");
  });

  it("selects a tab tapped before the pager has a width, and pages there once it has one", async () => {
    const watched: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          watched.push(cb);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const t = await made(SEED);
    shown(t);
    act(() => {
      fireEvent.click(tab("later"));
    });
    expect([selectedTab(), scrollCalls()]).toEqual(["later", []]);
    laidOut();
    act(() => watched.forEach((cb) => cb()));
    expect([selectedTab(), scrollCalls(), pager().scrollLeft]).toEqual(["later", [{ left: 2 * WIDTH, behavior: "auto" }], 2 * WIDTH]);
    vi.unstubAllGlobals();
  });

  it("shows no tabs and no pages when a merge leaves the plan without steps, and pages again once one is added", async () => {
    const t = await made([]);
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    act(() => {
      ["now", "next", "done"].forEach((step) => t.session.apply({ t: "step", op: "delete", step, to: null }));
      phone.session.apply({ t: "step", op: "delete", step: "later", to: null });
      phone.sync();
    });
    expect(stepsOf(t.session.view().plan)).toEqual([]);
    shown(t);
    expect([keys(), all(".board-page").length, one("[data-empty-board]").textContent]).toEqual([[], 0, "Every step in this plan completes items, so no open card has a column."]);
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: null });
    });
    const qa = stepId(t, "QA");
    expect([keys(), selectedTab()]).toEqual([[qa], qa]);
  });

  it("selects the page a scroll lands on and brings its tab into view, ignoring a pager with no width", async () => {
    const t = await made(SEED);
    shown(t);
    scrollAt(WIDTH);
    expect(selectedTab()).toBe("now");
    sized();
    scrollAt(WIDTH + 100);
    expect(selectedTab()).toBe("next");
    expect(lastIntoView()).toEqual([tab("next"), { block: "nearest", inline: "nearest" }]);
    scrollAt(9 * WIDTH);
    expect(selectedTab()).toBe("done");
  });

  it("ignores scrolls on the way to a tapped page, and a touch on the pager ends the aim", async () => {
    const t = await made(SEED);
    shown(t);
    sized();
    act(() => {
      fireEvent.click(tab("later"));
    });
    scrollAt(WIDTH);
    expect(selectedTab()).toBe("later");
    scrollAt(2 * WIDTH - 1);
    expect(selectedTab()).toBe("later");
    scrollAt(0);
    expect(selectedTab()).toBe("now");
    act(() => {
      fireEvent.click(tab("done"));
    });
    scrollAt(WIDTH);
    expect(selectedTab()).toBe("done");
    act(() => {
      fireEvent.pointerDown(pager(), { pointerType: "touch", pointerId: 3 });
    });
    scrollAt(WIDTH);
    expect(selectedTab()).toBe("next");
  });

  it("pages and focuses with ArrowLeft, ArrowRight, Home and End on the tabs", async () => {
    const t = await made(SEED);
    shown(t);
    sized();
    const press = (key: string): void => {
      act(() => {
        fireEvent.keyDown(one('.step-tab[aria-selected="true"]'), { key });
      });
    };
    press("ArrowRight");
    expect([selectedTab(), document.activeElement]).toEqual(["next", tab("next")]);
    press("End");
    expect([selectedTab(), document.activeElement]).toEqual(["done", tab("done")]);
    press("ArrowRight");
    expect(selectedTab()).toBe("now");
    press("ArrowLeft");
    expect(selectedTab()).toBe("done");
    press("Home");
    expect([selectedTab(), document.activeElement]).toEqual(["now", tab("now")]);
    expect(scrollCalls()[scrollCalls().length - 1]).toEqual({ left: 0, behavior: "smooth" });
  });

  it("opens on the selection's page, and a new selection on another page pages there", async () => {
    const t = await made(SEED);
    laidOut();
    shown(t, { selected: "mid" });
    expect([selectedTab(), scrollCalls(), pager().scrollLeft]).toEqual(["next", [{ left: WIDTH, behavior: "auto" }], WIDTH]);
    vi.mocked(Element.prototype.scrollTo).mockClear();
    act(() => {
      live.setUi({ selected: "soon" });
    });
    expect(selectedTab()).toBe("now");
    expect(scrollCalls()).toEqual([{ left: 0, behavior: "smooth" }]);
    act(() => {
      live.setUi({ selected: "d1" });
    });
    expect(selectedTab()).toBe("now");
  });

  it("keeps the index when the current step is deleted", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "toStep", items: ["w"], step: "next" });
      t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    });
    const qa = stepId(t, "QA");
    shown(t);
    sized();
    expect(keys()).toEqual(["now", "next", "later", qa, "done"]);
    act(() => {
      fireEvent.click(tab(qa));
    });
    scrollAt(3 * WIDTH);
    vi.mocked(Element.prototype.scrollTo).mockClear();
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: qa, to: null });
    });
    expect(keys()).toEqual(["now", "next", "later", "done"]);
    expect(selectedTab()).toBe("done");
    expect([scrollCalls(), pager().scrollLeft]).toEqual([[], 3 * WIDTH]);
  });

  it("follows its step when steps move", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "toStep", items: ["w"], step: "next" });
    });
    shown(t);
    sized();
    act(() => {
      fireEvent.click(tab("later"));
    });
    scrollAt(2 * WIDTH);
    vi.mocked(Element.prototype.scrollTo).mockClear();
    act(() => {
      t.session.apply({ t: "step", op: "reorder", step: "later", after: null });
    });
    expect([keys()[0], selectedTab()]).toEqual(["later", "later"]);
    expect(scrollCalls()).toEqual([{ left: 0, behavior: "auto" }]);
  });
});

describe("PhoneBoard prefs", () => {
  it("expands a folded Done and shows a hidden step, writing the device's Board settings", async () => {
    window.localStorage.setItem(boardKey(TEST_PLAN), JSON.stringify({ v: 1, hidden: ["later"], doneOpen: false }));
    const t = await made(SEED);
    shown(t);
    expect(tab("later").dataset.hidden).toBe("");
    expect(tab("later").getAttribute("aria-label")).toBe("Later, hidden on this device, 1 item");
    expect(one(".page-hidden", page("later")).textContent).toBe("Hidden on this device: 1 item.");
    act(() => {
      fireEvent.click(within(page("done")).getByRole("button", { name: "Done, 1 item. Expand" }));
    });
    expect(stored()).toEqual({ v: 1, hidden: ["later"], doneOpen: true });
    expect([tab("done").dataset.folded, cardsIn("done")]).toEqual([undefined, ["d1"]]);
    const show = within(page("later")).getByRole("button", { name: "Later, hidden on this device, 1 item. Show" });
    expect(show.textContent).toBe("Show");
    act(() => {
      fireEvent.click(show);
    });
    expect(stored()).toEqual({ v: 1, hidden: [], doneOpen: true });
    expect(tab("later").dataset.hidden).toBeUndefined();
    act(() => {
      fireEvent.click(within(page("done")).getByRole("button", { name: "Collapse Done" }));
    });
    expect(stored()).toEqual({ v: 1, hidden: [], doneOpen: false });
    expect(tab("done").dataset.folded).toBe("");
  });
});

describe("PhoneBoard +", () => {
  it("creates a task with the Defaults in the page's step, selects and names it, in one action", async () => {
    const t = await made([{ id: "g", name: "Commission", kind: "group" }, ...SEED]);
    act(() => {
      CREW.forEach(([name, initials, colour]) => t.session.apply({ t: "person", op: "add", name, initials, colour, after: null }));
    });
    const mo = peopleOf(t.session.view().plan)[0]?.id;
    if (mo === undefined) throw new Error("no person");
    act(() => {
      t.session.apply({ t: "defaults", field: "who", value: mo });
      t.session.apply({ t: "defaults", field: "group", value: "g" });
    });
    shown(t);
    sized();
    act(() => {
      fireEvent.click(tab("next"));
    });
    scrollAt(WIDTH);
    vi.mocked(Element.prototype.scrollTo).mockClear();
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.click(within(page("next")).getByRole("button", { name: "Add a task to Next" }));
    });
    expect(apply.mock.calls).toEqual([[{ t: "create", kind: "task", name: "New task", parent: "g", after: null, start: null, step: "next", who: mo }]]);
    const added = [...t.session.view().plan.items.values()].find((i) => i.name === "New task");
    if (added === undefined) throw new Error("no new task");
    expect([live.ui.selected, live.ui.naming]).toEqual([added.id, added.id]);
    expect(cardsIn("next")).toContain(added.id);
    expect(selectedTab()).toBe("next");
    expect(scrollCalls()).toEqual([]);
  });

  it("refuses a + whose step another device deleted before the page caught up", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    });
    const qa = stepId(t, "QA");
    shown(t);
    const add = within(page(qa)).getByRole("button", { name: "Add a task to QA" });
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "step", op: "delete", step: qa, to: null });
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      phone.sync();
      fireEvent.click(add);
    });
    await settle();
    expect([apply.mock.calls, live.ui.selected, screen.getByText(STALE_CONFIRM).textContent]).toEqual([[], null, STALE_CONFIRM]);
  });

  it("offers no + and only Open in the card menu on a read-only plan", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.setReadOnly(true);
    });
    shown(t);
    expect(document.querySelector(".col-add")).toBeNull();
    act(() => {
      fireEvent.contextMenu(card("u"));
    });
    await settle();
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(asks().map((s) => s.sections.map((x) => x.rows.map((r) => [r.id, r.title])))).toEqual([[[["open", "Open"]]]]);
  });
});

describe("PhoneBoard cards", () => {
  it("opens a card on a touch tap or a mouse click, and not after a move", async () => {
    const t = await made(SEED);
    shown(t);
    touch("pointerDown", card("u"), 20, 20);
    touch("pointerUp", card("u"), 60, 20);
    expect(live.ui.selected).toBeNull();
    touch("pointerDown", card("u"), 20, 20);
    touch("pointerUp", card("u"), 21, 20);
    expect(live.ui.selected).toBe("u");
    expect(card("u").classList.contains("selected")).toBe(true);
    act(() => {
      fireEvent.pointerDown(card("mid"), { button: 0, clientX: 5, clientY: 5 });
    });
    act(() => {
      fireEvent.pointerUp(card("mid"), { button: 0, clientX: 5, clientY: 5 });
    });
    expect(live.ui.selected).toBe("mid");
  });

  it("lifts a touch-held card with one medium haptic, blocks scrolling, and opens the native card rows on release", async () => {
    const t = await made(SEED);
    shown(t);
    touch("pointerDown", card("u"), 50, 50);
    expect(scrollBlocked()).toBe(false);
    await wait(520);
    expect(haptics()).toEqual([{ kind: "medium" }]);
    expect(card("u").classList.contains("lifted")).toBe(true);
    expect(scrollBlocked()).toBe(true);
    act(() => {
      fireEvent.contextMenu(card("u"));
    });
    await settle();
    expect(asks()).toEqual([]);
    touch("pointerUp", card("u"), 51, 50);
    await settle();
    expect([card("u").classList.contains("lifted"), scrollBlocked(), live.ui.selected]).toEqual([false, false, null]);
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(asks().map(rowsOf)).toEqual([
      [
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
      ],
    ]);
    expect(haptics()).toHaveLength(1);
  });

  it("opens nothing when the finger moves after the hold, and ends the lift on a cancel", async () => {
    const t = await made(SEED);
    shown(t);
    const apply = vi.spyOn(t.session, "apply");
    touch("pointerDown", card("w"), 50, 50);
    await wait(520);
    expect(card("w").classList.contains("lifted")).toBe(true);
    touch("pointerMove", card("w"), 50, 120);
    expect([card("w").classList.contains("lifted"), scrollBlocked()]).toEqual([false, false]);
    touch("pointerUp", card("w"), 50, 120);
    await settle();
    expect([asks(), apply.mock.calls, live.ui.selected, document.querySelector(".lifted"), scrollBlocked()]).toEqual([[], [], null, null, false]);
    touch("pointerDown", card("u"), 50, 50);
    await wait(520);
    touch("pointerUp", card("u"), 50, 130);
    await settle();
    expect([asks(), live.ui.selected, document.querySelector(".lifted")]).toEqual([[], null, null]);
    touch("pointerDown", card("mid"), 50, 50);
    await wait(520);
    act(() => {
      fireEvent.pointerCancel(card("mid"), { pointerType: "touch", pointerId: 7 });
    });
    await settle();
    expect([asks(), document.querySelector(".lifted"), scrollBlocked()]).toEqual([[], null, false]);
    expect(haptics()).toHaveLength(3);
  });

  it("ends a hold whose finger lifts off the card, and frees scrolling when the Board goes away", async () => {
    const t = await made(SEED);
    shown(t);
    touch("pointerDown", card("w"), 50, 50);
    await wait(520);
    act(() => {
      fireEvent.pointerUp(document.body, { pointerType: "touch", pointerId: 7, clientX: 50, clientY: 50 });
    });
    expect([document.querySelector(".lifted"), scrollBlocked()]).toEqual([null, false]);
    touch("pointerDown", card("u"), 50, 50);
    touch("pointerUp", card("u"), 50, 50);
    expect(live.ui.selected).toBe("u");
    touch("pointerDown", card("w"), 50, 50);
    await wait(520);
    expect(scrollBlocked()).toBe(true);
    cleanup();
    expect(scrollBlocked()).toBe(false);
  });

  it("selects the card when the native menu's Open is chosen", async () => {
    const t = await made(SEED);
    shown(t);
    touch("pointerDown", card("u"), 50, 50);
    await wait(520);
    touch("pointerUp", card("u"), 50, 50);
    await settle();
    chooseNative("open");
    expect(live.ui.selected).toBe("u");
    expect(selectedTab()).toBe("next");
  });

  it("moves a card by dates to a step from the native menu, switching to steps in one undoable action", async () => {
    const t = await made(SEED);
    shown(t);
    const apply = vi.spyOn(t.session, "apply");
    touch("pointerDown", card("soon"), 50, 50);
    await wait(520);
    touch("pointerUp", card("soon"), 50, 50);
    await settle();
    chooseNative("step:next");
    expect(apply.mock.calls).toEqual([[{ t: "toStep", items: ["soon"], step: "next" }]]);
    expect(stepModeOf(t.session.view().plan)).toBe("steps");
    expect(document.querySelector("[data-by-dates]")).toBeNull();
    expect(cardsIn("next")).toEqual(["soon", "mid", "u"]);
    act(() => {
      t.session.undo();
    });
    expect(stepModeOf(t.session.view().plan)).toBe("dates");
    expect(cardsIn("now")).toEqual(["soon"]);
  });

  it("names a card as a button with a menu, expanded while its menu is open", async () => {
    const t = await made(SEED);
    shown(t);
    const aria = (): (string | null)[] => ["role", "aria-haspopup", "aria-expanded"].map((a) => card("u").getAttribute(a));
    expect(aria()).toEqual(["button", "menu", "false"]);
    act(() => {
      fireEvent.contextMenu(card("u"));
    });
    await settle();
    expect([aria(), card("mid").getAttribute("aria-expanded")]).toEqual([["button", "menu", "true"], "false"]);
    act(() => {
      emitFromRust("menu-ended", { token: lastAsk().token });
    });
    expect(aria()).toEqual(["button", "menu", "false"]);
  });

  it("throws for a card whose item has no schedule, as the desktop Board does", async () => {
    const t = await made(SEED);
    const item = t.session.view().plan.items.get("u");
    if (item === undefined) throw new Error("no u");
    const view = t.session.view();
    const layout = boardLayout(view, projectBoard(view.plan, view.derived), EMPTY_BOARD_PREFS);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(themed(<CardBody view={view} layout={layout} item={{ ...item, schedule: null }} />))).toThrow("Board: item u has no schedule");
  });

  it("opens a card with Enter or Space", async () => {
    const t = await made(SEED);
    shown(t);
    expect(card("u").tabIndex).toBe(0);
    act(() => {
      fireEvent.keyDown(card("u"), { key: "Enter" });
    });
    expect(live.ui.selected).toBe("u");
    act(() => {
      fireEvent.keyDown(card("mid"), { key: " " });
    });
    expect(live.ui.selected).toBe("mid");
    act(() => {
      fireEvent.keyDown(card("soon"), { key: "Enter", metaKey: true });
    });
    expect(live.ui.selected).toBe("mid");
  });

  it("shows a search as the Filtered chip, and its X clears the search", async () => {
    const t = await made(SEED);
    shown(t, { query: "u" });
    expect(one("[data-filter-chip] .chip-text").textContent).toBe("Filtered: u");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    });
    expect(live.ui.query).toBe("");
    expect(document.querySelector("[data-filter-chip]")).toBeNull();
  });
});
