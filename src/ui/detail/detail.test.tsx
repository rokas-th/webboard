import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { seedPanesClosed } from "../../test/panes";
import { IPAD, setPlatform } from "../../test/platform";
import { MESA_SEED, testSession, type TestSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { shellFor } from "../../test/shell";
import { resetTauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { PANES_KEY, parsePanes, type PaneKey, type PanesRecord } from "../shell/panes";
import { PLACE_KEY, type ViewKind } from "../state";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];
const ON_IPAD: Partial<Registry> = {
  device: { deviceId: "ipad", name: "iPad", platform: "ios" },
};
const PICKED = "Tracking: review results";

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
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
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const shown = async (
  o: {
    over?: Partial<Registry>;
    view?: ViewKind;
    closed?: readonly PaneKey[];
    t?: TestSession;
  } = {},
): Promise<TestSession> => {
  const t = o.t ?? (await testSession(MESA_SEED));
  sessions.push(t.session);
  window.localStorage.setItem(
    PLACE_KEY,
    JSON.stringify({
      plan: t.session.view().plan.id,
      view: o.view ?? "timeline",
      zoom: "W",
    }),
  );
  seedPanesClosed(o.closed ?? ["outline"]);
  render(withSync(shellFor(t, o.over).ui));
  await settle();
  return t;
};

const bar = (): HTMLElement => {
  const el = document.querySelector("header.toolbar");
  if (!(el instanceof HTMLElement)) throw new Error("no toolbar");
  return el;
};

const toggle = (): HTMLElement => within(bar()).getByRole("button", { name: "Inspector" });

const slot = (): HTMLElement | null => document.querySelector<HTMLElement>(".slot-panel#inspector");

const detail = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-detail]");

const stored = (): PanesRecord => {
  const raw = window.localStorage.getItem(PANES_KEY);
  if (raw === null) throw new Error("no saved panes");
  const record = parsePanes(raw);
  if (record === null) throw new Error("the saved panes do not parse");
  return record;
};

const press = (target: Element | Window, key: string): void => {
  act(() => {
    fireEvent.keyDown(target, { key });
  });
};

const selectedRow = (): string | undefined => document.querySelector<HTMLElement>('.tl-row[aria-selected="true"]')?.dataset.row;

let clock = 1000;

const ticking = (): void => {
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
};

const later = (ms: number): void => {
  clock += ms;
};

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error(`no ${sel}`);
  return el;
};

const clickBar = (id: string, o: { x?: number; dx?: number } = {}): void => {
  const target = one(`[data-bar="${id}"]`);
  const x = o.x ?? 40;
  act(() => {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: 20 });
  });
  act(() => {
    fireEvent.pointerUp(target, { button: 0, pointerId: 1, pointerType: "mouse", clientX: x + (o.dx ?? 0), clientY: 20 });
  });
};

const doubleClickBar = (id: string): void => {
  clickBar(id);
  later(120);
  clickBar(id);
};

const modal = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-item-modal]");

const modalDetail = (): HTMLElement => one('[data-item-modal] [data-detail="modal"]');

const nameIn = (root: ParentNode): HTMLInputElement => {
  const el = one('[data-detail-field="name"]', root);
  if (!(el instanceof HTMLInputElement)) throw new Error("the name field is not an input");
  return el;
};

const nameOf = (t: TestSession, id: string): string | undefined => t.session.view().plan.items.get(id)?.name;

const refuseApply = (t: TestSession): { messages: string[]; restore(): void } => {
  const messages: string[] = [];
  const onError = (e: ErrorEvent): void => {
    messages.push(e.error instanceof Error ? e.error.message : String(e.error));
    e.preventDefault();
  };
  window.addEventListener("error", onError);
  const apply = vi.spyOn(t.session, "apply").mockImplementation(() => {
    throw new Error("the plan refused the name");
  });
  return {
    messages,
    restore: () => {
      window.removeEventListener("error", onError);
      apply.mockRestore();
    },
  };
};

const here = (): Element => document.activeElement ?? document.body;

const scrimPress = (scrim: Element, x: number, y: number): void => {
  const under = vi.spyOn(document, "elementFromPoint").mockReturnValue(scrim);
  act(() => {
    fireEvent.pointerDown(scrim, { button: 0, pointerType: "touch", clientX: x, clientY: y });
  });
  act(() => {
    fireEvent.pointerUp(scrim, { button: 0, pointerType: "touch", clientX: x, clientY: y });
  });
  act(() => {
    fireEvent.click(scrim, { button: 0, clientX: x, clientY: y });
  });
  under.mockRestore();
};

