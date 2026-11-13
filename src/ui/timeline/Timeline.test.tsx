import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Calendar, HolidayYear, RegionRef } from "../../domain/calendar";
import { toDay, toIso, weekday } from "../../domain/dates";
import { derive } from "../../domain/derive";
import { linkKey, type LinkType } from "../../domain/model";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { emptyYear, shellFor } from "../../test/shell";
import { clearToasts } from "../common/Toast";
import { EMPTY_PLAN } from "../copy";
import { OpenChoice } from "../run";
import { UiContext, useUi, type UiState } from "../state";
import { geometry, leadFor } from "./geometry";
import { Timeline } from "./Timeline";
import { withSync } from "../../test/withSync";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const ZH: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const sessions: PlanSession[] = [];
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const widths = { scroll: 1440, grid: 300, label: 0 };

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("tl-scroll") ? 700 : 0;
    },
  });
  widths.scroll = 1440;
  widths.grid = 300;
  widths.label = 0;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("tl-scroll") ? widths.scroll : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("tl-grid") ? widths.grid : this.classList.contains("bar-label") ? widths.label : 0;
    },
  });
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(useUi).mockClear();
  if (clientHeight === undefined) Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  if (clientWidth === undefined) Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  else Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
  if (offsetWidth === undefined) Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  else Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
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

const shown = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await made(seed, opts);
  render(withSync(shellFor(t).ui));
  await settle();
  return t;
};

