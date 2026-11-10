import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Refused } from "../../actions/intents";
import type { Pick, ResolveOptions } from "../../actions/resolve";
import { OfferRefused } from "../../actions/undo";
import { schedView } from "../../domain/derive";
import { toDay } from "../../domain/dates";
import { lagThatHolds, type Conflict } from "../../domain/schedule";
import { sideText, type Choice } from "../../plan/choices";
import type { PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { shellFor } from "../../test/shell";
import { impactText } from "../calendar/impact";
import { clearToasts } from "../common/Toast";
import { useUi, type UiState } from "../state";
import { geometry, ROW } from "../timeline/geometry";
import { timelineRows } from "../timeline/rows";
import { bannerText, heldChoice, itemChoices, unitSubject } from "./describe";
import { conflictSuccessor } from "./HeadCounts";
import { groupRows, outcomeLine } from "./outcome";
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

const DEFAULTS: ResolveOptions = { pushFromPredecessors: true, returnPushed: true };

const AB: readonly SeedItem[] = [
  { name: "A", start: "2026-11-10", dur: 3 },
  { name: "B", start: "2026-11-16", dur: 2 },
];

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
};

const peerOf = async (t: TestSession): Promise<{ session: PlanSession; sync(): void }> => {
  const p = await t.peer("iphone");
  sessions.push(p.session);
  return p;
};

const shown = async (t: TestSession): Promise<void> => {
  render(withSync(shellFor(t).ui));
  await settle();
};

const uiNow = (): [UiState, (patch: Partial<UiState>) => void] => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value;
};

const setUi = (patch: Partial<UiState>): void => act(() => uiNow()[1](patch));

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const all = (sel: string, root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

const head = (): HTMLElement => one(".plan-head");
const panel = (): HTMLElement => one('[data-slot="panel"]');
const dialog = (): HTMLElement => screen.getByRole("dialog");
const toastTexts = (): (string | null)[] => screen.queryAllByRole("status").map((e) => e.textContent);
const badToasts = (): (string | null)[] => all(".toast.bad").map((e) => e.textContent);

const click = (el: HTMLElement): void => {
  fireEvent.click(el);
};

const buttonIn = (root: HTMLElement, name: string | RegExp): HTMLButtonElement => {
  const el = within(root).getByRole("button", { name });
  if (!(el instanceof HTMLButtonElement)) throw new Error("no button " + String(name));
  return el;
};

const only = (t: TestSession): Choice => {
  const cs = t.session.view().choices;
  if (cs.length !== 1) throw new Error(`fixture: ${cs.length} choices`);
  return cs[0];
};

const keyOf = (c: Choice, label: string): string => {
  const s = c.sides.find((x) => x.label === label);
  if (s === undefined) throw new Error(`fixture: no side ${label}`);
  return s.key;
};

const columns = (): HTMLElement[] => all(".choice-col", dialog());

const columnOf = (label: string): HTMLElement => {
  const col = columns().find((c) => within(c).queryByRole("button", { name: `Keep ${label}` }) !== null);
  if (col === undefined) throw new Error("no column for " + label);
  return col;
};

const nameOf = (t: TestSession, id: string): string => {
  const it = t.session.view().plan.items.get(id);
  if (it === undefined) throw new Error(`fixture: no item ${id}`);
  return it.name;
};

const startOf = (t: TestSession, id: string): string | null => {
  const s = t.session.view().plan.items.get(id)?.schedule;
  if (s === undefined || s === null) throw new Error(`fixture: no schedule on ${id}`);
  return s.start;
};

const openChoiceFromHead = (t: TestSession, c: Choice): void => {
  const at = t.session.view().choices.findIndex((x) => x.id === c.id);
  if (at < 0) throw new Error("fixture: choice not listed");
  click(buttonIn(one(".chips", head()), "Choose…"));
  click(within(screen.getByRole("list", { name: "Open choices" })).getAllByRole("button")[at]);
  expect(uiNow()[0].dialog).toEqual({ t: "choice", id: c.id });
};

const counted = (cs: readonly Conflict[]): Conflict[] => cs.filter((c) => c.kind !== "dayoff");

const lastPreviewArgs = (spy: { mock: { calls: unknown[][] } }): unknown[] => {
  const calls = spy.mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("previewResolve was not called");
  return last;
};

describe("head counts", () => {
  const SEED: readonly SeedItem[] = [
    { name: "Build", start: "2026-11-16", dur: 5 },
    { name: "Review", start: "2026-11-17", dur: 2, deps: [fs("Build")] },
    { name: "P", start: "2026-11-10", dur: 2 },
    { name: "R", start: "2026-11-10", dur: 2, status: "doing", progress: 20, deps: [fs("P")] },
    { name: "Sat", start: "2026-11-14", dur: 1 },
    { name: "H1", start: "2026-11-30", dur: 1 },
    { name: "H2", start: "2026-11-30", dur: 1 },
    { name: "H3", start: "2026-11-30", dur: 1 },
  ];
  const HELD = ["H1", "H2", "H3"].map((id) => ({ unit: `s:${id}`, mac: ["2026-11-30", 1, "todo", 0, "now"], iphone: ["2026-12-01", 1, "todo", 0, "now"] }));

  it("counts early and loop conflicts in magenta, not day offs, and held items in amber", async () => {
    const t = await made(SEED, { clashes: HELD });
    const view = t.session.view();
    expect(view.derived.conflicts.map((c) => c.kind).sort()).toEqual(["dayoff", "early", "early"]);
    expect(view.held.size).toBe(3);
    await shown(t);
    expect(one(".chip-magenta", head()).textContent).toBe("2 conflicts · Go to first conflict");
    const held = buttonIn(head(), "3 held");
    expect(held.className).toContain("chip-amber");
  });

  it("goes to the first conflict: selects and scrolls to its successor", async () => {
    const fillers: SeedItem[] = Array.from({ length: 30 }, (_, i) => ({ name: `F${i}`, start: "2026-11-10", dur: 1 }));
    const t = await made([...fillers, ...SEED]);
    await shown(t);
    setUi({ view: "board" });
    click(buttonIn(head(), "Go to first conflict"));
    await settle();
    const view = t.session.view();
    const first = counted(view.derived.conflicts)[0];
    if (first === undefined || first.kind !== "early") throw new Error("fixture: no early conflict first");
    expect(uiNow()[0].selected).toBe(first.succ);
    expect(uiNow()[0].view).toBe("timeline");
    const index = timelineRows(view, new Set()).findIndex((r) => r.id === first.succ);
    expect(index).toBeGreaterThan(20);
    const scroll = one(".tl-scroll");
    expect(scroll.scrollTop).toBe(index * ROW);
    const geo = geometry(view, uiNow()[0].zoom);
    const span = geo.span(first.succ);
    if (span === null) throw new Error("fixture: successor has no dates");
    expect(scroll.scrollLeft).toBe(Math.max(0, geo.x(span.start) - 160));
    expect(scroll.scrollLeft).not.toBe(Math.max(0, geo.x(toDay(view.today)) - 160));
    expect(uiNow()[0].reveal).toBeNull();
  });

  it("selects an unscheduled successor without scrolling", async () => {
    const t = await made([
      { name: "L1", start: "2026-11-10", dur: 2, deps: [fs("L2")] },
      { name: "L2", start: null, dur: 2, deps: [fs("L1")] },
    ]);
    const view = t.session.view();
    const first = counted(view.derived.conflicts)[0];
    if (first === undefined || first.kind === "dayoff") throw new Error("fixture: no counted conflict");
    expect(conflictSuccessor(view, first)).toBe("L2");
    await shown(t);
    setUi({ view: "board" });
    click(buttonIn(head(), "Go to first conflict"));
    await settle();
    expect([uiNow()[0].view, uiNow()[0].selected, uiNow()[0].reveal]).toEqual(["timeline", "L2", null]);
    expect(one(".tl-scroll").scrollTop).toBe(0);
    expect(within(panel()).getByLabelText("Name")).toBeTruthy();
  });

  it("throws by name when a revealed item has no row", async () => {
    const t = await made(AB);
    await shown(t);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => setUi({ reveal: "zz" })).toThrow(new Error("Timeline: no row for zz to reveal"));
  });

  it("shows no conflict count without conflicts", async () => {
    const t = await made(AB);
    await shown(t);
    expect(head().querySelector(".chip-magenta")).toBeNull();
  });
});

