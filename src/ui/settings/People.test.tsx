import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusal } from "../../actions/copy";
import type { StepColour } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { fixedClock } from "../../services/clock";
import type { PlanSession } from "../../store/session";
import { IPAD, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { testRegistry } from "../../test/shell";
import { resetTauri, tauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { DEFAULT_STORE } from "../../theme/store";
import { ThemeProvider } from "../../theme/ThemeContext";
import type { CloseReason } from "../common/dismiss";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { toast } from "../common/Toast";
import { OpenChoice } from "../run";
import { UiContext, type UiState } from "../state";
import { People } from "./People";
import { SettingsView } from "./Settings";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));
vi.mock("../common/Toast", () => ({ toast: vi.fn() }));

const sessions: PlanSession[] = [];

const last = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

beforeEach(() => {
  setPlatform(MAC);
});

afterEach(async () => {
  cleanup();
  vi.mocked(toast).mockClear();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
  setPlatform(MAC);
});

const SEED: readonly SeedItem[] = [
  { id: "a", name: "Mirror coating", start: "2026-11-10", dur: 3 },
  { id: "m", name: "First light", kind: "milestone", start: "2026-11-24" },
  { id: "b", name: "Old mount", start: "2026-11-02", dur: 1 },
];

type Crew = readonly (readonly [string, string, StepColour])[];

const CREW: Crew = [
  ["Mira Okafor", "MO", "violet"],
  ["Ole Berg", "OB", "lime"],
  ["Ana Ruiz", "AR", "coral"],
];

const made = async (): Promise<TestSession> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  return t;
};

const addPeople = (t: TestSession, crew: Crew): Record<string, string> => {
  act(() => {
    crew.forEach(([name, initials, colour]) => {
      const known = peopleOf(t.session.view().plan);
      t.session.apply({ t: "person", op: "add", name, initials, colour, after: known.length === 0 ? null : known[known.length - 1].id });
    });
  });
  return Object.fromEntries(peopleOf(t.session.view().plan).map((p) => [p.initials, p.id]));
};

const crewed = async (): Promise<{ t: TestSession; ids: Record<string, string> }> => {
  const t = await made();
  const ids = addPeople(t, CREW);
  act(() => {
    t.session.apply({ t: "assign", items: ["a"], person: ids.MO });
    t.session.apply({ t: "assign", items: ["a"], person: ids.AR });
    t.session.apply({ t: "assign", items: ["m"], person: ids.OB });
    t.session.apply({ t: "assign", items: ["b"], person: ids.MO });
    t.session.apply({ t: "trash", items: ["b"] });
  });
  return { t, ids };
};

const mount = (session: PlanSession, readOnly = false, onHostKey = vi.fn()): HTMLElement => {
  const view = render(
    <OpenChoice.Provider value={vi.fn()}>
      <div className="host" onKeyDown={onHostKey}>
        <People session={session} readOnly={readOnly} />
      </div>
    </OpenChoice.Provider>,
  );
  const host = view.container.querySelector<HTMLElement>(".host");
  if (host === null) throw new Error("no host");
  return host;
};

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const input = (sel: string, root: ParentNode = document): HTMLInputElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLInputElement)) throw new Error("no input " + sel);
  return el;
};

const row = (id: string): HTMLElement => one(`li.people-row[data-person="${id}"]`);

const rowIds = (root: HTMLElement): (string | undefined)[] => [...root.querySelectorAll<HTMLElement>("li.people-row:not(.people-draft)")].map((r) => r.dataset.person);

const commit = (el: HTMLInputElement, value: string): void => {
  act(() => {
    el.focus();
  });
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: "Enter" });
};

const toasts = (): unknown[][] => vi.mocked(toast).mock.calls;

const draftInput = (root: HTMLElement): HTMLInputElement => input("li.people-row.people-draft input.people-draft-name", root);

const openDraft = (root: HTMLElement): HTMLInputElement => {
  fireEvent.click(one("button.people-add", root));
  return draftInput(root);
};

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const removeOf = (id: string): HTMLElement => one("button.people-remove", row(id));

