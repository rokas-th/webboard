import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusal } from "../../actions/copy";
import { BUILT_IN_DEFAULTS, type GoneDefault } from "../../domain/defaults";
import type { StepColour } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { IPAD, IPHONE, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { SEED_ROOT, testSession, type SeedItem, type TestSession } from "../../test/session";
import { encodeAction } from "../../store/doc";
import { emitFromRust, resetTauri, tauri } from "../../test/tauriMock";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { toast } from "../common/Toast";
import { OpenChoice } from "../run";
import { Defaults, goneText } from "./Defaults";
import { SETTINGS_SECTIONS } from "./sections";

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
  setPlatform(MAC);
});

const SEED: readonly SeedItem[] = [
  { id: "g1", name: "Dome", kind: "group" },
  { id: "t1", name: "Pour the pier", parent: "g1", start: "2026-11-10", dur: 3 },
  { id: "g2", name: "Commission", kind: "group" },
  { id: "g3", name: "Mirror cell", kind: "group", parent: "g2" },
  { id: "t2", name: "Coat the mirror", parent: "g3", start: "2026-11-12", dur: 2 },
  { id: "u1", name: "Kids star parties", horizon: "next" },
];

const CREW: readonly (readonly [string, string, StepColour])[] = [
  ["Mira Okafor", "MO", "violet"],
  ["Ole Berg", "OB", "lime"],
];

const made = async (): Promise<TestSession> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  return t;
};

const addCrew = (t: TestSession): Record<string, string> => {
  act(() => {
    CREW.forEach(([name, initials, colour]) => {
      const all = peopleOf(t.session.view().plan);
      t.session.apply({ t: "person", op: "add", name, initials, colour, after: all.length === 0 ? null : all[all.length - 1].id });
    });
  });
  return Object.fromEntries(peopleOf(t.session.view().plan).map((p) => [p.initials, p.id]));
};

const bySteps = (t: TestSession): void => {
  act(() => {
    t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
  });
};

const mount = (session: PlanSession, readOnly = false) => {
  const onPeople = vi.fn<() => void>();
  const view = render(
    <OpenChoice.Provider value={vi.fn()}>
      <div className="host">
        <Defaults session={session} readOnly={readOnly} onPeople={onPeople} />
      </div>
    </OpenChoice.Provider>,
  );
  const host = view.container.querySelector<HTMLElement>(".host");
  if (host === null) throw new Error("no host");
  return { host, onPeople };
};

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const button = (sel: string, root: ParentNode = document): HTMLButtonElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLButtonElement)) throw new Error("no button " + sel);
  return el;
};

const durField = (): HTMLInputElement => {
  const el = document.querySelector("input.defaults-dur");
  if (!(el instanceof HTMLInputElement)) throw new Error("no duration field");
  return el;
};

const typeDur = (value: string): void => {
  const el = durField();
  act(() => {
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value } });
    fireEvent.keyDown(el, { key: "Enter" });
  });
};

const pick = (field: "who" | "group" | "step"): HTMLButtonElement => button(`button.defaults-pick[data-pick="${field}"]`);

const openPick = (field: "who" | "group" | "step"): void => {
  act(() => {
    fireEvent.click(pick(field));
  });
};

const menuRows = (): [string | null, string | null][] => [...document.querySelectorAll('.context-menu [role^="menuitem"]')].map((e) => [e.textContent, e.getAttribute("aria-checked")]);

const choose = (row: string): void => {
  const el = [...document.querySelectorAll<HTMLElement>('.context-menu [role^="menuitem"]')].find((e) => e.textContent === row);
  if (el === undefined) throw new Error("no menu row " + row);
  act(() => {
    fireEvent.click(el);
  });
};

const statusLine = (): HTMLElement => one('p.defaults-line[role="status"]');

const goneLines = (): (string | null)[] => [...statusLine().querySelectorAll("span.board-problem")].map((s) => s.textContent);

const stepLine = (): string | null => one('[data-settings-row="defaults.step"] .workflow-new').textContent;

