import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meOf } from "../../domain/me";
import type { ItemId, PersonId } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem } from "../../test/session";
import { columnById, rowContext, type RowContext } from "./columns";
import { listModel, sortClick, sortRows, toggleChip, type ListModel } from "./model";
import { DEFAULT_LIST_PREFS, SCOPE_IDS, type ListPrefs, type ScopeId } from "./prefs";
import { searchMatcher } from "../search/match";
import { LOG_STYLE } from "../../domain/dates";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const SEED: readonly SeedItem[] = [
  { id: "g", name: "G", kind: "group" },
  { id: "c", name: "c", parent: "g", start: "2026-11-12", dur: 2 },
  { id: "a", name: "a", parent: "g" },
  { id: "b", name: "B", start: "2026-11-10", dur: 4 },
  { id: "d", name: "d", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  { id: "e", name: "e", start: "2026-11-10", dur: 1 },
];

const ctxOf = async (seed: readonly SeedItem[] = SEED): Promise<RowContext> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return rowContext(t.session.view(), (id) => t.session.note(id).toString(), null, LOG_STYLE);
};

const prefs = (over: Partial<ListPrefs>): ListPrefs => ({ ...DEFAULT_LIST_PREFS, ...over });

describe("sortClick", () => {
  it("sorts by a column, reverses on a second click and returns to Plan order on a third", () => {
    const one = sortClick(DEFAULT_LIST_PREFS, "start", false);
    const two = sortClick(one, "start", false);
    const three = sortClick(two, "start", false);
    expect([one.sort, two.sort, three.sort]).toEqual([[{ id: "start", dir: "asc" }], [{ id: "start", dir: "desc" }], []]);
  });

  it("starts over on a plain click of another column", () => {
    const two = sortClick(sortClick(DEFAULT_LIST_PREFS, "start", false), "name", true);
    expect(sortClick(two, "end", false).sort).toEqual([{ id: "end", dir: "asc" }]);
  });

  it("adds a key ascending on Shift, turns it descending, and drops it on a third Shift-click", () => {
    const a = sortClick(DEFAULT_LIST_PREFS, "start", false);
    const b = sortClick(a, "name", true);
    const c = sortClick(b, "name", true);
    const d = sortClick(c, "name", true);
    expect([b.sort, c.sort, d.sort]).toEqual([
      [
        { id: "start", dir: "asc" },
        { id: "name", dir: "asc" },
      ],
      [
        { id: "start", dir: "asc" },
        { id: "name", dir: "desc" },
      ],
      [{ id: "start", dir: "asc" }],
    ]);
  });
});

