import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusal } from "../../actions/copy";
import type { ItemId, StepColour } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import type { PlanSession } from "../../store/session";
import { IPAD, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { emitFromRust, resetTauri, tauri } from "../../test/tauriMock";
import { themed } from "../../test/theme";
import { useTheme, type ThemeApi } from "../../theme/ThemeContext";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { clearToasts, Toasts } from "../common/Toast";
import { DetailContext, type DetailApi } from "../detail/DetailContext";
import { ItemDetail, promoteText } from "../detail/ItemDetail";
import { ItemModal } from "../detail/ItemModal";
import { OpenChoice } from "../run";
import { UiContext, type UiState } from "../state";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
  setPlatform(MAC);
});

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
};

const SEED: readonly SeedItem[] = [
  { id: "a", name: "Mirror coating", start: "2026-11-10", dur: 3 },
  { id: "m", name: "First light", kind: "milestone", start: "2026-11-24" },
  { id: "g", name: "Dome", kind: "group" },
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

type Container = "column" | "sheet";

function GrabTheme(p: { into: { api: ThemeApi | null } }) {
  p.into.api = useTheme();
  return null;
}

const themeOf = (holder: { api: ThemeApi | null }): ThemeApi => {
  if (holder.api === null) throw new Error("no theme api grabbed");
  return holder.api;
};

const show = (t: TestSession, item: ItemId, o: { container?: Container; readOnly?: boolean } = {}) => {
  const setUi = vi.fn<(patch: Partial<UiState>) => void>();
  const theme: { api: ThemeApi | null } = { api: null };
  const api: DetailApi = { press: vi.fn(), step: vi.fn(), promote: vi.fn(), rename: vi.fn(), order: [item] };
  const text = promoteText(true);
  render(
    themed(
      <OpenChoice.Provider value={vi.fn()}>
        <UiContext.Provider value={{ ui: { ...UI, selected: item }, setUi }}>
          <DetailContext.Provider value={api}>
            <ItemDetail
              session={t.session}
              item={item}
              container={o.container ?? "column"}
              local="Mac"
              command
              readOnly={o.readOnly ?? false}
              naming={false}
              onNamed={() => undefined}
              onExpand={vi.fn()}
              expandLabel={text.label}
              expandTitle={text.title}
              {...((o.container ?? "column") === "column" ? { onClose: vi.fn() } : {})}
            />
          </DetailContext.Provider>
        </UiContext.Provider>
        <Toasts />
        <GrabTheme into={theme} />
      </OpenChoice.Provider>,
    ),
  );
  return { setUi, theme };
};

const showModal = (t: TestSession, item: ItemId) => {
  const onClose = vi.fn();
  const api: DetailApi = { press: vi.fn(), step: vi.fn(), promote: vi.fn(), rename: vi.fn(), order: [item] };
  render(
    themed(
      <OpenChoice.Provider value={vi.fn()}>
        <UiContext.Provider value={{ ui: { ...UI, selected: item }, setUi: vi.fn() }}>
          <DetailContext.Provider value={api}>
            <ItemModal
              session={t.session}
              item={item}
              local="Mac"
              command
              readOnly={false}
              naming={false}
              memo={null}
              onNamed={() => undefined}
              onRename={() => undefined}
              onClose={onClose}
            />
          </DetailContext.Provider>
        </UiContext.Provider>
        <Toasts />
      </OpenChoice.Provider>,
    ),
  );
  return { onClose };
};

const field = (): HTMLElement => {
  const el = document.querySelector('[data-detail] .fields .assignees[data-detail-field="assignees"]');
  if (!(el instanceof HTMLElement)) throw new Error("no assignees field");
  return el;
};

const chips = (): (string | null)[][] =>
  [...field().querySelectorAll<HTMLElement>(".who-chip")].map((c) => [
    c.dataset.who ?? null,
    c.querySelector(".avatar")?.textContent ?? null,
    c.querySelector(".who-name")?.textContent ?? null,
    c.querySelector("button.chip-x")?.getAttribute("aria-label") ?? null,
  ]);

const addButton = (): HTMLButtonElement => within(field()).getByRole("button", { name: "Assign…" });

const menuRows = (): [string | null, string | null][] => [...document.querySelectorAll('.context-menu [role^="menuitem"]')].map((e) => [e.textContent, e.getAttribute("aria-checked")]);

const choose = (row: string): void => {
  const el = [...document.querySelectorAll<HTMLElement>('.context-menu [role^="menuitem"]')].find((e) => e.textContent === row);
  if (el === undefined) throw new Error("no menu row " + row);
  act(() => {
    fireEvent.click(el);
  });
};

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const openAssign = (): void => {
  act(() => {
    fireEvent.click(addButton());
  });
};

const toastTexts = (): (string | null)[] => [...document.querySelectorAll(".toasts .toast")].map((e) => e.textContent);

const labelsOf = (): (string | null)[] => [...document.querySelectorAll("[data-detail] .fields:first-of-type > label")].map((l) => l.textContent);

const withFormer = async (t: TestSession, ids: Record<string, string>, item: ItemId): Promise<void> => {
  const phone = await t.peer("iphone");
  sessions.push(phone.session);
  phone.session.apply({ t: "assign", items: [item], person: ids.DL });
  act(() => {
    t.session.apply({ t: "person", op: "remove", person: ids.DL, to: null });
    phone.sync();
  });
};

describe("AssigneesField", () => {
  it("sits after Status and before Progress on a task, after Status on a milestone, and never on a group", async () => {
    const t = await made();
    show(t, "a");
    expect(labelsOf()).toEqual(["Start", "Duration", "End", "Status", "Assignees", "Progress"]);
    const label = [...document.querySelectorAll("[data-detail] .fields > label")].find((l) => l.textContent === "Assignees");
    expect(label?.nextElementSibling).toBe(field());
    cleanup();
    show(t, "m");
    expect(labelsOf()).toEqual(["Date", "Status", "Assignees"]);
    cleanup();
    show(t, "g");
    expect(labelsOf()).not.toContain("Assignees");
    expect(document.querySelector(".assignees")).toBeNull();
  });

  it("shows live people in Settings order, then the former ones, each with an avatar, a name and an X", async () => {
    const t = await made();
    const ids = addPeople(t, [...CREW, ["Dana Lee", "DL", "sky"]]);
    act(() => {
      t.session.apply({ t: "assign", items: ["a"], person: ids.AR });
      t.session.apply({ t: "assign", items: ["a"], person: ids.MO });
    });
    await withFormer(t, ids, "a");
    show(t, "a");
    expect(chips()).toEqual([
      [ids.MO, "MO", "Mira Okafor", "Unassign Mira Okafor"],
      [ids.AR, "AR", "Ana Ruiz", "Unassign Ana Ruiz"],
      [ids.DL, "DL", "Former: Dana Lee", "Unassign Former: Dana Lee"],
    ]);
    expect(field().querySelector('.who-chip[data-who="' + ids.DL + '"] .avatar')?.className).toBe("avatar former");
    const add = addButton();
    expect([add.className, add.getAttribute("aria-haspopup"), add.textContent]).toEqual(["chip-add", "menu", "Assign…"]);
    expect(field().lastElementChild).toBe(add);
  });

  it("unassigns with the X through the assignees intent, keeping the former people, as one undo entry", async () => {
    const t = await made();
    const ids = addPeople(t, [...CREW, ["Dana Lee", "DL", "sky"]]);
    act(() => {
      t.session.apply({ t: "assign", items: ["a"], person: ids.MO });
      t.session.apply({ t: "assign", items: ["a"], person: ids.AR });
    });
    await withFormer(t, ids, "a");
    show(t, "a");
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.click(within(field()).getByRole("button", { name: "Unassign Ana Ruiz" }));
    });
    expect(apply.mock.calls).toEqual([[{ t: "assignees", item: "a", people: [ids.MO, ids.DL] }]]);
    expect(chips().map((c) => c[2])).toEqual(["Mira Okafor", "Former: Dana Lee"]);
    act(() => {
      t.session.undo();
    });
    expect(chips().map((c) => c[2])).toEqual(["Mira Okafor", "Ana Ruiz", "Former: Dana Lee"]);
  });

  it("drops a former person with their X", async () => {
    const t = await made();
    const ids = addPeople(t, [...CREW, ["Dana Lee", "DL", "sky"]]);
    act(() => {
      t.session.apply({ t: "assign", items: ["a"], person: ids.OB });
    });
    await withFormer(t, ids, "a");
    show(t, "a");
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.click(within(field()).getByRole("button", { name: "Unassign Former: Dana Lee" }));
    });
    expect(apply.mock.calls).toEqual([[{ t: "assignees", item: "a", people: [ids.OB] }]]);
    expect(chips().map((c) => c[2])).toEqual(["Ole Berg"]);
  });

  it("opens an untitled pick menu of checkable people from Assign…, and a choice assigns or unassigns one person", async () => {
    const t = await made();
    const ids = addPeople(t, CREW);
    act(() => {
      t.session.apply({ t: "assign", items: ["m"], person: ids.OB });
    });
    show(t, "m");
    openAssign();
    const menu = screen.getByRole("menu", { name: "Assign" });
    expect(menu.querySelector(".context-menu-title")).toBeNull();
    expect(menuRows()).toEqual([
      ["Mira Okafor", "false"],
      ["Ole Berg", "true"],
      ["Ana Ruiz", "false"],
    ]);
    const apply = vi.spyOn(t.session, "apply");
    choose("Ana Ruiz");
    expect(document.querySelector(".context-menu")).toBeNull();
    openAssign();
    choose("Ole Berg");
    expect(apply.mock.calls).toEqual([[{ t: "assign", items: ["m"], person: ids.AR }], [{ t: "unassign", items: ["m"], person: ids.OB }]]);
    expect(chips().map((c) => c[2])).toEqual(["Ana Ruiz"]);
  });

  it("toasts the refusal when a ninth person is assigned", async () => {
    const t = await made();
    const nine: Crew = Array.from({ length: 9 }, (_, i): readonly [string, string, StepColour] => [`Person ${i + 1}`, `P${i + 1}`, "slate"]);
    const ids = addPeople(t, nine);
    act(() => {
      nine.slice(0, 8).forEach(([, initials]) => t.session.apply({ t: "assign", items: ["a"], person: ids[initials] }));
    });
    show(t, "a");
    expect(chips()).toHaveLength(8);
    openAssign();
    choose("Person 9");
    expect(toastTexts()).toEqual([refusal.assigneesFull("Mirror coating")]);
    expect(toastTexts()).toEqual(["“Mirror coating” already has 8 assignees."]);
    expect(chips()).toHaveLength(8);
  });

  it("offers Add people in Settings… when the plan has no people, opening Settings on People", async () => {
    const t = await made();
    const { setUi, theme } = show(t, "a");
    expect(field().querySelector(".who-chip")).toBeNull();
    openAssign();
    expect(menuRows()).toEqual([["Add people in Settings…", null]]);
    const apply = vi.spyOn(t.session, "apply");
    const preview = vi.spyOn(themeOf(theme), "preview");
    choose("Add people in Settings…");
    expect(preview.mock.calls).toEqual([[null]]);
    expect(setUi.mock.calls).toEqual([[{ settings: "people" }]]);
    expect(preview.mock.invocationCallOrder[0]).toBeLessThan(setUi.mock.invocationCallOrder[0]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops a live theme preview before Settings opens from Add people in Settings…", async () => {
    const t = await made();
    const { theme } = show(t, "a");
    const voidOf = (): string => document.documentElement.style.getPropertyValue("--void");
    const cyberdeck = voidOf();
    act(() => {
      themeOf(theme).preview("phosphor");
    });
    expect(voidOf()).not.toBe(cyberdeck);
    openAssign();
    choose("Add people in Settings…");
    expect(voidOf()).toBe(cyberdeck);
  });

  it("names the field Assignees as a group", async () => {
    const t = await made();
    show(t, "a");
    expect(screen.getByRole("group", { name: "Assignees" })).toBe(field());
  });

  it("moves the focus to the next chip's X after an X, and to Assign… after the last one", async () => {
    const t = await made();
    const ids = addPeople(t, CREW);
    act(() => {
      t.session.apply({ t: "assign", items: ["a"], person: ids.MO });
      t.session.apply({ t: "assign", items: ["a"], person: ids.OB });
    });
    show(t, "a");
    const x = (name: string): HTMLElement => within(field()).getByRole("button", { name });
    act(() => {
      x("Unassign Mira Okafor").focus();
      fireEvent.click(x("Unassign Mira Okafor"));
    });
    expect(document.activeElement).toBe(x("Unassign Ole Berg"));
    act(() => {
      fireEvent.click(x("Unassign Ole Berg"));
    });
    expect(chips()).toEqual([]);
    expect(document.activeElement).toBe(addButton());
  });

  it("says so when a person removed while the menu was open is chosen", async () => {
    const t = await made();
    const ids = addPeople(t, CREW);
    show(t, "a");
    openAssign();
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.OB, to: null });
    });
    const apply = vi.spyOn(t.session, "apply");
    choose("Ole Berg");
    expect(apply).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([STALE_CONFIRM]);
  });

  it("shows the chips without X or Assign… on a read-only plan, and Unassigned when nobody is", async () => {
    const t = await made();
    const ids = addPeople(t, CREW);
    act(() => {
      t.session.apply({ t: "assign", items: ["a"], person: ids.MO });
    });
    show(t, "a", { readOnly: true });
    expect(chips()).toEqual([[ids.MO, "MO", "Mira Okafor", null]]);
    expect(field().querySelector("button")).toBeNull();
    cleanup();
    show(t, "m", { readOnly: true });
    expect(field().querySelector(".who-chip, button")).toBeNull();
    const none = field().querySelector("span.val.dimc");
    expect(none?.textContent).toBe("Unassigned");
  });

  it("shows a trashed item's assignees without X or Assign…", async () => {
    const t = await made();
    const ids = addPeople(t, CREW);
    act(() => {
      t.session.apply({ t: "assign", items: ["a"], person: ids.AR });
      t.session.apply({ t: "trash", items: ["a"] });
    });
    show(t, "a");
    expect(chips()).toEqual([[ids.AR, "AR", "Ana Ruiz", null]]);
    expect(field().querySelector("button")).toBeNull();
  });

  it("is the same field in the phone sheet", async () => {
    const t = await made();
    const ids = addPeople(t, CREW);
    act(() => {
      t.session.apply({ t: "assign", items: ["a"], person: ids.OB });
    });
    show(t, "a", { container: "sheet" });
    expect(chips()).toEqual([[ids.OB, "OB", "Ole Berg", "Unassign Ole Berg"]]);
    expect(addButton().textContent).toBe("Assign…");
  });

  it("closes the menu on Escape and keeps the item modal open", async () => {
    const t = await made();
    addPeople(t, CREW);
    const { onClose } = showModal(t, "a");
    expect(document.querySelector('[data-detail="modal"] .assignees')).not.toBeNull();
    openAssign();
    const menu = screen.getByRole("menu", { name: "Assign" });
    act(() => {
      fireEvent.keyDown(menu, { key: "Escape" });
    });
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("AssigneesField on iPad", () => {
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

  it("sends the people to the native pull-down menu, checked, untitled, and a choice assigns", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const t = await made();
      const ids = addPeople(t, CREW);
      act(() => {
        t.session.apply({ t: "assign", items: ["a"], person: ids.MO });
      });
      show(t, "a");
      openAssign();
      await settle();
      expect(document.querySelector(".context-menu")).toBeNull();
      expect(lastAsk().sections.map((s) => [s.title, s.rows.map((r) => [r.id, r.title, r.checked])])).toEqual([
        [
          null,
          [
            [`person:${ids.MO}`, "Mira Okafor", true],
            [`person:${ids.OB}`, "Ole Berg", false],
            [`person:${ids.AR}`, "Ana Ruiz", false],
          ],
        ],
      ]);
      const apply = vi.spyOn(t.session, "apply");
      chooseNative(`person:${ids.OB}`);
      expect(apply.mock.calls).toEqual([[{ t: "assign", items: ["a"], person: ids.OB }]]);
      expect(chips().map((c) => c[2])).toEqual(["Mira Okafor", "Ole Berg"]);
    } finally {
      unstub();
    }
  });

  it("sends the one Settings row when the plan has no people", async () => {
    resetTauri({});
    setPlatform(IPAD);
    const unstub = stubVisualViewport();
    try {
      const t = await made();
      const { setUi } = show(t, "a");
      openAssign();
      await settle();
      expect(lastAsk().sections).toEqual([{ title: null, rows: [{ id: "people-settings", title: "Add people in Settings…", checked: false }] }]);
      chooseNative("people-settings");
      expect(setUi.mock.calls).toEqual([[{ settings: "people" }]]);
    } finally {
      unstub();
    }
  });
});