const segRadios = (): [string | null, string | null, boolean][] =>
  [...document.querySelectorAll<HTMLElement>('[data-settings-row="defaults.dated"] .seg[role="radiogroup"] [role="radio"]')].map((r) => [r.textContent, r.getAttribute("aria-checked"), r.classList.contains("active")]);

describe("Settings > Defaults", () => {
  it("shows the built-in defaults in five rows, each with its control, an empty status line and the by-dates step line", async () => {
    const t = await made();
    const { host } = mount(t.session);
    expect([...host.querySelectorAll<HTMLElement>(".defaults-row")].map((r) => [r.dataset["settingsRow"], r.querySelector(".settings-label")?.textContent])).toEqual([
      ["defaults.duration", "New task duration"],
      ["defaults.dated", "New items are"],
      ["defaults.assignee", "Default assignee"],
      ["defaults.group", "Board + puts items in"],
      ["defaults.step", "Step for new undated items"],
    ]);
    expect([statusLine().textContent, statusLine().childElementCount]).toEqual(["", 0]);
    expect([durField().value, durField().getAttribute("aria-label"), one(".stepper .defaults-unit").textContent, button('.stepper button.step-btn[aria-label="Shorter"]').disabled, button('.stepper button.step-btn[aria-label="Longer"]').disabled]).toEqual([
      "3",
      "New task duration in working days",
      "working days",
      false,
      false,
    ]);
    expect([one('[data-settings-row="defaults.duration"] .settings-hint').textContent, one('[data-settings-row="defaults.dated"] .settings-hint').textContent]).toEqual([
      "A new task lasts this long once it has dates.",
      "Dated items start on the next working day.",
    ]);
    expect([one('[data-settings-row="defaults.dated"] .seg').getAttribute("aria-label"), segRadios()]).toEqual([
      "New items are",
      [
        ["Dated", "true", true],
        ["Undated", "false", false],
      ],
    ]);
    expect([pick("who").textContent, pick("group").textContent, pick("who").getAttribute("aria-haspopup"), pick("who").getAttribute("aria-expanded")]).toEqual(["Nobody", "Plan root", "menu", "false"]);
    expect([document.querySelector('button.defaults-pick[data-pick="step"]'), stepLine()]).toEqual([null, "New undated items go to “Later” until this plan uses steps."]);
    expect(t.session.view().plan.defaults).toBeNull();
  });

  it("steps the duration with Shorter and Longer, disabled at 1 and 3650, and writes each step", async () => {
    const t = await made();
    mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.click(button('button.step-btn[aria-label="Longer"]'));
    });
    expect([apply.mock.calls, durField().value, t.session.view().plan.defaults]).toEqual([[[{ t: "defaults", field: "dur", value: 4 }]], "4", { ...BUILT_IN_DEFAULTS, dur: 4 }]);
    typeDur("1");
    expect([durField().value, button('button.step-btn[aria-label="Shorter"]').disabled, button('button.step-btn[aria-label="Longer"]').disabled]).toEqual(["1", true, false]);
    typeDur("3650");
    expect([durField().value, button('button.step-btn[aria-label="Shorter"]').disabled, button('button.step-btn[aria-label="Longer"]').disabled]).toEqual(["3650", false, true]);
    act(() => {
      fireEvent.click(button('button.step-btn[aria-label="Shorter"]'));
    });
    expect([durField().value, t.session.view().defaults.dur]).toEqual(["3649", 3649]);
    expect(vi.mocked(toast).mock.calls.filter(([, tone]) => tone === "bad")).toEqual([]);
  });

  it("moves keyboard focus to the other stepper button when a step reaches a bound and disables the focused one", async () => {
    const t = await made();
    mount(t.session);
    typeDur("2");
    const shorter = button('button.step-btn[aria-label="Shorter"]');
    const longer = button('button.step-btn[aria-label="Longer"]');
    act(() => {
      shorter.focus();
      fireEvent.click(shorter);
    });
    expect([durField().value, shorter.disabled, document.activeElement === longer]).toEqual(["1", true, true]);
    typeDur("3649");
    act(() => {
      longer.focus();
      fireEvent.click(longer);
    });
    expect([durField().value, longer.disabled, document.activeElement === shorter]).toEqual(["3650", true, true]);
    act(() => {
      shorter.focus();
      fireEvent.click(shorter);
    });
    expect([durField().value, document.activeElement === shorter]).toEqual(["3649", true]);
  });

  it("links each hint to its control, and renders the labels the settings search indexes", async () => {
    const t = await made();
    const { host } = mount(t.session);
    const hintOf = (el: HTMLElement): string | null => {
      const id = el.getAttribute("aria-describedby");
      return id === null ? null : (document.getElementById(id)?.textContent ?? null);
    };
    expect([hintOf(durField()), hintOf(one('[data-settings-row="defaults.dated"] [role="radiogroup"]'))]).toEqual([
      "A new task lasts this long once it has dates.",
      "Dated items start on the next working day.",
    ]);
    const indexed = SETTINGS_SECTIONS.find((s) => s.id === "defaults")?.rows.map((r) => [`defaults.${r.id}`, r.label]);
    expect([...host.querySelectorAll<HTMLElement>(".defaults-row")].map((r) => [r.dataset["settingsRow"], r.querySelector(".settings-label")?.textContent])).toEqual(indexed);
  });

  it("refuses a bad typed duration with the toast, and the field goes back", async () => {
    const t = await made();
    mount(t.session);
    ["0", "3651", "2.5", "abc", "-4"].forEach((typed) => {
      vi.mocked(toast).mockClear();
      typeDur(typed);
      expect([typed, vi.mocked(toast).mock.calls, durField().value, t.session.view().plan.defaults]).toEqual([typed, [[refusal.defaultDur, "bad"]], "3", null]);
    });
    vi.mocked(toast).mockClear();
    typeDur("03");
    expect([vi.mocked(toast).mock.calls, durField().value, t.session.view().plan.defaults]).toEqual([[], "3", null]);
  });

  it("switches between Dated and Undated with the radios and the arrow keys", async () => {
    const t = await made();
    mount(t.session);
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.click(one('[role="radio"][data-dated="undated"]'));
    });
    expect([apply.mock.calls, segRadios(), t.session.view().defaults.dated]).toEqual([
      [[{ t: "defaults", field: "dated", value: false }]],
      [
        ["Dated", "false", false],
        ["Undated", "true", true],
      ],
      false,
    ]);
    act(() => {
      fireEvent.click(one('[role="radio"][data-dated="undated"]'));
    });
    expect(apply.mock.calls.length).toBe(1);
    act(() => {
      fireEvent.keyDown(one('[role="radio"][data-dated="undated"]'), { key: "ArrowLeft" });
    });
    expect([apply.mock.calls.length, t.session.view().defaults.dated, document.activeElement?.textContent, segRadios().map((r) => r[1])]).toEqual([2, true, "Dated", ["true", "false"]]);
    expect([...document.querySelectorAll<HTMLElement>('[role="radio"][data-dated]')].map((r) => r.tabIndex)).toEqual([0, -1]);
  });

  it("picks the default assignee from Nobody and the live people, and offers Settings › People when there is nobody", async () => {
    const t = await made();
    const { onPeople } = mount(t.session);
    openPick("who");
    expect([menuRows(), pick("who").getAttribute("aria-expanded")]).toEqual([
      [
        ["Nobody", "true"],
        ["Add people in Settings…", null],
      ],
      "true",
    ]);
    choose("Add people in Settings…");
    expect([onPeople.mock.calls.length, t.session.view().plan.defaults]).toEqual([1, null]);
    const ids = addCrew(t);
    const apply = vi.spyOn(t.session, "apply");
    openPick("who");
    expect(menuRows()).toEqual([
      ["Nobody", "true"],
      ["Mira Okafor", "false"],
      ["Ole Berg", "false"],
    ]);
    choose("Ole Berg");
    expect([apply.mock.calls, pick("who").textContent, t.session.view().defaults.who]).toEqual([[[{ t: "defaults", field: "who", value: ids.OB }]], "Ole Berg", ids.OB]);
    openPick("who");
    expect(menuRows().map((r) => r[1])).toEqual(["false", "false", "true"]);
    choose("Ole Berg");
    expect(apply.mock.calls.length).toBe(1);
    openPick("who");
    choose("Nobody");
    expect([apply.mock.calls.slice(1), pick("who").textContent]).toEqual([[[{ t: "defaults", field: "who", value: null }]], "Nobody"]);
  });

  it("picks the group from Plan root and the live groups by outline path, leaving trashed ones out", async () => {
    const t = await made();
    mount(t.session);
    act(() => {
      t.session.apply({ t: "trash", items: ["g1"] });
    });
    const apply = vi.spyOn(t.session, "apply");
    openPick("group");
    expect(menuRows()).toEqual([
      ["Plan root", "true"],
      ["Commission", "false"],
      ["Commission › Mirror cell", "false"],
    ]);
    choose("Commission › Mirror cell");
    expect([apply.mock.calls, pick("group").textContent, t.session.view().defaults.group]).toEqual([[[{ t: "defaults", field: "group", value: "g3" }]], "Commission › Mirror cell", "g3"]);
    openPick("group");
    choose("Plan root");
    expect([apply.mock.calls.slice(1), pick("group").textContent]).toEqual([[[{ t: "defaults", field: "group", value: null }]], "Plan root"]);
  });

  it("picks the step for new undated items from First open step and the open steps once the plan uses steps", async () => {
    const t = await made();
    mount(t.session);
    bySteps(t);
    const apply = vi.spyOn(t.session, "apply");
    expect([pick("step").textContent, stepLine()]).toEqual(["First open step", "New undated items go to “Now”, the first step that does not complete items."]);
    openPick("step");
    expect(menuRows()).toEqual([
      ["First open step", "true"],
      ["Now", "false"],
      ["Review", "false"],
      ["Later", "false"],
    ]);
    choose("Review");
    expect([apply.mock.calls, pick("step").textContent, stepLine(), t.session.view().defaults.step]).toEqual([[[{ t: "defaults", field: "step", value: "next" }]], "Review", "New undated items go to “Review”.", "next"]);
  });

  it("toasts and writes nothing when a pick went stale while its menu was open", async () => {
    const t = await made();
    mount(t.session);
    const ids = addCrew(t);
    bySteps(t);
    const apply = vi.spyOn(t.session, "apply");
    openPick("who");
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.MO, to: null });
    });
    choose("Mira Okafor");
    openPick("group");
    act(() => {
      t.session.apply({ t: "trash", items: ["g2"] });
    });
    choose("Commission");
    const later = stepsOf(t.session.view().plan).find((s) => s.name === "Later");
    if (later === undefined) throw new Error("no Later step");
    openPick("step");
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: later.id, to: "now" });
    });
    choose("Later");
    expect([vi.mocked(toast).mock.calls.filter(([, tone]) => tone === "bad"), apply.mock.calls.filter(([i]) => i.t === "defaults"), t.session.view().plan.defaults]).toEqual([
      [
        [STALE_CONFIRM, "bad"],
        [STALE_CONFIRM, "bad"],
        [STALE_CONFIRM, "bad"],
      ],
      [],
      null,
    ]);
  });

  it("names each gone default in the status line until another is chosen", async () => {
    const t = await made();
    mount(t.session);
    const ids = addCrew(t);
    bySteps(t);
    act(() => {
      t.session.apply({ t: "defaults", field: "who", value: ids.MO });
      t.session.apply({ t: "defaults", field: "group", value: "g2" });
      t.session.apply({ t: "defaults", field: "step", value: "next" });
    });
    expect(goneLines()).toEqual([]);
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.MO, to: null });
      t.session.apply({ t: "trash", items: ["g2"] });
      t.session.apply({ t: "step", op: "delete", step: "next", to: "now" });
    });
    expect([goneLines(), pick("who").textContent, pick("group").textContent, pick("step").textContent, stepLine()]).toEqual([
      [
        "The default assignee “Mira Okafor” was removed from people. New items are unassigned until you choose another.",
        "The group “Commission” is in the Trash. Board + adds to the plan root until you choose another.",
        "The step “Review” was deleted. New undated items go to “Now” until you choose another.",
      ],
      "Nobody",
      "Plan root",
      "First open step",
      "New undated items go to “Now”, the first step that does not complete items.",
    ]);
    openPick("who");
    choose("Nobody");
    expect(goneLines()).toHaveLength(2);
  });

  it("renders a line for a stored default group that names no item, or an item that is not a group", async () => {
    const lineFor = async (group: string): Promise<(string | null)[]> => {
      const pd = encodeAction({ id: "x1", dev: "iphone", ses: "s1", at: 0, par: [SEED_ROOT], lbl: "Defaults", w: [{ u: "pd", v: { ...BUILT_IN_DEFAULTS, group }, c: "own" }] });
      const t = await testSession(SEED, { raw: { x1: pd } });
      sessions.push(t.session);
      mount(t.session);
      const lines = [...goneLines(), pick("group").textContent];
      cleanup();
      return lines;
    };
    expect([await lineFor("zz"), await lineFor("t1")]).toEqual([
      ["The default group was deleted. Board + adds to the plan root until you choose another.", "Plan root"],
      ["“Pour the pier” is not a group. Board + adds to the plan root until you choose another.", "Plan root"],
    ]);
  });

  it("says a default step that now completes items is not followed", async () => {
    const t = await made();
    mount(t.session);
    bySteps(t);
    act(() => {
      t.session.apply({ t: "defaults", field: "step", value: "later" });
      t.session.apply({ t: "step", op: "completes", step: "later", completes: true });
    });
    expect(goneLines()).toEqual(["“Later” completes items. New undated items go to “Now” until you choose another."]);
  });

  it("words every gone kind, named and unnamed", () => {
    const g = (field: GoneDefault["field"], why: GoneDefault["why"], name: string | null): GoneDefault => ({ field, id: "x1", name, why });
    expect(
      [g("who", "removed", "Dana Lee"), g("who", "removed", null), g("group", "trashed", "Commission"), g("group", "missing", "Commission"), g("group", "missing", null), g("group", "notGroup", "Mirror"), g("group", "notGroup", null), g("step", "deleted", "Review"), g("step", "deleted", null), g("step", "completes", "Done")].map((x) =>
        goneText(x, "Now"),
      ),
    ).toEqual([
      "The default assignee “Dana Lee” was removed from people. New items are unassigned until you choose another.",
      "The default assignee was removed from people. New items are unassigned until you choose another.",
      "The group “Commission” is in the Trash. Board + adds to the plan root until you choose another.",
      "The group “Commission” was deleted. Board + adds to the plan root until you choose another.",
      "The default group was deleted. Board + adds to the plan root until you choose another.",
      "“Mirror” is not a group. Board + adds to the plan root until you choose another.",
      "The default group names an item that is not a group. Board + adds to the plan root until you choose another.",
      "The step “Review” was deleted. New undated items go to “Now” until you choose another.",
      "The default step was deleted. New undated items go to “Now” until you choose another.",
      "“Done” completes items. New undated items go to “Now” until you choose another.",
    ]);
    expect(goneText(g("step", "deleted", "Review"), null)).toBe(`The step “Review” was deleted. ${refusal.noOpenStep}`);
  });

  it("disables every control when the plan is read-only", async () => {
    const t = await made();
    bySteps(t);
    const { host } = mount(t.session, true);
    const controls = [...host.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")];
    expect([controls.length, controls.filter((c) => !c.disabled).map((c) => c.className)]).toEqual([8, []]);
    expect(durField().value).toBe("3");
  });
});

