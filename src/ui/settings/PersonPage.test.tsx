import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusal } from "../../actions/copy";
import type { StepColour } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import type { PlanSession } from "../../store/session";
import { IPAD, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { resetTauri, tauri } from "../../test/tauriMock";
import { toast } from "../common/Toast";
import { OpenChoice } from "../run";
import { PERSON_GONE } from "../people/text";
import { PersonPage } from "./PersonPage";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));
vi.mock("../common/Toast", () => ({ toast: vi.fn() }));

const sessions: PlanSession[] = [];

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

const CREW: readonly (readonly [string, string, StepColour])[] = [
  ["Mira Okafor", "MO", "violet"],
  ["Ole Berg", "OB", "lime"],
  ["Ana Ruiz", "AR", "coral"],
];

const crewed = async (): Promise<{ t: TestSession; ids: Record<string, string> }> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  act(() => {
    CREW.forEach(([name, initials, colour]) => {
      const known = peopleOf(t.session.view().plan);
      t.session.apply({ t: "person", op: "add", name, initials, colour, after: known.length === 0 ? null : known[known.length - 1].id });
    });
  });
  const ids = Object.fromEntries(peopleOf(t.session.view().plan).map((p) => [p.initials, p.id]));
  act(() => {
    t.session.apply({ t: "assign", items: ["a"], person: ids.MO });
    t.session.apply({ t: "assign", items: ["m"], person: ids.MO });
    t.session.apply({ t: "assign", items: ["b"], person: ids.MO });
    t.session.apply({ t: "trash", items: ["b"] });
  });
  return { t, ids };
};

const mount = (session: PlanSession, person: string, o: { readOnly?: boolean; focus?: "initials" | null } = {}) => {
  const onRemoved = vi.fn<(next: string | null) => void>();
  const view = render(
    <OpenChoice.Provider value={vi.fn()}>
      <div className="host">
        <PersonPage session={session} readOnly={o.readOnly ?? false} person={person} focus={o.focus ?? null} onRemoved={onRemoved} />
      </div>
    </OpenChoice.Provider>,
  );
  const host = view.container.querySelector<HTMLElement>(".host");
  if (host === null) throw new Error("no host");
  return { root: host, onRemoved };
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

const commit = (el: HTMLInputElement, value: string): void => {
  act(() => {
    el.focus();
  });
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: "Enter" });
};

const labels = (root: HTMLElement): (string | null)[] => [...root.querySelectorAll<HTMLElement>(".settings-detail-row .settings-detail-label")].map((l) => l.textContent);

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