const uiNow = (): [UiState, (patch: Partial<UiState>) => void] => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value;
};

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const all = (sel: string): HTMLElement[] => [...document.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

const paths = (sel: string): Element[] => [...document.querySelectorAll(sel)];

const barOf = (id: string): HTMLElement => one(`[data-bar="${id}"]`);

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const rect = (left: number): DOMRect => ({ left, top: 0, right: left + 4000, bottom: 700, width: 4000, height: 700, x: left, y: 0, toJSON: () => ({}) });

const pointer = (el: Element, kind: "down" | "move" | "up", x: number, o: { y?: number; pointerType?: string } = {}): void => {
  const init = { clientX: x, clientY: o.y ?? 0, button: 0, pointerId: 1, pointerType: o.pointerType ?? "mouse" };
  act(() => {
    if (kind === "down") fireEvent.pointerDown(el, init);
    else if (kind === "move") fireEvent.pointerMove(el, init);
    else fireEvent.pointerUp(el, init);
  });
};

const noChoice = (): void => {
  throw new Error("Bare: no choice dialog");
};

function Bare(p: { session: PlanSession }) {
  const [ui, setUi] = useUi();
  return (
    <UiContext.Provider value={{ ui, setUi }}>
      <OpenChoice.Provider value={noChoice}>
        <Timeline session={p.session} />
      </OpenChoice.Provider>
    </UiContext.Provider>
  );
}

const drag = (el: Element, xs: readonly number[]): void => {
  pointer(el, "down", xs[0]);
  xs.slice(1, -1).forEach((x) => pointer(el, "move", x));
  pointer(el, "up", xs[xs.length - 1]);
};

describe("Review Focus 5: only the rows in view are mounted", () => {
  const SEED: SeedItem[] = Array.from({ length: 20 }, (_, g) => [
    { id: `g${g}`, name: `Group ${g}`, kind: "group" as const },
    ...Array.from({ length: 50 }, (_, i) => ({ id: `t${g}-${i}`, name: `Task ${g}-${i}`, parent: `g${g}`, start: "2026-11-10", dur: 3 })),
  ]).flat();

  it("mounts 29 rows at the top and 37 after a scroll", async () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(el: Element): void {
          observed.push(el);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    await shown(SEED);
    const scroll = one('[data-slot="timeline"] .tl-scroll');
    expect(observed.filter((el) => el.closest("header.toolbar") === null)).toEqual([document.documentElement, scroll]);
    const indices = (): number[] => all(".tl-row").map((r) => Number(r.dataset.index));
    expect(indices()).toEqual(Array.from({ length: 29 }, (_, i) => i));
    act(() => {
      scroll.scrollTop = 17000;
      fireEvent.scroll(scroll);
    });
    expect(indices()).toEqual(Array.from({ length: 37 }, (_, i) => 492 + i));
    expect(document.querySelector('[data-index="500"]')).not.toBeNull();
    expect(document.querySelector('[data-index="0"]')).toBeNull();
    expect(all(".bar").length).toBeLessThanOrEqual(37);
    expect(all(".bar").length).toBeGreaterThan(30);
    expect(one('[data-index="500"]').style.top).toBe(`${500 * 34}px`);
  });
});

describe("empty plan", () => {
  it("says so inside the scroller and shows no rows", async () => {
    await shown([]);
    const scroll = one('[data-slot="timeline"] .tl-scroll');
    expect(scroll.textContent).toBe(EMPTY_PLAN);
    expect(one('[data-slot="timeline"]').textContent).toBe(EMPTY_PLAN);
    expect(EMPTY_PLAN).toBe("No items yet. Add one with + New.");
    expect(all(".tl-row")).toHaveLength(0);
  });

  it("takes a jump to today without moving or failing", async () => {
    await shown([]);
    act(() => uiNow()[1]({ reveal: "today" }));
    expect(one(".tl-scroll").scrollLeft).toBe(0);
    expect(uiNow()[0].reveal).toBeNull();
    expect(one(".tl-scroll").textContent).toBe(EMPTY_PLAN);
  });

  it("says so when every item is trashed and none is a ghost", async () => {
    const t = await shown([
      { id: "a", name: "A", start: "2026-11-10", dur: 3 },
      { id: "b", name: "B", start: "2026-11-11", dur: 1 },
    ]);
    act(() => {
      t.session.apply({ t: "trash", items: ["a", "b"] });
    });
    expect(t.session.view().choices).toEqual([]);
    expect(one('[data-slot="timeline"] .tl-scroll').textContent).toBe(EMPTY_PLAN);
    expect(all(".tl-row")).toHaveLength(0);
  });

  it("does not say so once there is an item", async () => {
    await shown([{ name: "A", start: "2026-11-10", dur: 3 }]);
    expect(screen.queryByText(EMPTY_PLAN)).toBeNull();
    expect(all(".tl-row")).toHaveLength(1);
  });
});

describe("links and marks", () => {
  const SEED: SeedItem[] = [
    { id: "build", name: "Build", start: "2026-11-09", dur: 3 },
    { id: "review", name: "Review", start: "2026-11-10", dur: 2, status: "doing", deps: [fs("build")] },
    { id: "ship", name: "Ship", start: "2026-11-16", dur: 1, deps: [fs("review")] },
    { id: "test", name: "Test", start: "2026-11-11", dur: 1, deps: [fs("build")] },
    { id: "old", name: "Old", start: "2026-11-02", dur: 2 },
    { id: "x", name: "X", start: "2026-11-17", dur: 1, deps: [fs("y")] },
    { id: "y", name: "Y", start: "2026-11-18", dur: 1, deps: [fs("x")] },
    { id: "h", name: "H", start: "2026-11-19", dur: 1 },
  ];
  const HELD = { clashes: [{ unit: "s:h", mac: ["2026-11-19", 1, "todo", 0, "now"], iphone: ["2026-11-20", 1, "todo", 0, "now"] }] };

  it("draws a path per link, bad for early and loop links, hot at the selected item", async () => {
    await shown(SEED, HELD);
    const drawn = paths(".tl-links > path");
    expect(drawn).toHaveLength(5);
    expect(drawn.filter((p) => p.getAttribute("class") === "bad")).toHaveLength(4);
    expect(drawn.filter((p) => p.getAttribute("class") === "hot")).toHaveLength(0);
    expect(drawn.map((p) => p.getAttribute("marker-end")).filter((m) => m === "url(#arrBad)")).toHaveLength(4);
    pointer(barOf("ship"), "down", 10);
    pointer(barOf("ship"), "up", 10);
    expect(uiNow()[0].selected).toBe("ship");
    expect(paths(".tl-links > path").filter((p) => p.getAttribute("class") === "hot")).toHaveLength(1);
    expect(barOf("ship").classList.contains("selected")).toBe(true);
    expect(one('[data-row="ship"]').classList.contains("selected")).toBe(true);
  });

  it("leaves each arrowhead's colour to the stylesheet", async () => {
    await shown(SEED, HELD);
    const heads = paths(".tl-links marker").map((m) => [m.id, m.getAttribute("class"), m.querySelector("path")?.getAttribute("fill") ?? null]);
    expect(heads).toEqual([
      ["arr", null, null],
      ["arrHot", "hot", null],
      ["arrBad", "bad", null],
    ]);
  });

  it("marks an early successor, a late task and a held item", async () => {
    await shown(SEED, HELD);
    expect(barOf("review").classList.contains("conflict")).toBe(true);
    expect(barOf("review").title).toBe("Started before “Build” finished");
    expect(barOf("test").classList.contains("conflict")).toBe(true);
    expect(barOf("test").title).toBe("Test · 11 Nov – 11 Nov · 1 working day");
    expect(barOf("old").classList.contains("late")).toBe(true);
    expect(barOf("build").classList.contains("late")).toBe(false);
    expect(barOf("h").classList.contains("held")).toBe(true);
    expect(barOf("build").classList.contains("held")).toBe(false);
  });

  it("shows a delete choice's trashed item as a ghost row with no bar", async () => {
    const t = await made(SEED);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["old"] });
    p.session.apply({ t: "rename", item: "old", name: "Older" });
    p.sync();
    render(withSync(shellFor(t).ui));
    await settle();
    expect(one('[data-row="old"]').className).toBe("tl-row ghost-row");
    expect(document.querySelector('[data-bar="old"]')).toBeNull();
    act(() => {
      fireEvent.click(one('[data-row="old"]'));
    });
    expect(uiNow()[0].selected).toBe("old");
  });

  it("marks a stored day off on the bar and not in the plan header (PF55)", async () => {
    await shown([{ name: "Sat", start: "2026-11-14", dur: 1 }]);
    expect(barOf("Sat").classList.contains("dayoff")).toBe(true);
    expect(barOf("Sat").title).toBe("Starts on a day off — shown from Mon 16 Nov");
    expect(one(".plan-head").textContent).not.toMatch(/conflict/i);
  });

  it.each<[LinkType, string]>([
    ["FS", "Started before “Build” finished"],
    ["SS", "Started before “Build” started"],
    ["FF", "Finished before “Build” finished"],
    ["SF", "Finished before “Build” started"],
  ])("titles an early %s successor that is under way", async (type, title) => {
    await shown([
      { id: "build", name: "Build", start: "2026-11-10", dur: 3 },
      { id: "review", name: "Review", start: "2026-11-09", dur: 1, status: "doing", deps: [{ from: "build", type, lag: 0 }] },
    ]);
    expect(barOf("review").classList.contains("conflict")).toBe(true);
    expect(barOf("review").title).toBe(title);
  });

  it("hides a trashed group's children until it is restored", async () => {
    const t = await shown([
      { id: "g", name: "G", kind: "group" },
      { id: "a", name: "A", parent: "g", start: "2026-11-10", dur: 2 },
      { id: "b", name: "B", parent: "g", start: "2026-11-12", dur: 1 },
      { id: "c", name: "C", start: "2026-11-10", dur: 1 },
    ]);
    const rows = (): (string | undefined)[] => all(".tl-row").map((e) => e.dataset.row);
    const bars = (): (string | undefined)[] => all("[data-bar]").map((e) => e.dataset.bar);
    expect(rows()).toEqual(["g", "a", "b", "c"]);
    act(() => {
      t.session.apply({ t: "trash", items: ["g"] });
    });
    expect(rows()).toEqual(["c"]);
    expect(bars()).toEqual(["c"]);
    act(() => {
      t.session.apply({ t: "restore", items: ["g"] });
    });
    expect(rows()).toEqual(["g", "a", "b", "c"]);
    expect(bars()).toEqual(["a", "b", "c"]);
    cleanup();
    const v = t.session.view();
    const plan = { ...v.plan, items: new Map([...v.plan.items].map(([id, i]) => [id, id === "g" ? { ...i, trashed: true } : i])) };
    vi.spyOn(t.session, "view").mockReturnValue({ ...v, plan, derived: derive(plan, v.held, v.today) });
    render(<Bare session={t.session} />);
    await settle();
    expect(rows()).toEqual(["c"]);
    expect(bars()).toEqual(["c"]);
  });

  it("collapses and expands a group by its caret", async () => {
    await shown([
      { id: "g", name: "G", kind: "group" },
      { id: "a", name: "A", parent: "g", start: "2026-11-10", dur: 2 },
    ]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse G" }));
    });
    expect(document.querySelector('[data-row="a"]')).toBeNull();
    expect([...uiNow()[0].collapsed]).toEqual(["g"]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Expand G" }));
    });
    expect(document.querySelector('[data-row="a"]')).not.toBeNull();
  });
});