describe("the inspector's detail", () => {
  it("a click reveals a closed column", async () => {
    await shown({ closed: ["outline", "inspector"] });
    expect(slot()).toBeNull();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    expect([slot()?.querySelector("[data-detail]")?.getAttribute("data-detail"), detail()?.dataset.detailItem, stored().desk.inspector.open]).toEqual(["column", "t3", true]);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("deselecting keeps the inspector open, on the plan summary", async () => {
    await shown();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    expect(detail()?.dataset.detailItem).toBe("t3");
    press(document.body, "Escape");
    expect([detail(), slot()?.querySelector(".plan-summary h2")?.textContent, stored().desk.inspector.open]).toEqual([null, "Plan", true]);
  });

  it("column X keeps the selection", async () => {
    await shown();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    const x = slot()?.querySelector(".detail-head .inspector-close");
    if (!(x instanceof HTMLButtonElement)) throw new Error("no X in the column");
    expect(x.getAttribute("aria-label")).toBe("Close");
    fireEvent.click(x);
    expect([slot(), stored().desk.inspector.open, selectedRow()]).toEqual([null, false, "t3"]);
    press(document.body, "j");
    expect([slot()?.querySelector("[data-detail]")?.getAttribute("data-detail-item"), stored().desk.inspector.open]).toEqual(["t4", true]);
  });

  it("column X commits the focused field first and hands focus to the toolbar's Inspector button", async () => {
    const t = await shown();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    const name = nameIn(one("#inspector [data-detail]"));
    act(() => {
      name.focus();
      fireEvent.change(name, { target: { value: "Tracking: closed by X" } });
    });
    fireEvent.click(one("#inspector .inspector-close"));
    expect([nameOf(t, "t3"), slot(), document.activeElement]).toEqual(["Tracking: closed by X", null, toggle()]);
  });

  it("column X keeps the column and the draft when the field's commit throws", async () => {
    const t = await shown();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    const name = nameIn(one("#inspector [data-detail]"));
    act(() => {
      name.focus();
      fireEvent.change(name, { target: { value: "Tracking: refused" } });
    });
    const refused = refuseApply(t);
    try {
      fireEvent.click(one("#inspector .inspector-close"));
    } finally {
      refused.restore();
    }
    expect([refused.messages, stored().desk.inspector.open, nameIn(one("#inspector [data-detail]")).value]).toEqual([["the plan refused the name"], true, "Tracking: refused"]);
  });

  it("the Next button commits a field that kept focus, as WebKit leaves it, and keeps focus in the detail", async () => {
    const t = await shown();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    const name = nameIn(one("#inspector [data-detail]"));
    act(() => {
      name.focus();
      fireEvent.change(name, { target: { value: "Tracking: stepped away" } });
    });
    fireEvent.click(one("#inspector .detail-next"));
    expect([nameOf(t, "t3"), detail()?.dataset.detailItem, document.activeElement]).toEqual(["Tracking: stepped away", "t4", detail()]);
  });

  it("names its detail for assistive tech", async () => {
    await shown();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    expect([detail()?.getAttribute("role"), detail()?.getAttribute("aria-label")]).toEqual(["group", PICKED]);
  });

  it("steps from its previous and next buttons in the tab's order, and counts its place", async () => {
    await shown();
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    const pos = (): string | null | undefined => detail()?.querySelector(".detail-pos")?.textContent;
    const at = pos();
    fireEvent.click(
      within(slot() ?? document.body).getByRole("button", {
        name: "Next item",
      }),
    );
    expect([detail()?.dataset.detailItem, selectedRow()]).toEqual(["t4", "t4"]);
    fireEvent.click(
      within(slot() ?? document.body).getByRole("button", {
        name: "Previous item",
      }),
    );
    expect([detail()?.dataset.detailItem, pos()]).toEqual(["t3", at]);
  });

  it.each<ViewKind>(["board", "list"])("steps on J, K and the arrows on the %s too", async (view) => {
    await shown({ view });
    press(document.body, "j");
    const first = detail()?.dataset.detailItem;
    expect(first).toBeDefined();
    expect(detail()?.querySelector(".detail-pos")?.textContent).toMatch(/^1 \/ \d+$/);
    press(document.body, "ArrowDown");
    const second = detail()?.dataset.detailItem;
    expect(second).not.toBe(first);
    expect(detail()?.querySelector(".detail-pos")?.textContent).toMatch(/^2 \/ \d+$/);
    press(document.body, "k");
    expect(detail()?.dataset.detailItem).toBe(first);
  });
});

describe("the inspector drawer's detail on an iPad at 834", () => {
  beforeEach(() => {
    setPlatform(IPAD);
    setScreen(834, 1194);
  });

  it("holds the detail without an X of its own, and steps on J and the arrows while open", async () => {
    await shown({ over: ON_IPAD });
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    const d = screen.getByRole("dialog", { name: "Inspector" });
    expect([detail()?.dataset.detail, d.querySelectorAll(".inspector-close").length, d.querySelectorAll(".drawer-close").length]).toEqual(["drawer", 0, 1]);
    press(d, "j");
    expect(detail()?.dataset.detailItem).toBe("t4");
    press(d, "ArrowUp");
    expect(detail()?.dataset.detailItem).toBe("t3");
    press(d, "n");
    expect(detail()?.dataset.detailItem).toBe("t3");
  });
});

describe("the item modal", () => {
  beforeEach(ticking);

  it("double click opens the modal and hides the inspector", async () => {
    await shown();
    doubleClickBar("t3");
    const m = modal();
    if (m === null) throw new Error("no item modal");
    expect([m.className, m.getAttribute("aria-label"), modalDetail().dataset.detailItem, slot(), stored().desk.inspector.open]).toEqual(["modal modal-item", PICKED, "t3", null, true]);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const back = within(modalDetail()).getByRole("button", { name: "Back to the inspector" });
    expect([back.title, m.querySelectorAll(".modal-head .modal-close").length, modalDetail().querySelectorAll(".inspector-close").length]).toEqual(["Back to the inspector (Space)", 1, 0]);
    fireEvent.click(back);
    expect([modal(), slot()?.querySelector("[data-detail]")?.getAttribute("data-detail-item"), selectedRow()]).toEqual([null, "t3", "t3"]);
    await settle();
    expect(document.activeElement).toBe(slot()?.querySelector("[data-detail]"));
  });

  it("a micro-drag then a click is single", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    clickBar("t3", { dx: 5 });
    later(100);
    clickBar("t3");
    expect([modal(), selectedRow(), detail()?.dataset.detail]).toEqual([null, "t3", "column"]);
    later(100);
    clickBar("t3", { dx: 5 });
    expect([modal(), apply.mock.calls]).toEqual([null, []]);
  });

  it("two clicks 401 ms apart are single", async () => {
    await shown();
    clickBar("t3");
    later(401);
    clickBar("t3");
    expect([modal(), selectedRow()]).toEqual([null, "t3"]);
    later(100);
    clickBar("t3", { x: 47 });
    expect(modal()).toBeNull();
    later(100);
    clickBar("t4");
    expect([modal(), selectedRow()]).toEqual([null, "t4"]);
  });

  it("Space toggles, never in a field or on a button", async () => {
    await shown();
    clickBar("t3");
    later(1000);
    press(document.body, " ");
    expect([modalDetail().dataset.detailItem, document.activeElement]).toEqual(["t3", modalDetail()]);
    press(here(), " ");
    expect([modal(), detail()?.dataset.detail]).toEqual([null, "column"]);
    const column = one("#inspector [data-detail]");
    press(nameIn(column), " ");
    press(one(".detail-next", column), " ");
    expect(modal()).toBeNull();
    press(column, " ");
    expect(modal()).not.toBeNull();
    press(nameIn(modalDetail()), " ");
    press(one(".detail-next", modalDetail()), " ");
    expect(modal()).not.toBeNull();
  });

  it("⌘↓ opens, Return renames", async () => {
    await shown();
    clickBar("t3");
    act(() => {
      fireEvent.keyDown(document.body, { key: "ArrowDown", metaKey: true });
    });
    expect([modalDetail().dataset.detailItem, document.activeElement]).toEqual(["t3", modalDetail()]);
    press(here(), "Enter");
    const inModal = nameIn(modalDetail());
    expect([document.activeElement, inModal.selectionStart, inModal.selectionEnd]).toEqual([inModal, 0, PICKED.length]);
    press(inModal, "Escape");
    press(document.activeElement ?? document.body, "Escape");
    expect(modal()).toBeNull();
    act(() => document.body.focus());
    press(document.body, "Enter");
    const inColumn = nameIn(one("#inspector [data-detail]"));
    expect([document.activeElement, inColumn.selectionStart, inColumn.selectionEnd, modal()]).toEqual([inColumn, 0, PICKED.length, null]);
  });

  it("↑/↓/J/K step in the modal and never nudge", async () => {
    const t = await shown();
    clickBar("t3");
    press(document.body, " ");
    const apply = vi.spyOn(t.session, "apply");
    expect(document.activeElement).toBe(modalDetail());
    press(here(), "ArrowDown");
    expect([modalDetail().dataset.detailItem, modal()?.getAttribute("aria-label"), document.activeElement]).toEqual(["t4", nameOf(t, "t4"), modalDetail()]);
    press(here(), "k");
    expect(modalDetail().dataset.detailItem).toBe("t3");
    press(here(), "j");
    press(here(), "ArrowUp");
    expect(modalDetail().dataset.detailItem).toBe("t3");
    press(here(), "ArrowRight");
    press(here(), "ArrowLeft");
    expect([apply.mock.calls, slot(), stored().desk.inspector.open]).toEqual([[], null, true]);
  });

  it("Esc closes the modal, then deselects", async () => {
    await shown();
    doubleClickBar("t3");
    expect(document.activeElement).toBe(modalDetail());
    press(here(), "Escape");
    expect([modal(), selectedRow(), detail()?.dataset.detail]).toEqual([null, "t3", "column"]);
    await settle();
    press(here(), "Escape");
    expect([selectedRow(), detail(), slot()?.querySelector(".plan-summary h2")?.textContent]).toEqual([undefined, null, "Plan"]);
  });

  it("takes Space, J and Return on the dialog itself after Esc leaves a field", async () => {
    await shown();
    doubleClickBar("t3");
    act(() => nameIn(modalDetail()).focus());
    press(here(), "Escape");
    expect([modal() !== null, document.activeElement]).toEqual([true, modal()]);
    press(here(), "j");
    expect([modalDetail().dataset.detailItem, document.activeElement]).toEqual(["t4", modal()]);
    press(here(), "Enter");
    expect(document.activeElement).toBe(nameIn(modalDetail()));
    press(here(), "Escape");
    press(here(), " ");
    expect([modal(), detail()?.dataset.detail, detail()?.dataset.detailItem]).toEqual([null, "column", "t4"]);
  });

  it("opens a ghost row on a double press with the detail focused, and Space and Return work on it from the keyboard", async () => {
    const { t, p } = await deleteClash();
    sessions.push(p.session);
    await shown({ t, view: "list" });
    const row = one('[data-lrow="A"]');
    const tap = (): void => {
      const at = { clientX: 10, clientY: 10, button: 0, pointerId: 1, pointerType: "mouse" };
      act(() => {
        fireEvent.pointerDown(row, at);
      });
      act(() => {
        fireEvent.pointerUp(row, at);
      });
    };
    tap();
    later(120);
    tap();
    expect([row.classList.contains("ghost-row"), modalDetail().dataset.detailItem, document.activeElement]).toEqual([true, "A", modalDetail()]);
    press(here(), "Enter");
    expect(document.activeElement).toBe(modalDetail());
    press(here(), " ");
    expect([modal(), detail()?.dataset.detailItem]).toEqual([null, "A"]);
    await settle();
    press(here(), " ");
    expect(modalDetail().dataset.detailItem).toBe("A");
    press(here(), " ");
    await settle();
    press(here(), "Enter");
    expect([modal(), document.activeElement]).toEqual([null, detail()]);
  });

  it("ignores a held Space, so the modal does not flicker open and shut", async () => {
    await shown();
    clickBar("t3");
    later(1000);
    act(() => {
      fireEvent.keyDown(document.body, { key: " ", repeat: true });
    });
    expect(modal()).toBeNull();
    press(document.body, " ");
    act(() => {
      fireEvent.keyDown(here(), { key: " ", repeat: true });
    });
    expect([modal() !== null, document.activeElement]).toEqual([true, modalDetail()]);
  });

  it.each<readonly [string, (t: TestSession) => void]>([
    ["a read-only plan", (t) => t.session.setReadOnly(true)],
    ["no change", () => undefined],
  ])("opens on a double click with %s, focusing the detail, and Return only selects when the name is text", async (_, before) => {
    const t = await shown();
    act(() => before(t));
    doubleClickBar("t3");
    expect([modalDetail().dataset.detailItem, document.activeElement]).toEqual(["t3", modalDetail()]);
    press(here(), "Enter");
    const name = modalDetail().querySelector('[aria-label="Name"]');
    expect(document.activeElement).toBe(t.session.readOnly ? modalDetail() : name);
  });

  it("keeps focus, caret and scroll on promote", async () => {
    await shown();
    clickBar("t3");
    const column = one("#inspector [data-detail]");
    const name = nameIn(column);
    act(() => {
      name.focus();
      name.setSelectionRange(2, 5);
    });
    one("#inspector").scrollTop = 40;
    fireEvent.click(within(column).getByRole("button", { name: "Open as modal" }));
    const inModal = nameIn(modalDetail());
    expect([document.activeElement, inModal.selectionStart, inModal.selectionEnd, one(".modal-item-body").scrollTop]).toEqual([inModal, 2, 5, 40]);
    fireEvent.click(within(modalDetail()).getByRole("button", { name: "Back to the inspector" }));
    later(1000);
    clickBar("t3");
    act(() => one("#inspector [data-detail]").focus());
    one("#inspector").scrollTop = 0;
    press(one("#inspector [data-detail]"), " ");
    expect([document.activeElement, one(".modal-item-body").scrollTop]).toEqual([modalDetail(), 0]);
  });

  it("keeps the inspector and the draft when the field's commit throws on promote", async () => {
    const t = await shown();
    clickBar("t3");
    const name = nameIn(one("#inspector [data-detail]"));
    act(() => {
      name.focus();
      fireEvent.change(name, { target: { value: "Tracking: refused" } });
    });
    const refused = refuseApply(t);
    try {
      fireEvent.click(within(one("#inspector [data-detail]")).getByRole("button", { name: "Open as modal" }));
    } finally {
      refused.restore();
    }
    expect([refused.messages, modal(), detail()?.dataset.detail, nameIn(one("#inspector [data-detail]")).value]).toEqual([
      ["the plan refused the name"],
      null,
      "column",
      "Tracking: refused",
    ]);
  });

  it("keeps the modal and its draft, and drops Settings, when the field's commit throws as Settings opens", async () => {
    const t = await shown();
    doubleClickBar("t3");
    const name = nameIn(modalDetail());
    act(() => {
      name.focus();
      fireEvent.change(name, { target: { value: "Tracking: refused" } });
    });
    const refused = refuseApply(t);
    try {
      fireEvent.click(within(bar()).getByRole("button", { name: "Settings" }));
    } finally {
      refused.restore();
    }
    await settle();
    expect([refused.messages, modal() !== null, nameIn(modalDetail()).value, document.querySelector(".settings-panel")]).toEqual([
      ["the plan refused the name"],
      true,
      "Tracking: refused",
      null,
    ]);
  });

  it.each<readonly [string, () => void]>([
    ["X", () => fireEvent.click(within(one(".modal-head")).getByRole("button", { name: "Close" }))],
    ["scrim", () => scrimPress(one(".overlay.center"), 5, 5)],
    ["collapse", () => fireEvent.click(within(modalDetail()).getByRole("button", { name: "Back to the inspector" }))],
  ])("commits the focused field on %s", async (_, close) => {
    const t = await shown();
    doubleClickBar("t3");
    const name = nameIn(modalDetail());
    act(() => {
      name.focus();
      fireEvent.change(name, { target: { value: "Tracking: second pass" } });
    });
    act(close);
    expect([modal(), nameOf(t, "t3"), detail()?.dataset.detail]).toEqual([null, "Tracking: second pass", "column"]);
  });

  it("commits the focused field on Space, which closes only from outside a field", async () => {
    const t = await shown();
    doubleClickBar("t3");
    const name = nameIn(modalDetail());
    act(() => {
      name.focus();
      fireEvent.change(name, { target: { value: "Tracking: third pass" } });
    });
    press(name, " ");
    expect([modal() !== null, nameOf(t, "t3")]).toEqual([true, PICKED]);
    act(() => modalDetail().focus());
    press(modalDetail(), " ");
    expect([modal(), nameOf(t, "t3")]).toEqual([null, "Tracking: third pass"]);
  });

  it("Settings closes the modal", async () => {
    const t = await shown();
    doubleClickBar("t3");
    const name = nameIn(modalDetail());
    act(() => {
      name.focus();
      fireEvent.change(name, { target: { value: "Tracking: before settings" } });
    });
    fireEvent.click(within(bar()).getByRole("button", { name: "Settings" }));
    await settle();
    expect([modal(), nameOf(t, "t3"), slot()?.querySelector(".settings-panel") !== null, selectedRow()]).toEqual([null, "Tracking: before settings", true, "t3"]);
  });

  it("clears itself when the selection goes", async () => {
    const t = await shown();
    doubleClickBar("t3");
    act(() => {
      t.session.apply({ t: "trash", items: ["t3"] });
    });
    await settle();
    expect([modal(), selectedRow()]).toEqual([null, undefined]);
  });
});

describe("the item modal on an iPad at 834", () => {
  beforeEach(() => {
    ticking();
    setPlatform(IPAD);
    setScreen(834, 1194);
  });

  it("a drawer scrim double tap promotes, a late one closes", async () => {
    await shown({ over: ON_IPAD });
    fireEvent.click(one('.tl-row[data-row="t3"]'), { clientX: 30, clientY: 300 });
    screen.getByRole("dialog", { name: "Inspector" });
    later(150);
    scrimPress(one(".inspector-overlay-scrim"), 31, 300);
    expect([modalDetail().dataset.detailItem, screen.queryByRole("dialog", { name: "Inspector" })]).toEqual(["t3", null]);
    expect(document.activeElement).toBe(modalDetail());
    press(here(), " ");
    await settle();
    expect([modal(), screen.getByRole("dialog", { name: "Inspector" }).querySelector("[data-detail]")?.getAttribute("data-detail")]).toEqual([null, "drawer"]);
    expect(document.activeElement).toBe(document.querySelector('[data-detail="drawer"]'));
    later(1000);
    fireEvent.click(one('.tl-row[data-row="t4"]'), { clientX: 30, clientY: 334 });
    later(401);
    scrimPress(one(".inspector-overlay-scrim"), 30, 334);
    await settle();
    expect([modal(), document.querySelector(".inspector-overlay-layer:not([inert])"), selectedRow()]).toEqual([null, null, undefined]);
  });

  it("opens the item as a form sheet from the drawer's expand", async () => {
    await shown({ over: ON_IPAD });
    fireEvent.click(screen.getAllByText(PICKED)[0]);
    const d = screen.getByRole("dialog", { name: "Inspector" });
    const expand = within(d).getByRole("button", { name: "Open as modal" });
    expect(expand.title).toBe("Open as modal (Space, ⌘↓)");
    fireEvent.click(expand);
    expect([modalDetail().dataset.detailItem, screen.queryByRole("dialog", { name: "Inspector" })]).toEqual(["t3", null]);
  });
});

describe("the item modal from the sheet form", () => {
  beforeEach(() => {
    ticking();
    setScreen(820, 760);
  });

  it("opens from the item sheet's expand, hides the sheet, and brings it back on close", async () => {
    await shown();
    fireEvent.click(one('.tl-row[data-row="t3"]'));
    const sheet = screen.getByRole("dialog", { name: PICKED });
    const sheetDetail = one("[data-detail]", sheet);
    expect([sheetDetail.dataset.detail, sheet.querySelectorAll(".sheet-close").length, sheetDetail.querySelectorAll(".inspector-close").length]).toEqual(["drawer", 1, 0]);
    fireEvent.click(within(sheetDetail).getByRole("button", { name: "Open as modal" }));
    expect([modalDetail().dataset.detailItem, document.querySelectorAll(".sheet").length]).toEqual(["t3", 0]);
    fireEvent.click(within(modalDetail()).getByRole("button", { name: "Back to the inspector" }));
    await settle();
    expect([modal(), document.querySelector('.sheet [data-detail="drawer"]')?.getAttribute("data-detail-item")]).toEqual([null, "t3"]);
    expect(document.activeElement).toBe(document.querySelector('.sheet [data-detail="drawer"]'));
  });

  it("keeps one sheet across Next, with focus staying on Next", async () => {
    const t = await shown();
    fireEvent.click(one('.tl-row[data-row="t3"]'));
    const sheet = one(".sheet");
    const next = one(".detail-next", sheet);
    act(() => next.focus());
    fireEvent.click(next);
    expect([one(".sheet") === sheet, one("[data-detail]", sheet).dataset.detailItem, sheet.getAttribute("aria-label"), document.activeElement]).toEqual([true, "t4", nameOf(t, "t4"), next]);
  });
});