describe("fix actions", () => {
  it("pushes a successor with no lock", async () => {
    const t = await made([
      { name: "Build", start: "2026-11-16", dur: 5 },
      { name: "Review", start: "2026-11-17", dur: 2, deps: [fs("Build")] },
    ]);
    await shown(t);
    setUi({ selected: "Review" });
    expect(within(panel()).getByText("Starts earlier than the link from “Build” allows.")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: /Shorten the lag/ })).toBeNull();
    const apply = vi.spyOn(t.session, "apply");
    click(buttonIn(panel(), "Push “Review” to Mon 23 Nov"));
    expect(apply.mock.calls.map((c) => [c[0].t, c[0].t === "fix" ? c[0].how : null])).toEqual([["fix", "push"]]);
    expect(startOf(t, "Review")).toBe("2026-11-23");
    const built = apply.mock.results[0]?.value;
    expect(toastTexts()).toEqual([built?.toast]);
  });

  it("offers a shorter lag or no link on an item in progress", async () => {
    const t = await made([
      { name: "Build", start: "2026-11-16", dur: 2 },
      { name: "Review", start: "2026-11-19", dur: 2, status: "doing", progress: 10, deps: [fs("Build", 3)] },
    ]);
    const view = t.session.view();
    const sv = schedView(view.plan, view.held);
    const link = view.plan.links.get("Build>Review");
    const succ = sv.items.get("Review");
    const pred = sv.items.get("Build");
    if (link === undefined || succ === undefined || pred === undefined) throw new Error("fixture: no link");
    expect(lagThatHolds(succ, link, pred, sv.cal)).toBe(1);
    await shown(t);
    setUi({ selected: "Review" });
    expect(within(panel()).getByText("Started before “Build” finished")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: /^Push/ })).toBeNull();
    expect(buttonIn(panel(), "Remove the link")).toBeTruthy();
    click(buttonIn(panel(), "Shorten the lag to 1"));
    expect(t.session.view().plan.links.get("Build>Review")?.lag).toBe(1);
    expect(counted(t.session.view().derived.conflicts)).toEqual([]);
  });

  it("opens the choice of a held successor", async () => {
    const t = await made(
      [
        { name: "Build", start: "2026-11-16", dur: 5 },
        { name: "Review", start: "2026-11-17", dur: 2, deps: [fs("Build")] },
      ],
      { clashes: [{ unit: "s:Review", mac: ["2026-11-17", 2, "todo", 0, "now"], iphone: ["2026-11-18", 2, "todo", 0, "now"] }] },
    );
    const c = only(t);
    await shown(t);
    setUi({ selected: "Review" });
    expect(within(panel()).queryByRole("button", { name: /^Push/ })).toBeNull();
    click(buttonIn(panel(), "Open the choice"));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: c.id });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(toastTexts()).toEqual([]);
  });

  it("opens the choice of a held successor while read-only, without a write", async () => {
    const t = await made(
      [
        { name: "Build", start: "2026-11-16", dur: 5 },
        { name: "Review", start: "2026-11-17", dur: 2, deps: [fs("Build")] },
      ],
      { clashes: [{ unit: "s:Review", mac: ["2026-11-17", 2, "todo", 0, "now"], iphone: ["2026-11-18", 2, "todo", 0, "now"] }] },
    );
    const c = only(t);
    await shown(t);
    act(() => t.session.setReadOnly(true));
    const apply = vi.spyOn(t.session, "apply");
    setUi({ selected: "Review" });
    click(buttonIn(panel(), "Open the choice"));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: c.id });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
  });

  it("opens the choice when a push meets a successor held meanwhile", async () => {
    const t = await made([
      { name: "Build", start: "2026-11-16", dur: 5 },
      { name: "Review", start: "2026-11-17", dur: 2, deps: [fs("Build")] },
    ]);
    const p = await peerOf(t);
    t.session.apply({ t: "schedule", item: "Review", set: { dur: 3 } });
    p.session.apply({ t: "schedule", item: "Review", set: { dur: 4 } });
    await shown(t);
    setUi({ selected: "Review" });
    const push = buttonIn(panel(), "Push “Review” to Mon 23 Nov");
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      p.sync();
      click(push);
    });
    const c = only(t);
    expect(t.session.view().held.has("Review")).toBe(true);
    expect(apply.mock.calls.map((x) => x[0].t)).toEqual(["fix"]);
    expect(apply.mock.results.map((r) => r.type)).toEqual(["throw"]);
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: c.id });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(startOf(t, "Review")).toBe("2026-11-17");
  });

  it("offers a shorter lag or no link on a done item, and removes the link", async () => {
    const t = await made([
      { name: "Build", start: "2026-11-16", dur: 2 },
      { name: "Review", start: "2026-11-19", dur: 2, status: "done", progress: 100, deps: [fs("Build", 3)] },
    ]);
    const early = t.session.view().derived.conflicts.find((c) => c.kind === "early");
    if (early === undefined || early.kind !== "early") throw new Error("fixture: no early conflict");
    expect(early.succLock).toBe("done");
    await shown(t);
    setUi({ selected: "Review" });
    expect(within(panel()).getByText("Started before “Build” finished")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: /^Push/ })).toBeNull();
    expect(buttonIn(panel(), "Shorten the lag to 1")).toBeTruthy();
    const apply = vi.spyOn(t.session, "apply");
    click(buttonIn(panel(), "Remove the link"));
    expect(apply.mock.calls).toEqual([[{ t: "fix", conflict: early, how: "remove" }]]);
    expect(t.session.view().plan.links.has("Build>Review")).toBe(false);
  });

  it("removes a link in a loop", async () => {
    const t = await made([
      { name: "L1", start: "2026-11-10", dur: 2, deps: [fs("L2")] },
      { name: "L2", start: "2026-11-12", dur: 2, deps: [fs("L1")] },
    ]);
    expect(t.session.view().derived.conflicts.map((c) => c.kind)).toEqual(["loop", "loop"]);
    await shown(t);
    expect(one(".chip-magenta", head()).textContent).toBe("2 conflicts · Go to first conflict");
    setUi({ selected: "L2" });
    expect(within(panel()).getByText("The link from “L1” is part of a loop.")).toBeTruthy();
    expect(within(panel()).getAllByRole("button", { name: /Remove the link|Push|Shorten/ }).map((b) => b.textContent)).toEqual(["Remove the link"]);
    click(buttonIn(panel(), "Remove the link"));
    expect(t.session.view().plan.links.has("L1>L2")).toBe(false);
    expect(t.session.view().derived.conflicts.filter((c) => c.kind === "loop")).toEqual([]);
  });

  it("snaps a start on a day off", async () => {
    const t = await made([{ name: "Sat", start: "2026-11-14", dur: 1 }]);
    await shown(t);
    setUi({ selected: "Sat" });
    expect(within(panel()).getByText("Starts on a day off — shown from Mon 16 Nov")).toBeTruthy();
    click(buttonIn(panel(), "Snap to next working day"));
    expect(startOf(t, "Sat")).toBe("2026-11-16");
    expect(t.session.view().derived.conflicts).toEqual([]);
  });

  it("offers no fix while read-only", async () => {
    const t = await made([
      { name: "Build", start: "2026-11-16", dur: 5 },
      { name: "Review", start: "2026-11-17", dur: 2, deps: [fs("Build")] },
      { name: "Sat", start: "2026-11-14", dur: 1 },
    ]);
    await shown(t);
    act(() => t.session.setReadOnly(true));
    const apply = vi.spyOn(t.session, "apply");
    setUi({ selected: "Review" });
    expect(within(panel()).getByText("Starts earlier than the link from “Build” allows.")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: /Push|Shorten|Remove the link/ })).toBeNull();
    setUi({ selected: "Sat" });
    expect(within(panel()).getByText("Starts on a day off — shown from Mon 16 Nov")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: "Snap to next working day" })).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("calendar banner", () => {
  it("stays in amber until the owner chooses, and opens the choice", async () => {
    const t = await made(AB, { clashes: [{ unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null }] });
    const c = only(t);
    await shown(t);
    const banner = one(".calendar-banner", head());
    expect(within(banner).getByText("The calendar was changed on two devices. Nothing moves until you choose.")).toBeTruthy();
    click(buttonIn(banner, "Choose…"));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: c.id });
  });

  it("tells its Choose… apart from the open-choices Choose… by its description", async () => {
    const t = await made(AB, { clashes: [{ unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null }] });
    await shown(t);
    const chooses = within(head()).getAllByRole("button", { name: "Choose…" });
    expect(chooses).toHaveLength(2);
    expect(within(head()).getByRole("button", { name: "Choose…", description: "The calendar was changed on two devices. Nothing moves until you choose." })).toBe(
      buttonIn(one(".calendar-banner", head()), "Choose…"),
    );
    expect(buttonIn(one(".chips", head()), "Choose…").getAttribute("aria-describedby")).toBeNull();
  });

  it("is absent without a calendar choice", async () => {
    const t = await made(AB, { clashes: [{ unit: "n:A", mac: "Alpha", iphone: "Beta" }] });
    await shown(t);
    expect(document.querySelector(".calendar-banner")).toBeNull();
  });
});