describe("shading on CH-ZH", () => {
  const year = (y: number, days: HolidayYear["days"]): HolidayYear => ({ region: "oh:CH:CH-ZH", year: y, days, fetchedAt: "2026-11-01T00:00:00Z" });
  const calendar: Partial<Calendar> = {
    region: ZH,
    holidays: new Map([[2026, year(2026, [{ date: "2026-12-25", name: "Christmas Day", kind: "public", sourceId: "x", scope: null }])]]),
    closures: new Map([["c1", { id: "c1", from: "2026-11-18", to: "2026-11-19", name: "Offsite" }]]),
  };
  const SEED: SeedItem[] = [
    { name: "A", start: "2026-11-10", dur: 3 },
    { name: "B", start: "2026-12-21", dur: 2 },
  ];
  const zoom = (z: string): void => {
    act(() => {
      fireEvent.click(within(one(".seg-zoom")).getByRole("button", { name: z }));
    });
  };
  const plain = (): HTMLElement[] => all(".tl-off").filter((e) => !e.classList.contains("hol") && !e.classList.contains("closure"));

  it("shades holidays, closures, and weekends except at Q", async () => {
    const t = await shown(SEED, { calendar, answers: { holidays_year: emptyYear } });
    const g = geometry(t.session.view(), "W");
    const weekends = Array.from({ length: g.days }, (_, i) => g.origin + i).filter((d) => weekday(d) >= 6).length;
    const hol = all(".tl-off.hol");
    expect(hol.map((e) => [e.title, e.style.left])).toEqual([["Christmas Day", `${g.x(toDay("2026-12-25"))}px`]]);
    expect(all(".tl-off.closure").map((e) => [e.title, e.style.left])).toEqual([
      ["Offsite", `${g.x(toDay("2026-11-18"))}px`],
      ["Offsite", `${g.x(toDay("2026-11-19"))}px`],
    ]);
    expect(plain()).toHaveLength(weekends);
    expect(all(".tl-tick.hol").map((e) => e.title)).toEqual(["Offsite", "Offsite", "Christmas Day"]);
    zoom("M");
    expect(plain()).toHaveLength(weekends);
    expect(plain()[0].style.width).toBe("16px");
    zoom("Q");
    expect(plain()).toHaveLength(0);
    expect(all(".tl-off.hol")).toHaveLength(1);
    expect(all(".tl-off.closure")).toHaveLength(2);
    expect(all(".tl-month.nodata")).toHaveLength(0);
  });

  it("marks the months of a year without holiday data", async () => {
    await shown([{ name: "A", start: "2031-01-06", dur: 2 }], {
      today: "2030-12-23",
      calendar: { region: ZH, holidays: new Map([[2030, year(2030, [])]]) },
      answers: { holidays_year: emptyYear },
    });
    const months = all(".tl-month");
    expect(months.map((m) => [m.textContent, m.classList.contains("nodata"), m.title])).toEqual([
      ["Dec 2030", false, ""],
      ["Jan 2031", true, "No holiday data for 2031 — dates use weekdays and closures"],
      ["Feb 2031", true, "No holiday data for 2031 — dates use weekdays and closures"],
    ]);
  });
});

