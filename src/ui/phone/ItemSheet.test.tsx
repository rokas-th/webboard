import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Refused, type Built, type Intent } from "../../actions/intents";
import type { ItemId } from "../../domain/model";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { phoneRegistry } from "../../test/phone";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { setScreen } from "../../test/setup";
import { withSync } from "../../test/withSync";
import { bannerText } from "../choices/describe";
import { clearToasts, Toasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { useUi, type UiState } from "../state";
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

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
};

const REVIEW: SeedItem = { name: "Review", start: "2026-11-13", dur: 3 };

const shown = (t: TestSession, item: ItemId) => {
  const apply = vi.spyOn(t.session, "apply");
  const onChoice = vi.fn();
  const onClose = vi.fn();
  render(
    <OpenChoice.Provider value={onChoice}>
      <ItemSheet session={t.session} item={item} local="Mac" onClose={onClose} />
      <Toasts />
    </OpenChoice.Provider>,
  );
  return { apply, onChoice, onClose };
};

const sheet = (): HTMLElement => screen.getByRole("dialog");
const button = (name: string): HTMLElement => within(sheet()).getByRole("button", { name });
const noButton = (name: string): HTMLElement | null => within(sheet()).queryByRole("button", { name });
const startText = (): string | null => sheet().querySelector(".isheet-start")?.textContent ?? null;
const intents = (apply: { mock: { calls: Intent[][] } }): Intent[] => apply.mock.calls.map((c) => c[0]);
const toasts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);
const linkRow = (key: string): HTMLElement => {
  const el = sheet().querySelector(`[data-link="${key}"]`);
  if (!(el instanceof HTMLElement)) throw new Error("no link row " + key);
  return el;
};
const typeSelect = (row: HTMLElement): HTMLSelectElement => {
  const el = within(row).getByRole("combobox", { name: "Link type" });
  if (!(el instanceof HTMLSelectElement)) throw new Error("no type select");
  return el;
};

const lagField = (row: HTMLElement): HTMLInputElement => {
  const el = within(row).getByRole("spinbutton", { name: "Link lag" });
  if (!(el instanceof HTMLInputElement)) throw new Error("no link lag field");
  return el;
};
const field = (label: string): HTMLInputElement => {
  const el = within(sheet()).getByLabelText(label);
  if (!(el instanceof HTMLInputElement)) throw new Error(label + " is not an input");
  return el;
};
const typed = (el: HTMLInputElement, value: string, end: "Enter" | "Escape" | "blur"): void => {
  act(() => {
    el.focus();
    fireEvent.change(el, { target: { value } });
  });
  act(() => {
    if (end === "blur") el.blur();
    else fireEvent.keyDown(el, { key: end });
  });
};