describe("Settings > People", () => {
  it("lists every person with grip, avatar, name, initials, the count of untrashed items and Remove…", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    expect(rowIds(root)).toEqual([ids.MO, ids.OB, ids.AR]);
    expect([one(".people-head", root).getAttribute("aria-hidden"), [...root.querySelectorAll(".people-head span")].map((s) => s.textContent)]).toEqual(["true", ["", "", "Name", "Initials", "Items", ""]]);
    const shape = [ids.MO, ids.OB, ids.AR].map((id) => {
      const r = row(id);
      const avatar = one("button.people-avatar .avatar", r);
      return [
        one("button.people-grip", r).getAttribute("aria-label"),
        one("button.people-avatar", r).getAttribute("aria-label"),
        avatar.textContent,
        avatar.style.getPropertyValue("--person"),
        input("input.people-name", r).value,
        input("input.people-name", r).getAttribute("aria-label"),
        input("input.people-initials", r).value,
        input("input.people-initials", r).getAttribute("aria-label"),
        input("input.people-initials", r).maxLength,
        one(".people-count", r).textContent,
        removeOf(id).textContent,
        removeOf(id).getAttribute("aria-label"),
      ];
    });
    expect(shape).toEqual([
      ["Reorder Mira Okafor", "Colour of Mira Okafor", "MO", "var(--s-violet)", "Mira Okafor", "Name of Mira Okafor", "MO", "Initials of Mira Okafor", -1, "1 item", "Remove…", "Remove Mira Okafor"],
      ["Reorder Ole Berg", "Colour of Ole Berg", "OB", "var(--s-lime)", "Ole Berg", "Name of Ole Berg", "OB", "Initials of Ole Berg", -1, "1 item", "Remove…", "Remove Ole Berg"],
      ["Reorder Ana Ruiz", "Colour of Ana Ruiz", "AR", "var(--s-coral)", "Ana Ruiz", "Name of Ana Ruiz", "AR", "Initials of Ana Ruiz", -1, "1 item", "Remove…", "Remove Ana Ruiz"],
    ]);
    expect([
      one('[data-settings-row="people.people"] .settings-label', root).textContent,
      one('[data-settings-row="people.add"] button.people-add', root).textContent,
      one(".people-foot", root).textContent,
      [one("p.people-line", root).getAttribute("role"), one("p.people-line", root).childElementCount],
      root.querySelector(".people-empty"),
    ]).toEqual(["People", "+ Add person", "Order here is the order of avatars on cards. Up to 8 people per item.", ["status", 0], null]);
  });

  it("says so when the plan has no people", async () => {
    const t = await made();
    const root = mount(t.session);
    const empty = one("p.settings-line.people-empty", root);
    expect([empty.textContent, root.querySelectorAll("li.people-row").length, root.querySelector(".people-head")]).toEqual([
      "No people yet. Add someone to assign tasks and milestones.",
      0,
      null,
    ]);
  });

  it("shows a same-name problem from a peer in the status line, which was there before it", async () => {
    const t = await made();
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    addPeople(t, CREW);
    const root = mount(t.session);
    const before = one("p.people-line", root);
    expect([before.getAttribute("role"), before.childElementCount]).toEqual(["status", 0]);
    act(() => {
      peer.session.apply({ t: "person", op: "add", name: "Mira Okafor", initials: "MK", colour: "sky", after: null });
    });
    act(() => {
      peer.sync();
    });
    const line = one("p.people-line", root);
    expect(line).toBe(before);
    expect([line.getAttribute("role"), [...line.querySelectorAll("span.board-problem")].map((s) => s.textContent)]).toEqual([
      "status",
      ["More than one person is named “Mira Okafor”. Rename one."],
    ]);
  });

  it("renames, keeps typed initials as they are, and toasts initials that are too long", async () => {
    const { t, ids } = await crewed();
    mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    commit(input("input.people-name", row(ids.OB)), "Ole Bergen");
    commit(input("input.people-initials", row(ids.MO)), "mo");
    expect(apply.mock.calls).toEqual([
      [{ t: "person", op: "rename", person: ids.OB, name: "Ole Bergen" }],
      [{ t: "person", op: "initials", person: ids.MO, initials: "mo" }],
    ]);
    expect([input("input.people-initials", row(ids.MO)).value, one("button.people-avatar .avatar", row(ids.MO)).textContent, input("input.people-name", row(ids.OB)).getAttribute("aria-label")]).toEqual([
      "mo",
      "mo",
      "Name of Ole Bergen",
    ]);
    commit(input("input.people-initials", row(ids.AR)), "ABCD");
    expect([last(toasts()), input("input.people-initials", row(ids.AR)).value]).toEqual([[refusal.initials, "bad"], "AR"]);
    commit(input("input.people-name", row(ids.AR)), "ole bergen");
    expect([last(toasts()), input("input.people-name", row(ids.AR)).value]).toEqual([[refusal.personNameTaken("Ole Bergen"), "bad"], "Ana Ruiz"]);
  });

  it("recolours through the colour popover, which moves with the arrow keys and has its close control", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    const popState = (): (string | null)[][] => [ids.MO, ids.OB].map((id) => [one("button.people-avatar", row(id)).getAttribute("aria-haspopup"), one("button.people-avatar", row(id)).getAttribute("aria-expanded")]);
    expect(popState()).toEqual([
      ["dialog", "false"],
      ["dialog", "false"],
    ]);
    fireEvent.click(one("button.people-avatar", row(ids.MO)));
    expect(popState()).toEqual([
      ["dialog", "true"],
      ["dialog", "false"],
    ]);
    const pop = within(root).getByRole("dialog", { name: "Colour · Mira Okafor" });
    expect([one(".step-pop-title", pop).textContent, within(pop).getAllByRole("radio").length, within(pop).getByRole("radio", { name: "Violet" }).getAttribute("aria-checked"), within(pop).getByRole("button", { name: "Close" }) !== null]).toEqual([
      "Colour · Mira Okafor",
      8,
      "true",
      true,
    ]);
    expect(document.activeElement).toBe(within(pop).getByRole("radio", { name: "Violet" }));
    fireEvent.keyDown(within(pop).getByRole("radio", { name: "Violet" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(pop).getByRole("radio", { name: "Magenta" }));
    fireEvent.keyDown(within(pop).getByRole("radio", { name: "Magenta" }), { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(pop).getByRole("radio", { name: "Sky" }));
    fireEvent.click(within(pop).getByRole("radio", { name: "Sky" }));
    expect([apply.mock.calls, within(root).queryByRole("dialog"), one("button.people-avatar .avatar", row(ids.MO)).style.getPropertyValue("--person")]).toEqual([
      [[{ t: "person", op: "colour", person: ids.MO, colour: "sky" }]],
      null,
      "var(--s-sky)",
    ]);
    fireEvent.click(one("button.people-avatar", row(ids.OB)));
    const again = within(root).getByRole("dialog", { name: "Colour · Ole Berg" });
    const esc = fireEvent.keyDown(within(again).getByRole("radio", { name: "Lime" }), { key: "Escape" });
    expect([esc, within(root).queryByRole("dialog"), apply.mock.calls.length]).toEqual([false, null, 1]);
  });

  it("closes the colour popover with a toast when its person is removed elsewhere", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    fireEvent.click(one("button.people-avatar", row(ids.OB)));
    expect(within(root).getByRole("dialog", { name: "Colour · Ole Berg" })).not.toBeNull();
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.OB, to: null });
    });
    expect([within(root).queryByRole("dialog"), last(toasts())]).toEqual([null, [STALE_CONFIRM, "bad"]]);
  });

  it("reorders with ⌥↑ and ⌥↓ on the grip, which keeps focus, and not past either end", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    const grip = (id: string): HTMLElement => one("button.people-grip", row(id));
    act(() => {
      grip(ids.MO).focus();
    });
    fireEvent.keyDown(grip(ids.MO), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(grip(ids.MO), { key: "ArrowDown" });
    expect(apply.mock.calls).toEqual([]);
    fireEvent.keyDown(grip(ids.MO), { key: "ArrowDown", altKey: true });
    expect([apply.mock.calls, rowIds(root), document.activeElement]).toEqual([[[{ t: "person", op: "reorder", person: ids.MO, after: ids.OB }]], [ids.OB, ids.MO, ids.AR], grip(ids.MO)]);
    fireEvent.keyDown(grip(ids.AR), { key: "ArrowUp", altKey: true });
    expect([last(apply.mock.calls), rowIds(root)]).toEqual([[{ t: "person", op: "reorder", person: ids.AR, after: ids.OB }], [ids.OB, ids.AR, ids.MO]]);
    fireEvent.keyDown(grip(ids.OB), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(grip(ids.MO), { key: "ArrowDown", altKey: true });
    expect(apply.mock.calls.length).toBe(2);
  });

  it("reorders by dragging a grip at once onto another row", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    const drag = (from: string, onto: string): void => {
      const target = row(onto);
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
      try {
        fireEvent.pointerDown(one("button.people-grip", row(from)), { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
        expect(row(from).classList.contains("dragging")).toBe(true);
        fireEvent.pointerMove(document, { clientX: 5, clientY: 80, pointerId: 1 });
        expect(target.classList.contains("drop-over")).toBe(from !== onto);
        fireEvent.pointerUp(document, { clientX: 5, clientY: 80, pointerId: 1 });
      } finally {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    };
    drag(ids.AR, ids.MO);
    expect([apply.mock.calls, rowIds(root), root.querySelectorAll(".drop-over, .dragging").length]).toEqual([[[{ t: "person", op: "reorder", person: ids.AR, after: null }]], [ids.AR, ids.MO, ids.OB], 0]);
    drag(ids.MO, ids.OB);
    expect([last(apply.mock.calls), rowIds(root)]).toEqual([[{ t: "person", op: "reorder", person: ids.MO, after: ids.OB }], [ids.AR, ids.OB, ids.MO]]);
    drag(ids.OB, ids.OB);
    expect(apply.mock.calls.length).toBe(2);
  });

  it("toasts the stale confirmation and writes nothing when the dragged person or the drop target is removed before the drop", async () => {
    const { t, ids } = await crewed();
    mount(t.session);
    const drop = (from: string, onto: string, gone: string): void => {
      const target = row(onto);
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
      try {
        fireEvent.pointerDown(one("button.people-grip", row(from)), { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
        fireEvent.pointerMove(document, { clientX: 5, clientY: 80, pointerId: 1 });
        act(() => {
          t.session.apply({ t: "person", op: "remove", person: gone, to: null });
        });
        const apply = vi.spyOn(t.session, "apply");
        fireEvent.pointerUp(document, { clientX: 5, clientY: 80, pointerId: 1 });
        expect([apply.mock.calls, last(toasts())]).toEqual([[], [STALE_CONFIRM, "bad"]]);
        apply.mockRestore();
      } finally {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    };
    drop(ids.AR, ids.MO, ids.MO);
    drop(ids.AR, ids.OB, ids.AR);
    expect(toasts().filter(([text]) => text === STALE_CONFIRM)).toHaveLength(2);
  });

  it("adds a person from the draft on Return in the first unused colour, then focuses the new initials, selected", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    const draft = openDraft(root);
    expect([document.activeElement, draft.placeholder, draft.getAttribute("aria-label"), apply.mock.calls]).toEqual([draft, "Name", "Name of the new person", []]);
    fireEvent.change(draft, { target: { value: "  Dana Lee " } });
    fireEvent.keyDown(draft, { key: "Enter" });
    const dana = peopleOf(t.session.view().plan).find((p) => p.name === "Dana Lee");
    if (dana === undefined) throw new Error("no Dana Lee");
    expect([apply.mock.calls, rowIds(root), root.querySelector(".people-draft")]).toEqual([
      [[{ t: "person", op: "add", name: "Dana Lee", initials: "DL", colour: "cyan", after: ids.AR }]],
      [ids.MO, ids.OB, ids.AR, dana.id],
      null,
    ]);
    const initials = input("input.people-initials", row(dana.id));
    expect([document.activeElement, initials.selectionStart, initials.selectionEnd, one(".people-count", row(dana.id)).textContent]).toEqual([initials, 0, 2, "0 items"]);
  });

  it("adds a person when the draft loses focus with a name, and in slate once every colour is used", async () => {
    const t = await made();
    const eight: Crew = (["cyan", "violet", "magenta", "lime", "amber", "coral", "sky", "slate"] as const).map((c, i) => [`Person ${i + 1}`, `P${i + 1}`, c]);
    const ids = addPeople(t, eight);
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    const draft = openDraft(root);
    fireEvent.change(draft, { target: { value: "ole" } });
    fireEvent.blur(draft);
    expect([apply.mock.calls, root.querySelector(".people-draft")]).toEqual([[[{ t: "person", op: "add", name: "ole", initials: "O", colour: "slate", after: ids.P8 }]], null]);
  });

  it("writes nothing for Escape, which goes no further, or for an empty name, and keeps the draft when the name is taken", async () => {
    const { t } = await crewed();
    const hostKey = vi.fn();
    const root = mount(t.session, false, hostKey);
    const apply = vi.spyOn(t.session, "apply");
    const draft = openDraft(root);
    fireEvent.change(draft, { target: { value: "Dana Lee" } });
    fireEvent.keyDown(draft, { key: "Escape" });
    expect([apply.mock.calls, root.querySelector(".people-draft"), hostKey.mock.calls.length]).toEqual([[], null, 0]);
    const empty = openDraft(root);
    fireEvent.change(empty, { target: { value: "   " } });
    fireEvent.keyDown(empty, { key: "Enter" });
    expect([apply.mock.calls, root.querySelector(".people-draft")]).toEqual([[], null]);
    const blank = openDraft(root);
    fireEvent.blur(blank);
    expect([apply.mock.calls, root.querySelector(".people-draft")]).toEqual([[], null]);
    const taken = openDraft(root);
    fireEvent.change(taken, { target: { value: "ana ruiz" } });
    fireEvent.keyDown(taken, { key: "Enter" });
    expect([last(toasts()), draftInput(root).value, peopleOf(t.session.view().plan).length]).toEqual([[refusal.personNameTaken("Ana Ruiz"), "bad"], "ana ruiz", 3]);
  });

  it("refuses a taken name once: the blur after a refused Return adds nothing and toasts nothing more", async () => {
    const { t } = await crewed();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    const draft = openDraft(root);
    fireEvent.change(draft, { target: { value: "ana ruiz" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    fireEvent.blur(draft);
    expect([toasts(), apply.mock.calls.length, draftInput(root).value]).toEqual([[[refusal.personNameTaken("Ana Ruiz"), "bad"]], 1, "ana ruiz"]);
    fireEvent.change(draft, { target: { value: "Dana Lee" } });
    fireEvent.blur(draft);
    expect([apply.mock.calls.length, root.querySelector(".people-draft"), toasts().filter(([, tone]) => tone === "bad").length]).toEqual([2, null, 1]);
  });

  it("moves the focus to the next row's Remove… after a removal, and to + Add person after the last row's", async () => {
    const { t, ids } = await crewed();
    act(() => {
      t.session.apply({ t: "unassign", items: ["m"], person: ids.OB });
    });
    const root = mount(t.session);
    act(() => {
      removeOf(ids.OB).focus();
    });
    fireEvent.click(removeOf(ids.OB));
    fireEvent.click(within(within(root).getByRole("dialog", { name: "Remove person" })).getByRole("button", { name: "Remove" }));
    expect([rowIds(root), document.activeElement]).toEqual([[ids.MO, ids.AR], removeOf(ids.AR)]);
    fireEvent.click(removeOf(ids.AR));
    fireEvent.click(within(within(root).getByRole("dialog", { name: "Remove person" })).getByRole("button", { name: "Remove" }));
    expect([rowIds(root), document.activeElement]).toEqual([[ids.MO], one("button.people-add", root)]);
  });

  it("keeps the give-to dialog, and its pick, when a peer unassigns the last item while it is open", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    fireEvent.click(removeOf(ids.OB));
    fireEvent.click(input(`[data-pick="${ids.AR}"] input`, within(root).getByRole("dialog", { name: "Remove person" })));
    act(() => {
      t.session.apply({ t: "unassign", items: ["m"], person: ids.OB });
    });
    const ask = within(root).getByRole("dialog", { name: "Remove person" });
    expect([ask.querySelector('[role="radiogroup"]') !== null, input(`[data-pick="${ids.AR}"] input`, ask).checked]).toEqual([true, true]);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect([apply.mock.calls, rowIds(root)]).toEqual([[[{ t: "person", op: "remove", person: ids.OB, to: ids.AR }]], [ids.MO, ids.AR]]);
  });

  it("refuses a plain remove with a toast when a peer assigned the person while the dialog was open", async () => {
    const { t, ids } = await crewed();
    act(() => {
      t.session.apply({ t: "unassign", items: ["m"], person: ids.OB });
    });
    const root = mount(t.session);
    fireEvent.click(removeOf(ids.OB));
    act(() => {
      t.session.apply({ t: "assign", items: ["a"], person: ids.OB });
    });
    const ask = within(root).getByRole("dialog", { name: "Remove person" });
    expect(ask.querySelector('[role="radiogroup"]')).toBeNull();
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect([apply.mock.calls, within(root).queryByRole("dialog"), last(toasts()), rowIds(root)]).toEqual([[], null, [STALE_CONFIRM, "bad"], [ids.MO, ids.OB, ids.AR]]);
  });

  it("removes a person who holds no item after a plain confirm, as one undo entry", async () => {
    const { t, ids } = await crewed();
    act(() => {
      t.session.apply({ t: "unassign", items: ["m"], person: ids.OB });
    });
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(removeOf(ids.OB));
    const ask = within(root).getByRole("dialog", { name: "Remove person" });
    expect([one(".remove-person-text", ask).textContent, within(ask).getByRole("button", { name: "Close" }) !== null, ask.querySelector('[role="radiogroup"]')]).toEqual([
      "Remove “Ole Berg” from this plan? No item is assigned to them.",
      true,
      null,
    ]);
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect([within(root).queryByRole("dialog"), apply.mock.calls]).toEqual([null, []]);
    fireEvent.click(removeOf(ids.OB));
    const again = within(root).getByRole("dialog", { name: "Remove person" });
    expect(within(again).getByRole("button", { name: "Remove" }).className).toBe("button-danger");
    fireEvent.click(within(again).getByRole("button", { name: "Remove" }));
    expect([apply.mock.calls, rowIds(root), within(root).queryByRole("dialog")]).toEqual([[[{ t: "person", op: "remove", person: ids.OB, to: null }]], [ids.MO, ids.AR], null]);
    act(() => {
      t.session.undo();
    });
    expect(rowIds(root)).toEqual([ids.MO, ids.OB, ids.AR]);
  });

  it("gives the items to Unassigned, preselected, and notes the trashed ones", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(removeOf(ids.MO));
    const ask = within(root).getByRole("dialog", { name: "Remove person" });
    const group = within(ask).getByRole("radiogroup", { name: "Give the items to" });
    const picks = [...group.querySelectorAll<HTMLElement>("[data-pick]")].map((r) => [r.dataset.pick, r.textContent, input("input", r).checked, r.querySelector(".avatar")?.textContent ?? null]);
    expect([one(".remove-person-text", ask).textContent, one(".remove-person-trashed", ask).textContent, picks]).toEqual([
      "“Mira Okafor” is assigned to 2 items. Give them to…",
      "1 of them is in the Trash.",
      [
        ["none", "Unassigned", true, null],
        [ids.OB, "OBOle Berg", false, "OB"],
        [ids.AR, "ARAna Ruiz", false, "AR"],
      ],
    ]);
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect([apply.mock.calls, within(root).queryByRole("dialog")]).toEqual([[[{ t: "person", op: "remove", person: ids.MO, to: null }]], null]);
    expect([t.session.view().people.assignees.get("a")?.map((a) => (a.kind === "live" ? a.person.initials : a.id)), rowIds(root)]).toEqual([["AR"], [ids.OB, ids.AR]]);
    act(() => {
      t.session.undo();
    });
    expect([t.session.view().people.assignees.get("a")?.map((a) => (a.kind === "live" ? a.person.initials : a.id)), one(".people-count", row(ids.MO)).textContent]).toEqual([["MO", "AR"], "1 item"]);
  });

  it("gives the items to another person, as one undo entry", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(removeOf(ids.OB));
    const ask = within(root).getByRole("dialog", { name: "Remove person" });
    expect([one(".remove-person-text", ask).textContent, ask.querySelector(".remove-person-trashed")]).toEqual(["“Ole Berg” is assigned to 1 item. Give them to…", null]);
    fireEvent.click(input(`[data-pick="${ids.AR}"] input`, ask));
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect(apply.mock.calls).toEqual([[{ t: "person", op: "remove", person: ids.OB, to: ids.AR }]]);
    expect(t.session.view().people.assignees.get("m")?.map((a) => (a.kind === "live" ? a.person.name : a.id))).toEqual(["Ana Ruiz"]);
    act(() => {
      t.session.undo();
    });
    expect([t.session.view().people.assignees.get("m")?.map((a) => (a.kind === "live" ? a.person.name : a.id)), rowIds(root)]).toEqual([["Ole Berg"], [ids.MO, ids.OB, ids.AR]]);
  });

  it("resets a pick that was removed elsewhere to Unassigned with a toast", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    fireEvent.click(removeOf(ids.MO));
    const ask = within(root).getByRole("dialog", { name: "Remove person" });
    fireEvent.click(input(`[data-pick="${ids.AR}"] input`, ask));
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.AR, to: null });
    });
    const now = within(root).getByRole("dialog", { name: "Remove person" });
    expect([input('[data-pick="none"] input', now).checked, now.querySelector(`[data-pick="${ids.AR}"]`), last(toasts())]).toEqual([true, null, [STALE_CONFIRM, "bad"]]);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(now).getByRole("button", { name: "Remove" }));
    expect(apply.mock.calls).toEqual([[{ t: "person", op: "remove", person: ids.MO, to: null }]]);
  });

  it("closes with a toast when the person was removed elsewhere", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session);
    fireEvent.click(removeOf(ids.MO));
    expect(within(root).getByRole("dialog", { name: "Remove person" })).not.toBeNull();
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.MO, to: null });
    });
    expect([within(root).queryByRole("dialog"), last(toasts())]).toEqual([null, [STALE_CONFIRM, "bad"]]);
  });

  it("disables every control when the plan is read-only", async () => {
    const { t, ids } = await crewed();
    const root = mount(t.session, true);
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")];
    expect([controls.length, controls.filter((c) => !c.disabled).map((c) => c.className)]).toEqual([3 * 5 + 1, []]);
    expect([input("input.people-name", row(ids.MO)).value, input("input.people-initials", row(ids.MO)).value]).toEqual(["Mira Okafor", "MO"]);
  });
});