describe("Settings > Defaults on iPad", () => {
  interface Sent {
    token: string;
    sections: { title: string | null; rows: { id: string; title: string; checked: boolean }[] }[];
  }
  const lastAsk = (): Sent => {
    const sent = tauri.calls.filter((c) => c.cmd === "menu_show").map((c) => (c.args as { menu: Sent }).menu);
    const last = sent[sent.length - 1];
    if (last === undefined) throw new Error("no menu_show was sent");
    return last;
  };
  const chooseNative = (id: string): void => {
    const { token } = lastAsk();
    act(() => {
      emitFromRust("menu-ended", { token });
      emitFromRust("menu-chosen", { token, id });
    });
  };
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      await new Promise<void>((r) => setTimeout(r, 0));
    });
  };

  it("sends each picker's rows to the native pull-down menu, checked, and a choice writes", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const t = await made();
      const ids = addCrew(t);
      bySteps(t);
      mount(t.session);
      const apply = vi.spyOn(t.session, "apply");
      openPick("who");
      await settle();
      expect([document.querySelector(".context-menu"), lastAsk().sections.map((s) => [s.title, s.rows.map((r) => [r.id, r.title, r.checked])])]).toEqual([
        null,
        [
          [
            null,
            [
              ["none", "Nobody", true],
              [`person:${ids.MO}`, "Mira Okafor", false],
              [`person:${ids.OB}`, "Ole Berg", false],
            ],
          ],
        ],
      ]);
      chooseNative(`person:${ids.MO}`);
      openPick("group");
      await settle();
      expect(lastAsk().sections.flatMap((s) => s.rows.map((r) => r.title))).toEqual(["Plan root", "Dome", "Commission", "Commission › Mirror cell"]);
      chooseNative("group:g3");
      openPick("step");
      await settle();
      expect(lastAsk().sections.flatMap((s) => s.rows.map((r) => [r.id, r.checked]))).toEqual([
        ["first", true],
        ["step:now", false],
        ["step:next", false],
        ["step:later", false],
      ]);
      chooseNative("step:later");
      expect(apply.mock.calls).toEqual([[{ t: "defaults", field: "who", value: ids.MO }], [{ t: "defaults", field: "group", value: "g3" }], [{ t: "defaults", field: "step", value: "later" }]]);
    } finally {
      unstub();
    }
  });

  it("on iPhone also sends every picker to the native pull-down menu and draws no web menu", async () => {
    resetTauri({});
    setPlatform(IPHONE);
    const unstub = stubVisualViewport();
    try {
      const t = await made();
      const ids = addCrew(t);
      bySteps(t);
      mount(t.session);
      const apply = vi.spyOn(t.session, "apply");
      const asked = async (field: "who" | "group" | "step"): Promise<[Element | null, (string | boolean)[][]]> => {
        openPick(field);
        await settle();
        return [document.querySelector(".context-menu"), lastAsk().sections.flatMap((s) => s.rows.map((r) => [r.title, r.checked]))];
      };
      const who = await asked("who");
      chooseNative(`person:${ids.OB}`);
      const group = await asked("group");
      chooseNative("root");
      const step = await asked("step");
      chooseNative("step:now");
      expect([who, group, step]).toEqual([
        [
          null,
          [
            ["Nobody", true],
            ["Mira Okafor", false],
            ["Ole Berg", false],
          ],
        ],
        [
          null,
          [
            ["Plan root", true],
            ["Dome", false],
            ["Commission", false],
            ["Commission › Mirror cell", false],
          ],
        ],
        [
          null,
          [
            ["First open step", true],
            ["Now", false],
            ["Review", false],
            ["Later", false],
          ],
        ],
      ]);
      expect(apply.mock.calls).toEqual([[{ t: "defaults", field: "who", value: ids.OB }], [{ t: "defaults", field: "step", value: "now" }]]);
    } finally {
      unstub();
    }
  });
});