describe("PersonPage", () => {
  it("shows Name, Initials, Colour and the untrashed items of the person", async () => {
    const { t, ids } = await crewed();
    const { root } = mount(t.session, ids.MO);
    expect([
      labels(root),
      input("input.people-name", root).value,
      input("input.people-name", root).getAttribute("aria-label"),
      input("input.people-initials", root).value,
      one("button.people-avatar .avatar", root).textContent,
      one("button.people-avatar", root).getAttribute("aria-label"),
      one(".settings-detail-value", root).textContent,
      one("button.settings-detail-danger", root).textContent,
      root.querySelector("p.settings-line"),
    ]).toEqual([["Name", "Initials", "Colour", "Items"], "Mira Okafor", "Name of Mira Okafor", "MO", "MO", "Colour of Mira Okafor", "2 items", "Remove person", null]);
  });

  it("renames, sets initials and refuses initials that are too long", async () => {
    const { t, ids } = await crewed();
    const { root } = mount(t.session, ids.OB);
    const apply = vi.spyOn(t.session, "apply");
    commit(input("input.people-name", root), "Ole Bergen");
    commit(input("input.people-initials", root), "ob");
    expect([apply.mock.calls, input("input.people-name", root).getAttribute("aria-label"), one("button.people-avatar .avatar", root).textContent]).toEqual([
      [[{ t: "person", op: "rename", person: ids.OB, name: "Ole Bergen" }], [{ t: "person", op: "initials", person: ids.OB, initials: "ob" }]],
      "Name of Ole Bergen",
      "ob",
    ]);
    commit(input("input.people-initials", root), "ABCD");
    expect([vi.mocked(toast).mock.lastCall, input("input.people-initials", root).value]).toEqual([[refusal.initials, "bad"], "ob"]);
  });

  it("recolours through the colour popover, which has its close control", async () => {
    const { t, ids } = await crewed();
    const { root } = mount(t.session, ids.AR);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.people-avatar", root));
    const pop = within(root).getByRole("dialog", { name: "Colour · Ana Ruiz" });
    expect([one("button.people-avatar", root).getAttribute("aria-expanded"), within(pop).getByRole("button", { name: "Close" }) !== null]).toEqual(["true", true]);
    fireEvent.click(within(pop).getByRole("radio", { name: "Sky" }));
    expect([apply.mock.calls, within(root).queryByRole("dialog"), one("button.people-avatar .avatar", root).style.getPropertyValue("--person")]).toEqual([
      [[{ t: "person", op: "colour", person: ids.AR, colour: "sky" }]],
      null,
      "var(--s-sky)",
    ]);
  });

  it("focuses Initials, selected, when opened for a new person", async () => {
    const { t, ids } = await crewed();
    const { root } = mount(t.session, ids.AR, { focus: "initials" });
    const initials = input("input.people-initials", root);
    expect([document.activeElement, initials.selectionStart, initials.selectionEnd]).toEqual([initials, 0, 2]);
  });

  it("asks before Remove person, writes nothing on Cancel, and reports the next person after a removal", async () => {
    const { t, ids } = await crewed();
    const { root, onRemoved } = mount(t.session, ids.OB);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(one("button.settings-detail-danger", root));
    const ask = within(root).getByRole("dialog", { name: "Remove person" });
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect([apply.mock.calls, onRemoved.mock.calls, within(root).queryByRole("dialog")]).toEqual([[], [], null]);
    fireEvent.click(one("button.settings-detail-danger", root));
    fireEvent.click(within(within(root).getByRole("dialog", { name: "Remove person" })).getByRole("button", { name: "Remove" }));
    expect([apply.mock.calls, onRemoved.mock.calls]).toEqual([[[{ t: "person", op: "remove", person: ids.OB, to: null }]], [[ids.AR]]]);
  });

  it("reports no next person when the last one is removed, after giving the items away", async () => {
    const { t, ids } = await crewed();
    act(() => {
      t.session.apply({ t: "assign", items: ["a"], person: ids.AR });
    });
    const { root, onRemoved } = mount(t.session, ids.AR);
    fireEvent.click(one("button.settings-detail-danger", root));
    const ask = within(root).getByRole("dialog", { name: "Remove person" });
    fireEvent.click(input(`[data-pick="${ids.OB}"] input`, ask));
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect(onRemoved.mock.calls).toEqual([[null]]);
  });

  it("shows a line, and no fields, when the person is removed elsewhere", async () => {
    const { t, ids } = await crewed();
    const { root, onRemoved } = mount(t.session, ids.OB);
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.OB, to: null });
    });
    expect([one("p.settings-line", root).textContent, root.querySelectorAll("input, button").length, onRemoved.mock.calls]).toEqual([PERSON_GONE, 0, []]);
    expect(PERSON_GONE).toBe("This person is no longer in this plan.");
  });

  it("disables every field and Remove person when the plan is read-only", async () => {
    const { t, ids } = await crewed();
    const { root } = mount(t.session, ids.MO, { readOnly: true });
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")];
    expect([controls.length, controls.filter((c) => !c.disabled).map((c) => c.className), input("input.people-name", root).value, input("input.people-initials", root).value]).toEqual([4, [], "Mira Okafor", "MO"]);
  });
});

describe("PersonPage on iPad", () => {
  it("asks Remove person through the native alert and reports the removal", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const { t, ids } = await crewed();
      const { root, onRemoved } = mount(t.session, ids.OB);
      tauri.answers.alert_ask = () => "confirm";
      fireEvent.click(one("button.settings-detail-danger", root));
      await settle();
      expect([tauri.calls.filter((c) => c.cmd === "alert_ask").length, within(root).queryByRole("dialog"), onRemoved.mock.calls, peopleOf(t.session.view().plan).map((p) => p.initials)]).toEqual([1, null, [[ids.AR]], ["MO", "AR"]]);
    } finally {
      unstub();
    }
  });
});
