import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Built } from "../../actions/intents";
import { childrenOf } from "../../plan/project";
import { READ_ONLY, type HistoryEntry, type PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { fs, MESA_SEED, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { themed } from "../../test/theme";
import { shellFor } from "../../test/shell";
import { CHOICE_TITLE } from "../choices/pick";
import { clearToasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { UiContext, useUi, type UiState } from "../state";
import { historyTime, revertText } from "./historyText";
import { groupOptions, ItemPanel } from "./ItemPanel";
import { withSync } from "../../test/withSync";
import { IPAD, LINUX, MAC, setPlatform } from "../../test/platform";
import { LOG_STYLE } from "../../domain/dates";

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

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
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

const select = (id: string | null): void => act(() => uiNow()[1]({ selected: id }));

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const all = (sel: string, root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

const panel = (): HTMLElement => one('[data-slot="panel"]');
const inPanel = () => within(panel());

const input = (label: string): HTMLInputElement => {
  const el = inPanel().getByLabelText(label);
  if (!(el instanceof HTMLInputElement)) throw new Error(label + " is not an input");
  return el;
};

const headName = (): HTMLInputElement => {
  const el = document.querySelector('.plan-head input[aria-label="Plan name"]');
  if (!(el instanceof HTMLInputElement)) throw new Error("no Plan name field in the heading");
  return el;
};

const selectOf = (label: string): HTMLSelectElement => {
  const el = inPanel().getByLabelText(label);
  if (!(el instanceof HTMLSelectElement)) throw new Error(label + " is not a select");
  return el;
};

const button = (name: string | RegExp): HTMLButtonElement => {
  const el = inPanel().getByRole("button", { name });
  if (!(el instanceof HTMLButtonElement)) throw new Error("no button " + String(name));
  return el;
};

const noButton = (name: string | RegExp): void => {
  expect([String(name), inPanel().queryAllByRole("button", { name })]).toEqual([String(name), []]);
};

const click = (el: Element): void => {
  act(() => {
    fireEvent.click(el);
  });
};

const edit = (el: HTMLInputElement, value: string, end: "Enter" | "blur"): void => {
  act(() => {
    el.focus();
    fireEvent.change(el, { target: { value } });
  });
  act(() => {
    if (end === "Enter") fireEvent.keyDown(el, { key: "Enter" });
    else el.blur();
  });
};

const choose = (el: HTMLSelectElement, value: string): void => {
  act(() => {
    fireEvent.change(el, { target: { value } });
  });
};

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const pointer = (el: Element, kind: "down" | "up", x: number): void => {
  const init = { clientX: x, clientY: 0, button: 0, pointerId: 1, pointerType: "mouse" };
  act(() => {
    if (kind === "down") fireEvent.pointerDown(el, init);
    else fireEvent.pointerUp(el, init);
  });
};

const tap = (el: Element): void => {
  pointer(el, "down", 10);
  pointer(el, "up", 11);
};

const builtOf = (spy: MockInstance<PlanSession["revert"]>, i: number): Built => {
  const r = spy.mock.results[i];
  if (r === undefined || r.type !== "return") throw new Error("no result " + i);
  return r.value;
};

const ITEM_SEED: SeedItem[] = [
  { name: "W", start: "2026-11-10", dur: 2 },
  { name: "X", start: "2026-11-16", dur: 3, status: "doing", progress: 40, deps: [fs("W")] },
  { name: "M", kind: "milestone", start: "2026-11-23", deps: [fs("X")] },
  { name: "U" },
  { name: "One", start: "2026-11-10", dur: 1 },
];

describe("ItemPanel fields", () => {
  it("renames on Enter and on blur, once, and keeps the old name for an empty one", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    edit(input("Name"), "Build", "Enter");
    act(() => input("Name").blur());
    expect(apply.mock.calls).toEqual([[{ t: "rename", item: "X", name: "Build" }]]);
    expect(t.session.view().plan.items.get("X")?.name).toBe("Build");
    edit(input("Name"), "Ship", "blur");
    expect(apply.mock.calls[1]).toEqual([{ t: "rename", item: "X", name: "Ship" }]);
    clearToasts();
    edit(input("Name"), "   ", "Enter");
    expect(toastTexts()).toEqual(["The name is empty. Type at least one character."]);
    expect(input("Name").value).toBe("Ship");
    expect(t.session.view().plan.items.get("X")?.name).toBe("Ship");
  });

  it("schedules a new start and the End field follows it", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    expect(input("Start").value).toBe("2026-11-16");
    expect(input("End").value).toBe("2026-11-18");
    const apply = vi.spyOn(t.session, "apply");
    edit(input("Start"), "2026-11-17", "blur");
    expect(apply.mock.calls).toEqual([[{ t: "schedule", item: "X", set: { start: "2026-11-17" } }]]);
    expect(input("End").value).toBe("2026-11-19");
  });

  it("types an end date as one resize, and refuses a day before the start or a day off with copy", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    expect([input("End").min, input("End").max]).toEqual(["2026-11-16", "2040-11-09"]);
    const apply = vi.spyOn(t.session, "apply");
    edit(input("End"), "2026-11-20", "Enter");
    expect(apply.mock.calls).toEqual([[{ t: "resize", item: "X", dur: 5 }]]);
    expect([t.session.view().plan.items.get("X")?.schedule?.dur, input("Duration").value, input("End").value]).toEqual([5, "5", "2026-11-20"]);
    expect(document.activeElement).not.toBe(input("End"));
    clearToasts();
    edit(input("End"), "2026-11-13", "Enter");
    expect(toastTexts()).toEqual(["The end cannot come before the start, 16 Nov."]);
    expect(input("End").value).toBe("2026-11-20");
    clearToasts();
    edit(input("End"), "2026-11-21", "blur");
    expect(toastTexts()).toEqual(["21 Nov is not a working day. Pick a working day for the end."]);
    expect(input("End").value).toBe("2026-11-20");
    edit(input("End"), "", "blur");
    expect(input("End").value).toBe("2026-11-20");
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("lets the End field hold an end past 2199 that the longest task allows", async () => {
    const t = await made([{ id: "Late", name: "Late", start: "2199-06-03", dur: 400 }]);
    render(
      themed(
        <OpenChoice.Provider value={vi.fn()}>
          <UiContext.Provider
            value={{
              ui: { plan: null, view: "timeline", zoom: "W", selected: "Late", collapsed: new Set(), baseline: null, dialog: null, reveal: null, follow: null, naming: null, settings: null, settingsRow: null, settingsRoot: false, syncPane: null, sidebarOpen: true, sidebarWidth: null, query: "", searchAsk: 0, columnsAsk: 0 },
              setUi: vi.fn(),
            }}
          >
            <ItemPanel session={t.session} item="Late" local="Mac" command={true} naming={false} onNamed={() => undefined} />
          </UiContext.Provider>
        </OpenChoice.Provider>,
      ),
    );
    const end = document.querySelector('input[aria-label="End"]');
    if (!(end instanceof HTMLInputElement)) throw new Error("no End field");
    expect([end.value, end.min, end.max]).toEqual(["2200-12-12", "2199-06-03", "2213-05-28"]);
  });

  it("shows no End field on an unscheduled task or a milestone", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("U");
    expect(inPanel().queryByLabelText("End")).toBeNull();
    expect(panel().textContent).toContain("End—");
    select("M");
    expect(inPanel().queryByLabelText("End")).toBeNull();
  });

  it("types a duration as one resize, keeps the steppers, and refuses a broken or out-of-range one", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    expect([input("Duration").type, input("Duration").min, input("Duration").max, input("Duration").value]).toEqual(["number", "1", "3650", "3"]);
    const apply = vi.spyOn(t.session, "apply");
    edit(input("Duration"), "7", "Enter");
    expect(apply.mock.calls).toEqual([[{ t: "resize", item: "X", dur: 7 }]]);
    expect(input("End").value).toBe("2026-11-24");
    click(button("Longer by one working day"));
    expect(apply.mock.calls[1]).toEqual([{ t: "resize", item: "X", dur: 8 }]);
    expect(input("Duration").value).toBe("8");
    clearToasts();
    edit(input("Duration"), "2.5", "Enter");
    expect(toastTexts()).toEqual(["A duration is a whole number of working days."]);
    expect(input("Duration").value).toBe("8");
    clearToasts();
    edit(input("Duration"), "4000", "blur");
    expect(toastTexts()).toEqual(["A task lasts 1 to 3650 working days."]);
    expect(input("Duration").value).toBe("8");
    clearToasts();
    edit(input("Duration"), "", "blur");
    edit(input("Duration"), "08", "blur");
    expect([input("Duration").value, toastTexts()]).toEqual(["8", []]);
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it("toasts and writes nothing when the browser holds a duration or lag it cannot read as a number", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    const unreadable = (el: HTMLInputElement): HTMLInputElement => {
      Object.defineProperty(el, "validity", { configurable: true, value: { badInput: true } });
      return el;
    };
    clearToasts();
    edit(unreadable(input("Duration")), "", "Enter");
    expect([input("Duration").value, toastTexts()]).toEqual(["3", ["A duration is a whole number of working days."]]);
    clearToasts();
    const lag = within(one('[data-dep="W"]', panel())).getByRole("spinbutton", { name: "Lag" });
    if (!(lag instanceof HTMLInputElement)) throw new Error("no lag field");
    expect([input("Duration").getAttribute("inputmode"), lag.type, lag.getAttribute("inputmode")]).toEqual(["numeric", "number", null]);
    edit(unreadable(lag), "", "blur");
    expect([lag.value, toastTexts()]).toEqual(["0", ["Lag must be a whole number of working days."]]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("toasts and writes nothing when the browser holds a start date it cannot read", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    const before = input("Start").value;
    Object.defineProperty(input("Start"), "validity", { configurable: true, value: { badInput: true } });
    clearToasts();
    edit(input("Start"), "", "Enter");
    expect([input("Start").value, toastTexts()]).toEqual([before, ["The date is not complete. Enter a day, month and year."]]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("toasts every unreadable start of an unscheduled item, once per Enter, and puts the field back to empty", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("U");
    const apply = vi.spyOn(t.session, "apply");
    const start = input("Start");
    expect(start.value).toBe("");
    Object.defineProperty(start, "validity", { configurable: true, value: { badInput: true } });
    const partial = (): void => {
      act(() => {
        start.focus();
      });
      start.value = "2026-11";
    };
    const DATE = "The date is not complete. Enter a day, month and year.";
    act(() => clearToasts());
    partial();
    act(() => start.blur());
    expect([start.value, toastTexts()]).toEqual(["", [DATE]]);
    act(() => clearToasts());
    partial();
    act(() => start.blur());
    expect([start.value, toastTexts()]).toEqual(["", [DATE]]);
    act(() => clearToasts());
    partial();
    act(() => {
      fireEvent.keyDown(start, { key: "Enter" });
    });
    expect([start.value, toastTexts()]).toEqual(["", [DATE]]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("puts a typed duration back on Escape and writes nothing", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      input("Duration").focus();
      fireEvent.change(input("Duration"), { target: { value: "9" } });
    });
    act(() => {
      fireEvent.keyDown(input("Duration"), { key: "Escape" });
    });
    expect([input("Duration").value, document.activeElement === input("Duration"), uiNow()[0].selected]).toEqual(["3", false, "X"]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("bounds the Start field to the plan window and names a year that is not this year", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    expect([input("Start").min, input("Start").max]).toEqual(["1900-01-01", "2199-12-31"]);
    edit(input("Start"), "0026-11-16", "blur");
    expect(toastTexts()).toEqual(["Dates run from 1 Jan 1900 to 31 Dec 2199."]);
    expect(input("Start").value).toBe("2026-11-16");
    clearToasts();
    edit(input("Start"), "2027-11-16", "blur");
    expect(toastTexts()).toEqual(["Scheduled “X” from 16 Nov 2027; 1 dependent item moved."]);
    expect(input("End").value).toBe("2027-11-18");
  });

  it("never unschedules from the Start or Date field: an empty or malformed value puts the stored date back", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    edit(input("Start"), "", "blur");
    expect(input("Start").value).toBe("2026-11-16");
    edit(input("Start"), "16.11.2026", "blur");
    expect(input("Start").value).toBe("2026-11-16");
    edit(input("Start"), "", "Enter");
    expect(input("Start").value).toBe("2026-11-16");
    select("M");
    edit(input("Date"), "", "blur");
    expect(input("Date").value).toBe("2026-11-23");
    edit(input("Date"), "16.11.2026", "Enter");
    expect(input("Date").value).toBe("2026-11-23");
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
    expect(t.session.view().plan.items.get("X")?.schedule?.start).toBe("2026-11-16");
  });

  it("resizes by working days and stops − at 1", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    click(button("Longer by one working day"));
    expect(input("Duration").value).toBe("4");
    click(button("Shorter by one working day"));
    expect(apply.mock.calls).toEqual([[{ t: "resize", item: "X", dur: 4 }], [{ t: "resize", item: "X", dur: 3 }]]);
    select("One");
    expect([input("Duration").value, input("Duration").nextElementSibling?.textContent]).toEqual(["1", "working day"]);
    expect(button("Shorter by one working day").disabled).toBe(true);
    expect(button("Longer by one working day").disabled).toBe(false);
  });

  it("stops + at the longest task", async () => {
    const t = await made([{ id: "Long", name: "Long", start: "2026-11-16", dur: 3650 }]);
    await shown(t);
    select("Long");
    expect(button("Longer by one working day").disabled).toBe(true);
    expect(button("Shorter by one working day").disabled).toBe(false);
  });

  it("sets status from three options and progress in steps of 5", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const status = selectOf("Status");
    expect([...status.options].map((o) => o.textContent)).toEqual(["Not started", "In progress", "Done"]);
    expect(status.value).toBe("doing");
    const progress = input("Progress");
    expect([progress.type, progress.step, progress.value]).toEqual(["range", "5", "40"]);
    const apply = vi.spyOn(t.session, "apply");
    choose(status, "done");
    act(() => {
      input("Progress").focus();
      fireEvent.change(input("Progress"), { target: { value: "45" } });
    });
    expect(panel().textContent).toContain("45 %");
    act(() => input("Progress").blur());
    expect(apply.mock.calls).toEqual([
      [{ t: "schedule", item: "X", set: { status: "done" } }],
      [{ t: "schedule", item: "X", set: { progress: 45 } }],
    ]);
  });

  it("moves the progress draft with arrow keys and writes once on blur", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    act(() => input("Progress").focus());
    [45, 50, 55].forEach((v) =>
      act(() => {
        fireEvent.keyDown(input("Progress"), { key: "ArrowRight" });
        fireEvent.change(input("Progress"), { target: { value: String(v) } });
        fireEvent.keyUp(input("Progress"), { key: "ArrowRight" });
      }),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(panel().textContent).toContain("55 %");
    act(() => input("Progress").blur());
    expect(apply.mock.calls).toEqual([[{ t: "schedule", item: "X", set: { progress: 55 } }]]);
    expect(t.session.history()).toHaveLength(2);
  });

  it("puts the slider back and toasts once when the progress write is refused", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    vi.spyOn(t.session, "readOnlyReason", "get").mockReturnValue(READ_ONLY);
    act(() => {
      input("Progress").focus();
      fireEvent.change(input("Progress"), { target: { value: "70" } });
    });
    act(() => {
      fireEvent.pointerUp(input("Progress"));
    });
    expect(input("Progress").value).toBe("40");
    expect(panel().textContent).toContain("40 %");
    act(() => input("Progress").blur());
    act(() => {
      fireEvent.keyDown(input("Progress"), { key: "Enter" });
    });
    expect(toastTexts()).toEqual([READ_ONLY]);
    expect(apply).not.toHaveBeenCalled();
    expect(t.session.view().plan.items.get("X")?.schedule?.progress).toBe(40);
  });

  it("shows a milestone without duration, its status derived from its predecessors", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("M");
    expect(inPanel().queryByText("Duration")).toBeNull();
    expect(inPanel().queryByText("Progress")).toBeNull();
    expect(inPanel().getByText("Date")).not.toBeNull();
    expect(panel().textContent).toContain("open · from its predecessors");
    expect(inPanel().queryByLabelText("Status")).toBeNull();
    act(() => {
      t.session.apply({ t: "schedule", item: "W", set: { status: "done" } });
      t.session.apply({ t: "schedule", item: "X", set: { status: "done" } });
    });
    expect(panel().textContent).toContain("reached · from its predecessors");
  });

  it("deletes the item", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("U");
    const apply = vi.spyOn(t.session, "apply");
    click(button("Delete"));
    expect(apply.mock.calls).toEqual([[{ t: "trash", items: ["U"] }]]);
  });
});

describe("ItemPanel links", () => {
  it("changes a predecessor's type and lag, one link each, and removes it", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("X");
    const row = one('[data-dep="W"]', panel());
    expect(within(row).getByText("W")).not.toBeNull();
    const type = within(row).getByLabelText("Dependency type");
    if (!(type instanceof HTMLSelectElement)) throw new Error("no type select");
    expect([...type.options].map((o) => o.value)).toEqual(["FS", "SS", "FF", "SF"]);
    const lag = (): HTMLInputElement => {
      const el = within(one('[data-dep="W"]', panel())).getByRole("spinbutton", { name: "Lag" });
      if (!(el instanceof HTMLInputElement)) throw new Error("no lag field");
      return el;
    };
    expect([lag().value, lag().min, lag().max]).toEqual(["0", "-1000", "1000"]);
    const apply = vi.spyOn(t.session, "apply");
    choose(type, "SS");
    click(within(one('[data-dep="W"]', panel())).getByRole("button", { name: "More lag" }));
    expect(lag().value).toBe("1");
    click(within(one('[data-dep="W"]', panel())).getByRole("button", { name: "Less lag" }));
    click(within(one('[data-dep="W"]', panel())).getByRole("button", { name: "Less lag" }));
    expect(lag().value).toBe("-1");
    edit(lag(), "3", "Enter");
    clearToasts();
    edit(lag(), "1001", "Enter");
    expect(toastTexts()).toEqual(["A lag is at most 1000 working days either way."]);
    expect(lag().value).toBe("3");
    edit(lag(), "-2", "blur");
    click(within(one('[data-dep="W"]', panel())).getByRole("button", { name: "Remove dependency" }));
    expect(apply.mock.calls).toEqual([
      [{ t: "link", from: "W", to: "X", type: "SS", lag: 0 }],
      [{ t: "link", from: "W", to: "X", type: "SS", lag: 1 }],
      [{ t: "link", from: "W", to: "X", type: "SS", lag: 0 }],
      [{ t: "link", from: "W", to: "X", type: "SS", lag: -1 }],
      [{ t: "link", from: "W", to: "X", type: "SS", lag: 3 }],
      [{ t: "link", from: "W", to: "X", type: "SS", lag: 1001 }],
      [{ t: "link", from: "W", to: "X", type: "SS", lag: -2 }],
      [{ t: "unlink", link: "W>X" }],
    ]);
    expect(panel().querySelector("[data-dep]")).toBeNull();
  });

  it("offers only dependencies that close no loop, and lists successors as Needed by", async () => {
    const t = await made(ITEM_SEED);
    await shown(t);
    select("W");
    const add = selectOf("Add a dependency");
    expect([...add.options].map((o) => o.textContent)).toEqual(["+ Add a dependency…", "U", "One"]);
    expect(one('[data-succ="X"]', panel()).textContent).toBe("XFS");
    expect(inPanel().getByText("Needed by")).not.toBeNull();
    const apply = vi.spyOn(t.session, "apply");
    choose(add, "U");
    expect(apply.mock.calls).toEqual([[{ t: "link", from: "U", to: "W", type: "FS", lag: 0 }]]);
    expect(selectOf("Add a dependency").value).toBe("");
    expect(one('[data-dep="U"]', panel())).not.toBeNull();
    select("M");
    expect(panel().querySelector("[data-succ]")).toBeNull();
    expect(inPanel().queryByText("Needed by")).toBeNull();
  });
});

describe("the note", () => {
  const typeInto = (el: HTMLTextAreaElement, value: string): void => {
    act(() => {
      el.value = value;
      el.setSelectionRange(value.length, value.length);
      fireEvent.input(el);
    });
  };

  it.each([{ metaKey: true }, { ctrlKey: true }])("undoes its own typing on %o with the note focused, never the session", async (mod) => {
    const t = await made([{ name: "A", start: "2026-11-10", note: "abc" }]);
    await shown(t);
    select("A");
    const note = inPanel().getByLabelText("Notes");
    if (!(note instanceof HTMLTextAreaElement)) throw new Error("no note");
    expect(note.value).toBe("abc");
    const undo = vi.spyOn(t.session, "undo");
    act(() => note.focus());
    typeInto(note, "abcd");
    expect(t.session.note("A").toString()).toBe("abcd");
    act(() => {
      fireEvent.keyDown(note, { key: "z", ...mod });
    });
    expect(t.session.note("A").toString()).toBe("abc");
    expect(note.value).toBe("abc");
    act(() => {
      fireEvent.keyDown(note, { key: "z", shiftKey: true, ...mod });
    });
    expect(note.value).toBe("abcd");
    expect(undo).not.toHaveBeenCalled();
  });

  it("on an iPad, ⌘Z and ⇧⌘Z in the focused note undo its own typing and never run the plan's undo, and Ctrl+Y is not redo", async () => {
    setPlatform(IPAD);
    const t = await made([{ name: "A", start: "2026-11-10", note: "abc" }]);
    render(withSync(shellFor(t, { device: { deviceId: "ipad", name: "iPad", platform: "ios" } }).ui));
    await settle();
    select("A");
    const note = inPanel().getByLabelText("Notes");
    if (!(note instanceof HTMLTextAreaElement)) throw new Error("no note");
    const undo = vi.spyOn(t.session, "undo");
    const redo = vi.spyOn(t.session, "redo");
    act(() => note.focus());
    typeInto(note, "abcd");
    act(() => {
      fireEvent.keyDown(note, { key: "z", metaKey: true });
    });
    expect(note.value).toBe("abc");
    act(() => {
      fireEvent.keyDown(note, { key: "z", metaKey: true, shiftKey: true });
    });
    expect(note.value).toBe("abcd");
    act(() => {
      fireEvent.keyDown(note, { key: "z", ctrlKey: true });
    });
    expect(note.value).toBe("abc");
    act(() => {
      fireEvent.keyDown(note, { key: "y", ctrlKey: true });
    });
    expect(note.value).toBe("abc");
    expect(t.session.note("A").toString()).toBe("abc");
    expect([undo.mock.calls.length, redo.mock.calls.length]).toEqual([0, 0]);
  });

  it.each([
    ["linux", "abcd"],
    ["macos", "abc"],
  ] as const)("on %s, Ctrl+Y in the focused note leaves the note at %s", async (platform, after) => {
    setPlatform(platform === "linux" ? LINUX : MAC);
    const t = await made([{ name: "A", start: "2026-11-10", note: "abc" }]);
    render(withSync(shellFor(t, { device: { deviceId: "mac", name: "Mac", platform } }).ui));
    await settle();
    select("A");
    const note = inPanel().getByLabelText("Notes");
    if (!(note instanceof HTMLTextAreaElement)) throw new Error("no note");
    const redo = vi.spyOn(t.session, "redo");
    act(() => note.focus());
    typeInto(note, "abcd");
    act(() => {
      fireEvent.keyDown(note, { key: "z", ctrlKey: true });
    });
    expect(note.value).toBe("abc");
    act(() => {
      fireEvent.keyDown(note, { key: "y", ctrlKey: true });
    });
    expect(note.value).toBe(after);
    expect(t.session.note("A").toString()).toBe(after);
    expect(redo).not.toHaveBeenCalled();
  });
});

describe("no-op edits (refinement 36)", () => {
  it("fires nothing for an unchanged name, plan name or start, and one rename for a new name", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    await shown(t);
    const apply = vi.spyOn(t.session, "apply");
    act(() => headName().focus());
    act(() => headName().blur());
    edit(headName(), "  Plan  ", "Enter");
    select("A");
    act(() => input("Name").focus());
    act(() => input("Name").blur());
    edit(input("Name"), "  A  ", "Enter");
    edit(input("Start"), "2026-11-10", "blur");
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
    expect(input("Name").value).toBe("A");
    edit(input("Name"), "B", "Enter");
    expect(apply.mock.calls).toEqual([[{ t: "rename", item: "A", name: "B" }]]);
  });
});