describe("today and baselines", () => {
  it("draws the today line mid-day and moves it with the clock", async () => {
    const t = await shown([{ name: "A", start: "2026-11-10", dur: 3 }]);
    const g = geometry(t.session.view(), "W");
    expect(one(".tl-today").style.left).toBe(`${g.x(toDay("2026-11-09")) + 20}px`);
    expect(one(".tl-today-label").style.left).toBe(`${g.x(toDay("2026-11-09")) + 20}px`);
    act(() => t.clock.set("2026-11-10"));
    expect(one(".tl-today").style.left).toBe(`${g.x(toDay("2026-11-10")) + 20}px`);
  });

  it("scrolls to today on open and keeps the day at the lead-in on a zoom change", async () => {
    const t = await shown([{ name: "A", start: "2026-12-01", dur: 10 }], { today: "2026-12-07" });
    const scroll = one(".tl-scroll");
    const w = geometry(t.session.view(), "W");
    expect(scroll.scrollLeft).toBe(w.x(toDay("2026-12-07")) - 160);
    act(() => {
      scroll.scrollLeft = 1000;
      fireEvent.scroll(scroll);
    });
    const day = w.origin + (1000 + 160) / w.ppd;
    act(() => {
      fireEvent.click(within(one(".seg-zoom")).getByRole("button", { name: "M" }));
    });
    const m = geometry(t.session.view(), "M");
    expect(scroll.scrollLeft).toBe(Math.round((day - m.origin) * m.ppd - 160));
    act(() => {
      fireEvent.click(within(one(".seg-zoom")).getByRole("button", { name: "W" }));
    });
    expect(scroll.scrollLeft).toBe(1000);
  });

  it("keeps the day at the lead-in when an earlier start moves the chart's origin", async () => {
    const t = await shown([
      { id: "a", name: "A", start: "2026-11-09", dur: 2 },
      { id: "b", name: "B", start: "2026-11-16", dur: 3 },
    ]);
    const scroll = one(".tl-scroll");
    const before = geometry(t.session.view(), "W");
    act(() => {
      scroll.scrollLeft = 400;
      fireEvent.scroll(scroll);
    });
    act(() => {
      t.session.apply({ t: "move", items: ["a"], days: -3 });
    });
    const after = geometry(t.session.view(), "W");
    expect(before.origin - after.origin).toBe(7);
    expect(scroll.scrollLeft).toBe(400 + 7 * 40);
    act(() => {
      t.session.undo();
    });
    expect(scroll.scrollLeft).toBe(400);
  });

  it("shows the zoom switch only on the timeline, each button titled", async () => {
    await shown([{ name: "A", start: "2026-11-10", dur: 3 }]);
    const zoom = one(".seg-zoom");
    expect(within(zoom).getAllByRole("button").map((b) => [b.textContent, b.title])).toEqual([
      ["W", "Week"],
      ["M", "Month"],
      ["Q", "Quarter"],
      ["F", "Fit the whole plan"],
    ]);
    const bar = one(".toolbar");
    act(() => {
      fireEvent.click(within(bar).getByRole("tab", { name: "Now · Next · Later" }));
    });
    expect(document.querySelectorAll(".seg-zoom").length).toBe(0);
    expect(within(bar).getByRole("button", { name: "Today" })).toBeTruthy();
    act(() => {
      fireEvent.click(within(bar).getByRole("tab", { name: "List" }));
    });
    expect(document.querySelectorAll(".seg-zoom").length).toBe(0);
    act(() => {
      fireEvent.click(within(bar).getByRole("tab", { name: "Timeline" }));
    });
    expect(document.querySelectorAll(".seg-zoom").length).toBe(1);
  });

  it("opens a plan that lies wholly after today at its first start, and still jumps to today by the toolbar and by T", async () => {
    const t = await shown([{ name: "A", start: "2026-12-10", dur: 3 }], { today: "2026-12-07" });
    const scroll = one(".tl-scroll");
    const g = geometry(t.session.view(), "W");
    expect(scroll.scrollLeft).toBe(g.x(toDay("2026-12-10")) - 160);
    const today = within(one(".toolbar")).getByRole("button", { name: "Today" });
    expect(today.title).toBe("Jump to today");
    expect(today.previousElementSibling?.classList.contains("seg-zoom")).toBe(true);
    act(() => {
      fireEvent.click(today);
    });
    expect(scroll.scrollLeft).toBe(g.x(toDay("2026-12-07")) - 160);
    act(() => {
      scroll.scrollLeft = 0;
      fireEvent.scroll(scroll);
    });
    act(() => {
      fireEvent.keyDown(window, { key: "t" });
    });
    expect(scroll.scrollLeft).toBe(g.x(toDay("2026-12-07")) - 160);
  });

  it("opens a plan that ended before today at its first start", async () => {
    const t = await shown([{ name: "A", start: "2026-10-01", dur: 3 }], { today: "2026-12-07" });
    expect(one(".tl-scroll").scrollLeft).toBe(geometry(t.session.view(), "W").x(toDay("2026-10-01")) - 160);
  });

  it("scrolls a clicked row's bar into view only when it is off screen", async () => {
    const t = await shown([
      { id: "a", name: "A", start: "2026-11-09", dur: 2 },
      { id: "z", name: "Z", start: "2027-03-01", dur: 2 },
    ]);
    const scroll = one(".tl-scroll");
    const g = geometry(t.session.view(), "W");
    const row = (id: string): HTMLElement => one(`.tl-row[data-row="${id}"]`);
    expect(scroll.scrollLeft).toBe(g.x(toDay("2026-11-09")) - 160);
    act(() => {
      fireEvent.click(row("z"));
    });
    expect([uiNow()[0].selected, uiNow()[0].follow, scroll.scrollLeft, scroll.scrollTop]).toEqual(["z", null, g.x(toDay("2027-03-01")) - 160, 0]);
    act(() => {
      scroll.scrollLeft = g.x(toDay("2027-03-01")) - 600;
      fireEvent.scroll(scroll);
    });
    act(() => {
      fireEvent.click(row("z"));
    });
    expect(scroll.scrollLeft).toBe(g.x(toDay("2027-03-01")) - 600);
    act(() => {
      fireEvent.click(row("a"));
    });
    expect(scroll.scrollLeft).toBe(g.x(toDay("2026-11-09")) - 160);
  });

  it("opens a narrow chart with today a third of the way into the visible chart", async () => {
    widths.scroll = 390;
    widths.grid = 252;
    const t = await shown([{ name: "A", start: "2026-12-01", dur: 10 }], { today: "2026-12-07" });
    const at = geometry(t.session.view(), "W").x(toDay("2026-12-07"));
    expect(leadFor(390 - 252)).toBe(46);
    expect(one(".tl-scroll").scrollLeft).toBe(at - 46);
  });

  it("opens a chart with no visible width on today itself", async () => {
    widths.scroll = 0;
    widths.grid = 0;
    const t = await shown([{ name: "A", start: "2026-12-01", dur: 10 }], { today: "2026-12-07" });
    expect(one(".tl-scroll").scrollLeft).toBe(geometry(t.session.view(), "W").x(toDay("2026-12-07")));
  });

  it("scrolls to today when the plan changes", async () => {
    const one1 = await made([{ name: "A", start: "2026-12-01", dur: 10 }], { today: "2026-12-07" });
    const two = await made([{ name: "B", start: "2026-10-01", dur: 60 }], { today: "2026-12-07", plan: "plan0000002" });
    const { rerender } = render(<Bare session={one1.session} />);
    await settle();
    const scroll = one(".tl-scroll");
    expect(scroll.scrollLeft).toBe(geometry(one1.session.view(), "W").x(toDay("2026-12-07")) - 160);
    act(() => {
      scroll.scrollLeft = 0;
    });
    rerender(<Bare session={two.session} />);
    await settle();
    const g = geometry(two.session.view(), "W");
    expect(g.x(toDay("2026-12-07")) - 160).toBeGreaterThan(0);
    expect(scroll.scrollLeft).toBe(g.x(toDay("2026-12-07")) - 160);
  });

  it("clears a shown baseline that another device removed", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    t.session.apply({ t: "baseline", op: "save", name: "B1" });
    const p = await t.peer("iphone");
    sessions.push(p.session);
    render(withSync(shellFor(t).ui));
    await settle();
    const [id] = [...t.session.view().plan.baselines.keys()];
    act(() => uiNow()[1]({ baseline: id }));
    expect(uiNow()[0].baseline).toBe(id);
    expect(all(".ghost")).toHaveLength(1);
    act(() => {
      p.session.apply({ t: "baseline", op: "remove", id });
      p.sync();
    });
    await settle();
    expect(t.session.view().plan.baselines.size).toBe(0);
    expect(uiNow()[0].baseline).toBeNull();
    expect(all(".ghost")).toHaveLength(0);
  });

  it("draws a shown baseline's spans and the slip", async () => {
    const t = await made([
      { name: "A", start: "2026-11-10", dur: 3 },
      { name: "M", kind: "milestone", start: "2026-11-13" },
    ]);
    t.session.apply({ t: "baseline", op: "save", name: "B1" });
    t.session.apply({ t: "move", items: ["A"], days: 3 });
    render(withSync(shellFor(t).ui));
    await settle();
    expect(all(".ghost")).toHaveLength(0);
    const [id] = [...t.session.view().plan.baselines.keys()];
    act(() => uiNow()[1]({ baseline: id }));
    const g = geometry(t.session.view(), "W");
    const ghosts = all(".ghost");
    expect(ghosts.map((e) => [e.className, e.style.left])).toEqual([
      ["ghost", `${g.x(toDay("2026-11-10"))}px`],
      ["ghost ms-ghost", `${g.x(toDay("2026-11-13")) + 20}px`],
    ]);
    expect(ghosts[0].style.width).toBe(`${3 * 40}px`);
    expect(t.session.view().derived.slip(id).get("A")).toBe(3);
    expect(all(".bar-label .meta").map((e) => e.textContent)).toContain("+3d vs baseline");
  });

  it("shows the slip of a task that only got longer", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    t.session.apply({ t: "baseline", op: "save", name: "B1" });
    const [a] = [...t.session.view().plan.items.keys()];
    t.session.apply({ t: "resize", item: a, dur: 5 });
    render(withSync(shellFor(t).ui));
    await settle();
    const [id] = [...t.session.view().plan.baselines.keys()];
    act(() => uiNow()[1]({ baseline: id }));
    expect(t.session.view().derived.slip(id).get(a)).toBe(2);
    expect(all(".bar-label .meta").map((e) => e.textContent)).toContain("+2d vs baseline");
  });
});

