import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemId } from "../../domain/model";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { IPHONE, setPlatform } from "../../test/platform";
import { phoneRegistry, startOnList } from "../../test/phone";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { themed } from "../../test/theme";
import { setScreen } from "../../test/setup";
import { withSync } from "../../test/withSync";
import { bannerText } from "../choices/describe";
import { clearToasts, Toasts } from "../common/Toast";
import { DetailContext, type DetailApi } from "../detail/DetailContext";
import { OpenChoice } from "../run";
import { UiContext, useUi, type UiState } from "../state";
import { ItemSheet } from "./ItemSheet";
import { PhoneShell } from "./PhoneShell";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const sessions: PlanSession[] = [];
const registries: Registry[] = [];

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(registries.splice(0).map((r) => r.close()));
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const uiNow = (): [UiState, (patch: Partial<UiState>) => void] => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value;
};

const UI: UiState = {
  plan: null,
  view: "list",
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

const made = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return t;
};

const REVIEW: SeedItem = { name: "Review", start: "2026-11-13", dur: 3 };

const shown = (t: TestSession, item: ItemId) => {
  const onClose = vi.fn();
  const api: DetailApi = { press: vi.fn(), step: vi.fn(), promote: vi.fn(), rename: vi.fn(), order: [item] };
  render(
    themed(
      <OpenChoice.Provider value={vi.fn()}>
        <UiContext.Provider value={{ ui: { ...UI, selected: item }, setUi: vi.fn() }}>
          <DetailContext.Provider value={api}>
            <ItemSheet session={t.session} item={item} local="Mac" naming={false} onNamed={() => undefined} onClose={onClose} />
          </DetailContext.Provider>
        </UiContext.Provider>
        <Toasts />
      </OpenChoice.Provider>,
    ),
  );
  return { onClose };
};

const sheet = (): HTMLElement => screen.getByRole("dialog");
const expand = (): HTMLElement => {
  const el = sheet().querySelector(".detail-head .detail-expand");
  if (!(el instanceof HTMLElement)) throw new Error("no expand button");
  return el;
};
const detentOf = (): [string | undefined, string | null] => [sheet().dataset.detent, expand().getAttribute("aria-label")];