describe("group progress (spec §6.2)", () => {
  it("reads the duration-weighted progress of a group as text", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    select("g1");
    expect(inPanel().getByText("Progress 94 %")).not.toBeNull();
    expect(panel().querySelector('input[type="range"]')).toBeNull();
    select("g3");
    expect(inPanel().getByText("Progress 26 %")).not.toBeNull();
    expect(panel().querySelector('input[type="range"]')).toBeNull();
  });

  it("shows no progress for a group holding only a milestone", async () => {
    const t = await made([
      { name: "G", kind: "group" },
      { name: "m", kind: "milestone", parent: "G", start: "2026-11-10" },
    ]);
    await shown(t);
    select("G");
    expect(panel().textContent).toContain("GROUP");
    expect(panel().textContent).not.toMatch(/Progress/);
  });
});

describe("groups and order", () => {
  const SEED: SeedItem[] = [
    { name: "G", kind: "group" },
    { name: "H", kind: "group", parent: "G" },
    { name: "X", start: "2026-11-10", dur: 2 },
    { name: "Y", start: "2026-11-11", dur: 2 },
    { name: "Z", start: "2026-11-12", dur: 2 },
    { name: "U" },
  ];
  const top = (t: TestSession): string[] => childrenOf(t.session.view().plan, null).map((i) => i.id);

  it("offers every other group by its path, after Top level", async () => {
    const t = await made(SEED);
    const plan = t.session.view().plan;
    expect(groupOptions(plan, "G").map((o) => o.label)).toEqual(["Top level"]);
    expect(groupOptions(plan, "H").map((o) => o.label)).toEqual(["Top level", "G"]);
    expect(groupOptions(plan, "X").map((o) => o.label)).toEqual(["Top level", "G", "G › H"]);
    expect(groupOptions(plan, "X").map((o) => o.id)).toEqual([null, "G", "H"]);
    act(() => {
      t.session.apply({ t: "trash", items: ["H"] });
    });
    expect(groupOptions(t.session.view().plan, "X").map((o) => o.label)).toEqual(["Top level", "G"]);
  });

  it("moves into a group, back to the top level, and up and down among siblings", async () => {
    const t = await made(SEED.filter((s) => s.name !== "U"));
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    expect([...selectOf("Group").options].map((o) => o.textContent)).toEqual(["Top level", "G", "G › H"]);
    choose(selectOf("Group"), "G");
    expect(apply.mock.calls).toEqual([[{ t: "place", item: "X", parent: "G", after: "H" }]]);
    expect(t.session.history()[0].label).toBe("Moved “X” into “G”");
    choose(selectOf("Group"), "");
    expect(apply.mock.calls[1]).toEqual([{ t: "place", item: "X", parent: null, after: "Z" }]);
    expect(t.session.history()[0].label).toBe("Moved “X” to the top level");
    expect(top(t)).toEqual(["G", "Y", "Z", "X"]);
    select("Z");
    click(button("Move up"));
    expect(apply.mock.calls[2]).toEqual([{ t: "place", item: "Z", parent: null, after: "G" }]);
    expect(t.session.history()[0].label).toBe("Reordered “Z”");
    expect(top(t)).toEqual(["G", "Z", "Y", "X"]);
    click(button("Move down"));
    expect(apply.mock.calls[3]).toEqual([{ t: "place", item: "Z", parent: null, after: "Y" }]);
    expect(top(t)).toEqual(["G", "Y", "Z", "X"]);
    select("G");
    expect(button("Move up").disabled).toBe(true);
    expect(button("Move down").disabled).toBe(false);
    select("X");
    expect(button("Move down").disabled).toBe(true);
    expect(button("Move up").disabled).toBe(false);
    expect(apply).toHaveBeenCalledTimes(4);
  });

  it("moves up to first place with after null", async () => {
    const t = await made(SEED.filter((s) => s.name !== "U"));
    await shown(t);
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    click(button("Move up"));
    expect(apply.mock.calls).toEqual([[{ t: "place", item: "X", parent: null, after: null }]]);
    expect(top(t)).toEqual(["X", "G", "Y", "Z"]);
  });

  it("unschedules a scheduled item into the tray, and offers it on nothing else", async () => {
    const t = await made(SEED);
    await shown(t);
    const before = Number(one(".tray-title").textContent?.replace(/\D+/g, ""));
    expect(document.querySelector('[data-row="X"]')).not.toBeNull();
    select("X");
    const apply = vi.spyOn(t.session, "apply");
    click(button("Unschedule"));
    expect(apply.mock.calls).toEqual([[{ t: "schedule", item: "X", set: { start: null } }]]);
    expect(t.session.history()[0].label).toBe("Unscheduled “X”");
    expect(document.querySelector('[data-row="X"]')).toBeNull();
    expect(one(".tray-title").textContent).toBe(`Unscheduled · ${before + 1}`);
    expect(one('[data-chip="X"]').textContent).toBe("X");
    noButton("Unschedule");
    select("G");
    noButton("Unschedule");
    select("U");
    noButton("Unschedule");
  });
});

