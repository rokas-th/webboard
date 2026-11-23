import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peopleOf } from "../../domain/people";
import { stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { testSession, fs, type SeedItem, type TestSession } from "../../test/session";
import { UiContext, useUi } from "../state";
import { PhoneList } from "./PhoneList";
import { deviced } from "../../test/theme";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
});

const made = async (...a: Parameters<typeof testSession>): Promise<TestSession> => {
  const t = await testSession(...a);
  sessions.push(t.session);
  return t;
};

function Phone(p: { session: PlanSession; onOpen: (item: string) => void }) {
  const [ui, setUi] = useUi("timeline");
  const value = useMemo(() => ({ ui, setUi }), [ui, setUi]);
  return deviced(
    <UiContext.Provider value={value}>
      <PhoneList session={p.session} onOpen={p.onOpen} />
    </UiContext.Provider>
  );
}

const SPRINT: readonly SeedItem[] = [
  { id: "S4", name: "Sprint 4", kind: "group" },
  { name: "Review", parent: "S4", start: "2026-11-10" },
  { name: "Ship", parent: "S4", start: "2026-12-14" },
  { name: "Old", parent: "S4", start: "2026-11-02", status: "done", progress: 100 },
  { name: "Idea", parent: "S4", status: "done", progress: 100 },
  { name: "QA", kind: "group", parent: "S4" },
  { name: "Test", parent: "QA", start: "2026-11-12" },
  { name: "Notes", start: "2026-11-11" },
];

const CLASH = [{ unit: "s:Review", mac: ["2026-11-10", 2, "todo", 0, "now"], iphone: ["2026-11-12", 2, "todo", 0, "now"] }];

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const all = (sel: string, root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

const scope = (id: string): HTMLElement => one(`.scope-bar [data-scope="${id}"]`);

const pick = (id: string): void => {
  act(() => {
    fireEvent.click(scope(id));
  });
};

const sections = (): [string, string[]][] =>
  all(".psec").map((s) => [s.querySelector(".psec-title")?.textContent ?? "", all(".prow-name", s).map((n) => n.textContent ?? "")]);

const row = (name: string): HTMLElement => {
  const hit = all(".prow").find((r) => r.querySelector(".prow-name")?.textContent === name);
  if (hit === undefined) throw new Error("no row " + name);
  return hit;
};

const meta = (name: string): string => {
  const r = row(name);
  const id = r.getAttribute("aria-describedby");
  if (id === null) throw new Error("row " + name + " has no description");
  const described = document.getElementById(id);
  if (described === null) throw new Error("row " + name + " names a missing description");
  return described.textContent ?? "";
};

const dims = (): string[] => all(".phone-list > p.dim").map((p) => p.textContent ?? "");

const search = (q: string): void => {
  act(() => {
    fireEvent.change(screen.getByRole("searchbox", { name: "Search this plan" }), { target: { value: q } });
  });
};

const openSort = (): HTMLElement => {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Sort and group" }));
  });
  return screen.getByRole("menu", { name: "Sort and group" });
};

const menuGroups = (menu: HTMLElement): [string | null, [string | null, string | null][]][] =>
  all('[role="group"]', menu).map((g) => [g.getAttribute("aria-label"), all('[role="menuitemcheckbox"]', g).map((r) => [r.textContent, r.getAttribute("aria-checked")])]);

const choose = (menu: HTMLElement, group: string, title: string): void => {
  const g = all('[role="group"]', menu).find((x) => x.getAttribute("aria-label") === group);
  if (g === undefined) throw new Error("no menu group " + group);
  act(() => {
    fireEvent.click(within(g).getByRole("menuitemcheckbox", { name: title }));
  });
};