describe("gestures", () => {
  const SEED: SeedItem[] = [
    { id: "a", name: "A", start: "2026-11-09", dur: 2 },
    { id: "b", name: "B", start: "2026-11-11", dur: 2, deps: [fs("a")] },
    { id: "c", name: "C", start: "2026-11-16", dur: 1 },
    { id: "u", name: "u" },
  ];

  it("applies one intent per drag and one undo restores it", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    const bar = barOf("a");
    pointer(bar, "down", 0);
    [25, 50, 75, 100, 120].forEach((x) => pointer(bar, "move", x));
    expect(all(".drop-ghost").map((e) => e.textContent)).toEqual(["moves 2"]);
    expect(barOf("a").classList.contains("dragging")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    pointer(bar, "up", 120);
    expect(apply.mock.calls).toEqual([[{ t: "move", items: ["a"], days: 3 }]]);
    expect(all(".drop-ghost")).toHaveLength(0);
    const starts = (): (string | null | undefined)[] => ["a", "b"].map((id) => t.session.view().plan.items.get(id)?.schedule?.start);
    expect(starts()).toEqual(["2026-11-12", "2026-11-16"]);
    act(() => {
      t.session.undo();
    });
    expect(starts()).toEqual(["2026-11-09", "2026-11-11"]);
  });

  it("issues nothing for a drag that ends where it began (refinement 36)", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    pointer(barOf("a"), "down", 0);
    [25, 50].forEach((x) => pointer(barOf("a"), "move", x));
    expect(all(".drop-ghost")).toHaveLength(1);
    pointer(barOf("a"), "move", 10);
    expect(all(".drop-ghost")).toHaveLength(0);
    pointer(barOf("a"), "up", 10);
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
    expect(uiNow()[0].selected).toBeNull();
    const handle = one(".h.r", barOf("a"));
    pointer(handle, "down", 0);
    [25, 50].forEach((x) => pointer(handle, "move", x));
    expect(all(".drop-ghost")).toHaveLength(1);
    pointer(handle, "move", 10);
    expect(all(".drop-ghost")).toHaveLength(0);
    pointer(handle, "up", 10);
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });

  it("cancels only the drag on Esc, keeping the selection; a second Esc lets go", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    act(() => uiNow()[1]({ selected: "c" }));
    pointer(barOf("a"), "down", 0);
    pointer(barOf("a"), "move", 80);
    expect(all(".drop-ghost")).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(all(".drop-ghost")).toHaveLength(0);
    expect(uiNow()[0].selected).toBe("c");
    pointer(barOf("a"), "up", 80);
    expect(apply).not.toHaveBeenCalled();
    expect(uiNow()[0].selected).toBe("c");
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(uiNow()[0].selected).toBeNull();
  });

  it("previews once per intent, not once per move", async () => {
    const t = await shown(SEED);
    const preview = vi.spyOn(t.session, "preview");
    pointer(barOf("a"), "down", 0);
    [45, 50, 55].forEach((x) => pointer(barOf("a"), "move", x));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(all(".drop-ghost").map((e) => e.textContent)).toEqual(["moves 2"]);
    pointer(barOf("a"), "move", 85);
    expect(preview).toHaveBeenCalledTimes(2);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
  });

  it("stops marking the bar as dragged when the pointer comes back", async () => {
    await shown(SEED);
    pointer(barOf("a"), "down", 0);
    pointer(barOf("a"), "move", 10);
    expect(all(".dragging").map((e) => e.dataset.bar)).toEqual(["a"]);
    pointer(barOf("a"), "move", 2);
    expect(all(".dragging")).toHaveLength(0);
    pointer(barOf("a"), "up", 2);
  });

  it("cancels a drag whose item loses its row", async () => {
    const t = await shown([
      { id: "g", name: "G", kind: "group" },
      { id: "a", name: "A", parent: "g", start: "2026-11-09", dur: 2 },
      { id: "c", name: "C", start: "2026-11-16", dur: 1 },
    ]);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    const apply = vi.spyOn(t.session, "apply");
    const scroll = one(".tl-scroll");
    const collapse = (ids: readonly string[]): void => {
      act(() => uiNow()[1]({ collapsed: new Set(ids) }));
    };
    pointer(barOf("a"), "down", 0);
    pointer(barOf("a"), "move", 80);
    expect(all(".drop-ghost")).toHaveLength(1);
    collapse(["g"]);
    expect(document.querySelector('[data-row="a"]')).toBeNull();
    pointer(scroll, "move", 120);
    expect(all(".drop-ghost")).toHaveLength(0);
    pointer(scroll, "up", 120);
    collapse([]);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(barOf("c"));
    pointer(one(".nub", barOf("a")), "down", 100);
    collapse(["g"]);
    pointer(scroll, "up", 300);
    expect(document.querySelector(".tl-links .temp")).toBeNull();
    pointer(barOf("c"), "down", 0);
    pointer(barOf("c"), "move", 80);
    expect(all(".drop-ghost")).toHaveLength(1);
    act(() => {
      p.session.apply({ t: "trash", items: ["c"] });
      p.sync();
    });
    expect(document.querySelector('[data-row="c"]')).toBeNull();
    pointer(scroll, "move", 120);
    expect(all(".drop-ghost")).toHaveLength(0);
    pointer(scroll, "up", 120);
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });

  it("resizes by the end handle and moves the start by the start handle", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    drag(one(".h.r", barOf("c")), [0, 40, 80]);
    drag(one(".h.l", barOf("a")), [0, 20, 40]);
    expect(apply.mock.calls).toEqual([
      [{ t: "resize", item: "c", dur: 3 }],
      [{ t: "schedule", item: "a", set: { start: "2026-11-10", dur: 1 } }],
    ]);
  });

  it("links by the nub, and cancels on Esc and pointercancel", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    vi.spyOn(one(".tl-chart"), "getBoundingClientRect").mockReturnValue(rect(0));
    const target = vi.spyOn(document, "elementFromPoint").mockReturnValue(barOf("c"));
    const nub = one(".nub", barOf("a"));
    pointer(nub, "down", 100, { y: 17 });
    pointer(nub, "move", 300, { y: 85 });
    expect(paths(".tl-links .temp").map((p) => p.getAttribute("d"))).toEqual(["M100,17 L300,85"]);
    pointer(nub, "up", 300, { y: 85 });
    expect(target).toHaveBeenCalledWith(300, 85);
    expect(apply.mock.calls).toEqual([[{ t: "link", from: "a", to: "c", type: "FS", lag: 0 }]]);
    expect(document.querySelector(".tl-links .temp")).toBeNull();
    pointer(barOf("c"), "down", 0);
    pointer(barOf("c"), "move", 80);
    expect(all(".drop-ghost")).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(all(".drop-ghost")).toHaveLength(0);
    pointer(barOf("c"), "up", 80);
    pointer(barOf("c"), "down", 0);
    pointer(barOf("c"), "move", 80);
    act(() => {
      fireEvent.pointerCancel(barOf("c"), { pointerId: 1 });
    });
    pointer(barOf("c"), "up", 80);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("links to the row under the pointer when a mouse drop misses the bar, and to nothing outside the chart", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    const chart = one(".tl-chart");
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(rect(0));
    const target = vi.spyOn(document, "elementFromPoint").mockReturnValue(one(".tl-rowline", chart));
    const nub = one(".nub", barOf("a"));
    pointer(nub, "down", 100, { y: 17 });
    pointer(nub, "up", 900, { y: 2 * 34 + 4 });
    expect(apply.mock.calls).toEqual([[{ t: "link", from: "a", to: "c", type: "FS", lag: 0 }]]);
    target.mockReturnValue(document.body);
    pointer(nub, "down", 100, { y: 17 });
    pointer(nub, "up", 900, { y: 2 * 34 + 4 });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("toasts a refused link with its message", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(barOf("a"));
    const nub = one(".nub", barOf("b"));
    pointer(nub, "down", 0);
    pointer(nub, "up", 60);
    expect(apply.mock.calls).toEqual([[{ t: "link", from: "b", to: "a", type: "FS", lag: 0 }]]);
    const result = apply.mock.results[0];
    if (result.type !== "throw" || !(result.value instanceof Error)) throw new Error("expected a Refused");
    expect(toastTexts()).toEqual([result.value.message]);
    expect(one('[role="alert"]').className).toBe("toast bad");
  });

  it("offers no gesture when read-only, and a click still selects", async () => {
    const t = await made(SEED);
    act(() => t.session.setReadOnly(true));
    render(withSync(shellFor(t).ui));
    await settle();
    const apply = vi.spyOn(t.session, "apply");
    expect(all(".nub")).toHaveLength(0);
    expect(all(".h")).toHaveLength(0);
    expect(all(".bar").length).toBe(3);
    pointer(barOf("a"), "down", 0);
    [25, 50, 75, 100, 120].forEach((x) => pointer(barOf("a"), "move", x));
    expect(all(".drop-ghost")).toHaveLength(0);
    pointer(barOf("a"), "up", 120);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(barOf("c"));
    drag(barOf("a"), [0, 60]);
    expect(all(".drop-ghost")).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
    pointer(barOf("a"), "down", 30);
    pointer(barOf("a"), "up", 31);
    expect(uiNow()[0].selected).toBe("a");
  });
});