describe("ItemPanel read-only", () => {
  it("swaps every field for its value and drops every writing button without a remount", async () => {
    const t = await made([
      { name: "W", start: "2026-11-10", dur: 2 },
      { name: "X", start: "2026-11-16", dur: 3, status: "doing", progress: 40, deps: [fs("W")] },
    ]);
    await shown(t);
    select("X");
    const selected = (s: HTMLSelectElement): string => s.options[s.selectedIndex].textContent ?? "";
    const row = one('[data-dep="W"]', panel());
    const typeSelect = within(row).getByLabelText("Dependency type");
    if (!(typeSelect instanceof HTMLSelectElement)) throw new Error("no type");
    const values = [
      input("Name").value,
      input("Start").value,
      "3 working days",
      selected(selectOf("Status")),
      "40 %",
      selected(selectOf("Group")),
      selected(typeSelect),
      "0d",
    ];
    expect(values).toEqual(["X", "2026-11-16", "3 working days", "In progress", "40 %", "Top level", "FS", "0d"]);
    expect([input("Duration").value, input("End").value, within(row).getByRole("spinbutton", { name: "Lag" }) instanceof HTMLInputElement]).toEqual(["3", "2026-11-18", true]);
    expect(panel().textContent).toContain("40 %");
    const note = inPanel().getByLabelText("Notes");
    const apply = vi.spyOn(t.session, "apply");
    act(() => t.session.setReadOnly(true));
    expect(inPanel().getByLabelText("Notes")).toBe(note);
    expect(panel().querySelectorAll("input, select")).toHaveLength(0);
    ["−", "+", "×"].forEach((text) => expect([text, all("button", panel()).filter((b) => b.textContent === text)]).toEqual([text, []]));
    ["Move up", "Move down", "Unschedule", "Remove dependency", "Delete"].forEach(noButton);
    expect(panel().textContent).not.toContain("+ Add a dependency…");
    values.forEach((v) => expect([v, panel().textContent?.includes(v)]).toEqual([v, true]));
    expect(note instanceof HTMLTextAreaElement && note.readOnly).toBe(true);
    act(() => {
      fireEvent.keyDown(inPanel().getByLabelText("Name"), { key: "Enter" });
    });
    all(".detail-body button", panel()).forEach(click);
    expect(apply).not.toHaveBeenCalled();
    act(() => t.session.setReadOnly(false));
    expect(input("Name").value).toBe("X");
    expect(selectOf("Status").value).toBe("doing");
    expect(button("Delete")).not.toBeNull();
  });
});