describe("Settings > People on iPad", () => {
  it("confirms a plain remove with a native alert and a destructive Remove", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const { t, ids } = await crewed();
      act(() => {
        t.session.apply({ t: "unassign", items: ["m"], person: ids.OB });
      });
      const root = mount(t.session);
      tauri.answers.alert_ask = () => "confirm";
      const apply = vi.spyOn(t.session, "apply");
      fireEvent.click(removeOf(ids.OB));
      await settle();
      expect(tauri.calls.filter((c) => c.cmd === "alert_ask").map((c) => c.args)).toEqual([
        { ask: { title: "Remove person", message: "Remove “Ole Berg” from this plan? No item is assigned to them.", confirm: { label: "Remove", destructive: true }, cancel: "Cancel" } },
      ]);
      expect([within(root).queryByRole("dialog"), apply.mock.calls, rowIds(root)]).toEqual([null, [[{ t: "person", op: "remove", person: ids.OB, to: null }]], [ids.MO, ids.AR]]);
      act(() => {
        t.session.undo();
      });
      expect(rowIds(root)).toEqual([ids.MO, ids.OB, ids.AR]);
    } finally {
      unstub();
    }
  });

  it("reports no stale confirmation after a confirmed native removal when React renders on its own schedule", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    const actEnv = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    try {
      const { t, ids } = await crewed();
      act(() => {
        t.session.apply({ t: "unassign", items: ["m"], person: ids.OB });
      });
      const root = mount(t.session);
      tauri.answers.alert_ask = () => "confirm";
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
      fireEvent.click(removeOf(ids.OB));
      await Promise.all([0, 1, 2, 3].map((n) => new Promise<void>((r) => setTimeout(r, n * 5))));
      await new Promise<void>((r) => setTimeout(r, 30));
      expect([rowIds(root), toasts().filter(([text]) => text === STALE_CONFIRM)]).toEqual([[ids.MO, ids.AR], []]);
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnv);
      unstub();
    }
  });

  it("reports a peer's removal once when the native alert is answered afterwards", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const { t, ids } = await crewed();
      act(() => {
        t.session.apply({ t: "unassign", items: ["m"], person: ids.OB });
      });
      mount(t.session);
      const answer: { send: ((a: string) => void) | null } = { send: null };
      tauri.answers.alert_ask = () => new Promise<string>((r) => (answer.send = r));
      fireEvent.click(removeOf(ids.OB));
      await settle();
      act(() => {
        t.session.apply({ t: "person", op: "remove", person: ids.OB, to: null });
      });
      await settle();
      const send = answer.send;
      if (send === null) throw new Error("the alert was not asked");
      send("confirm");
      await settle();
      expect(toasts().filter(([text]) => text === STALE_CONFIRM)).toHaveLength(1);
    } finally {
      unstub();
    }
  });

  it("asks where held items go in the dialog, not an alert", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const { t, ids } = await crewed();
      const root = mount(t.session);
      fireEvent.click(removeOf(ids.OB));
      await settle();
      expect([tauri.calls.filter((c) => c.cmd === "alert_ask").length, within(root).getByRole("radiogroup", { name: "Give the items to" }) !== null]).toEqual([0, true]);
    } finally {
      unstub();
    }
  });
});

