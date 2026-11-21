import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Refused, type Intent } from "../../actions/intents";
import { toDay, type IsoDate } from "../../domain/dates";
import { liveLinks } from "../../plan/project";
import { READ_ONLY, type PlanSession } from "../../store/session";
import { IPAD, MAC, setPlatform } from "../../test/platform";
import { setScreen } from "../../test/setup";
import { tauri } from "../../test/tauriMock";
import { fs, testSession, type SeedItem, type TestSession } from "../../test/session";
import { shellFor } from "../../test/shell";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { useUi, type UiState, type Zoom } from "../state";
import { geometry } from "./geometry";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const sessions: PlanSession[] = [];
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("tl-scroll") ? 700 : 0;
    },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  if (clientHeight === undefined) Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  else Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
});

const SEED: readonly SeedItem[] = [
  { id: "Review", name: "Review", start: "2026-11-09", dur: 3 },
  { id: "Ship", name: "Ship", start: "2026-11-16", dur: 1 },
  { id: "u", name: "u" },
];

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const shown = async (seed: readonly SeedItem[] = SEED): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  render(withSync(shellFor(t).ui));
  await settle();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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

const barOf = (id: string): HTMLElement => one(`[data-bar="${id}"]`);
const chart = (): HTMLElement => one(".tl-chart");
const rowY = (id: string): number => parseFloat(barOf(id).style.top) + 9;
const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

type Kind = "down" | "move" | "up" | "cancel" | "lost";

const touch = (el: Element, kind: Kind, x: number, y: number, pointerId = 1, isPrimary = pointerId === 1): void => {
  const init = { clientX: x, clientY: y, button: 0, pointerId, pointerType: "touch", isPrimary };
  act(() => {
    if (kind === "down") fireEvent.pointerDown(el, init);
    else if (kind === "move") fireEvent.pointerMove(el, init);
    else if (kind === "up") fireEvent.pointerUp(el, init);
    else if (kind === "cancel") fireEvent.pointerCancel(el, init);
    else fireEvent.lostPointerCapture(el, init);
  });
};