describe("ItemPanel on a trashed item", () => {
  it("shows the ghost row of a delete choice as text with no writing control", async () => {
    const { t, p } = await deleteClash();
    sessions.push(t.session, p.session);
    await shown(t);
    select("A");
    expect(uiNow()[0].selected).toBe("A");
    expect(panel().querySelectorAll("input, select")).toHaveLength(0);
    expect(all(".detail-body button", panel()).map((b) => b.textContent)).toEqual(["Choose"]);
    expect(inPanel().getByLabelText("Name").textContent).toBe("Renamed");
    const note = inPanel().getByLabelText("Notes");
    expect(note instanceof HTMLTextAreaElement && note.readOnly).toBe(true);
    expect(panel().textContent).not.toContain("+ Add a dependency…");
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.keyDown(note, { key: "z", metaKey: true });
    });
    expect(toastTexts()).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("opens from every view (refinement 48)", () => {
  it("opens the item's panel from its bar, card, list row and tray chip", async () => {
    const t = await made(MESA_SEED);
    await shown(t);
    const opened = (id: string, name: string): void => {
      expect(uiNow()[0].selected).toBe(id);
      expect(input("Name").value).toBe(name);
      select(null);
      expect(inPanel().queryByLabelText("Name")).toBeNull();
    };
    expect(panel().querySelector(".panel h2")?.textContent).toBe("Plan");
    tap(one('[data-bar="t3"]'));
    opened("t3", "Tracking: review results");
    tap(one('[data-chip="u1"]'));
    opened("u1", "Kids star parties");
    click(screen.getByRole("tab", { name: "Board" }));
    tap(one('[data-card="t3"]'));
    opened("t3", "Tracking: review results");
    click(screen.getByRole("tab", { name: "List" }));
    tap(one('[data-lrow="t3"]'));
    opened("t3", "Tracking: review results");
  });
});

describe("PlanPanel", () => {
  const stat = (k: string): HTMLElement => one(`[data-stat="${k}"]`, panel());

  it("summary counts, span, progress; rows open History and Trash and return", async () => {
    const t = await made([
      { id: "G", name: "G", kind: "group" },
      { id: "a", name: "a", parent: "G", start: "2026-11-10", dur: 2, status: "done", progress: 100 },
      { id: "b", name: "b", parent: "G", start: "2026-11-12", dur: 2, status: "doing", progress: 40 },
      { id: "T", name: "T", start: "2026-11-20", dur: 3, status: "doing", progress: 10 },
      { id: "M", name: "M", kind: "milestone", start: "2026-12-01" },
      { id: "U", name: "U", kind: "milestone" },
      { id: "K", name: "K", start: "2026-11-10", dur: 1 },
    ]);
    act(() => {
      t.session.apply({ t: "trash", items: ["K"] });
    });
    await shown(t);
    const summary = one(".panel.plan-summary", panel());
    expect([one("h2", summary).textContent, one(".summary-name", summary).textContent, one(".summary-span", summary).textContent, one(".summary-span", summary).classList.contains("mono")]).toEqual([
      "Plan",
      t.session.view().plan.name,
      "10 Nov – 1 Dec",
      true,
    ]);
    expect([one(".summary-progress", summary).textContent, one(".summary-bar > span", summary).style.width]).toEqual(["Progress 40 %", "40%"]);
    expect(["Items", "Done", "Unscheduled", "Late", "Held", "Conflicts", "Not started", "In progress"].map((k) => [k, stat(k).textContent])).toEqual([
      ["Items", "5"],
      ["Done", "1"],
      ["Unscheduled", "1"],
      ["Late", "0"],
      ["Held", "0"],
      ["Conflicts", "0"],
      ["Not started", "2"],
      ["In progress", "2"],
    ]);
    const rows = all("button.summary-row", summary);
    expect(rows.map((r) => [r.dataset.summaryRow, one(".summary-row-label", r).textContent, one(".summary-row-count, .summary-row-value", r).textContent, r instanceof HTMLButtonElement && r.disabled])).toEqual([
      ["working-time", "Working time", "No holiday region · Mon–Fri · no closures", false],
      ["baselines", "Baselines", "0", false],
      ["history", "History", String(t.session.history().length), false],
      ["trash", "Trash", "1", false],
    ]);
    click(rows[2]);
    expect([panel().querySelector(".plan-summary .summary-row"), one(".summary-back", panel()).textContent, one(".panel h2", panel()).textContent, all(".history li", panel()).length]).toEqual([
      null,
      "‹ Plan",
      "History",
      t.session.history().length,
    ]);
    click(one(".summary-back", panel()));
    expect(all("button.summary-row", panel())).toHaveLength(4);
    click(one('button.summary-row[data-summary-row="trash"]', panel()));
    expect([one(".panel h2", panel()).textContent, all("[data-trashed]", panel()).map((r) => r.dataset.trashed)]).toEqual(["Trash", ["K"]]);
    click(within(one('[data-trashed="K"]', panel())).getByRole("button", { name: "Restore" }));
    const trashRow = one('button.summary-row[data-summary-row="trash"]', panel());
    expect([panel().querySelector(".summary-back"), one(".summary-row-count", trashRow).textContent, trashRow instanceof HTMLButtonElement && trashRow.disabled]).toEqual([null, "0", true]);
  });

  it("hands focus to the History row when restoring the last Trash item empties the page", async () => {
    const t = await made([
      { id: "K", name: "K", start: "2026-11-10", dur: 1 },
      { id: "L", name: "L", start: "2026-11-12", dur: 1 },
    ]);
    act(() => {
      t.session.apply({ t: "trash", items: ["K"] });
    });
    await shown(t);
    const historyRow = (): HTMLElement => one('button.summary-row[data-summary-row="history"]', panel());
    click(historyRow());
    expect(document.activeElement).toBe(one(".summary-back", panel()));
    click(one(".summary-back", panel()));
    expect(document.activeElement).toBe(historyRow());
    click(one('button.summary-row[data-summary-row="trash"]', panel()));
    const restore = within(one('[data-trashed="K"]', panel())).getByRole("button", { name: "Restore" });
    act(() => restore.focus());
    click(restore);
    expect([panel().querySelector(".summary-back"), document.activeElement]).toEqual([null, historyRow()]);
  });

  it("omits the span of a plan with nothing dated, and the progress of a plan without a task", async () => {
    const t = await made([{ name: "Gate", kind: "milestone" }, { name: "G", kind: "group" }]);
    await shown(t);
    expect([panel().querySelector(".summary-span"), panel().querySelector(".summary-progress"), stat("Items").textContent]).toEqual([null, null, "1"]);
  });

  it("counts items, done, unscheduled, late, held and conflicts", async () => {
    const t = await made(
      [
        { name: "L", start: "2026-11-02", dur: 2 },
        { name: "P", start: "2026-11-10", dur: 3, status: "doing" },
        { name: "C", start: "2026-11-11", dur: 1, deps: [fs("P")] },
        { name: "D", start: "2026-11-03", status: "done", progress: 100 },
        { name: "U" },
        { name: "G", kind: "group" },
        { name: "H", start: "2026-11-20", dur: 2 },
      ],
      {
        clashes: [{ unit: "s:H", mac: ["2026-11-20", 2, "todo", 0, "later"], iphone: ["2026-11-23", 2, "todo", 0, "later"] }],
      },
    );
    await shown(t);
    expect(t.session.view().held.size).toBe(1);
    const read = (k: string): [string, string | null, boolean, boolean] => [k, stat(k).textContent, stat(k).classList.contains("amber"), stat(k).classList.contains("magenta")];
    expect(["Items", "Done", "Unscheduled", "Late", "Held", "Conflicts"].map(read)).toEqual([
      ["Items", "6", false, false],
      ["Done", "1", false, false],
      ["Unscheduled", "1", false, false],
      ["Late", "1", true, false],
      ["Held", "1", true, false],
      ["Conflicts", "1", false, true],
    ]);
  });

  it("updates Late when the day rolls over, without a remount (Review Focus 3)", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    await shown(t);
    const before = stat("Late");
    expect([before.textContent, before.classList.contains("amber")]).toEqual(["0", false]);
    act(() => t.clock.set("2026-11-30"));
    expect(stat("Late")).toBe(before);
    expect([stat("Late").textContent, stat("Late").classList.contains("amber")]).toEqual(["1", true]);
  });

  it("summarises the plan's calendar in a Working time row that opens Settings at Working time, read-only too", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    await shown(t);
    const row = (): HTMLElement => one('button.summary-row[data-summary-row="working-time"]', panel());
    const value = one(".summary-row-value", row());
    expect([one(".summary-row-label", row()).textContent, value.textContent, value.title]).toEqual([
      "Working time",
      "No holiday region · Mon–Fri · no closures",
      "No holiday region · Mon–Fri · no closures",
    ]);
    expect([panel().querySelector(".plan-summary > h2 + .val-line"), all(".plan-summary h2", panel()).map((h) => h.textContent)]).toEqual([null, ["Plan"]]);
    noButton("Change calendar…");
    click(row());
    expect([uiNow()[0].settings, uiNow()[0].dialog, panel().querySelector(".summary-back")]).toEqual(["working-time", null, null]);
    act(() => uiNow()[1]({ settings: null }));
    act(() => t.session.setReadOnly(true));
    expect(row().hasAttribute("disabled")).toBe(false);
    click(row());
    expect(uiNow()[0].settings).toBe("working-time");
  });

  it("counts baselines in a summary row that opens Settings at Baselines, read-only too", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    act(() => {
      t.session.apply({ t: "baseline", op: "save", name: "Before" });
      t.session.apply({ t: "baseline", op: "save", name: "After" });
    });
    await shown(t);
    const row = (): HTMLElement => one('button.summary-row[data-summary-row="baselines"]', panel());
    expect([panel().querySelector("[data-baseline]"), panel().querySelector(".baselines"), one(".summary-row-count", row()).textContent]).toEqual([null, null, "2"]);
    ["Save baseline", "Show", "Remove"].forEach(noButton);
    click(row());
    expect([uiNow()[0].settings, panel().querySelector(".summary-back")]).toEqual(["baselines", null]);
    act(() => uiNow()[1]({ settings: null }));
    act(() => t.session.setReadOnly(true));
    expect(row().hasAttribute("disabled")).toBe(false);
    click(row());
    expect(uiNow()[0].settings).toBe("baselines");
  });

  it("lists what was trashed by its own unit and restores it", async () => {
    const t = await made([
      { name: "G", kind: "group" },
      { name: "in", parent: "G", start: "2026-11-10" },
      { name: "T", start: "2026-11-10" },
      { name: "K", start: "2026-11-10" },
    ]);
    act(() => {
      t.session.apply({ t: "trash", items: ["G"] });
      t.session.apply({ t: "trash", items: ["T"] });
    });
    await shown(t);
    click(one('button.summary-row[data-summary-row="trash"]', panel()));
    expect(all("[data-trashed]", panel()).map((r) => r.dataset.trashed)).toEqual(["G", "T"]);
    const apply = vi.spyOn(t.session, "apply");
    click(within(one('[data-trashed="T"]', panel())).getByRole("button", { name: "Restore" }));
    expect(apply.mock.calls).toEqual([[{ t: "restore", items: ["T"] }]]);
    expect(all("[data-trashed]", panel()).map((r) => r.dataset.trashed)).toEqual(["G"]);
  });
});