describe("tray", () => {
  const SEED: SeedItem[] = [
    { id: "a", name: "A", start: "2026-11-09", dur: 2 },
    { id: "u", name: "u" },
  ];
  const chip = (): HTMLElement => one('[data-chip="u"]');

  it("schedules a chip dropped on the chart at the day under the pointer", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    const chart = one(".tl-chart");
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(rect(0));
    vi.spyOn(document, "elementFromPoint").mockReturnValue(chart);
    act(() => {
      one(".tl-scroll").scrollLeft = 0;
    });
    const g = geometry(t.session.view(), "W");
    pointer(chip(), "down", 0);
    pointer(chip(), "move", 120);
    expect(one(".drag-ghost").textContent).toBe("u");
    pointer(chip(), "up", 200);
    expect(apply.mock.calls).toEqual([[{ t: "schedule", item: "u", set: { start: toIso(g.dayAt(200)) } }]]);
    expect(document.querySelector(".drag-ghost")).toBeNull();
  });

  it("drops nothing while read-only", async () => {
    const t = await made(SEED);
    act(() => t.session.setReadOnly(true));
    render(withSync(shellFor(t).ui));
    await settle();
    const apply = vi.spyOn(t.session, "apply");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(one(".tl-chart"));
    pointer(chip(), "down", 0);
    pointer(chip(), "move", 120);
    expect(document.querySelector(".drag-ghost")).toBeNull();
    pointer(chip(), "up", 200);
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });

  it.each([false, true])("selects a clicked chip and issues nothing (refinement 48, read-only %s)", async (readOnly) => {
    const t = await made(SEED);
    act(() => t.session.setReadOnly(readOnly));
    render(withSync(shellFor(t).ui));
    await settle();
    const apply = vi.spyOn(t.session, "apply");
    pointer(chip(), "down", 100);
    pointer(chip(), "up", 102);
    expect(uiNow()[0].selected).toBe("u");
    expect(chip().classList.contains("selected")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("selects a chip by the %j key", async (key) => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      chip().focus();
      fireEvent.keyDown(chip(), { key });
    });
    expect(document.activeElement).toBe(chip());
    expect(uiNow()[0].selected).toBe("u");
    expect(apply).not.toHaveBeenCalled();
  });

  it("selects nothing for a chip dragged back onto the tray", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(one(".tray"));
    pointer(chip(), "down", 100);
    pointer(chip(), "move", 110);
    pointer(chip(), "up", 110);
    expect(uiNow()[0].selected).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("starts no drag from a touch", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(one(".tl-chart"));
    pointer(chip(), "down", 0, { pointerType: "touch" });
    pointer(chip(), "move", 120, { pointerType: "touch" });
    pointer(chip(), "up", 200, { pointerType: "touch" });
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector(".drag-ghost")).toBeNull();
  });

  it("passes the dropped day off and lets the builder snap it (refinement 29)", async () => {
    const t = await shown(SEED);
    const apply = vi.spyOn(t.session, "apply");
    const chart = one(".tl-chart");
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(rect(0));
    vi.spyOn(document, "elementFromPoint").mockReturnValue(chart);
    const g = geometry(t.session.view(), "W");
    pointer(chip(), "down", 0);
    pointer(chip(), "up", g.x(toDay("2026-11-14")) + 20);
    expect(apply.mock.calls).toEqual([[{ t: "schedule", item: "u", set: { start: "2026-11-14" } }]]);
    expect(t.session.view().plan.items.get("u")?.schedule?.start).toBe("2026-11-16");
    expect(barOf("u").classList.contains("dayoff")).toBe(false);
    expect(toastTexts()).toEqual(["Scheduled “u” from 16 Nov."]);
  });
});