const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const touchMove = (el: Element): Event => {
  const e = new Event("touchmove", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

const xOf = (t: TestSession, zoom: Zoom, day: IsoDate): number => geometry(t.session.view(), zoom).x(toDay(day));
const x0 = (t: TestSession): number => xOf(t, "W", "2026-11-09");
const links = (t: TestSession): ReturnType<typeof liveLinks> => liveLinks(t.session.view().plan);

const holdAndDrag = (el: Element, from: number, to: number, y: number, upY = y): void => {
  touch(el, "down", from, y);
  wait(500);
  touch(el, "move", (from + to) / 2, y);
  touch(el, "move", to, upY);
  touch(el, "up", to, upY);
};

describe("touch on the timeline bars", () => {
  it.each<[string, (t: TestSession) => number, number, Intent]>([
    ["body held, moved 80 px", (t) => x0(t) + 60, 80, { t: "move", items: ["Review"], days: 2 }],
    ["end +80 px", (t) => x0(t) + 115, 80, { t: "resize", item: "Review", dur: 5 }],
    ["start +40 px", (t) => x0(t) + 5, 40, { t: "schedule", item: "Review", set: { start: "2026-11-10", dur: 2 } }],
  ])("%s applies one intent through run", async (_name, at, dx, intent) => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const from = at(t);
    holdAndDrag(barOf("Review"), from, from + dx, rowY("Review"));
    expect(apply.mock.calls).toEqual([[intent]]);
    expect(document.querySelector(".drop-ghost")).toBeNull();
  });

  it("previews while held, before anything applies", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const y = rowY("Review");
    touch(barOf("Review"), "down", x0(t) + 60, y);
    wait(500);
    expect(barOf("Review").classList.contains("dragging")).toBe(true);
    touch(barOf("Review"), "move", x0(t) + 140, y);
    expect([...document.querySelectorAll(".drop-ghost")].map((e) => e.textContent)).toEqual(["moves 1"]);
    expect(apply).not.toHaveBeenCalled();
    touch(barOf("Review"), "up", x0(t) + 140, y);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("links by the link handle onto Ship, without lifting the bar", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const nub = one(".nub", barOf("Review"));
    const y = rowY("Review");
    touch(nub, "down", x0(t) + 140, y);
    wait(500);
    expect(barOf("Review").classList.contains("dragging")).toBe(false);
    touch(nub, "move", x0(t) + 220, y);
    expect(document.querySelectorAll(".tl-links .temp")).toHaveLength(1);
    expect(barOf("Review").classList.contains("dragging")).toBe(false);
    touch(nub, "move", x0(t) + 300, rowY("Ship"));
    touch(nub, "up", x0(t) + 300, rowY("Ship"));
    expect(apply.mock.calls).toEqual([[{ t: "link", from: "Review", to: "Ship", type: "FS", lag: 0 }]]);
    expect(document.querySelector(".tl-links .temp")).toBeNull();
  });

  it("hits the end handle 20 px past the drawn end", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const end = x0(t) + 120;
    holdAndDrag(chart(), end + 20, end + 100, rowY("Review"));
    expect(apply.mock.calls).toEqual([[{ t: "resize", item: "Review", dur: 5 }]]);
  });

  it("hits the start handle 20 px before the drawn start of a wide bar", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    holdAndDrag(chart(), x0(t) - 20, x0(t) + 20, rowY("Review"));
    expect(apply.mock.calls).toEqual([[{ t: "schedule", item: "Review", set: { start: "2026-11-10", dur: 2 } }]]);
  });

  it.each<[string, number, number, Intent]>([
    ["at its first pixel moves", 0, 12, { t: "move", items: ["Ship"], days: 2 }],
    ["in the middle moves", 3, 12, { t: "move", items: ["Ship"], days: 2 }],
    ["at its last pixel moves", 5, 12, { t: "move", items: ["Ship"], days: 2 }],
    ["10 px left of its start changes the start", -10, -12, { t: "schedule", item: "Ship", set: { start: "2026-11-13", dur: 2 } }],
    ["10 px right of its end resizes", 16, 12, { t: "resize", item: "Ship", dur: 3 }],
  ])("a hold on a 1-day bar at zoom Q %s", async (_name, at, dx, intent) => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    act(() => uiNow()[1]({ zoom: "Q" }));
    const from = xOf(t, "Q", "2026-11-16") + at;
    expect(parseFloat(barOf("Ship").style.width)).toBe(6);
    holdAndDrag(chart(), from, from + dx, rowY("Ship"));
    expect(apply.mock.calls).toEqual([[intent]]);
  });

  it("a tap on empty chart clears the selection", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    act(() => uiNow()[1]({ selected: "Review" }));
    const y = rowY("Review") + 200;
    touch(chart(), "down", 100, y);
    wait(120);
    touch(chart(), "up", 101, y);
    expect(uiNow()[0].selected).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("a row a peer trashes during the hold cancels the whole gesture", async () => {
    const t = await shown();
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    const apply = vi.spyOn(t.session, "apply");
    const y = rowY("Review");
    touch(chart(), "down", x0(t) + 60, y);
    wait(500);
    expect(barOf("Review").classList.contains("dragging")).toBe(true);
    act(() => {
      peer.session.apply({ t: "trash", items: ["Review"] });
      peer.sync();
    });
    expect(document.querySelector('[data-bar="Review"]')).toBeNull();
    expect(touchMove(chart()).defaultPrevented).toBe(false);
    touch(chart(), "move", x0(t) + 140, y);
    touch(chart(), "up", x0(t) + 140, y);
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
    expect(document.querySelector(".drop-ghost")).toBeNull();
    expect(touchMove(chart()).defaultPrevented).toBe(false);
    const ship = xOf(t, "W", "2026-11-16") + 20;
    touch(barOf("Ship"), "down", ship, rowY("Ship"));
    touch(barOf("Ship"), "up", ship + 1, rowY("Ship"));
    expect(uiNow()[0].selected).toBe("Ship");
  });

  it("a new primary touch drops a pointer whose row went away without an up", async () => {
    const t = await shown();
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    touch(chart(), "down", x0(t) + 60, rowY("Review"), 1);
    act(() => {
      peer.session.apply({ t: "trash", items: ["Review"] });
      peer.sync();
    });
    const ship = xOf(t, "W", "2026-11-16") + 20;
    touch(barOf("Ship"), "down", ship, rowY("Ship"), 2, true);
    touch(barOf("Ship"), "up", ship + 1, rowY("Ship"), 2, true);
    expect(uiNow()[0].selected).toBe("Ship");
  });

  it("a lost pointer capture after pickup cancels like pointercancel", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const y = rowY("Review");
    touch(chart(), "down", x0(t) + 60, y);
    wait(500);
    touch(chart(), "move", x0(t) + 140, y);
    expect(document.querySelectorAll(".drop-ghost")).toHaveLength(1);
    touch(chart(), "lost", x0(t) + 140, y);
    expect(document.querySelector(".drop-ghost")).toBeNull();
    expect(barOf("Review").classList.contains("dragging")).toBe(false);
    expect(touchMove(chart()).defaultPrevented).toBe(false);
    touch(chart(), "up", x0(t) + 140, y);
    expect(apply).not.toHaveBeenCalled();
  });

  it("switching to read-only mid-hold cancels the gesture", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const y = rowY("Review");
    touch(chart(), "down", x0(t) + 60, y);
    wait(500);
    touch(chart(), "move", x0(t) + 140, y);
    expect(document.querySelectorAll(".drop-ghost")).toHaveLength(1);
    act(() => t.session.setReadOnly(true));
    expect(document.querySelector(".drop-ghost")).toBeNull();
    expect(touchMove(chart()).defaultPrevented).toBe(false);
    touch(chart(), "move", x0(t) + 180, y);
    touch(chart(), "up", x0(t) + 180, y);
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector(".drop-ghost")).toBeNull();
    expect(touchMove(chart()).defaultPrevented).toBe(false);
  });

  it("toasts a drop that would close a loop and changes no link", async () => {
    const t = await shown([
      { id: "Review", name: "Review", start: "2026-11-09", dur: 3 },
      { id: "Ship", name: "Ship", start: "2026-11-16", dur: 1, deps: [fs("Review")] },
    ]);
    const apply = vi.spyOn(t.session, "apply");
    const loop: Intent = { t: "link", from: "Ship", to: "Review", type: "FS", lag: 0 };
    const message = ((): string => {
      try {
        t.session.preview(loop);
      } catch (e) {
        if (e instanceof Refused) return e.message;
        throw e;
      }
      throw new Error("expected the loop to be refused");
    })();
    const before = links(t);
    const shipEnd = geometry(t.session.view(), "W").x(toDay("2026-11-16")) + 40;
    holdAndDrag(one(".nub", barOf("Ship")), shipEnd + 20, x0(t) + 60, rowY("Ship"), rowY("Review"));
    expect(apply.mock.calls).toEqual([[loop]]);
    expect(links(t)).toEqual(before);
    expect(toastTexts()).toEqual([message]);
    expect(one('[role="alert"]').className).toBe("toast bad");
  });

  it("drops nothing on pointercancel after pickup and leaves the bar where it was", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const left = barOf("Review").style.left;
    const y = rowY("Review");
    touch(barOf("Review"), "down", x0(t) + 60, y);
    wait(500);
    touch(barOf("Review"), "move", x0(t) + 140, y);
    expect(document.querySelectorAll(".drop-ghost")).toHaveLength(1);
    touch(barOf("Review"), "cancel", x0(t) + 140, y);
    expect(document.querySelector(".drop-ghost")).toBeNull();
    expect(barOf("Review").classList.contains("dragging")).toBe(false);
    expect(barOf("Review").style.left).toBe(left);
    touch(barOf("Review"), "up", x0(t) + 140, y);
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });

  it("a tap selects and applies nothing", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const y = rowY("Review");
    touch(barOf("Review"), "down", x0(t) + 60, y);
    wait(120);
    touch(barOf("Review"), "up", x0(t) + 62, y);
    expect(uiNow()[0].selected).toBe("Review");
    expect(apply).not.toHaveBeenCalled();
  });

  it("a scroll swipe across a bar does nothing", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const y = rowY("Review");
    touch(barOf("Review"), "down", x0(t) + 60, y);
    touch(barOf("Review"), "move", x0(t) + 90, y);
    wait(600);
    touch(barOf("Review"), "move", x0(t) + 200, y);
    touch(barOf("Review"), "up", x0(t) + 200, y);
    expect(document.querySelector(".drop-ghost")).toBeNull();
    expect(uiNow()[0].selected).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("a pinch out zooms M to W, once, and applies nothing", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    act(() => uiNow()[1]({ zoom: "M" }));
    const y = rowY("Review") + 200;
    touch(chart(), "down", 100, y, 1);
    touch(chart(), "down", 200, y, 2);
    touch(chart(), "move", 260, y, 2);
    expect(uiNow()[0].zoom).toBe("W");
    touch(chart(), "move", 500, y, 2);
    touch(chart(), "up", 500, y, 2);
    touch(chart(), "up", 100, y, 1);
    expect(uiNow()[0].zoom).toBe("W");
    touch(chart(), "down", 100, y, 1);
    touch(chart(), "down", 200, y, 2);
    touch(chart(), "move", 300, y, 2);
    touch(chart(), "up", 300, y, 2);
    touch(chart(), "up", 100, y, 1);
    expect(uiNow()[0].zoom).toBe("W");
    expect(apply).not.toHaveBeenCalled();
  });

  it("a pinch out at fit zooms to the next fixed zoom wider than the fit", async () => {
    await shown();
    act(() => uiNow()[1]({ zoom: "F" }));
    const y = rowY("Review") + 200;
    touch(chart(), "down", 100, y, 1);
    touch(chart(), "down", 200, y, 2);
    touch(chart(), "move", 260, y, 2);
    touch(chart(), "up", 260, y, 2);
    touch(chart(), "up", 100, y, 1);
    expect(uiNow()[0].zoom).toBe("Q");
  });

  it("touchmove is prevented only during a pickup", async () => {
    const t = await shown();
    const y = rowY("Review");
    const bar = barOf("Review");
    touch(bar, "down", x0(t) + 60, y);
    expect(touchMove(bar).defaultPrevented).toBe(false);
    wait(500);
    expect(touchMove(bar).defaultPrevented).toBe(true);
    touch(bar, "up", x0(t) + 60, y);
    expect(touchMove(bar).defaultPrevented).toBe(false);
    touch(bar, "down", x0(t) + 60, y);
    wait(500);
    expect(touchMove(bar).defaultPrevented).toBe(true);
    touch(bar, "cancel", x0(t) + 60, y);
    expect(touchMove(bar).defaultPrevented).toBe(false);
  });

  it("offers taps and pinch but no pickup while read-only", async () => {
    const t = await testSession(SEED);
    sessions.push(t.session);
    act(() => t.session.setReadOnly(true));
    render(withSync(shellFor(t).ui));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const apply = vi.spyOn(t.session, "apply");
    const y = rowY("Review");
    touch(barOf("Review"), "down", x0(t) + 60, y);
    wait(800);
    expect(touchMove(barOf("Review")).defaultPrevented).toBe(false);
    touch(barOf("Review"), "up", x0(t) + 61, y);
    expect(uiNow()[0].selected).toBe("Review");
    expect(document.querySelector(".drop-ghost")).toBeNull();
    touch(chart(), "down", 100, y, 1);
    touch(chart(), "down", 200, y, 2);
    touch(chart(), "move", 160, y, 2);
    expect(uiNow()[0].zoom).toBe("M");
    expect(apply).not.toHaveBeenCalled();
  });

  it("mouse keeps Phase 4's behaviour", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const init = { button: 0, pointerId: 1, pointerType: "mouse" };
    act(() => {
      fireEvent.pointerDown(barOf("Review"), { ...init, clientX: 0, clientY: 0 });
    });
    act(() => {
      fireEvent.pointerMove(barOf("Review"), { ...init, clientX: 80, clientY: 0 });
    });
    expect(barOf("Review").classList.contains("dragging")).toBe(true);
    act(() => {
      fireEvent.pointerUp(barOf("Review"), { ...init, clientX: 80, clientY: 0 });
    });
    expect(apply.mock.calls).toEqual([[{ t: "move", items: ["Review"], days: 2 }]]);
  });
});