describe("sortRows", () => {
  it("puts nulls last in both directions and breaks ties by Plan order", async () => {
    const ctx = await ctxOf();
    const rows = ["c", "a", "b", "d", "e"];
    expect(sortRows(ctx, [{ id: "start", dir: "asc" }], rows)).toEqual(["d", "b", "e", "c", "a"]);
    expect(sortRows(ctx, [{ id: "start", dir: "desc" }], rows)).toEqual(["c", "b", "e", "d", "a"]);
    expect(sortRows(ctx, [], ["e", "d", "b", "a", "c"])).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("sorts names case-blind and uses later keys for ties", async () => {
    const ctx = await ctxOf();
    expect(sortRows(ctx, [{ id: "name", dir: "asc" }], ["c", "a", "b", "d", "e"])).toEqual(["a", "b", "c", "d", "e"]);
    expect(
      sortRows(
        ctx,
        [
          { id: "start", dir: "asc" },
          { id: "name", dir: "desc" },
        ],
        ["c", "a", "b", "d", "e"],
      ),
    ).toEqual(["d", "e", "b", "c", "a"]);
  });
});

describe("listModel", () => {
  it("shows Open by default, skipping done items, under the outline's sections", async () => {
    const ctx = await ctxOf();
    const m = listModel(ctx, DEFAULT_LIST_PREFS, null);
    expect(m.sections.map((s) => [s.title, s.rows])).toEqual([
      ["G", ["c", "a"]],
      ["Not in a group", ["b", "e"]],
    ]);
    expect(m.sections.map((s) => [s.key, s.group])).toEqual([
      ["outline:g", "g"],
      ["outline:none", null],
    ]);
    expect([m.order, m.scoped, m.shown]).toEqual([["c", "a", "b", "e"], 4, 4]);
    expect(m.scopeCounts).toEqual({ open: 4, soon: 3, late: 0, blocked: 0, unscheduled: 1, unassigned: 5, milestones: 0, done: 1, all: 5, mine: 0 });
  });

  it("sorts inside each section and hides an emptied section", async () => {
    const ctx = await ctxOf();
    const m = listModel(ctx, prefs({ scope: "done", sort: [{ id: "name", dir: "desc" }] }), null);
    expect(m.sections.map((s) => [s.title, s.rows])).toEqual([["Not in a group", ["d"]]]);
    const all = listModel(ctx, prefs({ scope: "all", sort: [{ id: "name", dir: "desc" }], group: "none" }), null);
    expect(all.sections.map((s) => [s.key, s.title, s.rows])).toEqual([["all", "", ["e", "d", "c", "b", "a"]]]);
  });

  it("narrows the scoped rows to the matches, counts shown of scoped, hides emptied sections and keeps the scope counts", async () => {
    const ctx = await ctxOf();
    const match = searchMatcher(ctx, "g");
    const m = listModel(ctx, DEFAULT_LIST_PREFS, match);
    expect(m.sections.map((s) => [s.title, s.rows])).toEqual([["G", ["c", "a"]]]);
    expect([m.order, m.scoped, m.shown]).toEqual([["c", "a"], 4, 2]);
    expect(m.scopeCounts).toEqual(listModel(ctx, DEFAULT_LIST_PREFS, null).scopeCounts);
    expect(listModel(ctx, DEFAULT_LIST_PREFS, searchMatcher(ctx, "zebra")).order).toEqual([]);
  });
});

const CREW_SEED: readonly SeedItem[] = [
  { id: "g", name: "Site", kind: "group" },
  { id: "a", name: "Pour", parent: "g", start: "2026-11-02", dur: 2 },
  {
    id: "b",
    name: "Bolt",
    parent: "g",
    start: "2026-11-10",
    dur: 3,
    deps: [fs("a")],
  },
  {
    id: "c",
    name: "Crane",
    start: "2026-11-11",
    dur: 1,
    status: "done",
    progress: 100,
  },
  { id: "m", name: "Dome set", kind: "milestone", start: "2026-11-16" },
  { id: "u", name: "Undated", horizon: "next" },
  { id: "x", name: "Orphan", horizon: "now" },
];

interface Crew {
  ctx: RowContext;
  ids: Readonly<Record<string, PersonId>>;
  session: PlanSession;
}

const CREW: readonly (readonly [string, string])[] = [
  ["Mira Okafor", "MO"],
  ["Ana Ruiz", "AR"],
  ["Ole Berg", "OB"],
  ["Dana Lee", "DL"],
];

const crewOf = async (): Promise<Crew> => {
  const t = await testSession(CREW_SEED);
  sessions.push(t.session);
  const ids: Record<string, PersonId> = {};
  act(() => {
    CREW.forEach(([name, initials]) => {
      const known = peopleOf(t.session.view().plan);
      t.session.apply({
        t: "person",
        op: "add",
        name,
        initials,
        colour: "sky",
        after: known.length === 0 ? null : known[known.length - 1].id,
      });
    });
    peopleOf(t.session.view().plan).forEach((p) => {
      ids[p.initials] = p.id;
    });
    t.session.apply({ t: "assign", items: ["a"], person: ids.AR });
    t.session.apply({ t: "assign", items: ["b"], person: ids.AR });
    t.session.apply({ t: "assign", items: ["b"], person: ids.MO });
    t.session.apply({
      t: "step",
      op: "add",
      name: "QA",
      colour: "lime",
      after: "later",
    });
  });
  const qa = stepsOf(t.session.view().plan).find((s) => s.name === "QA");
  if (qa === undefined) throw new Error("no QA step");
  const phone = await t.peer("iphone");
  sessions.push(phone.session);
  phone.session.apply({ t: "assign", items: ["m"], person: ids.DL });
  phone.session.apply({ t: "toStep", items: ["x"], step: qa.id });
  act(() => {
    t.session.apply({ t: "person", op: "remove", person: ids.DL, to: null });
    t.session.apply({ t: "step", op: "delete", step: qa.id, to: null });
    phone.sync();
  });
  return {
    ctx: rowContext(t.session.view(), (id) => t.session.note(id).toString(), null, LOG_STYLE),
    ids,
    session: t.session,
  };
};

const rowsOf = (m: ListModel): ItemId[] => m.sections.flatMap((s) => s.rows);

describe("scopes", () => {
  it("counts and filters each of the ten scopes, Mine empty without a me", async () => {
    const { ctx } = await crewOf();
    expect(listModel(ctx, prefs({ scope: "all", group: "none" }), null).scopeCounts).toEqual({
      open: 5,
      soon: 2,
      late: 1,
      blocked: 1,
      unscheduled: 2,
      unassigned: 4,
      milestones: 1,
      done: 1,
      all: 6,
      mine: 0,
    });
    const shown = (scope: ScopeId): ItemId[] => rowsOf(listModel(ctx, prefs({ scope, group: "none" }), null));
    expect(Object.fromEntries(SCOPE_IDS.map((s) => [s, shown(s)]))).toEqual({
      open: ["a", "b", "m", "u", "x"],
      soon: ["b", "m"],
      late: ["a"],
      blocked: ["b"],
      unscheduled: ["u", "x"],
      unassigned: ["c", "m", "u", "x"],
      milestones: ["m"],
      done: ["c"],
      all: ["a", "b", "c", "m", "u", "x"],
      mine: [],
    });
  });

  it("lists open items whose live assignees include a live me under Mine, and nothing for any other me", async () => {
    const { ids, session } = await crewOf();
    act(() => {
      session.apply({ t: "assign", items: ["c", "u"], person: ids.AR });
    });
    const mine = (me: PersonId | null): [ItemId[], number] => {
      const m = listModel(rowContext(session.view(), (id) => session.note(id).toString(), me, LOG_STYLE), prefs({ scope: "mine", group: "none" }), null);
      return [rowsOf(m), m.scopeCounts.mine];
    };
    expect(mine(ids.AR)).toEqual([["a", "b", "u"], 3]);
    expect(mine(ids.MO)).toEqual([["b"], 1]);
    expect(mine(null)).toEqual([[], 0]);
    expect(mine(ids.DL)).toEqual([[], 0]);
    expect(mine("nobody")).toEqual([[], 0]);
    expect([meOf(session.view(), ids.DL).kind, meOf(session.view(), "nobody").kind]).toEqual(["removed", "missing"]);
  });

  it("counts a former-only item as Unassigned", async () => {
    const { ctx } = await crewOf();
    expect(ctx.view.people.assignees.get("m")?.map((a) => a.kind)).toEqual(["former"]);
    expect(rowsOf(listModel(ctx, prefs({ scope: "unassigned", group: "none" }), null))).toContain("m");
  });

  it("ends Due soon seven working days on, across a weekend and a closure", async () => {
    const seed: SeedItem[] = [
      { id: "past", name: "past", start: "2026-11-05", dur: 1 },
      { id: "today", name: "today", start: "2026-11-09", dur: 1 },
      { id: "wed", name: "wed", start: "2026-11-18", dur: 1 },
      { id: "thu", name: "thu", start: "2026-11-19", dur: 1 },
      { id: "fri", name: "fri", start: "2026-11-20", dur: 1 },
      { id: "mon", name: "mon", start: "2026-11-23", dur: 1 },
      {
        id: "done",
        name: "done",
        start: "2026-11-10",
        dur: 1,
        status: "done",
        progress: 100,
      },
    ];
    const plain = await ctxOf(seed);
    expect(rowsOf(listModel(plain, prefs({ scope: "soon", group: "none" }), null))).toEqual(["today", "wed"]);
    const t = await testSession(seed, {
      calendar: {
        closures: new Map([["c1", { id: "c1", from: "2026-11-12", to: "2026-11-13", name: "Offsite" }]]),
      },
    });
    sessions.push(t.session);
    const closed = rowContext(t.session.view(), (id) => t.session.note(id).toString(), null, LOG_STYLE);
    expect(rowsOf(listModel(closed, prefs({ scope: "soon", group: "none" }), null))).toEqual(["today", "wed", "thu", "fri"]);
  });

  it("lets a ghost pass every scope and chip without being counted", async () => {
    const t = await testSession([
      { id: "S", name: "Sprint 4", kind: "group" },
      { id: "r", name: "Review", parent: "S", start: "2026-11-10", dur: 3 },
      {
        id: "x",
        name: "Other",
        start: "2026-11-16",
        dur: 2,
        status: "done",
        progress: 100,
      },
    ]);
    sessions.push(t.session);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["S"] });
    p.session.apply({ t: "rename", item: "r", name: "Review 2" });
    p.sync();
    const ctx = rowContext(t.session.view(), (id) => t.session.note(id).toString(), null, LOG_STYLE);
    expect(ctx.ghosts.has("r")).toBe(true);
    const m = listModel(
      ctx,
      prefs({
        scope: "done",
        chips: [{ f: "kind", v: "milestone" }],
        group: "none",
      }),
      null,
    );
    expect([rowsOf(m), m.scoped, m.shown, m.scopeCounts.done, m.scopeCounts.all]).toEqual([["r"], 0, 0, 0, 0]);
    expect(listModel(ctx, prefs({ scope: "done", group: "none" }), null).scopeCounts).toMatchObject({ done: 1, all: 1, open: 0 });
  });

  it("lets a ghost pass Mine only while a live me is set, since Mine without a live me lists nothing", async () => {
    const t = await testSession([
      { id: "S", name: "Sprint 4", kind: "group" },
      { id: "r", name: "Review", parent: "S", start: "2026-11-10", dur: 3 },
    ]);
    sessions.push(t.session);
    t.session.apply({ t: "person", op: "add", name: "Mira Okafor", initials: "MO", colour: "sky", after: null });
    const mira = peopleOf(t.session.view().plan)[0].id;
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["S"] });
    p.session.apply({ t: "rename", item: "r", name: "Review 2" });
    p.sync();
    const mine = (me: PersonId | null): ItemId[] => {
      const ctx = rowContext(t.session.view(), (id) => t.session.note(id).toString(), me, LOG_STYLE);
      expect(ctx.ghosts.has("r")).toBe(true);
      return rowsOf(listModel(ctx, prefs({ scope: "mine", group: "none" }), null));
    };
    expect([mine(mira), mine(null), mine("nobody")]).toEqual([["r"], [], []]);
  });
});