describe("PhoneList", () => {
  it("puts search and Sort and group first, then the scope bar and the status line", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    const list = one(".phone-list");
    const top = one(":scope > .plist-top", list);
    expect(list.firstElementChild).toBe(top);
    const field = one("label.search-field", top);
    const input = one('input[type="search"]', field);
    expect([input.getAttribute("placeholder"), input.getAttribute("aria-label")]).toEqual(["Search", "Search this plan"]);
    const sort = one('button.icon-button[data-list="sort"]', top);
    expect([sort.getAttribute("aria-label"), sort.getAttribute("title"), sort.getAttribute("aria-haspopup")]).toEqual(["Sort and group", "Sort and group", "menu"]);
    expect(all(":scope > *", list).map((e) => e.className)).toEqual(["plist-top", "list-bar", "list-status", "psec", "psec", "psec"]);
    expect(all('[role="tab"]', list)).toEqual([]);
    expect(all("[data-list=filter], [data-list=group]", list)).toEqual([]);
  });

  it("starts on Open and shows each scope's rows under the outline's sections", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    expect(scope("open").getAttribute("aria-checked")).toBe("true");
    expect(sections()).toEqual([
      ["Sprint 4", ["Review", "Ship"]],
      ["Sprint 4 › QA", ["Test"]],
      ["Not in a group", ["Notes"]],
    ]);
    expect(one(".list-status .list-count").textContent).toBe("4 items");
    pick("done");
    expect(sections()).toEqual([["Sprint 4", ["Old", "Idea"]]]);
    pick("milestones");
    expect([sections(), dims()]).toEqual([[], ["Nothing in Milestones."]]);
  });

  it("lists every untrashed item under All, done ones included, and opens rows and group headers", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    const onOpen = vi.fn();
    render(<Phone session={t.session} onOpen={onOpen} />);
    pick("all");
    expect(sections()).toEqual([
      ["Sprint 4", ["Review", "Ship", "Old", "Idea"]],
      ["Sprint 4 › QA", ["Test"]],
      ["Not in a group", ["Notes"]],
    ]);
    fireEvent.click(row("Old"));
    expect(onOpen.mock.calls).toEqual([["Old"]]);
    fireEvent.click(screen.getByRole("button", { name: "Sprint 4 › QA" }));
    expect(onOpen.mock.calls).toEqual([["Old"], ["QA"]]);
    expect(screen.queryByRole("button", { name: "Not in a group" })).toBeNull();
    expect(one("h2.psec-title").textContent).toBe("Not in a group");
  });

  it("empty plan: one dim line under every scope", async () => {
    const t = await made([]);
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    ["open", "soon", "late", "blocked", "unscheduled", "unassigned", "milestones", "done", "all"].forEach((s) => {
      pick(s);
      expect([s, dims(), sections()]).toEqual([s, ["No items yet. Add one with +."], []]);
    });
  });

  it("empty scope: names the scope, and the search when one is set", async () => {
    const t = await made([
      { name: "A", start: "2026-12-14" },
      { name: "B", start: "2026-12-21" },
    ]);
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    expect(dims()).toEqual([]);
    pick("late");
    expect([dims(), sections()]).toEqual([["Nothing in Late."], []]);
    pick("open");
    search("zz");
    expect([dims(), sections()]).toEqual([["Nothing in Open matches “zz”."], []]);
  });

  it("empty group: its section is hidden in every scope", async () => {
    const t = await made([...SPRINT, { name: "Empty", kind: "group" }], { clashes: CLASH });
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    expect(sections().map(([n]) => n)).not.toContain("Empty");
    pick("all");
    expect(sections().map(([n]) => n)).not.toContain("Empty");
    expect(screen.queryByRole("button", { name: "Empty" })).toBeNull();
  });

  it("ghost rows: a trashed item of an open delete choice lists in every scope, dimmed, and opens", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    t.session.apply({ t: "trash", items: ["Notes"] });
    peer.session.apply({ t: "move", items: ["Notes"], days: 1 });
    peer.sync();
    expect(t.session.view().choices.filter((c) => c.kind === "delete")).toHaveLength(1);
    const onOpen = vi.fn();
    render(<Phone session={t.session} onOpen={onOpen} />);
    expect(sections()).toEqual([
      ["Sprint 4", ["Review", "Ship"]],
      ["Sprint 4 › QA", ["Test"]],
      ["Not in a group", ["Notes"]],
    ]);
    expect(row("Notes").classList.contains("ghost-row")).toBe(true);
    expect(meta("Notes")).toBe("held");
    pick("done");
    expect(sections()).toEqual([
      ["Sprint 4", ["Old", "Idea"]],
      ["Not in a group", ["Notes"]],
    ]);
    fireEvent.click(row("Notes"));
    expect(onOpen.mock.calls).toEqual([["Notes"]]);
  });

  it("day off marker", async () => {
    const t = await made([...SPRINT, { name: "Sat", start: "2026-11-14", dur: 1 }], { clashes: CLASH });
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    expect(row("Sat").classList.contains("dayoff")).toBe(true);
    expect(row("Review").classList.contains("dayoff")).toBe(false);
  });

  it("two-line rows: the name, then step · assignees · dates, the name labelling the row and the meta describing it", async () => {
    const t = await made([
      { id: "a", name: "Pour footings", start: "2026-11-02", dur: 3 },
      { id: "m", name: "Dome set", kind: "milestone", start: "2026-11-20" },
      { id: "u", name: "Undated", horizon: "next" },
      { id: "x", name: "Orphan", horizon: "now" },
      { id: "e", name: "Build", start: "2026-11-16", dur: 1, deps: [fs("a")] },
    ]);
    act(() => {
      [
        ["Mira Okafor", "MO"],
        ["Ana Ruiz", "AR"],
      ].forEach(([name, initials]) => {
        const known = peopleOf(t.session.view().plan);
        t.session.apply({ t: "person", op: "add", name, initials, colour: "sky", after: known.length === 0 ? null : known[known.length - 1].id });
      });
      peopleOf(t.session.view().plan).forEach((p) => t.session.apply({ t: "assign", items: ["a"], person: p.id }));
      t.session.apply({ t: "assign", items: ["e"], person: peopleOf(t.session.view().plan)[1].id });
      t.session.apply({ t: "step", op: "add", name: "QA", colour: "lime", after: "later" });
    });
    const qa = stepsOf(t.session.view().plan).find((s) => s.name === "QA");
    if (qa === undefined) throw new Error("no QA step");
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    peer.session.apply({ t: "toStep", items: ["x"], step: qa.id });
    act(() => {
      t.session.apply({ t: "step", op: "delete", step: qa.id, to: null });
      peer.sync();
    });
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    expect(all(".prow-name").map((n) => n.textContent)).toEqual(["Pour footings", "◆ Dome set", "Undated", "Orphan", "Build"]);
    expect(["Pour footings", "◆ Dome set", "Undated", "Orphan", "Build"].map(meta)).toEqual([
      "late · Now · Mira Okafor +1 · 2 Nov – 4 Nov",
      "Now · Unassigned · 20 Nov",
      "Next · Unassigned · No dates",
      "No step · Unassigned · No dates",
      "Now · Ana Ruiz · 16 Nov",
    ]);
    const r = row("Pour footings");
    const name = one(".prow-name", r);
    expect([r.tagName, r.getAttribute("aria-labelledby"), r.getAttribute("aria-describedby")]).toEqual(["BUTTON", name.id, one(".prow-meta", r).id]);
    expect(screen.getByRole("button", { name: "Pour footings" })).toBe(r);
  });

  it("leads the meta with a tinted conflict, held or late, and marks the selected row", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    const held = one(".prow-meta .st", row("Review"));
    expect([held.className, held.textContent, meta("Review").startsWith("held · ")]).toEqual(["st held", "held", true]);
    expect([row("Ship").querySelector(".st"), meta("Ship").startsWith("held")]).toEqual([null, false]);
    expect(all(".prow.selected")).toEqual([]);
  });

  it("marks the row of the selected item", async () => {
    const t = await made(SPRINT);
    function Selected(p: { session: PlanSession }) {
      const [ui, setUi] = useUi("timeline");
      const value = useMemo(() => ({ ui: { ...ui, selected: "Ship" }, setUi }), [ui, setUi]);
      return (
        <UiContext.Provider value={value}>
          <PhoneList session={p.session} onOpen={vi.fn()} />
        </UiContext.Provider>
      );
    }
    render(deviced(<Selected session={t.session} />));
    expect(all(".prow.selected").map((r) => one(".prow-name", r).textContent)).toEqual(["Ship"]);
  });

  it("search narrows the rows, highlights the match and counts shown of scoped", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    search("es");
    expect(sections()).toEqual([["Sprint 4 › QA", ["Test"]], ["Not in a group", ["Notes"]]]);
    expect(one(".list-status .list-count").textContent).toBe("2 of 4");
    expect(all(".prow-name mark").map((m) => m.textContent)).toEqual(["es", "es"]);
    search("");
    expect(one(".list-status .list-count").textContent).toBe("4 items");
  });

  it("Sort and group: sorts by Plan order or a shown column, flips the primary, and groups", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    const sort = screen.getByRole("button", { name: "Sort and group" });
    expect(sort.getAttribute("aria-expanded")).toBe("false");
    const menu = openSort();
    expect(sort.getAttribute("aria-expanded")).toBe("true");
    expect(menuGroups(menu)).toEqual([
      [
        "Sort by",
        [
          ["Plan order", "true"],
          ["Name", "false"],
          ["Step", "false"],
          ["Assignees", "false"],
          ["Start", "false"],
          ["End", "false"],
          ["Status", "false"],
        ],
      ],
      [
        "Group by",
        [
          ["Plan outline", "true"],
          ["Step", "false"],
          ["Assignee", "false"],
          ["None", "false"],
        ],
      ],
    ]);
    choose(menu, "Sort by", "Name");
    expect(sections()).toEqual([
      ["Sprint 4", ["Review", "Ship"]],
      ["Sprint 4 › QA", ["Test"]],
      ["Not in a group", ["Notes"]],
    ]);
    expect(one(".list-status .sort-summary").textContent).toBe("Sorted by Name ↑Plan order");
    const again = openSort();
    expect(menuGroups(again)[0][1].filter(([, c]) => c === "true")).toEqual([["Name ↑", "true"]]);
    choose(again, "Sort by", "Name ↑");
    expect(sections()[0]).toEqual(["Sprint 4", ["Ship", "Review"]]);
    expect(menuGroups(openSort())[0][1].filter(([, c]) => c === "true")).toEqual([["Name ↓", "true"]]);
    choose(screen.getByRole("menu", { name: "Sort and group" }), "Group by", "None");
    expect([all(".psec-title"), all(".prow-name").map((n) => n.textContent)]).toEqual([[], ["Test", "Ship", "Review", "Notes"]]);
    choose(openSort(), "Sort by", "Plan order");
    expect(all(".prow-name").map((n) => n.textContent)).toEqual(["Review", "Ship", "Test", "Notes"]);
  });

  it("group by step: headers are titles, not buttons", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    const onOpen = vi.fn();
    render(<Phone session={t.session} onOpen={onOpen} />);
    choose(openSort(), "Group by", "Step");
    expect(all("button.psec-title")).toEqual([]);
    expect(all("h2.psec-title").length).toBeGreaterThan(0);
  });

  it("re-renders when the plan changes", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    render(<Phone session={t.session} onOpen={vi.fn()} />);
    act(() => {
      t.session.apply({ t: "move", items: ["Ship"], days: -20 });
    });
    expect(sections()[0]).toEqual(["Sprint 4", ["Review", "Ship"]]);
  });
});