describe("touch in the Shell (iPad)", () => {
  const tap = (el: Element, moved: number): void => {
    touch(el, "down", 10, 10);
    touch(el, "up", 10 + moved, 10);
    act(() => {
      fireEvent.click(el);
    });
  };

  const panelTitle = (root: ParentNode = document): string | null => {
    const input = root.querySelector(".panel .title-input");
    return input instanceof HTMLInputElement ? input.value : null;
  };

  it("tray chip: a touch drag onto the chart schedules nothing", async () => {
    setScreen(1366, 1024);
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(chart());
    const chip = one('[data-chip="u"]');
    touch(chip, "down", 0, 0);
    wait(600);
    touch(chip, "move", 100, 0);
    touch(chip, "move", 200, 0);
    expect(document.querySelector(".drag-ghost")).toBeNull();
    touch(chip, "up", 200, 0);
    expect(apply).toHaveBeenCalledTimes(0);
    expect(toastTexts()).toEqual([]);
  });

  it("taps open items: List row, Board card and tray chip (refinement 48)", async () => {
    setScreen(1366, 1024);
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    expect(document.documentElement.dataset.form).toBe("full");
    act(() => uiNow()[1]({ view: "list" }));
    tap(one('[data-lrow="Review"]'), 2);
    expect(uiNow()[0].selected).toBe("Review");
    expect(panelTitle()).toBe("Review");
    act(() => uiNow()[1]({ selected: null, view: "board" }));
    tap(one('[data-card="Review"]'), 2);
    expect(uiNow()[0].selected).toBe("Review");
    expect(panelTitle()).toBe("Review");
    act(() => uiNow()[1]({ selected: null, view: "timeline" }));
    tap(one('[data-chip="u"]'), 2);
    expect(uiNow()[0].selected).toBe("u");
    expect(panelTitle()).toBe("u");
    act(() => uiNow()[1]({ selected: null, view: "board" }));
    tap(one('[data-card="Review"]'), 6);
    expect(uiNow()[0].selected).toBeNull();
    act(() => setScreen(820, 1180));
    expect(document.documentElement.dataset.form).toBe("compact");
    act(() => uiNow()[1]({ view: "list" }));
    tap(one('[data-lrow="Review"]'), 2);
    expect(uiNow()[0].selected).toBe("Review");
    expect(panelTitle(screen.getByRole("dialog", { name: "Review" }))).toBe("Review");
    expect(apply).toHaveBeenCalledTimes(0);
  });
});