describe("chips", () => {
  it("ORs chips within a field and ANDs them across fields", async () => {
    const { ctx, ids } = await crewOf();
    const shown = (chips: ListPrefs["chips"]): ItemId[] => rowsOf(listModel(ctx, prefs({ scope: "all", group: "none", chips }), null));
    expect(shown([{ f: "assignee", v: ids.MO }])).toEqual(["b"]);
    expect(shown([{ f: "assignee", v: ids.AR }])).toEqual(["a", "b"]);
    expect(
      shown([
        { f: "assignee", v: ids.MO },
        { f: "assignee", v: null },
      ]),
    ).toEqual(["b", "c", "m", "u", "x"]);
    expect(
      shown([
        { f: "assignee", v: null },
        { f: "kind", v: "task" },
      ]),
    ).toEqual(["c", "u", "x"]);
    expect(shown([{ f: "group", v: "g" }])).toEqual(["a", "b"]);
    expect(
      shown([
        { f: "group", v: null },
        { f: "kind", v: "milestone" },
      ]),
    ).toEqual(["m"]);
    expect(shown([{ f: "step", v: null }])).toEqual(["x"]);
    expect(shown([{ f: "step", v: "next" }])).toEqual(["u"]);
    expect(shown([{ f: "step", v: "gone1" }])).toEqual([]);
    const m = listModel(
      ctx,
      prefs({
        scope: "open",
        group: "none",
        chips: [{ f: "kind", v: "task" }],
      }),
      null,
    );
    expect([m.scoped, m.scopeCounts.open, m.scopeCounts.all, m.scopeCounts.milestones]).toEqual([4, 4, 5, 0]);
  });

  it("toggles a chip on and off", () => {
    const one = toggleChip(DEFAULT_LIST_PREFS, { f: "step", v: "next" });
    const two = toggleChip(one, { f: "step", v: null });
    expect([one.chips, two.chips, toggleChip(two, { f: "step", v: "next" }).chips]).toEqual([
      [{ f: "step", v: "next" }],
      [
        { f: "step", v: "next" },
        { f: "step", v: null },
      ],
      [{ f: "step", v: null }],
    ]);
  });
});