describe("ItemSheet", () => {
  it("is a medium sheet named after the item, holding the shared detail", async () => {
    const t = await made([REVIEW]);
    const { onClose } = shown(t, "Review");
    expect([sheet().getAttribute("aria-label"), sheet().getAttribute("aria-modal")]).toEqual(["Review", "true"]);
    expect(detentOf()).toEqual(["medium", "Expand to full height"]);
    expect(expand().title).toBe("Expand to full height");
    const detail = sheet().querySelector(".sheet-body [data-detail]");
    expect([detail?.getAttribute("data-detail"), detail?.getAttribute("data-detail-item"), detail?.querySelector(".inspector-close")]).toEqual(["sheet", "Review", null]);
    expect(within(sheet()).getAllByRole("button", { name: "Close" })).toHaveLength(1);
    fireEvent.keyDown(sheet(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("expands to full height and goes back to medium", async () => {
    const t = await made([REVIEW]);
    shown(t, "Review");
    fireEvent.click(expand());
    expect(detentOf()).toEqual(["large", "Back to medium height"]);
    fireEvent.click(expand());
    expect(detentOf()).toEqual(["medium", "Expand to full height"]);
  });

  it("Space toggles the detent, never in a field or on a button", async () => {
    const t = await made([REVIEW]);
    shown(t, "Review");
    fireEvent.keyDown(sheet(), { key: " " });
    expect(detentOf()[0]).toBe("large");
    fireEvent.keyDown(sheet().querySelector(".detail-body") ?? sheet(), { key: " " });
    expect(detentOf()[0]).toBe("medium");
    fireEvent.keyDown(within(sheet()).getByRole("textbox", { name: "Name" }), { key: " " });
    fireEvent.keyDown(within(sheet()).getByRole("textbox", { name: "Notes" }), { key: " " });
    fireEvent.keyDown(within(sheet()).getByRole("button", { name: "Move up" }), { key: " " });
    fireEvent.keyDown(sheet(), { key: " ", shiftKey: true });
    expect(detentOf()[0]).toBe("medium");
  });

  it("ignores a held Space", async () => {
    const t = await made([REVIEW]);
    shown(t, "Review");
    fireEvent.keyDown(sheet(), { key: " ", repeat: true });
    expect(detentOf()[0]).toBe("medium");
    fireEvent.keyDown(sheet(), { key: " " });
    fireEvent.keyDown(sheet(), { key: " ", repeat: true });
    expect(detentOf()[0]).toBe("large");
  });

  it("a drag up from the head on iOS gives full height, and a swipe down from there returns to medium", async () => {
    setPlatform(IPHONE);
    const t = await made([REVIEW]);
    const { onClose } = shown(t, "Review");
    vi.spyOn(sheet(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 400, 390, 420));
    const head = sheet().querySelector(".sheet-head");
    if (!(head instanceof HTMLElement)) throw new Error("no sheet head");
    const drag = (dy: number): void => {
      fireEvent.pointerDown(head, { button: 0, pointerId: 3, pointerType: "touch", clientX: 190, clientY: 420 });
      fireEvent.pointerMove(head, { pointerId: 3, pointerType: "touch", clientX: 190, clientY: 420 + dy });
      fireEvent.pointerUp(head, { pointerId: 3, pointerType: "touch", clientX: 190, clientY: 420 + dy });
    };
    drag(-80);
    expect(detentOf()).toEqual(["large", "Back to medium height"]);
    drag(200);
    expect([detentOf()[0], onClose.mock.calls.length]).toEqual(["medium", 0]);
    drag(200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("throws, naming the item, when it is not in the plan", async () => {
    const t = await made([REVIEW]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => shown(t, "nope")).toThrow(new Error("ItemSheet: no item nope"));
  });
});

describe("ItemSheet in the phone shell", () => {
  const ABC: readonly SeedItem[] = [
    { name: "A", start: "2026-11-10", dur: 2 },
    { name: "B", start: "2026-11-12", dur: 2 },
    { name: "C", start: "2026-11-16", dur: 2 },
  ];
  const bannersIn = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll(".choice-banner")].filter((e): e is HTMLElement => e instanceof HTMLElement);

  it("a tap on a row opens the shared detail at medium height, and Delete closes it", async () => {
    const t = await made(ABC);
    setScreen(390, 844);
    startOnList();
    const registry = await phoneRegistry(t);
    registries.push(registry);
    render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
    await settle();
    const list = document.querySelector(".phone-list");
    if (!(list instanceof HTMLElement)) throw new Error("no phone list");
    const row = within(list).getByText("B").closest("button");
    if (row === null) throw new Error("no B row");
    fireEvent.click(row);
    const item = screen.getByRole("dialog", { name: "B" });
    expect([item.dataset.detent, item.querySelector('[data-detail="sheet"]')?.getAttribute("data-detail-item")]).toEqual(["medium", "B"]);
    fireEvent.click(within(item).getByRole("button", { name: "Delete" }));
    await settle();
    expect([t.session.view().plan.items.get("B")?.trashed, uiNow()[0].selected, screen.queryByRole("dialog")]).toEqual([true, null, null]);
  });

  it("keeps one sheet at full height across Next, with focus staying on Next", async () => {
    const t = await made(ABC);
    setScreen(390, 844);
    startOnList();
    const registry = await phoneRegistry(t);
    registries.push(registry);
    render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
    await settle();
    const list = document.querySelector(".phone-list");
    if (!(list instanceof HTMLElement)) throw new Error("no phone list");
    const row = within(list).getByText("A").closest("button");
    if (row === null) throw new Error("no A row");
    fireEvent.click(row);
    const item = screen.getByRole("dialog", { name: "A" });
    fireEvent.click(within(item).getByRole("button", { name: "Expand to full height" }));
    const next = item.querySelector(".detail-next");
    if (!(next instanceof HTMLButtonElement)) throw new Error("no Next button");
    act(() => next.focus());
    fireEvent.click(next);
    const after = screen.getByRole("dialog");
    expect([after === item, after.dataset.detent, after.getAttribute("aria-label"), after.querySelector("[data-detail]")?.getAttribute("data-detail-item"), document.activeElement]).toEqual([
      true,
      "large",
      "B",
      "B",
      next,
    ]);
  });

  it("a link clash shows on both ends", async () => {
    const t = await testSession(ABC, { clashes: [{ unit: "l:B>A", mac: ["FS", 0], iphone: ["SS", 1] }] });
    sessions.push(t.session);
    const choices = t.session.view().choices;
    expect(choices).toHaveLength(1);
    const c3 = choices[0];
    expect(bannerText(c3, "Mac")).toBe("Changed on Mac and iPhone. Choose which to keep.");
    setScreen(390, 844);
    const registry = await phoneRegistry(t);
    registries.push(registry);
    render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
    await settle();
    const setUi = (patch: Partial<UiState>): void => act(() => uiNow()[1](patch));
    for (const item of ["A", "B"]) {
      setUi({ selected: item, dialog: null });
      const itemSheet = screen.getByRole("dialog", { name: item });
      expect(bannersIn(itemSheet).map((b) => b.querySelector(".banner-text")?.textContent)).toEqual([bannerText(c3, registry.device.name)]);
      fireEvent.click(within(bannersIn(itemSheet)[0]).getByRole("button", { name: "Choose" }));
      expect(uiNow()[0].dialog).toEqual({ t: "choice", id: c3.id });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.getByRole("dialog", { name: "Choose which to keep" })).toBeTruthy();
    }
    setUi({ selected: "C", dialog: null });
    expect(bannersIn(screen.getByRole("dialog", { name: "C" }))).toEqual([]);
  });

  it("a calendar clash shows no banner on an item", async () => {
    const t = await testSession(ABC, { clashes: [{ unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null }] });
    sessions.push(t.session);
    expect(t.session.view().choices).toHaveLength(1);
    shown(t, "A");
    expect(bannersIn(sheet())).toEqual([]);
  });

  it("a delete clash opens from the item's banner", async () => {
    const t = await made([
      { id: "S4", name: "Sprint 4", kind: "group" },
      { name: "Review", parent: "S4", start: "2026-11-10", dur: 2 },
    ]);
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    act(() => {
      t.session.apply({ t: "trash", items: ["S4"] });
      peer.session.apply({ t: "place", item: "Review", parent: null, after: null });
      peer.sync();
    });
    const view = t.session.view();
    expect(view.choices).toHaveLength(1);
    const choice = view.choices[0];
    expect(choice.kind).toBe("delete");
    expect(choice.units.filter((u) => u.startsWith("s:"))).toEqual([]);
    expect(view.held.size).toBe(0);
    expect(view.plan.items.get("Review")?.place.parent).toBeNull();
    setScreen(390, 844);
    startOnList();
    const registry = await phoneRegistry(t);
    registries.push(registry);
    render(withSync(<PhoneShell registry={registry} clock={t.clock} />));
    await settle();
    const list = document.querySelector(".phone-list");
    if (!(list instanceof HTMLElement)) throw new Error("no phone list");
    const row = within(list).getByText("Review").closest("button");
    if (row === null) throw new Error("no Review row");
    const section = row.closest("section.psec");
    if (section === null) throw new Error("the Review row is in no section");
    expect(section.querySelector(":scope > h2.psec-title")).not.toBeNull();
    expect(section.querySelector(":scope > button.psec-title")).toBeNull();
    expect([...list.querySelectorAll(".psec-title")].map((e) => e.textContent)).not.toContain("Sprint 4");
    fireEvent.click(row);
    const body = screen.getByRole("dialog", { name: "Review" }).querySelector(".detail-body");
    if (body === null) throw new Error("no item detail body");
    const first = body.firstElementChild;
    if (!(first instanceof HTMLElement)) throw new Error("an empty item detail");
    expect(first.classList.contains("choice-banner")).toBe(true);
    expect(first.querySelector(".banner-text")?.textContent).toBe(bannerText(choice, registry.device.name));
    expect(bannerText(choice, "Mac")).toBe("Changed on Mac and iPhone. Choose which to keep.");
    expect(body.querySelectorAll(".choice-banner")).toHaveLength(1);
    fireEvent.click(within(first).getByRole("button", { name: "Choose" }));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: choice.id });
  });
});