describe("ItemSheet typed fields", () => {
  it("types a duration and an end date as one resize each, and refuses an end on a day off", async () => {
    const t = await made([REVIEW]);
    const { apply } = shown(t, "Review");
    expect([field("Duration").value, field("End").value]).toEqual(["3", "2026-11-17"]);
    typed(field("Duration"), "5", "Enter");
    expect(intents(apply)).toEqual([{ t: "resize", item: "Review", dur: 5 }]);
    expect(field("End").value).toBe("2026-11-19");
    typed(field("End"), "2026-11-23", "Enter");
    expect(intents(apply)[1]).toEqual({ t: "resize", item: "Review", dur: 7 });
    expect(field("Duration").value).toBe("7");
    clearToasts();
    typed(field("End"), "2026-11-22", "Enter");
    expect(toasts()).toEqual(["22 Nov is not a working day. Pick a working day for the end."]);
    typed(field("End"), "2026-11-12", "blur");
    expect(toasts()).toEqual(["22 Nov is not a working day. Pick a working day for the end.", "The end cannot come before the start, 13 Nov."]);
    typed(field("Duration"), "9", "Escape");
    expect([field("Duration").value, field("End").value, screen.queryByRole("dialog") !== null]).toEqual(["7", "2026-11-23", true]);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("toasts and writes nothing when the browser holds an end date it cannot read", async () => {
    const t = await made([REVIEW]);
    const { apply } = shown(t, "Review");
    Object.defineProperty(field("End"), "validity", { configurable: true, value: { badInput: true } });
    clearToasts();
    typed(field("End"), "", "Enter");
    expect([field("End").value, toasts()]).toEqual(["2026-11-17", ["The date is not complete. Enter a day, month and year."]]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("types a link's lag through the link intent and refuses one that is not whole", async () => {
    const t = await made([REVIEW, { name: "Ship", start: "2026-11-18", dur: 1, deps: [fs("Review")] }]);
    const { apply } = shown(t, "Review");
    typed(lagField(linkRow("Review>Ship")), "-2", "Enter");
    expect(intents(apply)).toEqual([{ t: "link", from: "Review", to: "Ship", type: "FS", lag: -2 }]);
    clearToasts();
    typed(lagField(linkRow("Review>Ship")), "1.5", "blur");
    expect(toasts()).toEqual(["Lag must be a whole number of working days."]);
    expect([lagField(linkRow("Review>Ship")).value, apply.mock.calls.length]).toEqual(["-2", 1]);
  });

  it("shows no End on an unscheduled task, and text in place of every field while read-only", async () => {
    const t = await made([REVIEW, { name: "Loose" }]);
    shown(t, "Loose");
    expect(within(sheet()).queryByLabelText("End")).toBeNull();
    cleanup();
    t.session.setReadOnly(true);
    shown(t, "Review");
    expect(sheet().querySelectorAll("input")).toHaveLength(0);
    expect(sheet().textContent).toContain("3 working days");
    expect(sheet().textContent).toContain("EndTue 17 Nov");
  });
});

describe("ItemSheet", () => {
  it("is a sheet named after the item", async () => {
    const t = await made([REVIEW]);
    const { onClose } = shown(t, "Review");
    expect(sheet().getAttribute("aria-label")).toBe("Review");
    expect(sheet().getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(sheet(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("names the start's year when it is not this year", async () => {
    const t = await made([{ ...REVIEW, start: "2027-11-12" }]);
    shown(t, "Review");
    expect(startText()).toBe("Fri 12 Nov 2027");
  });

  it("steps the start by working days and the duration", async () => {
    const t = await made([REVIEW]);
    const { apply } = shown(t, "Review");
    expect(startText()).toBe("Fri 13 Nov");
    fireEvent.click(button("Start +1 working day"));
    expect(intents(apply)).toEqual([{ t: "move", items: ["Review"], days: 1 }]);
    expect(startText()).toBe("Mon 16 Nov");
    fireEvent.click(button("Start −1 working day"));
    expect(intents(apply)[1]).toEqual({ t: "move", items: ["Review"], days: -1 });
    expect(startText()).toBe("Fri 13 Nov");
    fireEvent.click(button("Duration +1"));
    expect(intents(apply)[2]).toEqual({ t: "resize", item: "Review", dur: 4 });
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it("disables Duration −1 at one day and has no duration stepper on a milestone", async () => {
    const t = await made([{ name: "One", start: "2026-11-13", dur: 1 }, { name: "M", kind: "milestone", start: "2026-11-20", deps: [fs("One")] }]);
    shown(t, "One");
    expect(button("Duration −1").hasAttribute("disabled")).toBe(true);
    cleanup();
    shown(t, "M");
    expect(noButton("Duration +1")).toBeNull();
    expect(noButton("Duration −1")).toBeNull();
    expect(within(sheet()).queryByRole("group", { name: "Status" })).toBeNull();
    expect(sheet().textContent).toContain("open · from its predecessors");
  });

  it("sets the status, and picking the current one does nothing", async () => {
    const t = await made([REVIEW]);
    const { apply } = shown(t, "Review");
    const status = within(sheet()).getByRole("group", { name: "Status" });
    expect(within(status).getAllByRole("button").map((b) => b.textContent)).toEqual(["Not started", "In progress", "Done"]);
    fireEvent.click(within(status).getByRole("button", { name: "Not started" }));
    expect(apply).toHaveBeenCalledTimes(0);
    fireEvent.click(within(status).getByRole("button", { name: "Done" }));
    expect(intents(apply)).toEqual([{ t: "schedule", item: "Review", set: { status: "done" } }]);
    expect(within(status).getByRole("button", { name: "Done" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("edits a link's lag, type and existence", async () => {
    const t = await made([REVIEW, { name: "Ship", start: "2026-11-18", dur: 1, deps: [fs("Review")] }]);
    const { apply } = shown(t, "Review");
    const row = linkRow("Review>Ship");
    expect(lagField(row).value).toBe("0");
    fireEvent.change(typeSelect(row), { target: { value: "FS" } });
    expect(apply).toHaveBeenCalledTimes(0);
    fireEvent.click(within(row).getByRole("button", { name: "Lag +1" }));
    expect(intents(apply)).toEqual([{ t: "link", from: "Review", to: "Ship", type: "FS", lag: 1 }]);
    fireEvent.click(within(linkRow("Review>Ship")).getByRole("button", { name: "Lag −1" }));
    expect(intents(apply)[1]).toEqual({ t: "link", from: "Review", to: "Ship", type: "FS", lag: 0 });
    fireEvent.change(typeSelect(linkRow("Review>Ship")), { target: { value: "SS" } });
    expect(intents(apply)[2]).toEqual({ t: "link", from: "Review", to: "Ship", type: "SS", lag: 0 });
    fireEvent.click(within(linkRow("Review>Ship")).getByRole("button", { name: "Remove" }));
    expect(intents(apply)[3]).toEqual({ t: "unlink", link: "Review>Ship" });
    expect(apply).toHaveBeenCalledTimes(4);
    expect(sheet().querySelector('[data-link="Review>Ship"]')).toBeNull();
  });

  it("a refused link edit shows one bad toast and changes nothing", async () => {
    const t = await made([REVIEW, { name: "Ship", start: "2026-11-18", dur: 1, deps: [fs("Review")] }]);
    const { apply } = shown(t, "Review");
    const message = "This link would close a loop: “Review” → “Ship” → “Review”.";
    apply.mockImplementationOnce(() => {
      throw new Refused(message);
    });
    const before = t.session.history().length;
    fireEvent.click(within(linkRow("Review>Ship")).getByRole("button", { name: "Lag +1" }));
    expect(Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => [e.textContent, e.className])).toEqual([[message, "toast bad"]]);
    expect(t.session.history().length).toBe(before);
    expect(lagField(linkRow("Review>Ship")).value).toBe("0");
  });

  it("adds a dependency only from items that would not loop", async () => {
    const t = await made([REVIEW, { name: "Ship", start: "2026-11-18", dur: 1, deps: [fs("Review")] }, { name: "Notes", start: "2026-11-09", dur: 1 }]);
    const { apply } = shown(t, "Review");
    const pred = within(sheet()).getByRole("combobox", { name: "Predecessor" });
    expect(within(pred).getAllByRole("option").map((o) => [o.textContent, o instanceof HTMLOptionElement && o.disabled])).toEqual([
      ["Choose a predecessor", true],
      ["Notes", false],
    ]);
    expect(button("Add a dependency").hasAttribute("disabled")).toBe(true);
    fireEvent.change(pred, { target: { value: "Notes" } });
    fireEvent.change(within(sheet()).getByRole("combobox", { name: "Type" }), { target: { value: "SS" } });
    fireEvent.change(within(sheet()).getByRole("spinbutton", { name: "Lag" }), { target: { value: "2" } });
    fireEvent.click(button("Add a dependency"));
    expect(intents(apply)).toEqual([{ t: "link", from: "Notes", to: "Review", type: "SS", lag: 2 }]);
  });

  it("adds a dependency only with a whole-number lag", async () => {
    const t = await made([REVIEW, { name: "Notes", start: "2026-11-09", dur: 1 }]);
    const { apply } = shown(t, "Review");
    const lag = (): HTMLElement => within(sheet()).getByRole("spinbutton", { name: "Lag" });
    fireEvent.change(within(sheet()).getByRole("combobox", { name: "Predecessor" }), { target: { value: "Notes" } });
    ["", "2.7"].forEach((v) => {
      fireEvent.change(lag(), { target: { value: v } });
      fireEvent.click(button("Add a dependency"));
      expect([v, Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => [e.textContent, e.className])]).toEqual([v, [["Lag must be a whole number of working days.", "toast bad"]]]);
      clearToasts();
    });
    expect(apply).toHaveBeenCalledTimes(0);
    fireEvent.change(lag(), { target: { value: "-2" } });
    fireEvent.click(button("Add a dependency"));
    expect(intents(apply)).toEqual([{ t: "link", from: "Notes", to: "Review", type: "FS", lag: -2 }]);
  });

  it("drops a chosen predecessor that can no longer be added", async () => {
    const t = await made([REVIEW, { name: "Ship", start: "2026-11-18", dur: 1, deps: [fs("Review")] }, { name: "Notes", start: "2026-11-09", dur: 1 }]);
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    const { apply } = shown(t, "Review");
    const pred = (): HTMLSelectElement => {
      const el = within(sheet()).getByRole("combobox", { name: "Predecessor" });
      if (!(el instanceof HTMLSelectElement)) throw new Error("no predecessor select");
      return el;
    };
    fireEvent.change(pred(), { target: { value: "Notes" } });
    expect(button("Add a dependency").hasAttribute("disabled")).toBe(false);
    peer.session.apply({ t: "link", from: "Review", to: "Notes", type: "FS", lag: 0 });
    act(() => peer.sync());
    expect(within(sheet()).getByText("“Notes” can no longer be added.").classList.contains("dim")).toBe(true);
    expect(pred().value).toBe("");
    expect(button("Add a dependency").hasAttribute("disabled")).toBe(true);
    fireEvent.click(button("Add a dependency"));
    expect(apply).toHaveBeenCalledTimes(0);
  });

  it("throws for a live scheduled item with no derived start", async () => {
    const t = await made([REVIEW]);
    const v = t.session.view();
    const start = new Map(v.derived.start);
    start.delete("Review");
    vi.spyOn(t.session, "view").mockReturnValue({ ...v, derived: { ...v.derived, start } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <OpenChoice.Provider value={vi.fn()}>
          <ItemSheet session={t.session} item="Review" local="Mac" onClose={vi.fn()} />
        </OpenChoice.Provider>,
      ),
    ).toThrow(new Error("ItemSheet: scheduled item Review has no derived start"));
  });

  it("schedules an unscheduled item from today", async () => {
    const t = await made([{ name: "Idea" }]);
    const { apply } = shown(t, "Idea");
    expect(noButton("Start +1 working day")).toBeNull();
    fireEvent.click(button("Schedule"));
    expect(intents(apply)).toEqual([{ t: "schedule", item: "Idea", set: { start: "2026-11-09" } }]);
    expect(startText()).toBe("Mon 9 Nov");
    expect(noButton("Schedule")).toBeNull();
  });

  it("schedule on a day off", async () => {
    const t = await made([{ name: "Idea" }]);
    act(() => t.clock.set("2026-11-14"));
    const { apply } = shown(t, "Idea");
    fireEvent.click(button("Schedule"));
    expect(intents(apply)).toEqual([{ t: "schedule", item: "Idea", set: { start: "2026-11-14" } }]);
    expect(t.session.view().plan.items.get("Idea")?.schedule?.start).toBe("2026-11-16");
    expect(startText()).toBe("Mon 16 Nov");
    expect(toasts()).toEqual(["Scheduled “Idea” from 16 Nov."]);
    expect(within(sheet()).queryByText(/Starts on a day off/)).toBeNull();
  });

  it("binds the note to a textarea", async () => {
    const t = await made([REVIEW]);
    shown(t, "Review");
    const area = within(sheet()).getByRole("textbox", { name: "Notes" });
    if (!(area instanceof HTMLTextAreaElement)) throw new Error("the note is not a textarea");
    area.value = "Bring the build";
    fireEvent.input(area);
    expect(t.session.note("Review").toString()).toBe("Bring the build");
    act(() => {
      t.session.note("Review").insert(0, "> ");
    });
    expect(area.value).toBe("> Bring the build");
  });

  it("a group sheet shows only its progress line", async () => {
    const t = await made([
      { name: "QA", kind: "group" },
      { name: "T1", parent: "QA", start: "2026-11-09", dur: 2, progress: 40 },
      { name: "T2", parent: "QA", start: "2026-11-09", dur: 3, status: "done", progress: 100 },
      { name: "E", kind: "group" },
    ]);
    shown(t, "QA");
    expect(within(sheet()).getByText("Progress 76 %")).toBeTruthy();
    ["Start +1 working day", "Start −1 working day", "Duration +1", "Duration −1", "Schedule", "Add a dependency"].forEach((n) => expect([n, noButton(n)]).toEqual([n, null]));
    expect(within(sheet()).queryByRole("group", { name: "Status" })).toBeNull();
    expect(sheet().querySelector('input[type="range"]')).toBeNull();
    cleanup();
    shown(t, "E");
    expect(within(sheet()).queryByText(/Progress/)).toBeNull();
  });

  it("drops every writing control while read-only and brings them back", async () => {
    const t = await made([REVIEW, { name: "Ship", start: "2026-11-18", dur: 1, deps: [fs("Review")] }, { name: "Notes", start: "2026-11-09", dur: 1 }]);
    const { apply } = shown(t, "Review");
    act(() => t.session.setReadOnly(true));
    ["Start +1 working day", "Start −1 working day", "Duration +1", "Duration −1", "Lag +1", "Lag −1", "Remove", "Add a dependency", "Schedule"].forEach((n) =>
      expect([n, noButton(n)]).toEqual([n, null]),
    );
    expect(within(sheet()).queryByRole("group", { name: "Status" })).toBeNull();
    expect(within(sheet()).queryByRole("combobox", { name: "Link type" })).toBeNull();
    expect(within(linkRow("Review>Ship")).getByText("FS")).toBeTruthy();
    expect(within(linkRow("Review>Ship")).getByText("0d")).toBeTruthy();
    expect(startText()).toBe("Fri 13 Nov");
    expect(within(sheet()).getByText("Not started")).toBeTruthy();
    const area = within(sheet()).getByRole("textbox", { name: "Notes" });
    expect(area instanceof HTMLTextAreaElement && area.readOnly).toBe(true);
    expect(apply).toHaveBeenCalledTimes(0);
    act(() => t.session.setReadOnly(false));
    expect(button("Start +1 working day")).toBeTruthy();
  });

  it("edits report through useRun", async () => {
    const t = await made([REVIEW, { name: "Ship", start: "2026-11-18", dur: 1, deps: [fs("Review")] }]);
    const { apply } = shown(t, "Review");
    fireEvent.click(button("Duration +1"));
    const result = apply.mock.results[0];
    if (result === undefined || result.type !== "return") throw new Error("apply did not return");
    const built: Built = result.value;
    expect(built.preview.movedLater).toBe(1);
    expect(toasts()).toEqual([built.toast]);
  });

  it("fix actions always show", async () => {
    const t = await made([REVIEW, { name: "Sat", start: "2026-11-14", dur: 1 }, { name: "Ship", start: "2026-11-16", dur: 1, deps: [fs("Review")] }]);
    const sat = shown(t, "Sat");
    expect(within(sheet()).getByText("Starts on a day off — shown from Mon 16 Nov")).toBeTruthy();
    fireEvent.click(button("Snap to next working day"));
    expect(intents(sat.apply)).toEqual([{ t: "snap", item: "Sat" }]);
    cleanup();
    const ship = shown(t, "Ship");
    fireEvent.click(button("Push “Ship” to Wed 18 Nov"));
    const [intent] = intents(ship.apply);
    expect(intent?.t === "fix" && intent.how === "push" && intent.conflict.kind === "early" && intent.conflict.succ === "Ship").toBe(true);
    cleanup();
    shown(t, "Review");
    expect(sheet().querySelector(".conflicts")).toBeNull();
  });

  it("fix actions read-only", async () => {
    const t = await made([REVIEW, { name: "Sat", start: "2026-11-14", dur: 1 }, { name: "Ship", start: "2026-11-16", dur: 1, deps: [fs("Review")] }]);
    const sat = shown(t, "Sat");
    act(() => t.session.setReadOnly(true));
    expect(noButton("Snap to next working day")).toBeNull();
    act(() => t.session.setReadOnly(false));
    expect(button("Snap to next working day")).toBeTruthy();
    cleanup();
    const ship = shown(t, "Ship");
    act(() => t.session.setReadOnly(true));
    expect(noButton("Push “Ship” to Wed 18 Nov")).toBeNull();
    act(() => t.session.setReadOnly(false));
    expect(button("Push “Ship” to Wed 18 Nov")).toBeTruthy();
    expect([sat.apply.mock.calls.length, ship.apply.mock.calls.length]).toEqual([0, 0]);
  });

  it("a link clash shows on both ends", async () => {
    const ABC: readonly SeedItem[] = [
      { name: "A", start: "2026-11-10", dur: 2 },
      { name: "B", start: "2026-11-12", dur: 2 },
      { name: "C", start: "2026-11-16", dur: 2 },
    ];
    const bannersIn = (root: HTMLElement): HTMLElement[] =>
      [...root.querySelectorAll(".choice-banner")].filter((e): e is HTMLElement => e instanceof HTMLElement);
    const banners = (): HTMLElement[] => bannersIn(sheet());
    const linked = await made(ABC, { clashes: [{ unit: "l:B>A", mac: ["FS", 0], iphone: ["SS", 1] }] });
    const choices = linked.session.view().choices;
    expect(choices).toHaveLength(1);
    const c3 = choices[0];
    expect(bannerText(c3, "Mac")).toBe("Changed on Mac and iPhone. Choose which to keep.");
    setScreen(390, 844);
    const registry = await phoneRegistry(linked);
    registries.push(registry);
    render(withSync(<PhoneShell registry={registry} clock={linked.clock} />));
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
    cleanup();
    await Promise.all(sessions.splice(0).map((s) => s.close()));
    await Promise.all(registries.splice(0).map((r) => r.close()));
    const calendar = await made(ABC, { clashes: [{ unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null }] });
    expect(calendar.session.view().choices).toHaveLength(1);
    shown(calendar, "A");
    expect(banners()).toEqual([]);
  });
});

describe("ItemSheet editing (Step 4)", () => {
  const EDIT_SEED: readonly SeedItem[] = [
    { id: "S4", name: "Sprint 4", kind: "group" },
    { name: "QA", kind: "group", parent: "S4" },
    { name: "Test", parent: "QA", start: "2026-11-10", dur: 1 },
    { name: "Review", parent: "S4", start: "2026-11-10", dur: 2 },
    { name: "Notes", horizon: "now" },
  ];
  const EMPTY_NAME = "The name is empty. Type at least one character.";
  const nameField = (): HTMLInputElement => {
    const el = within(sheet()).getByRole("textbox", { name: "Name" });
    if (!(el instanceof HTMLInputElement)) throw new Error("no name input");
    return el;
  };
  const select = (name: string): HTMLSelectElement => {
    const el = within(sheet()).getByRole("combobox", { name });
    if (!(el instanceof HTMLSelectElement)) throw new Error("no select " + name);
    return el;
  };
  const newest = (t: TestSession): string | undefined => t.session.history()[0]?.label;

  it("renames on Enter or blur, refuses an empty name and fires only on a change", async () => {
    const t = await made(EDIT_SEED);
    const { apply } = shown(t, "Review");
    const field = nameField();
    expect(field.value).toBe("Review");
    act(() => field.focus());
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: "Review " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(apply).toHaveBeenCalledTimes(0);
    expect(toasts()).toEqual([]);
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(apply).toHaveBeenCalledTimes(0);
    expect(Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => [e.textContent, e.className])).toEqual([[EMPTY_NAME, "toast bad"]]);
    expect(nameField().value).toBe("Review");
    clearToasts();
    fireEvent.change(nameField(), { target: { value: "Review 2" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(intents(apply)).toEqual([{ t: "rename", item: "Review", name: "Review 2" }]);
    expect(newest(t)).toBe("Renamed “Review” to “Review 2”");
    fireEvent.change(nameField(), { target: { value: "Review 3" } });
    fireEvent.blur(nameField());
    expect(intents(apply)[1]).toEqual({ t: "rename", item: "Review", name: "Review 3" });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("offers groupOptions' labels in the Group picker and places into a group or the top level", async () => {
    const t = await made(EDIT_SEED);
    shown(t, "S4");
    expect([...select("Group").options].map((o) => o.textContent)).toEqual(["Top level"]);
    cleanup();
    const { apply } = shown(t, "Review");
    const group = select("Group");
    expect([...group.options].map((o) => o.textContent)).toEqual(["Top level", "Sprint 4", "Sprint 4 › QA"]);
    expect(group.selectedOptions[0]?.textContent).toBe("Sprint 4");
    fireEvent.change(group, { target: { value: "S4" } });
    expect(apply).toHaveBeenCalledTimes(0);
    fireEvent.change(select("Group"), { target: { value: "QA" } });
    expect(intents(apply)).toEqual([{ t: "place", item: "Review", parent: "QA", after: "Test" }]);
    expect(newest(t)).toBe("Moved “Review” into “QA”");
    fireEvent.change(select("Group"), { target: { value: "" } });
    expect(intents(apply)[1]).toEqual({ t: "place", item: "Review", parent: null, after: "Notes" });
    expect(newest(t)).toBe("Moved “Review” to the top level");
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("does not offer a trashed group", async () => {
    const t = await made(EDIT_SEED);
    act(() => {
      t.session.apply({ t: "trash", items: ["QA"] });
    });
    shown(t, "Review");
    expect([...select("Group").options].map((o) => o.textContent)).toEqual(["Top level", "Sprint 4"]);
  });

  it("unschedules a scheduled task, and shows no Unschedule on an unscheduled item or a group", async () => {
    const t = await made(EDIT_SEED);
    const { apply } = shown(t, "Review");
    fireEvent.click(button("Unschedule"));
    expect(intents(apply)).toEqual([{ t: "schedule", item: "Review", set: { start: null } }]);
    expect(newest(t)).toBe("Unscheduled “Review”");
    cleanup();
    shown(t, "Notes");
    expect(noButton("Unschedule")).toBeNull();
    cleanup();
    shown(t, "S4");
    expect(noButton("Unschedule")).toBeNull();
  });

  it("shows a refused Unschedule's message", async () => {
    const t = await made(EDIT_SEED);
    const { apply } = shown(t, "Review");
    apply.mockImplementationOnce(() => {
      throw new Refused("Refused for the test.");
    });
    fireEvent.click(button("Unschedule"));
    expect(toasts()).toEqual(["Refused for the test."]);
  });

  it("moves an undated item between Now, Next and Later, and shows no Horizon on a dated item or a group", async () => {
    const t = await made(EDIT_SEED);
    const { apply } = shown(t, "Notes");
    const horizon = select("Horizon");
    expect([...horizon.options].map((o) => o.textContent)).toEqual(["Now", "Next", "Later"]);
    expect(horizon.selectedOptions[0]?.textContent).toBe("Now");
    fireEvent.change(horizon, { target: { value: "now" } });
    expect(apply).toHaveBeenCalledTimes(0);
    fireEvent.change(select("Horizon"), { target: { value: "next" } });
    expect(intents(apply)).toEqual([{ t: "schedule", item: "Notes", set: { horizon: "next" } }]);
    expect(newest(t)).toBe("Moved “Notes” to Next");
    expect(toasts()).toEqual(["Moved “Notes” to Next."]);
    cleanup();
    shown(t, "Review");
    expect(within(sheet()).queryByRole("combobox", { name: "Horizon" })).toBeNull();
    cleanup();
    shown(t, "S4");
    expect(within(sheet()).queryByRole("combobox", { name: "Horizon" })).toBeNull();
  });

  it("moves an item to the Trash and closes the sheet", async () => {
    const t = await made(EDIT_SEED);
    const { apply, onClose } = shown(t, "Review");
    fireEvent.click(button("Move to Trash"));
    expect(intents(apply)).toEqual([{ t: "trash", items: ["Review"] }]);
    expect(toasts()).toEqual(["Moved “Review” to the Trash. Undo brings it back."]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reorders among siblings with Move up and Move down", async () => {
    const t = await made(EDIT_SEED);
    const notes = shown(t, "Notes");
    fireEvent.click(button("Move up"));
    expect(intents(notes.apply)).toEqual([{ t: "place", item: "Notes", parent: null, after: null }]);
    expect(newest(t)).toBe("Reordered “Notes”");
    expect(notes.apply).toHaveBeenCalledTimes(1);
    cleanup();
    const t2 = await made(EDIT_SEED);
    const qa = shown(t2, "QA");
    expect(button("Move up").hasAttribute("disabled")).toBe(true);
    fireEvent.click(button("Move down"));
    expect(intents(qa.apply)).toEqual([{ t: "place", item: "QA", parent: "S4", after: "Review" }]);
    expect(qa.apply).toHaveBeenCalledTimes(1);
    cleanup();
    shown(t2, "S4");
    expect(button("Move up").hasAttribute("disabled")).toBe(true);
    cleanup();
    const t3 = await made(EDIT_SEED);
    shown(t3, "Review");
    expect(button("Move down").hasAttribute("disabled")).toBe(true);
    cleanup();
    shown(t3, "Notes");
    expect(button("Move down").hasAttribute("disabled")).toBe(true);
  });
});

describe("ItemSheet choices (Task 5.8 Step 2)", () => {
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
    const body = screen.getByRole("dialog", { name: "Review" }).querySelector(".isheet");
    if (body === null) throw new Error("no item sheet body");
    const first = body.firstElementChild;
    if (!(first instanceof HTMLElement)) throw new Error("an empty item sheet");
    expect(first.classList.contains("choice-banner")).toBe(true);
    expect(first.querySelector(".banner-text")?.textContent).toBe(bannerText(choice, registry.device.name));
    expect(bannerText(choice, "Mac")).toBe("Changed on Mac and iPhone. Choose which to keep.");
    expect(body.querySelectorAll(".choice-banner")).toHaveLength(1);
    fireEvent.click(within(first).getByRole("button", { name: "Choose" }));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: choice.id });
  });
});