describe("People in the phone Settings sheet", () => {
  const UI: UiState = {
    plan: null,
    view: "timeline",
    zoom: "W",
    selected: null,
    collapsed: new Set(),
    baseline: null,
    dialog: null,
    reveal: null,
    follow: null,
    naming: null,
    settings: null,
    syncPane: null,
    sidebarOpen: true,
    sidebarWidth: null,
    query: "",
    searchAsk: 0,
    columnsAsk: 0,
  };

  it("lists the people rows in the grouped list after Overview", async () => {
    const { t, ids } = await crewed();
    const closer = createRef<((r: CloseReason) => boolean) | null>();
    render(
      withSync(
        <OpenChoice.Provider value={vi.fn()}>
          <UiContext.Provider value={{ ui: UI, setUi: vi.fn() }}>
            <ThemeProvider storage={window.localStorage} initial={{ store: DEFAULT_STORE, unreadable: null }}>
              <SettingsView
                frame="sheet"
                section="people"
                session={t.session}
                readOnly={false}
                device="Test iPhone"
                clock={fixedClock("2026-11-09")}
                hover={false}
                closer={closer}
                files={{ creating: false, importing: false, newPlan: vi.fn(), newExample: vi.fn(), importPlan: vi.fn() }}
                onSection={vi.fn()}
                syncPane={null}
                onClose={vi.fn()}
                onSyncPane={vi.fn()}
                onTrashPlan={vi.fn()}
                sync={{ kind: "off" }}
                syncName={() => null}
                updates={null}
                syncPanes={<div />}
                planLocked={false}
              />
            </ThemeProvider>
          </UiContext.Provider>
        </OpenChoice.Provider>,
        { registry: testRegistry(t) },
      ),
    );
    const group = one('.sheet section.settings-group[data-section="people"]');
    expect([
      one("h2.settings-group-title", group).textContent,
      group.previousElementSibling?.getAttribute("data-section"),
      [...group.querySelectorAll<HTMLElement>("li.people-row")].map((r) => r.dataset.person),
      one("button.people-add", group).textContent,
    ]).toEqual(["People", "overview", [ids.MO, ids.OB, ids.AR], "+ Add person"]);
  });
});