describe("History", () => {
  const SEED: SeedItem[] = [{ name: "A", start: "2026-11-10", dur: 3 }];
  const rows = (): HTMLElement[] => all(".history li", panel());
  const rowText = (li: HTMLElement): string | null => one(".hist-text", li).textContent;
  const dialogLines = (): (string | null)[] => all(".revert-text p", screen.getByRole("dialog")).map((p) => p.textContent);
  const shownHistory = async (t: TestSession): Promise<void> => {
    await shown(t);
    click(one('button.summary-row[data-summary-row="history"]', panel()));
  };

  it("lists newest first with time, device and label, dims inactive entries and has no button on the first", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "move", items: ["A"], days: 1 });
      t.session.apply({ t: "rename", item: "A", name: "B" });
      t.session.undo();
    });
    await shownHistory(t);
    const h = t.session.history();
    expect(rows().map((li) => li.dataset.action)).toEqual(h.map((e) => e.id));
    expect(rows().map(rowText)).toEqual(h.map((e) => `${historyTime(e.at, "2026-11-09", LOG_STYLE)} · Mac · ${e.label}`));
    expect(rows().map((li) => li.classList.contains("inactive"))).toEqual(h.map((e) => !e.active));
    expect(rows().map((li) => all("button", li).map((b) => [b.textContent, b.getAttribute("aria-label")]))).toEqual([
      [["Revert", "Revert this action"]],
      [["Bring back", "Bring this action back"]],
      [["Revert", "Revert this action"]],
      [],
    ]);
    expect(h[h.length - 1].root).toBe(true);
  });

  it("reverts a move through its dialog, then brings it back", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "move", items: ["A"], days: 1 });
    });
    await shownHistory(t);
    const id = t.session.history()[0].id;
    const revert = vi.spyOn(t.session, "revert");
    click(within(rows()[0]).getByRole("button", { name: "Revert this action" }));
    expect(uiNow()[0].dialog).toEqual({ t: "revert", id });
    expect(dialogLines()).toEqual(revertText("Moved “A” later by 1 working day", t.session.previewRevert(id)));
    expect(dialogLines()[1]).toBe("Changes 1 item");
    click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" }));
    expect(revert.mock.calls).toEqual([[id]]);
    expect(toastTexts()).toEqual([builtOf(revert, 0).toast]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(t.session.view().plan.items.get("A")?.schedule?.start).toBe("2026-11-10");
    const row = rows().find((li) => li.dataset.action === id);
    if (row === undefined) throw new Error("no row for the move");
    expect(row.classList.contains("inactive")).toBe(true);
    click(within(row).getByRole("button", { name: "Bring this action back" }));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Bring this action back");
    click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" }));
    expect(revert.mock.calls).toEqual([[id], [id]]);
    expect(t.session.view().plan.items.get("A")?.schedule?.start).toBe("2026-11-11");
  });

  it("reverts a plan rename with its exact dialog text", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "planName", name: "Q1" });
    });
    await shownHistory(t);
    click(within(rows()[0]).getByRole("button", { name: "Revert this action" }));
    expect(dialogLines()).toEqual(["Renamed the plan to “Q1”", "No item dates change."]);
    expect(screen.getByRole("dialog").textContent).not.toMatch(/Changes/);
  });

  it("closes the dialog on Esc and on Cancel", async () => {
    const t = await made(SEED);
    act(() => {
      t.session.apply({ t: "move", items: ["A"], days: 1 });
    });
    await shownHistory(t);
    click(within(rows()[0]).getByRole("button", { name: "Revert this action" }));
    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uiNow()[0].dialog).toBeNull();
    click(within(rows()[0]).getByRole("button", { name: "Revert this action" }));
    click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(uiNow()[0].dialog).toBeNull();
  });

  it("reads a row from yesterday with its day", async () => {
    const t = await made(SEED, { today: "2026-11-08" });
    const entry: HistoryEntry = { id: "x1", label: "Moved “A”", device: "Mac", at: new Date(2026, 10, 7, 14, 2).getTime(), active: true, root: false };
    vi.spyOn(t.session, "history").mockReturnValue([entry]);
    await shownHistory(t);
    expect(rows().map(rowText)).toEqual(["7 Nov 14:02 · Mac · Moved “A”"]);
  });

  it("shows the newest 50 changes and 50 more per Show older changes", async () => {
    const t = await made(SEED);
    const entries: HistoryEntry[] = Array.from({ length: 120 }, (_, i) => ({
      id: "h" + i,
      label: "Change " + i,
      device: "Mac",
      at: 0,
      active: true,
      root: i === 119,
    }));
    vi.spyOn(t.session, "history").mockReturnValue(entries);
    await shownHistory(t);
    const ids = (): (string | undefined)[] => rows().map((li) => li.dataset.action);
    expect(ids()).toEqual(entries.slice(0, 50).map((e) => e.id));
    click(button("Show older changes"));
    expect(ids()).toEqual(entries.slice(0, 100).map((e) => e.id));
    click(button("Show older changes"));
    expect(ids()).toEqual(entries.map((e) => e.id));
    noButton("Show older changes");
  });

  it("gives the first action no button", async () => {
    const t = await made(SEED);
    const entry: HistoryEntry = { id: "x0", label: "Created the plan", device: "Mac", at: 0, active: true, root: true };
    vi.spyOn(t.session, "history").mockReturnValue([entry]);
    await shownHistory(t);
    expect(rows().map(rowText)).toEqual([`${historyTime(0, "2026-11-09", LOG_STYLE)} · Mac · Created the plan`]);
    expect(all("button", rows()[0])).toEqual([]);
  });

  it("opens the choice with the other side preselected for a side of an open choice", async () => {
    const t = await made(SEED);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    act(() => {
      t.session.apply({ t: "move", items: ["A"], days: 1 });
      p.session.apply({ t: "move", items: ["A"], days: 2 });
      p.sync();
    });
    expect(t.session.view().choices.map((c) => c.kind)).toEqual(["items"]);
    const apply = vi.spyOn(t.session, "apply");
    const revert = vi.spyOn(t.session, "revert");
    const resolve = vi.spyOn(t.session, "resolve");
    await shownHistory(t);
    const local = rows().find((li) => rowText(li)?.endsWith("· Mac · Moved “A” later by 1 working day"));
    if (local === undefined) throw new Error("no row for the local move");
    click(within(local).getByRole("button", { name: "Revert this action" }));
    const offer = t.session.undoOffer();
    if (offer === null) throw new Error("no offer");
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: t.session.view().choices[0].id, side: offer.side });
    expect(within(screen.getByRole("dialog", { name: CHOICE_TITLE })).getByRole("button", { name: "Keep the other version" })).toBeTruthy();
    expect([apply.mock.calls.length, revert.mock.calls.length, resolve.mock.calls.length]).toEqual([0, 0, 0]);
    expect(toastTexts()).toEqual([]);
  });

  it("closes an open revert dialog into the choice when its action becomes a side of one", async () => {
    const t = await made(SEED);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    act(() => {
      t.session.apply({ t: "move", items: ["A"], days: 1 });
    });
    await shownHistory(t);
    click(within(rows()[0]).getByRole("button", { name: "Revert this action" }));
    expect(screen.getByRole("dialog")).not.toBeNull();
    act(() => {
      p.session.apply({ t: "move", items: ["A"], days: 2 });
      p.sync();
    });
    const offer = t.session.undoOffer();
    if (offer === null) throw new Error("no offer");
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: t.session.view().choices[0].id, side: offer.side });
    expect(screen.getAllByRole("dialog").map((d) => d.getAttribute("aria-label"))).toEqual([CHOICE_TITLE]);
  });
});