describe("choice dialog", () => {
  const SCHED = { unit: "s:A", mac: ["2026-11-10", 3, "todo", 0, "now"], iphone: ["2026-11-12", 3, "todo", 0, "now"] };
  const CHAIN: readonly SeedItem[] = [
    { name: "A", start: "2026-11-10", dur: 3 },
    { name: "B", start: "2026-11-17", dur: 2, deps: [fs("A")] },
    { name: "C", start: "2026-11-19", dur: 2, deps: [fs("B")] },
  ];

  it("shows a column per side, from sideText, sideContent and the grouped drill-down", async () => {
    const t = await made(CHAIN, { clashes: [SCHED] });
    const c = only(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    const plan = t.session.view().plan;
    expect(columns()).toHaveLength(2);
    c.sides.forEach((s) => {
      const col = columnOf(s.label);
      const rp = t.session.previewResolve(c.id, { side: s.key }, DEFAULTS);
      const moved = rp.rows.filter((r) => JSON.stringify(r.before) !== JSON.stringify(r.after)).length;
      expect(one(".choice-side", col).textContent).toBe(sideText(c, s.key, plan));
      expect(all(".choice-value", col).map((e) => e.textContent)).toEqual([`${unitSubject("s:A", plan)}: starts ${s.label === "Mac" ? "10" : "12"} Nov · 3 working days`]);
      expect(one(".choice-summary", col).textContent).toBe(`moves ${moved}`);
      expect(all(".choice-kept", col).map((e) => e.textContent)).toEqual([...rp.preview.kept]);
      expect(col.querySelector(".recal")).toBeNull();
      const moves = one(".choice-moves", col);
      expect(within(moves).getByText("Show what moves")).toBeTruthy();
      const sections = groupRows(rp.rows, plan);
      expect(all(".moves-title", moves).map((e) => e.textContent)).toEqual(sections.map((x) => x.title));
      expect(all(".moves-line", moves).map((e) => e.textContent)).toEqual(sections.flatMap((x) => x.rows.map((r) => outcomeLine(r, plan))));
    });
    expect(c.sides.some((s) => one(".choice-summary", columnOf(s.label)).textContent !== "moves 0")).toBe(true);
  });

  it("lists where a push stops", async () => {
    const t = await made(
      [
        { name: "P", start: "2026-11-10", dur: 3 },
        { name: "A", start: "2026-11-13", dur: 3, deps: [fs("P")] },
        { name: "B", start: "2026-11-16", dur: 2, status: "doing", progress: 10, deps: [fs("A")] },
      ],
      { clashes: [{ unit: "s:A", mac: ["2026-11-10", 3, "todo", 0, "now"], iphone: ["2026-11-11", 3, "todo", 0, "now"] }] },
    );
    const c = only(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    c.sides.forEach((s) => {
      const rp = t.session.previewResolve(c.id, { side: s.key }, DEFAULTS);
      const names = rp.preview.stopped.map((x) => `stopped at in progress “${nameOf(t, x.id)}”`);
      expect(all(".choice-stopped", columnOf(s.label)).map((e) => e.textContent)).toEqual(names);
    });
    expect(all(".choice-stopped", dialog()).map((e) => e.textContent)).toEqual(["stopped at in progress “B”", "stopped at in progress “B”"]);
  });

  it("shows a calendar choice's impact apart from its values", async () => {
    const t = await made(AB, { clashes: [{ unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null }] });
    const c = only(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    c.sides.forEach((s) => {
      const col = columnOf(s.label);
      const rp = t.session.previewResolve(c.id, { side: s.key }, DEFAULTS);
      expect(one(".recal", col).textContent).toBe(impactText(rp.preview));
      expect(all(".choice-value", col).map((e) => e.textContent)).toEqual([s.label === "Mac" ? "The calendar: day off “Away”" : "The calendar: not tuned"]);
    });
  });

  it("opens each side of a delete choice with its sentence", async () => {
    const t = await made([
      { id: "S", name: "Sprint 4", kind: "group" },
      { id: "Review", name: "Review", parent: "S", start: "2026-11-10", dur: 2 },
    ]);
    const p = await peerOf(t);
    t.session.apply({ t: "trash", items: ["S"] });
    p.session.apply({ t: "rename", item: "Review", name: "Reviewed" });
    p.sync();
    const c = only(t);
    expect(c.kind).toBe("delete");
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    expect(one(".choice-side", columnOf("Mac")).textContent).toBe("“Sprint 4” stays in the Trash");
    expect(one(".choice-side", columnOf("iPhone")).textContent).toBe("“Sprint 4” is restored with the iPhone's edit");
    expect(buttonIn(dialog(), "Keep Mac")).toBeTruthy();
    expect(buttonIn(dialog(), "Keep iPhone")).toBeTruthy();
  });

  it("re-runs the preview with each option and keeps with the same arguments", async () => {
    const t = await made(CHAIN, { clashes: [SCHED] });
    const c = only(t);
    await shown(t);
    const preview = vi.spyOn(t.session, "previewResolve");
    const resolve = vi.spyOn(t.session, "resolve");
    setUi({ dialog: { t: "choice", id: c.id } });
    const push = within(dialog()).getByRole("checkbox", { name: "Push from predecessors" });
    const back = within(dialog()).getByRole("checkbox", { name: "Return the items the other side's push moved" });
    expect([push instanceof HTMLInputElement && push.checked, back instanceof HTMLInputElement && back.checked]).toEqual([true, true]);
    expect(preview.mock.calls.map((x) => x[2])).toContainEqual(DEFAULTS);
    preview.mockClear();
    click(push);
    const off: ResolveOptions = { pushFromPredecessors: false, returnPushed: true };
    expect(preview.mock.calls.map((x) => [x[0], x[1], x[2]])).toEqual(["Mac", "iPhone"].map((l) => [c.id, { side: keyOf(c, l) }, off]));
    preview.mockClear();
    click(back);
    expect(lastPreviewArgs(preview)[2]).toEqual({ pushFromPredecessors: false, returnPushed: false });
    click(buttonIn(dialog(), "Keep iPhone"));
    const iphone = keyOf(c, "iPhone");
    expect(resolve.mock.calls).toEqual([[c.id, { side: iphone }, { pushFromPredecessors: false, returnPushed: false }]]);
    const built = resolve.mock.results[0]?.value;
    expect(toastTexts()).toEqual([built?.toast]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(startOf(t, "A")).toBe("2026-11-12");
  });

  it("picks per item, one row per unit named by its subject", async () => {
    const t = await made(AB, { clashes: [{ unit: ["n:A", "n:B"], mac: ["North", "East"], iphone: ["South", "West"] }] });
    const c = only(t);
    await shown(t);
    const a = nameOf(t, "A");
    const b = nameOf(t, "B");
    const preview = vi.spyOn(t.session, "previewResolve");
    const resolve = vi.spyOn(t.session, "resolve");
    setUi({ dialog: { t: "choice", id: c.id } });
    expect(dialog().querySelector(".pick-rows")).toBeNull();
    click(within(dialog()).getByRole("checkbox", { name: "Pick per item" }));
    const rows = all(".pick-row", dialog());
    expect(rows.map((r) => one(".pick-subject", r).textContent)).toEqual([`“${a}”`, `“${b}”`]);
    rows.forEach((r) => {
      expect(one(".pick-subject", r).id).not.toBe("");
      expect(one("select", r).getAttribute("aria-labelledby")).toBe(one(".pick-subject", r).id);
      expect(one("select", r).hasAttribute("aria-label")).toBe(false);
    });
    expect(within(dialog()).getByRole("combobox", { name: `“${b}”` })).toBe(one("select", rows[1]));
    preview.mockClear();
    const pickA = rows[0].querySelector("select");
    if (!(pickA instanceof HTMLSelectElement)) throw new Error("no pick for A");
    fireEvent.change(pickA, { target: { value: keyOf(c, "iPhone") } });
    const perUnit = new Map([["n:A", keyOf(c, "iPhone")]]);
    const picks: Pick[] = ["Mac", "iPhone"].map((l) => ({ side: keyOf(c, l), perUnit }));
    expect(preview.mock.calls.map((x) => x[1])).toEqual(picks);
    click(buttonIn(dialog(), "Keep Mac"));
    expect(resolve.mock.calls).toEqual([[c.id, { side: keyOf(c, "Mac"), perUnit }, DEFAULTS]]);
    expect([nameOf(t, "A"), nameOf(t, "B")]).toEqual(["South", "East"]);
  });

  it("puts this device's side first even when the iPhone's replays first", async () => {
    const t = await made(AB);
    const p = await peerOf(t);
    t.session.apply({ t: "rename", item: "A", name: "Draft" });
    t.session.apply({ t: "rename", item: "A", name: "Alpha" });
    p.session.apply({ t: "rename", item: "A", name: "Beta" });
    p.sync();
    const c = only(t);
    expect(c.sides.map((s) => s.label)).toEqual(["iPhone", "Mac"]);
    await shown(t);
    setUi({ selected: "A" });
    expect(one(".choice-banner .banner-text", panel()).textContent).toBe("Changed on Mac and iPhone. Choose which to keep.");
    click(buttonIn(one(".choice-banner", panel()), "Choose"));
    expect(all(".choice-side", dialog()).map((e) => e.textContent)).toEqual(["Mac", "iPhone"]);
    expect(within(dialog()).getAllByRole("button", { name: /^Keep / }).map((b) => b.textContent)).toEqual(["Keep Mac", "Keep iPhone"]);
  });

  it("lists two stopped items of the same name without a key clash", async () => {
    const errors = vi.spyOn(console, "error");
    const t = await made(
      [
        { name: "P", start: "2026-11-10", dur: 3 },
        { name: "A", start: "2026-11-13", dur: 3, deps: [fs("P")] },
        { id: "B1", name: "Same", start: "2026-11-16", dur: 2, status: "doing", progress: 10, deps: [fs("A")] },
        { id: "B2", name: "Same", start: "2026-11-16", dur: 2, status: "doing", progress: 10, deps: [fs("A")] },
      ],
      { clashes: [{ unit: "s:A", mac: ["2026-11-10", 3, "todo", 0, "now"], iphone: ["2026-11-11", 3, "todo", 0, "now"] }] },
    );
    const c = only(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    expect(all(".choice-stopped", dialog()).map((e) => e.textContent)).toEqual(Array.from({ length: 4 }, () => "stopped at in progress “Same”"));
    expect(errors).not.toHaveBeenCalled();
  });

  it("drops a per-item pick whose unit left the open choice, and says so", async () => {
    const t = await made(AB, { clashes: [{ unit: ["n:A", "n:B"], mac: ["North", "East"], iphone: ["South", "West"] }] });
    const c = only(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    click(within(dialog()).getByRole("checkbox", { name: "Pick per item" }));
    const pickB = all(".pick-row select", dialog())[1];
    fireEvent.change(pickB, { target: { value: keyOf(c, "iPhone") } });
    expect(toastTexts()).toEqual([]);
    const preview = vi.spyOn(t.session, "previewResolve");
    const shrunk: Choice = {
      ...c,
      units: c.units.filter((u) => u !== "n:B"),
      sides: c.sides.map((s) => ({ ...s, values: new Map([...s.values].filter(([u]) => u !== "n:B")) })),
    };
    vi.spyOn(t.session, "view").mockReturnValue({ ...t.session.view(), choices: [shrunk] });
    act(() => t.session.setReadOnly(false));
    expect(all(".pick-row", dialog())).toHaveLength(1);
    expect(preview.mock.calls.map((x) => x[1])).toEqual([{ side: keyOf(c, "Mac") }, { side: keyOf(c, "iPhone") }]);
    expect(toastTexts()).toEqual([`Your pick for “${nameOf(t, "B")}” no longer applies.`]);
    expect(badToasts()).toEqual([]);
    preview.mockClear();
    setUi({ dialog: { t: "choice", id: c.id } });
    setUi({ dialog: { t: "choice", id: c.id } });
    expect(preview).not.toHaveBeenCalled();
    vi.mocked(t.session.view).mockReturnValue({ ...t.session.view(), choices: [c] });
    act(() => t.session.setReadOnly(false));
    const rejoined = all(".pick-row select", dialog());
    expect(rejoined).toHaveLength(2);
    expect(rejoined.map((s) => (s instanceof HTMLSelectElement ? s.value : null))).toEqual(["", ""]);
    expect(toastTexts()).toHaveLength(1);
  });

  it("offers the other version on Undo, and resolves only when it is pressed", async () => {
    const t = await made(AB);
    const p = await peerOf(t);
    t.session.apply({ t: "move", items: ["A"], days: 1 });
    p.session.apply({ t: "move", items: ["A"], days: 2 });
    p.sync();
    const c = only(t);
    expect([c.kind, c.units]).toEqual(["items", ["s:A"]]);
    const offer = t.session.undoOffer();
    if (offer === null) throw new Error("fixture: no undo offer");
    await shown(t);
    const undo = vi.spyOn(t.session, "undo");
    const resolve = vi.spyOn(t.session, "resolve");
    click(screen.getByRole("button", { name: "Undo" }));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: offer.choice, side: offer.side });
    const keepOther = buttonIn(dialog(), "Keep the other version");
    expect(one(".undo-offer", dialog()).textContent).toBe("Keep the other version");
    expect(buttonIn(dialog(), "Keep Mac")).toBeTruthy();
    expect(buttonIn(dialog(), "Keep iPhone")).toBeTruthy();
    const picked = columns().filter((col) => col.classList.contains("picked"));
    const label = c.sides.find((s) => s.key === offer.side)?.label;
    expect(picked.map((col) => within(col).queryByRole("button", { name: `Keep ${label}` }) !== null)).toEqual([true]);
    expect([undo.mock.calls.length, resolve.mock.calls.length]).toEqual([0, 0]);
    click(keepOther);
    expect(undo).not.toHaveBeenCalled();
    expect(resolve.mock.calls).toEqual([[offer.choice, { side: offer.side }, DEFAULTS]]);
    expect(t.session.view().choices).toEqual([]);
  });

  it("opens the offer an undo refuses with", async () => {
    const t = await made(AB);
    const p = await peerOf(t);
    t.session.apply({ t: "move", items: ["A"], days: 1 });
    p.session.apply({ t: "move", items: ["A"], days: 2 });
    p.sync();
    const offer = t.session.undoOffer();
    if (offer === null) throw new Error("fixture: no undo offer");
    await shown(t);
    vi.spyOn(t.session, "undoOffer").mockReturnValue(null);
    vi.spyOn(t.session, "undo").mockImplementation(() => {
      throw new OfferRefused(offer);
    });
    click(screen.getByRole("button", { name: "Undo" }));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: offer.choice, side: offer.side });
    expect(buttonIn(dialog(), "Keep the other version")).toBeTruthy();
  });

  it("has no offer when opened without a side", async () => {
    const t = await made(AB, { clashes: [{ unit: "n:A", mac: "Alpha", iphone: "Beta" }] });
    const c = only(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    expect(dialog().querySelector(".undo-offer")).toBeNull();
    expect(columns().filter((col) => col.classList.contains("picked"))).toEqual([]);
  });
});

describe("a choice settled meanwhile", () => {
  const NAME = { unit: "n:A", mac: "Alpha", iphone: "Beta" };

  it("closes the dialog and says so", async () => {
    const t = await made(AB, { clashes: [NAME] });
    const p = await peerOf(t);
    const c = only(t);
    await shown(t);
    const resolve = vi.spyOn(t.session, "resolve");
    openChoiceFromHead(t, c);
    expect(screen.getByRole("dialog")).toBeTruthy();
    p.session.resolve(c.id, { side: keyOf(c, "iPhone") }, DEFAULTS);
    act(() => p.sync());
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual(["This choice was settled meanwhile."]);
    expect(nameOf(t, "A")).toBe("Beta");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("says nothing when the plan goes to the Trash elsewhere and another plan opens", async () => {
    const t = await made(AB, { clashes: [NAME] });
    const other = await made(AB, { plan: "p-other" });
    const c = only(t);
    const id = t.session.view().plan.id;
    let trashed = false;
    const pick = <T,>(x: string, mine: T, theirs: T): Promise<T> =>
      x === id ? Promise.resolve(mine) : x === "p-other" ? Promise.resolve(theirs) : Promise.reject(new Error("no plan " + x));
    const { ui, registry } = shellFor(t, {
      plans: () => [
        { id, name: "One", trashed, loaded: true, space: null },
        { id: "p-other", name: "Two", trashed: false, loaded: true, space: null },
      ],
      session: (x) => pick(x, t.session, other.session),
      doc: (x) => pick(x, t.doc, other.doc),
    });
    render(withSync(ui));
    await settle();
    openChoiceFromHead(t, c);
    expect(screen.getByRole("dialog")).toBeTruthy();
    trashed = true;
    act(() => registry.notify());
    expect(uiNow()[0].dialog).toBeNull();
    await settle();
    expect(uiNow()[0].plan).toBe("p-other");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual(["“One” was moved to the Trash on another device. Restore it from the Trash."]);
  });

  it("closes a dialog opened on a choice that is already gone, and says it was settled", async () => {
    const t = await made(AB);
    await shown(t);
    setUi({ dialog: { t: "choice", id: "gone" } });
    await settle();
    expect(uiNow()[0].dialog).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual(["This choice was settled meanwhile."]);
    expect(badToasts()).toEqual([]);
  });

  it("says it once when a Keep loses the race with the sync that settled it", async () => {
    const t = await made(AB, { clashes: [NAME] });
    const p = await peerOf(t);
    const c = only(t);
    await shown(t);
    openChoiceFromHead(t, c);
    const real = t.session.resolve.bind(t.session);
    const resolve = vi.spyOn(t.session, "resolve").mockImplementation((...args) => {
      p.session.resolve(c.id, { side: keyOf(c, "iPhone") }, DEFAULTS);
      p.sync();
      return real(...args);
    });
    click(buttonIn(dialog(), "Keep Mac"));
    await settle();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(badToasts()).toEqual(["This choice was settled meanwhile."]);
    expect(toastTexts()).toEqual(["This choice was settled meanwhile."]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uiNow()[0].dialog).toBeNull();
    expect(nameOf(t, "A")).toBe("Beta");
  });

  const offered = async (): Promise<{ t: TestSession; p: { session: PlanSession; sync(): void }; c: Choice; offer: { choice: string; side: string } }> => {
    const t = await made(AB);
    const p = await peerOf(t);
    t.session.apply({ t: "move", items: ["A"], days: 1 });
    p.session.apply({ t: "move", items: ["A"], days: 2 });
    p.sync();
    const offer = t.session.undoOffer();
    if (offer === null) throw new Error("fixture: no undo offer");
    await shown(t);
    click(screen.getByRole("button", { name: "Undo" }));
    return { t, p, c: only(t), offer };
  };

  it("closes the undo offer the same way", async () => {
    const { t, p, c, offer } = await offered();
    expect(buttonIn(dialog(), "Keep the other version")).toBeTruthy();
    p.session.resolve(offer.choice, { side: keyOf(c, "iPhone") }, DEFAULTS);
    act(() => p.sync());
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual(["This choice was settled meanwhile."]);
    expect(t.session.view().choices).toEqual([]);
  });

  it("only toasts the built toast when its own Keep settled it", async () => {
    const { t } = await offered();
    const resolve = vi.spyOn(t.session, "resolve");
    click(buttonIn(dialog(), "Keep Mac"));
    await settle();
    const built = resolve.mock.results[0]?.value;
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastTexts()).toEqual([built?.toast]);
  });

  it("shows a refused Keep as a bad toast", async () => {
    const { t } = await offered();
    vi.spyOn(t.session, "resolve").mockImplementation(() => {
      throw new Refused("This choice was settled meanwhile.");
    });
    click(buttonIn(dialog(), "Keep Mac"));
    await settle();
    expect(badToasts()).toEqual(["This choice was settled meanwhile."]);
    expect(toastTexts()).toEqual(["This choice was settled meanwhile."]);
  });
});

describe("a read-only choice dialog", () => {
  it("disables every Keep but still previews options and picks", async () => {
    const t = await made(AB);
    const p = await peerOf(t);
    t.session.apply({ t: "move", items: ["A"], days: 1 });
    p.session.apply({ t: "move", items: ["A"], days: 2 });
    p.sync();
    await shown(t);
    click(screen.getByRole("button", { name: "Undo" }));
    act(() => t.session.setReadOnly(true));
    const apply = vi.spyOn(t.session, "apply");
    const resolve = vi.spyOn(t.session, "resolve");
    const preview = vi.spyOn(t.session, "previewResolve");
    const keeps = within(dialog()).getAllByRole("button", { name: /^Keep / });
    expect(keeps.map((b) => b.textContent)).toEqual(["Keep the other version", "Keep Mac", "Keep iPhone"]);
    expect(keeps.every((b) => b instanceof HTMLButtonElement && b.disabled)).toBe(true);
    click(within(dialog()).getByRole("checkbox", { name: "Push from predecessors" }));
    expect(preview.mock.calls.length).toBeGreaterThan(0);
    preview.mockClear();
    click(within(dialog()).getByRole("checkbox", { name: "Pick per item" }));
    const pick = one(".pick-row select", dialog());
    fireEvent.change(pick, { target: { value: only(t).sides[1].key } });
    expect(preview.mock.calls.length).toBeGreaterThan(0);
    keeps.forEach((b) => click(b));
    expect(apply).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("every open choice is reachable", () => {
  const SCHED = { unit: "s:A", mac: ["2026-11-10", 3, "todo", 0, "now"], iphone: ["2026-11-12", 3, "todo", 0, "now"] };

  const heldControls = (): HTMLElement[] => all("*", head()).filter((e) => e.children.length === 0 && (e.textContent ?? "").endsWith("held"));

  const settled = (t: TestSession): void => {
    expect(t.session.view().choices).toEqual([]);
    expect(head().textContent).not.toMatch(/open choice/);
  };

  it("opens a held choice from the one held count", async () => {
    const t = await made(AB, { clashes: [SCHED] });
    await shown(t);
    expect(heldControls().map((e) => e.textContent)).toEqual(["1 held"]);
    click(buttonIn(head(), "1 held"));
    const held = heldChoice(t.session.view());
    if (held === null) throw new Error("fixture: no held choice");
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: held.id });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows one banner in the item panel, for its first choice, until none is left", async () => {
    const t = await made(AB, {
      clashes: [
        { unit: "n:A", mac: "North", iphone: "South" },
        { unit: "l:A>B", mac: ["FS", 0], iphone: ["SS", 1] },
      ],
    });
    await shown(t);
    setUi({ selected: "A" });
    const bannerNow = (): HTMLElement[] => all(".choice-banner", panel());
    const first = itemChoices(t.session.view(), "A")[0];
    expect(bannerNow().map((b) => one(".banner-text", b).textContent)).toEqual([bannerText(first, "Mac")]);
    const name = within(panel()).getByLabelText("Name");
    expect(bannerNow()[0].compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click(buttonIn(bannerNow()[0], "Choose"));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: first.id });
    click(buttonIn(dialog(), "Keep Mac"));
    const next = itemChoices(t.session.view(), "A");
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe(first.id);
    expect(bannerNow()).toHaveLength(1);
    click(buttonIn(bannerNow()[0], "Choose"));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: next[0].id });
    click(buttonIn(dialog(), "Keep Mac"));
    expect(itemChoices(t.session.view(), "A")).toEqual([]);
    expect(bannerNow()).toEqual([]);
  });

  it("opens a rename clash from the header", async () => {
    const t = await made(AB, { clashes: [{ unit: "n:A", mac: "Alpha", iphone: "Beta" }] });
    expect(t.session.view().held.size).toBe(0);
    await shown(t);
    expect(heldControls()).toEqual([]);
    expect(one(".chip-amber", head()).textContent).toBe("1 open choice · Choose…");
    openChoiceFromHead(t, only(t));
    click(buttonIn(dialog(), "Keep Mac"));
    expect(nameOf(t, "A")).toBe("Alpha");
    settled(t);
  });

  it("opens a baseline clash from the header", async () => {
    const t = await made(AB, { clashes: [{ unit: "b:B1", mac: { name: "Before", at: "2026-11-09", dates: {} }, iphone: null }] });
    await shown(t);
    expect(one(".chip-amber", head()).textContent).toBe("1 open choice · Choose…");
    expect(heldControls()).toEqual([]);
    openChoiceFromHead(t, only(t));
    click(buttonIn(dialog(), "Keep iPhone"));
    expect(t.session.view().plan.baselines.has("B1")).toBe(false);
    settled(t);
  });

  it("opens a delete clash from the item panel", async () => {
    const { t, p } = await deleteClash();
    sessions.push(t.session, p.session);
    const c = only(t);
    expect(c.kind).toBe("delete");
    expect(c.units.some((u) => u.startsWith("s:"))).toBe(false);
    await shown(t);
    setUi({ selected: "A" });
    const text = "Changed on Mac and iPhone. Choose which to keep.";
    expect(bannerText(c, "Mac")).toBe(text);
    expect(one(".choice-banner .banner-text", panel()).textContent).toBe(text);
    setUi({ selected: null, view: "list" });
    const ghost = one("tr.ghost-row");
    fireEvent.pointerDown(ghost, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(ghost, { button: 0, clientX: 12, clientY: 11 });
    expect(uiNow()[0].selected).toBe("A");
    expect(one(".choice-banner .banner-text", panel()).textContent).toBe(text);
    click(buttonIn(one(".choice-banner", panel()), "Choose"));
    click(buttonIn(dialog(), "Keep iPhone"));
    const a = t.session.view().plan.items.get("A");
    expect([a?.trashed, a?.name]).toEqual([false, "Renamed"]);
    settled(t);
  });

  it("opens a held schedule clash from the held count", async () => {
    const t = await made(AB, { clashes: [SCHED] });
    await shown(t);
    expect(head().querySelector(".chip-magenta")).toBeNull();
    click(buttonIn(head(), "1 held"));
    click(buttonIn(dialog(), "Keep Mac"));
    expect(startOf(t, "A")).toBe("2026-11-10");
    expect(heldControls()).toEqual([]);
    settled(t);
  });

  it("opens a calendar choice from the header", async () => {
    const t = await made(AB, { clashes: [{ unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null }] });
    await shown(t);
    expect(one(".chip-amber", head()).textContent).toBe("1 open choice · Choose…");
    expect(head().querySelector(".calendar-banner")).not.toBeNull();
    openChoiceFromHead(t, only(t));
    click(buttonIn(dialog(), "Keep Mac"));
    expect(t.session.view().plan.calendar.tuning.get("2026-11-17")).toEqual({ kind: "add", name: "Away" });
    expect(head().querySelector(".calendar-banner")).toBeNull();
    settled(t);
  });

  it("lists two open choices at once", async () => {
    const t = await made(AB, {
      clashes: [
        { unit: "n:A", mac: "Alpha", iphone: "Beta" },
        { unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null },
      ],
    });
    await shown(t);
    expect(one(".chip-amber", head()).textContent).toBe("2 open choices · Choose…");
    click(buttonIn(one(".chips", head()), "Choose…"));
    expect(within(screen.getByRole("list", { name: "Open choices" })).getAllByRole("button")).toHaveLength(2);
  });
});
