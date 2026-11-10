import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Refused, type Built, type Intent } from "../../actions/intents";
import type { ItemId } from "../../domain/model";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem, type TestSession } from "../../test/session";
import { clearToasts, Toasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { ItemSheet } from "./ItemSheet";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await testSession(seed);
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
      <ItemSheet session={t.session} item={item} onClose={onClose} />
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
const toasts = (): (string | null)[] => screen.queryAllByRole("status").map((e) => e.textContent);
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

describe("ItemSheet", () => {
  it("is a sheet named after the item", async () => {
    const t = await made([REVIEW]);
    const { onClose } = shown(t, "Review");
    expect(sheet().getAttribute("aria-label")).toBe("Review");
    expect(sheet().getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(sheet(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
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
    expect(within(row).getByText("0d")).toBeTruthy();
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
    expect(screen.queryAllByRole("status").map((e) => [e.textContent, e.className])).toEqual([[message, "toast bad"]]);
    expect(t.session.history().length).toBe(before);
    expect(within(linkRow("Review>Ship")).getByText("0d")).toBeTruthy();
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
      expect([v, screen.queryAllByRole("status").map((e) => [e.textContent, e.className])]).toEqual([v, [["Lag must be a whole number of working days.", "toast bad"]]]);
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
          <ItemSheet session={t.session} item="Review" onClose={vi.fn()} />
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
});
