import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childrenOf } from "../../plan/project";
import type { PlanSession } from "../../store/session";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { clearToasts } from "../common/Toast";
import { ItemSheet } from "../phone/ItemSheet";
import { OpenChoice } from "../run";
import { UiContext, type UiState } from "../state";
import { ItemPanel } from "./ItemPanel";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  clearToasts();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const UI: UiState = {
  plan: null,
  view: "timeline",
  zoom: "W",
  selected: "a",
  collapsed: new Set(),
  baseline: null,
  dialog: null,
  reveal: null,
  follow: null,
  naming: null,
};

const SEED: readonly SeedItem[] = [
  { id: "a", name: "A", start: "2026-11-10", dur: 3 },
  { id: "b", name: "B", start: "2026-11-16", dur: 2 },
];

const made = async (): Promise<TestSession> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  return t;
};

const panel = (t: TestSession, ui: Partial<UiState> = {}, readOnly = false) => {
  const setUi = vi.fn<(p: Partial<UiState>) => void>();
  render(
    <OpenChoice.Provider value={vi.fn()}>
      <UiContext.Provider value={{ ui: { ...UI, ...ui }, setUi }}>
        <ItemPanel session={t.session} item="a" local="Mac" mac={true} readOnly={readOnly} naming={false} onNamed={() => undefined} />
      </UiContext.Provider>
    </OpenChoice.Provider>,
  );
  return setUi;
};

const copyId = (t: TestSession): string => {
  const copy = childrenOf(t.session.view().plan, null).find((i) => i.name === "A copy");
  if (copy === undefined) throw new Error("no copy");
  return copy.id;
};

describe("Duplicate in the item panel (product-7)", () => {
  it("duplicates the item, then selects and follows the copy on the timeline, without naming it", async () => {
    const t = await made();
    const setUi = panel(t);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    });
    const copy = copyId(t);
    expect(setUi.mock.calls).toEqual([[{ selected: copy, follow: copy }]]);
  });

  it("only selects the copy in the List", async () => {
    const t = await made();
    const setUi = panel(t, { view: "list" });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    });
    expect(setUi.mock.calls).toEqual([[{ selected: copyId(t) }]]);
  });

  it("offers no Duplicate read-only", async () => {
    const t = await made();
    panel(t, {}, true);
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
  });

  it("offers no Duplicate for an item inside a trashed group", async () => {
    const t = await testSession([
      { id: "g", name: "G", kind: "group" },
      { id: "a", name: "A", parent: "g", start: "2026-11-10", dur: 3 },
    ]);
    sessions.push(t.session);
    t.session.apply({ t: "trash", items: ["g"] });
    expect(t.session.view().plan.items.get("a")?.trashed).toBe(true);
    panel(t);
    expect(document.querySelector(".panel .kind")?.textContent).toBe("TASK");
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
  });

  it("is not on the phone's item sheet", async () => {
    const t = await made();
    render(
      <OpenChoice.Provider value={vi.fn()}>
        <ItemSheet session={t.session} item="a" local="Mac" onClose={() => undefined} />
      </OpenChoice.Provider>,
    );
    expect(screen.getByRole("button", { name: "Move up" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
  });
});