describe("keyboard rows", () => {
  const SEED: SeedItem[] = [
    { id: "g", name: "G", kind: "group" },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, parent: "g", start: "2026-11-10", dur: 1 })),
  ];
  const key = (k: string, el: Element | Window = window): void => {
    act(() => {
      fireEvent.keyDown(el, { key: k });
    });
  };

  it("gives the rows listbox semantics with the selection and the caret's state", async () => {
    await shown(SEED);
    const list = one(".tl-rows");
    expect([list.getAttribute("role"), list.getAttribute("aria-label")]).toEqual(["listbox", "Plan rows"]);
    expect(all(".tl-row").every((r) => r.getAttribute("role") === "option" && r.getAttribute("aria-selected") === "false")).toBe(true);
    expect(all(".tl-row").map((r) => r.tabIndex).slice(0, 3)).toEqual([0, -1, -1]);
    const caret = screen.getByRole("button", { name: "Collapse G" });
    expect(caret.getAttribute("aria-expanded")).toBe("true");
    key("ArrowDown");
    key("ArrowDown");
    expect(uiNow()[0].selected).toBe("t0");
    expect(one('.tl-row[data-row="t0"]').getAttribute("aria-selected")).toBe("true");
    expect(all(".tl-row").map((r) => r.tabIndex).slice(0, 3)).toEqual([-1, 0, -1]);
    act(() => {
      fireEvent.click(caret);
    });
    expect(screen.getByRole("button", { name: "Expand G" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("steps by ArrowUp and ArrowDown, scrolling only to keep the selected row in view", async () => {
    await shown(SEED);
    const scroll = one(".tl-scroll");
    act(() => uiNow()[1]({ selected: "t16" }));
    key("ArrowDown");
    expect([uiNow()[0].selected, scroll.scrollTop]).toEqual(["t17", 0]);
    key("ArrowDown");
    expect([uiNow()[0].selected, scroll.scrollTop]).toEqual(["t18", 0]);
    key("ArrowDown");
    expect([uiNow()[0].selected, scroll.scrollTop]).toEqual(["t19", 21 * 34 - 700]);
    key("ArrowUp");
    expect([uiNow()[0].selected, scroll.scrollTop]).toEqual(["t18", 21 * 34 - 700]);
    act(() => {
      scroll.scrollTop = 20 * 34;
      fireEvent.scroll(scroll);
    });
    key("ArrowUp");
    expect([uiNow()[0].selected, scroll.scrollTop]).toEqual(["t17", 18 * 34]);
    act(() => uiNow()[1]({ selected: "t5" }));
    key("ArrowUp");
    expect([uiNow()[0].selected, scroll.scrollTop]).toEqual(["t4", 5 * 34]);
  });

  it("moves focus with the selection when a row has it", async () => {
    await shown(SEED);
    const row = (id: string): HTMLElement => one(`.tl-row[data-row="${id}"]`);
    act(() => {
      fireEvent.click(row("t3"));
      row("t3").focus();
    });
    expect(document.activeElement).toBe(row("t3"));
    key("ArrowDown", row("t3"));
    expect([uiNow()[0].selected, document.activeElement === row("t4"), row("t4").getAttribute("aria-selected"), row("t4").tabIndex]).toEqual(["t4", true, "true", 0]);
    key("ArrowUp", row("t4"));
    key("ArrowUp", row("t3"));
    expect([uiNow()[0].selected, document.activeElement === row("t2")]).toEqual(["t2", true]);
  });

  it("leaves focus where it is when no row has it", async () => {
    await shown(SEED);
    const outside = screen.getByRole("button", { name: "Today" });
    act(() => outside.focus());
    act(() => uiNow()[1]({ selected: "t3" }));
    expect(document.activeElement).toBe(outside);
  });

  it("puts a Go to row at the top and its start at the lead-in, even when it is already in view", async () => {
    const t = await shown([
      { id: "g", name: "G", kind: "group" },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, parent: "g", start: i === 7 ? "2026-11-12" : "2026-11-10", dur: 1 })),
    ]);
    const scroll = one(".tl-scroll");
    const g = geometry(t.session.view(), "W");
    const opened = scroll.scrollLeft;
    expect(g.x(toDay("2026-11-12")) - leadFor(1440 - 300)).toBeGreaterThan(opened);
    act(() => uiNow()[1]({ selected: "t7", reveal: "t7" }));
    expect([uiNow()[0].reveal, scroll.scrollTop, scroll.scrollLeft]).toEqual([null, 8 * 34, g.x(toDay("2026-11-12")) - leadFor(1440 - 300)]);
    act(() => uiNow()[1]({ selected: "t7", follow: "t7" }));
    expect([uiNow()[0].follow, scroll.scrollTop, scroll.scrollLeft]).toEqual([null, 8 * 34, g.x(toDay("2026-11-12")) - leadFor(1440 - 300)]);
    act(() => {
      scroll.scrollTop = 0;
      fireEvent.scroll(scroll);
    });
    act(() => uiNow()[1]({ follow: "t7" }));
    expect(scroll.scrollTop).toBe(0);
  });

  it("does nothing while a field has focus", async () => {
    await shown(SEED);
    act(() => uiNow()[1]({ selected: "t3" }));
    const name = screen.getByLabelText("Name");
    key("ArrowDown", name);
    key("t", name);
    expect(uiNow()[0].selected).toBe("t3");
  });
});

describe("the render path", () => {
  const quiet = (): void => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  };

  it("throws for a task row with no dates", async () => {
    const t = await made([{ id: "a", name: "A", start: "2026-11-10", dur: 2 }]);
    const v = t.session.view();
    const start = new Map(v.derived.start);
    const end = new Map(v.derived.end);
    start.delete("a");
    end.delete("a");
    vi.spyOn(t.session, "view").mockReturnValue({ ...v, derived: { ...v.derived, start, end } });
    quiet();
    expect(() => render(<Bare session={t.session} />)).toThrow("Timeline row a has no dates");
  });

  it("throws for a conflict whose link is not in the plan", async () => {
    const t = await made([
      { id: "a", name: "A", start: "2026-11-10", dur: 2 },
      { id: "b", name: "B", start: "2026-11-10", dur: 2 },
    ]);
    const v = t.session.view();
    const conflicts = [...v.derived.conflicts, { kind: "early" as const, link: linkKey("a", "b"), pred: "a", succ: "b", need: toDay("2026-11-12"), succLock: null }];
    vi.spyOn(t.session, "view").mockReturnValue({ ...v, derived: { ...v.derived, conflicts } });
    quiet();
    expect(() => render(<Bare session={t.session} />)).toThrow("Conflict link a>b is not in the plan");
  });

  it("keeps rendering a group with no dates, a link to an unmounted row and an item newer than the baseline", async () => {
    const t = await made([
      { id: "g", name: "G", kind: "group" },
      { id: "u", name: "U", parent: "g" },
      { id: "h", name: "H", kind: "group" },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, start: "2026-11-10", dur: 1, deps: i === 39 ? [fs("t0")] : [] })),
    ]);
    t.session.apply({ t: "baseline", op: "save", name: "B1" });
    t.session.apply({ t: "create", kind: "task", name: "Late", parent: "h", after: null, start: "2026-11-11", dur: 1 });
    render(withSync(shellFor(t).ui));
    await settle();
    const [id] = [...t.session.view().plan.baselines.keys()];
    act(() => uiNow()[1]({ baseline: id }));
    const late = [...t.session.view().plan.items.values()].find((i) => i.name === "Late");
    if (late === undefined) throw new Error("no Late");
    expect(all(".tl-row").map((e) => e.dataset.row).slice(0, 3)).toEqual(["g", "h", late.id]);
    expect(all(".gbar")).toHaveLength(1);
    expect(document.querySelector('[data-row="t39"]')).toBeNull();
    expect(paths(".tl-links > path")).toHaveLength(1);
    expect(barOf(late.id).classList.contains("bar")).toBe(true);
    expect(all(".ghost")).toHaveLength(all(".bar").length - 1);
  });

  it("draws a link with one end mounted or crossing the window, and skips one wholly outside it", async () => {
    await shown([
      { id: "g", name: "G", kind: "group" },
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `t${i}`,
        name: `T${i}`,
        start: "2026-11-10",
        dur: 1,
        deps: i === 59 ? [fs("t0")] : i === 3 ? [fs("t1")] : i === 30 ? [fs("t2")] : [],
      })),
    ]);
    const scroll = one(".tl-scroll");
    act(() => {
      scroll.scrollTop = 26 * 34;
      fireEvent.scroll(scroll);
    });
    expect([document.querySelector('[data-row="t0"]'), document.querySelector('[data-row="t59"]'), document.querySelector('[data-row="t3"]')]).toEqual([null, null, null]);
    expect(document.querySelector('[data-row="t30"]')).not.toBeNull();
    const ys = paths(".tl-links > path").map((p) => (p.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number)[1]);
    expect(ys.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1 * 34 + 17, 3 * 34 + 17]);
  });

  it("has no elementFromPoint unless the test stubs it", () => {
    expect(() => document.elementFromPoint(0, 0)).toThrow("elementFromPoint is not stubbed in this test");
  });
});