describe("haptics on the timeline", () => {
  const haptics = (from: number): unknown[] => tauri.calls.slice(from).filter((c) => c.cmd === "haptic").map((c) => c.args);

  afterEach(() => setPlatform(MAC));

  it("on iOS a pickup plays medium once and a drop that applies plays light once", async () => {
    setPlatform(IPAD);
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const from = tauri.calls.length;
    const y = rowY("Review");
    touch(barOf("Review"), "down", x0(t) + 60, y);
    wait(500);
    expect(haptics(from)).toEqual([{ kind: "medium" }]);
    touch(barOf("Review"), "move", x0(t) + 100, y);
    touch(barOf("Review"), "move", x0(t) + 140, y);
    expect(haptics(from)).toEqual([{ kind: "medium" }]);
    touch(barOf("Review"), "up", x0(t) + 140, y);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(haptics(from)).toEqual([{ kind: "medium" }, { kind: "light" }]);
  });

  it("on iOS a drop with no intent and a cancelled hold play only the pickup", async () => {
    setPlatform(IPAD);
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const from = tauri.calls.length;
    const y = rowY("Review");
    touch(barOf("Review"), "down", x0(t) + 60, y);
    wait(500);
    touch(barOf("Review"), "up", x0(t) + 60, y);
    touch(barOf("Review"), "down", x0(t) + 60, y);
    wait(500);
    touch(barOf("Review"), "move", x0(t) + 140, y);
    touch(barOf("Review"), "cancel", x0(t) + 140, y);
    expect(apply).not.toHaveBeenCalled();
    expect(haptics(from)).toEqual([{ kind: "medium" }, { kind: "medium" }]);
  });

  it("on iOS a refused drop plays the pickup and the error toast's haptic, and no light", async () => {
    setPlatform(IPAD);
    const t = await shown([
      { id: "Review", name: "Review", start: "2026-11-09", dur: 3 },
      { id: "Ship", name: "Ship", start: "2026-11-16", dur: 1, deps: [fs("Review")] },
    ]);
    const apply = vi.spyOn(t.session, "apply");
    const from = tauri.calls.length;
    const shipEnd = geometry(t.session.view(), "W").x(toDay("2026-11-16")) + 40;
    holdAndDrag(one(".nub", barOf("Ship")), shipEnd + 20, x0(t) + 60, rowY("Ship"), rowY("Review"));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(one('[role="alert"]').className).toBe("toast bad");
    expect(haptics(from)).toEqual([{ kind: "medium" }, { kind: "error" }]);
  });

  it("on iOS a drop on a read-only session plays no light", async () => {
    setPlatform(IPAD);
    const t = await shown();
    vi.spyOn(t.session, "readOnlyReason", "get").mockReturnValue(READ_ONLY);
    const from = tauri.calls.length;
    holdAndDrag(barOf("Review"), x0(t) + 60, x0(t) + 140, rowY("Review"));
    expect(toastTexts()).toEqual([READ_ONLY]);
    expect(haptics(from)).toEqual([{ kind: "medium" }, { kind: "error" }]);
  });

  it("on iOS a tap plays nothing", async () => {
    setPlatform(IPAD);
    const t = await shown();
    const from = tauri.calls.length;
    touch(barOf("Review"), "down", x0(t) + 60, rowY("Review"));
    wait(120);
    touch(barOf("Review"), "up", x0(t) + 61, rowY("Review"));
    expect(haptics(from)).toEqual([]);
  });

  it("on macOS a touch pickup and drop send no haptic", async () => {
    const t = await shown();
    const apply = vi.spyOn(t.session, "apply");
    const from = tauri.calls.length;
    holdAndDrag(barOf("Review"), x0(t) + 60, x0(t) + 140, rowY("Review"));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(haptics(from)).toEqual([]);
  });
});