describe("PlanPanel read-only", () => {
  it("drops every writing control and keeps the Baselines count", async () => {
    const t = await made([
      { name: "A", start: "2026-11-10", dur: 3 },
      { name: "T", start: "2026-11-10" },
    ]);
    act(() => {
      t.session.apply({ t: "baseline", op: "save", name: "Before" });
      t.session.apply({ t: "trash", items: ["T"] });
      t.session.apply({ t: "move", items: ["A"], days: 1 });
    });
    await shown(t);
    const page = (row: "history" | "trash"): void => click(one(`button.summary-row[data-summary-row="${row}"]`, panel()));
    const back = (): void => click(one(".summary-back", panel()));
    page("trash");
    expect(button("Restore")).not.toBeNull();
    back();
    page("history");
    expect(inPanel().getAllByRole("button", { name: /Revert this action|Bring this action back/ }).length).toBeGreaterThan(0);
    back();
    const apply = vi.spyOn(t.session, "apply");
    const revert = vi.spyOn(t.session, "revert");
    act(() => t.session.setReadOnly(true));
    expect(panel().querySelectorAll("input, select")).toHaveLength(0);
    expect(panel().textContent).toContain("Plan");
    expect(one('button.summary-row[data-summary-row="baselines"] .summary-row-count', panel()).textContent).toBe("1");
    page("trash");
    noButton("Restore");
    expect(all("[data-trashed]", panel())).toHaveLength(1);
    back();
    page("history");
    ["Revert this action", "Bring this action back"].forEach(noButton);
    expect(all(".history li", panel()).length).toBeGreaterThan(0);
    all("button", panel()).forEach(click);
    all("button", panel()).forEach(click);
    expect([apply.mock.calls.length, revert.mock.calls.length]).toEqual([0, 0]);
  });
});