describe("orders", () => {
  it("sorts No step first by step, in workflow order", async () => {
    const { ctx } = await crewOf();
    const rows = rowsOf(
      listModel(
        ctx,
        prefs({
          scope: "all",
          group: "none",
          sort: [{ id: "step", dir: "asc" }],
        }),
        null,
      ),
    );
    expect(rows[0]).toBe("x");
    const ranks = rows.map((id) => Number(columnById("step").sortKey(ctx, id)));
    expect(ranks).toEqual([...ranks].sort((p, q) => p - q));
  });

  it("sorts people in Settings order, former-only after every live person and nobody last in both directions", async () => {
    const { ctx } = await crewOf();
    const by = (dir: "asc" | "desc"): ItemId[] =>
      rowsOf(
        listModel(
          ctx,
          prefs({
            scope: "all",
            group: "none",
            sort: [{ id: "assignees", dir }],
          }),
          null,
        ),
      );
    expect(by("asc")).toEqual(["b", "a", "m", "c", "u", "x"]);
    expect(by("desc")).toEqual(["m", "a", "b", "c", "u", "x"]);
  });
});

describe("grouping", () => {
  it("groups by step, No step first, then live steps in workflow order, empty steps hidden", async () => {
    const { ctx } = await crewOf();
    const m = listModel(ctx, prefs({ scope: "all", group: "step" }), null);
    const keys = m.sections.map((s) => s.key);
    expect(m.sections[0]).toEqual({
      key: "step:none",
      title: "No step",
      swatch: null,
      group: null,
      rows: ["x"],
    });
    expect(keys.slice(1)).toEqual(ctx.board.steps.map((s) => `step:${s.id}`).filter((k) => keys.includes(k)));
    expect(m.sections.find((s) => s.key === "step:next")?.rows).toEqual(["u"]);
    expect(m.sections.find((s) => s.key === "step:done")?.rows).toEqual(["c"]);
    expect(m.sections.every((s) => s.rows.length > 0)).toBe(true);
    expect(m.sections.flatMap((s) => s.rows).sort()).toEqual(["a", "b", "c", "m", "u", "x"]);
  });

  it("groups by first live assignee, then former-only people, then Unassigned", async () => {
    const { ctx, ids } = await crewOf();
    const m = listModel(ctx, prefs({ scope: "all", group: "assignee" }), null);
    expect(m.sections.map((s) => [s.key, s.title, s.rows])).toEqual([
      [`person:${ids.MO}`, "Mira Okafor", ["b"]],
      [`person:${ids.AR}`, "Ana Ruiz", ["a"]],
      [`former:${ids.DL}`, "Former: Dana Lee", ["m"]],
      ["unassigned", "Unassigned", ["c", "u", "x"]],
    ]);
    expect(m.order).toEqual(["b", "a", "m", "c", "u", "x"]);
  });

  it("groups by the outline and by nothing, hiding emptied sections", async () => {
    const { ctx } = await crewOf();
    const outline = listModel(ctx, prefs({ scope: "all", group: "outline" }), null);
    expect(outline.sections.map((s) => [s.title, s.rows])).toEqual([
      ["Site", ["a", "b"]],
      ["Not in a group", ["c", "m", "u", "x"]],
    ]);
    const done = listModel(ctx, prefs({ scope: "done", group: "outline" }), null);
    expect(done.sections.map((s) => [s.title, s.rows])).toEqual([["Not in a group", ["c"]]]);
    const none = listModel(ctx, prefs({ scope: "open", group: "none" }), null);
    expect(none.sections.map((s) => [s.key, s.title, s.rows])).toEqual([["all", "", ["a", "b", "m", "u", "x"]]]);
    expect([none.scoped, none.shown]).toEqual([5, 5]);
  });

  it("sorts inside each group", async () => {
    const { ctx, ids } = await crewOf();
    const m = listModel(
      ctx,
      prefs({
        scope: "all",
        group: "assignee",
        sort: [{ id: "name", dir: "desc" }],
      }),
      null,
    );
    expect(m.sections.find((s) => s.key === "unassigned")?.rows).toEqual(["u", "x", "c"]);
    expect(m.sections[0].key).toBe(`person:${ids.MO}`);
  });
});