describe("fit zoom", () => {
  const SEED: SeedItem[] = [
    { id: "a", name: "A", start: "2026-12-01", dur: 2 },
    { id: "b", name: "B", start: "2026-12-14", dur: 5 },
    { id: "u", name: "u" },
  ];
  const FIRST = toDay("2026-12-01") - 7;
  const fit = (): void => {
    act(() => {
      fireEvent.click(within(one(".seg-zoom")).getByRole("button", { name: "F" }));
    });
  };
  const resized: (() => void)[] = [];
  const watch = (): void => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          resized.push(cb);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  };
  const resize = (scroll: number): void => {
    widths.scroll = scroll;
    act(() => resized.forEach((cb) => cb()));
  };
  const ticks = (): string[] => all(".tl-tick").map((e) => e.textContent ?? "");

  beforeEach(() => {
    resized.splice(0);
  });

  it("sits after W, M and Q, fits the plan's days to the visible chart and scrolls to a week before its first start", async () => {
    widths.scroll = 300 + 640;
    const t = await shown(SEED, { today: "2026-11-10" });
    const buttons = within(one(".seg-zoom")).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["W", "M", "Q", "F"]);
    expect(buttons[3].title).toBe("Fit the whole plan");
    fit();
    expect(uiNow()[0].zoom).toBe("F");
    const g = geometry(t.session.view(), "F", 640);
    expect(g.ppd).toBe(20);
    expect(barOf("a").style.left).toBe(`${g.x(toDay("2026-12-01"))}px`);
    expect(barOf("b").style.width).toBe("100px");
    expect(one(".tl-scroll").scrollLeft).toBe(g.x(FIRST));
    expect(ticks().every((s) => /^W\d+ · \d+$/.test(s))).toBe(true);
  });

  it("recomputes when the chart resizes and picks the header by px a day", async () => {
    watch();
    widths.scroll = 300 + 640;
    const t = await shown(SEED, { today: "2026-11-10" });
    fit();
    resize(300 + 1140);
    const wide = geometry(t.session.view(), "F", 1140);
    expect(wide.ppd).toBeCloseTo(35.625, 10);
    expect(barOf("a").style.left).toBe(`${wide.x(toDay("2026-12-01"))}px`);
    expect(one(".tl-scroll").scrollLeft).toBe(wide.x(FIRST));
    expect(ticks().slice(0, 2)).toEqual(["M 2", "T 3"]);
    resize(300 + 192);
    const narrow = geometry(t.session.view(), "F", 192);
    expect(narrow.ppd).toBe(6);
    expect(barOf("a").style.left).toBe(`${narrow.x(toDay("2026-12-01"))}px`);
    expect(ticks().every((s) => /^\d+$/.test(s))).toBe(true);
    act(() => {
      fireEvent.click(within(one(".seg-zoom")).getByRole("button", { name: "W" }));
    });
    resize(300 + 900);
    expect(barOf("a").style.left).toBe(`${geometry(t.session.view(), "W").x(toDay("2026-12-01"))}px`);
  });

  it("hides the label of a bar narrower than it, at fit only", async () => {
    widths.scroll = 300 + 640;
    widths.label = 90;
    await shown(SEED, { today: "2026-11-10" });
    const label = (id: string): HTMLElement => {
      const next = barOf(id).nextElementSibling;
      if (!(next instanceof HTMLElement)) throw new Error(`no label after ${id}`);
      return next;
    };
    expect([label("a").classList.contains("hidden"), label("b").classList.contains("hidden")]).toEqual([false, false]);
    fit();
    expect([label("a").classList.contains("hidden"), label("b").classList.contains("hidden")]).toEqual([true, false]);
  });

  it("scrolls to a week before the first start on switching to fit when the fit's px a day equal the previous zoom's", async () => {
    widths.scroll = 300 + 1140;
    const t = await shown([{ id: "a", name: "A", start: "2026-12-01", dur: 5 }], { today: "2026-11-10" });
    const g = geometry(t.session.view(), "F", 1140);
    expect(g.ppd).toBe(40);
    expect(g.ppd).toBe(geometry(t.session.view(), "W").ppd);
    const el = one(".tl-scroll");
    el.scrollLeft = g.x(FIRST) + 333;
    fireEvent.scroll(el);
    fit();
    expect(uiNow()[0].zoom).toBe("F");
    expect(el.scrollLeft).toBe(g.x(FIRST));
  });

  it("schedules a tray chip at the fit day under the pointer", async () => {
    widths.scroll = 300 + 640;
    const t = await shown(SEED, { today: "2026-11-10" });
    fit();
    const apply = vi.spyOn(t.session, "apply");
    const chart = one(".tl-chart");
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(rect(0));
    vi.spyOn(document, "elementFromPoint").mockReturnValue(chart);
    const chip = one('[data-chip="u"]');
    const g = geometry(t.session.view(), "F", 640);
    expect(g.ppd).toBe(20);
    pointer(chip, "down", 0);
    pointer(chip, "move", 120);
    pointer(chip, "up", 500);
    expect(apply.mock.calls).toEqual([[{ t: "schedule", item: "u", set: { start: toIso(g.dayAt(500)) } }]]);
  });
});
