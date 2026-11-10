import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { phoneRegistry } from "../../test/phone";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { shellFor } from "../../test/shell";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { useUi } from "../state";
import { PhoneShell } from "./PhoneShell";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});
vi.mock("./PhoneList", async (importOriginal) => {
  const m = await importOriginal<typeof import("./PhoneList")>();
  function Probe() {
    const open = useContext(OpenChoice);
    if (open === null) throw new Error("Probe needs an OpenChoice provider");
    return (
      <button type="button" onClick={() => open("c1", "a2")}>
        Probe choice
      </button>
    );
  }
  return {
    ...m,
    PhoneList: (p: Parameters<typeof m.PhoneList>[0]) => (
      <>
        <m.PhoneList {...p} />
        <Probe />
      </>
    ),
  };
});

const sessions: PlanSession[] = [];
const registries: Registry[] = [];

beforeEach(() => {
  window.localStorage.clear();
  setScreen(390, 844);
});

afterEach(async () => {
  vi.useRealTimers();
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
  });
};

const SEED: readonly SeedItem[] = [
  { name: "Review", start: "2026-11-10", dur: 2 },
  { name: "Ship", start: "2026-11-12", dur: 1 },
];

const made = async (): Promise<TestSession> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  return t;
};

const shown = async (t: TestSession): Promise<void> => {
  const registry = await phoneRegistry(t);
  registries.push(registry);
  render(<PhoneShell registry={registry} clock={t.clock} />);
  await settle();
};

const lastUi = () => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value[0];
};

const rowOf = (name: string): HTMLElement => {
  const b = screen.getByText(name).closest("button");
  if (b === null) throw new Error("no row button for " + name);
  return b;
};

const views = (): HTMLElement => screen.getByRole("tablist", { name: "Views" });

describe('PhoneShell, data-form="phone"', () => {
  it("opens on the List and switches to a read-only Timeline", async () => {
    const t = await made();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    const list = within(views()).getByRole("tab", { name: "List" });
    expect(list.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".phone-list")).not.toBeNull();
    expect(document.querySelector(".tl-scroll")).toBeNull();
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    expect(within(views()).getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".phone-list")).toBeNull();
    expect(document.querySelectorAll(".tl-scroll")).toHaveLength(1);
    expect(document.querySelectorAll(".nub")).toHaveLength(0);
    expect(document.querySelectorAll(".bar .h")).toHaveLength(0);
    const bar = document.querySelector('[data-bar="Review"]');
    if (bar === null) throw new Error("no Review bar");
    const init = { clientX: 10, clientY: 0, button: 0, pointerId: 1, pointerType: "touch" };
    act(() => {
      fireEvent.pointerDown(bar, init);
    });
    act(() => {
      fireEvent.pointerUp(bar, init);
    });
    expect(screen.getByRole("dialog", { name: "Review" })).toBeTruthy();
    expect(apply).toHaveBeenCalledTimes(0);
  });

  it("each view tab controls the tab panel, which the selected tab labels", async () => {
    const t = await made();
    await shown(t);
    const panel = (): HTMLElement => screen.getByRole("tabpanel", { name: within(views()).getByRole("tab", { selected: true }).textContent ?? "" });
    const tabs = within(views()).getAllByRole("tab");
    expect(tabs.map((tb) => tb.getAttribute("aria-controls"))).toEqual(tabs.map(() => panel().id));
    expect(panel().querySelector(".phone-list")).not.toBeNull();
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    expect(panel().getAttribute("aria-labelledby")).toBe(within(views()).getByRole("tab", { name: "Timeline" }).id);
    expect(panel().querySelector(".tl-scroll")).not.toBeNull();
  });

  it("opens an item's sheet from the List and closes it", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(rowOf("Ship"));
    expect(screen.getByRole("dialog", { name: "Ship" })).toBeTruthy();
    expect(lastUi().selected).toBe("Ship");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Ship" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lastUi().selected).toBeNull();
  });

  it("open choice context: the sheet's useRun finds the provider, and a child opens a choice", async () => {
    const t = await made();
    await shown(t);
    fireEvent.click(rowOf("Review"));
    const sheet = screen.getByRole("dialog", { name: "Review" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Duration +1" }));
    expect(t.session.view().plan.items.get("Review")?.schedule?.dur).toBe(3);
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Probe choice" }));
    expect(lastUi().dialog).toEqual({ t: "choice", id: "c1", side: "a2" });
  });

  it("the read-only Timeline zooms by pinch, and a hold opens the item's sheet", async () => {
    const t = await made();
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    fireEvent.click(within(views()).getByRole("tab", { name: "Timeline" }));
    const setUi = (): ((patch: { zoom: "M" }) => void) => {
      const results = vi.mocked(useUi).mock.results;
      const r = results[results.length - 1];
      if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
      return r.value[1];
    };
    act(() => setUi()({ zoom: "M" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chart = document.querySelector(".tl-chart");
    if (chart === null) throw new Error("no chart");
    const fire = (el: Element, kind: "down" | "move" | "up", x: number, y: number, pointerId: number): void => {
      const init = { clientX: x, clientY: y, button: 0, pointerId, pointerType: "touch", isPrimary: pointerId === 1 };
      act(() => {
        if (kind === "down") fireEvent.pointerDown(el, init);
        else if (kind === "move") fireEvent.pointerMove(el, init);
        else fireEvent.pointerUp(el, init);
      });
    };
    fire(chart, "down", 0, 400, 1);
    fire(chart, "down", 100, 400, 2);
    fire(chart, "move", 160, 400, 2);
    fire(chart, "up", 160, 400, 2);
    fire(chart, "up", 0, 400, 1);
    expect(lastUi().zoom).toBe("W");
    expect(screen.queryByRole("dialog")).toBeNull();
    const bar = document.querySelector('[data-bar="Review"]');
    if (!(bar instanceof HTMLElement)) throw new Error("no Review bar");
    const x = parseFloat(bar.style.left) + 20;
    const y = parseFloat(bar.style.top) + 9;
    fire(bar, "down", x, y, 1);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(document.querySelector(".drop-ghost")).toBeNull();
    fire(bar, "up", x + 1, y, 1);
    expect(screen.getByRole("dialog", { name: "Review" })).toBeTruthy();
    expect(apply).toHaveBeenCalledTimes(0);
  });

  it("Shell renders the phone shell under phone, with no update line", async () => {
    const t = await made();
    const { ui } = shellFor(t);
    render(withSync(ui));
    await settle();
    expect(document.documentElement.dataset.form).toBe("phone");
    expect(document.querySelector(".phone-list")).not.toBeNull();
    expect(document.querySelector(".sidebar")).toBeNull();
    expect(document.querySelector(".update-line")).toBeNull();
    expect(screen.queryByText(/Check for updates|Up to date|WebBoard \d/)).toBeNull();
  });
});
