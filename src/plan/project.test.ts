import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyWrites, childrenOf, liveLinks, PlanIncomplete, projectPlan, trashRoots } from "./project";
import { planRules } from "./rules";
import { derive } from "../domain/derive";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import type { Item, PlanState } from "../domain/model";
import type { HolidayYear } from "../domain/calendar";
import { act } from "../test/act";

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  expect(log.pending).toEqual([]);
  return log;
};

const plan0 = [w("pn", "Plan"), w("cw", [1, 2, 3, 4, 5]), w("cr", null)];

const item = (id: string, kind: "task" | "milestone" | "group", name: string, parent: string | null, order: string, s?: unknown[]): Write[] => [
  w(`e:${id}`, { k: kind, t: false }),
  w(`n:${id}`, name),
  ...(s === undefined ? [] : [w(`s:${id}`, s)]),
  w(`p:${id}`, [parent, order]),
];

const sched = (start: string | null, dur = 3): unknown[] => [start, dur, "todo", 0, "later"];

const zh: HolidayYear = {
  region: "oh:CH:CH-ZH",
  year: 2027,
  days: [{ date: "2027-01-01", name: "Neujahrstag", kind: "public", sourceId: "oh-1", scope: null }],
  fetchedAt: "2026-11-01",
};

const groups = () =>
  logOf(
    act("a0", [], [
      ...plan0,
      ...item("G", "group", "Phase", null, "a0"),
      ...item("C", "task", "Spec", "G", "a0", sched("2026-11-16")),
      ...item("D", "task", "Build", null, "a1", sched("2026-11-19")),
      w("l:C>D", ["FS", 0]),
    ]),
  );

const withAction = (log: LogState, a: Action): LogState => {
  const next = log.fork();
  expect(next.add([a]).refused).toEqual([]);
  expect(log.pending).toEqual([]);
  expect(next.pending).toEqual([]);
  return next;
};

describe("projectPlan", () => {
  it("projects every unit kind", () => {
    const log = logOf(
      act("a0", [], [
        w("pn", "Launch"),
        w("cr", { src: "openholidays", country: "CH", subdivision: "CH-ZH" }),
        w("cw", [1, 2, 3, 4]),
        w("cc:X", ["2026-12-24", "2026-12-31", "Offsite"]),
        w("cc:Y", ["2026-12-01", "2026-12-02", "Gone"]),
        w("ct:2026-12-08", { kind: "add", name: "Closing" }),
        w("ct:2026-12-09", { kind: "off" }),
        w("ch:2027", zh),
        w("b:B1", { name: "Before", at: "2026-11-08", dates: { T: { start: "2026-11-16", dur: 3 } } }),
        w("b:B2", { name: "Old", at: "2026-11-01", dates: {} }),
        ...item("G", "group", "Phase", null, "a0"),
        ...item("T", "task", "Spec", "G", "a0", ["2026-11-16", 3, "doing", 40, "now"]),
        w("r:T", { jira: "WB-1" }),
        ...item("M", "milestone", "Ship", null, "a1", ["2026-11-30", 0, "todo", 0, "later"]),
        w("l:T>M", ["FS", 2]),
        w("l:M>T", ["SS", 0]),
      ]),
      act("a1", ["a0"], [w("cc:Y", null), w("ct:2026-12-09", null), w("b:B2", null), w("l:M>T", null)]),
    );
    const expected: PlanState = {
      id: "P",
      name: "Launch",
      items: new Map<string, Item>([
        ["G", { id: "G", kind: "group", name: "Phase", trashed: false, schedule: null, place: { parent: null, order: "a0" }, refs: {} }],
        [
          "M",
          {
            id: "M",
            kind: "milestone",
            name: "Ship",
            trashed: false,
            schedule: { start: "2026-11-30", dur: 0, status: "todo", progress: 0, horizon: "later" },
            place: { parent: null, order: "a1" },
            refs: {},
          },
        ],
        [
          "T",
          {
            id: "T",
            kind: "task",
            name: "Spec",
            trashed: false,
            schedule: { start: "2026-11-16", dur: 3, status: "doing", progress: 40, horizon: "now" },
            place: { parent: "G", order: "a0" },
            refs: { jira: "WB-1" },
          },
        ],
      ]),
      links: new Map([["T>M", { from: "T", to: "M", type: "FS", lag: 2 }]]),
      calendar: {
        region: { src: "openholidays", country: "CH", subdivision: "CH-ZH" },
        workdays: [1, 2, 3, 4],
        closures: new Map([["X", { id: "X", from: "2026-12-24", to: "2026-12-31", name: "Offsite" }]]),
        tuning: new Map([["2026-12-08", { kind: "add", name: "Closing" }]]),
        holidays: new Map([[2027, zh]]),
      },
      baselines: new Map([["B1", { id: "B1", name: "Before", at: "2026-11-08", dates: { T: { start: "2026-11-16", dur: 3 } } }]]),
    };
    expect(projectPlan("P", log)).toEqual(expected);
  });

  it("throws PlanIncomplete before the plan name, holiday region and working week exist", () => {
    expect(() => projectPlan("P", new LogState(planRules))).toThrow(PlanIncomplete);
    expect(() => projectPlan("P", logOf(act("a0", [], [w("pn", "Plan"), w("cr", null)])))).toThrow(PlanIncomplete);
    expect(() => projectPlan("P", logOf(act("a0", [], [w("cw", [1]), w("cr", null)])))).toThrow(PlanIncomplete);
    expect(() => projectPlan("P", logOf(act("a0", [], [w("pn", "Plan"), w("cw", [1])])))).toThrow(
      new PlanIncomplete("Plan P is not complete yet: it has no holiday region"),
    );
    expect(projectPlan("P", logOf(act("a0", [], [w("pn", "Plan"), w("cw", [1]), w("cr", null)]))).calendar.region).toBeNull();
  });

  it("sorts siblings by order, then id", () => {
    const log = logOf(
      act("a0", [], [
        ...plan0,
        ...item("B", "task", "B", null, "a0", sched(null)),
        ...item("A", "task", "A", null, "a0", sched(null)),
        ...item("C", "task", "C", null, "Zz", sched(null)),
        ...item("G", "group", "G", null, "b0"),
        ...item("Y", "task", "Y", "G", "a0", sched(null)),
        ...item("X", "task", "X", "G", "a0", sched(null)),
      ]),
    );
    const plan = projectPlan("P", log);
    expect(childrenOf(plan, null).map((i) => i.id)).toEqual(["C", "A", "B", "G"]);
    expect(childrenOf(plan, "G").map((i) => i.id)).toEqual(["X", "Y"]);
    expect(childrenOf(plan, "A")).toEqual([]);
  });

  it("hides the children of a trashed group without rewriting them and restores them with it", () => {
    const log = groups();
    const trashed = withAction(log, act("t1", ["a0"], [w("e:G", { k: "group", t: true })]));
    const plan = projectPlan("P", trashed);
    expect(plan.items.get("C")?.trashed).toBe(true);
    expect(plan.items.get("D")?.trashed).toBe(false);
    expect(trashRoots(plan)).toEqual(["G"]);
    expect(trashed.unit("e:C")?.value).toEqual({ k: "task", t: false });
    expect([...plan.links.keys()]).toEqual(["C>D"]);
    expect(liveLinks(plan)).toEqual([]);
    const restored = projectPlan("P", withAction(trashed, act("t2", ["t1"], [w("e:G", { k: "group", t: false })])));
    expect(restored.items.get("C")?.trashed).toBe(false);
    expect(trashRoots(restored)).toEqual([]);
    expect(liveLinks(restored)).toEqual([{ from: "C", to: "D", type: "FS", lag: 0 }]);
  });

  it("keeps a link out of liveLinks when an end is a group or missing", () => {
    const log = logOf(
      act("a0", [], [
        ...plan0,
        ...item("G", "group", "Phase", null, "a0"),
        ...item("C", "task", "Spec", null, "a1", sched("2026-11-16")),
        w("l:G>C", ["FS", 0]),
        w("l:C>Q", ["FS", 0]),
      ]),
    );
    const plan = projectPlan("P", log);
    expect([...plan.links.keys()]).toEqual(["C>Q", "G>C"]);
    expect(liveLinks(plan)).toEqual([]);
  });

  it("projects an item whose create was undone after another device built on it as trashed", () => {
    const c = act("c", ["a0"], item("X", "task", "Draft", null, "a5", sched("2026-11-16")));
    const r = act("r", ["c"], [w("n:X", "Y")], { dev: "d2" });
    const u = act("u", ["r"], [w("a:c", false, "undo")], { meta: { undo: "c" } });
    const log = logOf(act("a0", [], plan0), c, r, u);
    expect(log.unit("e:X")).toBeUndefined();
    const plan = projectPlan("P", log);
    expect(plan.items.get("X")).toEqual({
      id: "X",
      kind: "task",
      name: "Y",
      trashed: true,
      schedule: { start: "2026-11-16", dur: 3, status: "todo", progress: 0, horizon: "later" },
      place: { parent: null, order: "a5" },
      refs: {},
    });
    expect(trashRoots(plan)).toEqual(["X"]);
    const back = projectPlan("P", withAction(log, act("b", ["u"], [w("e:X", { k: "task", t: false })])));
    expect(back.items.get("X")).toEqual({ ...plan.items.get("X"), trashed: false });
  });

  it("projects an orphaned milestone and group as trashed with their own kinds", () => {
    const c = act("c", ["a0"], [...item("M", "milestone", "Ship", null, "a6", sched("2026-11-30", 0)), ...item("G", "group", "Phase", null, "a7")]);
    const r = act("r", ["c"], [w("n:M", "Ship it"), w("n:G", "Phase 2")], { dev: "d2" });
    const u = act("u", ["r"], [w("a:c", false, "undo")], { meta: { undo: "c" } });
    const plan = projectPlan("P", logOf(act("a0", [], plan0), c, r, u));
    expect(["M", "G"].map((id) => plan.items.get(id))).toEqual([
      { id: "M", kind: "milestone", name: "Ship it", trashed: true, schedule: { start: "2026-11-30", dur: 0, status: "todo", progress: 0, horizon: "later" }, place: { parent: null, order: "a6" }, refs: {} },
      { id: "G", kind: "group", name: "Phase 2", trashed: true, schedule: null, place: { parent: null, order: "a7" }, refs: {} },
    ]);
    expect(trashRoots(plan)).toEqual(["G", "M"]);
  });

  it("names an item it cannot rebuild", () => {
    const one = (...ws: Write[]) => () => projectPlan("P", logOf(act("a0", [], [...plan0, ...ws])));
    expect(one(...item("G", "group", "Phase", null, "a0", sched("2026-11-16")))).toThrow(new Error("Group G has a schedule"));
    expect(one(...item("T", "task", "Spec", null, "a0"))).toThrow(new Error("Item T has no schedule"));
    expect(one(w("n:X", "Lost"), w("p:X", [null, "a0"]))).toThrow(new Error("Item X has no existence"));
    expect(one(w("e:X", { k: "group", t: false }), w("p:X", [null, "a0"]))).toThrow(new Error("Item X has no name"));
    expect(one(w("e:X", { k: "group", t: false }), w("n:X", "Lost"))).toThrow(new Error("Item X has no place"));
  });

  it("drops an item none of whose units has a live value", () => {
    const c = act("c", ["a0"], item("X", "task", "Draft", null, "a5", sched("2026-11-16")));
    const log = logOf(act("a0", [], plan0), c, act("u", ["c"], [w("a:c", false, "undo")]));
    expect(projectPlan("P", log).items.has("X")).toBe(false);
  });

  it("projects a missing or non-group parent as top level", () => {
    const log = logOf(
      act("a0", [], [
        ...plan0,
        ...item("T", "task", "Task", null, "a0", sched("2026-11-16")),
        ...item("X", "task", "Under a task", "T", "a0", sched("2026-11-16")),
        ...item("Y", "task", "Under nothing", "Q", "a0", sched("2026-11-16")),
        ...item("S", "group", "Self", "S", "a0"),
      ]),
    );
    const plan = projectPlan("P", log);
    expect(["X", "Y", "S"].map((id) => plan.items.get(id)?.place)).toEqual([
      { parent: null, order: "a0" },
      { parent: null, order: "a0" },
      { parent: null, order: "a0" },
    ]);
    expect(() => derive(plan, new Set(), "2026-11-08")).not.toThrow();
  });

  it("shows the smaller id at top level in a parent loop made apart", () => {
    const log = logOf(
      act("a0", [], [...plan0, ...item("A", "group", "A", null, "a0"), ...item("B", "group", "B", null, "a1"), ...item("K", "task", "K", "A", "a0", sched("2026-11-16"))]),
      act("m1", ["a0"], [w("p:A", ["B", "a0"])]),
      act("m2", ["a0"], [w("p:B", ["A", "a0"])], { dev: "d2" }),
    );
    const plan = projectPlan("P", log);
    expect(plan.items.get("A")?.place).toEqual({ parent: null, order: "a0" });
    expect(plan.items.get("B")?.place).toEqual({ parent: "A", order: "a0" });
    expect(childrenOf(plan, null).map((i) => i.id)).toEqual(["A"]);
    expect(() => derive(plan, new Set(), "2026-11-08")).not.toThrow();
  });

  it("never yields a parent that is missing, not a group, or in a loop", () => {
    const ids = ["A", "B", "C", "D", "E"];
    const kinds = fc.constantFrom<"task" | "milestone" | "group">("task", "milestone", "group", "group");
    const parent = fc.constantFrom<string | null>(null, "A", "B", "C", "D", "E", "Q");
    const moves = fc.array(fc.tuple(fc.constantFrom(...ids), parent), { maxLength: 4 });
    fc.assert(
      fc.property(fc.array(fc.tuple(kinds, parent), { minLength: 5, maxLength: 5 }), moves, moves, (spec, left, right) => {
        const root = act("a0", [], [
          ...plan0,
          ...spec.flatMap(([k, p], i) => item(ids[i], k, ids[i], p, "a0", k === "group" ? undefined : sched("2026-11-16", k === "task" ? 2 : 0))),
        ]);
        const branch = (dev: string, ms: readonly [string, string | null][]) =>
          ms.map(([id, p], i) => act(`${dev}${i}`, [i === 0 ? "a0" : `${dev}${i - 1}`], [w(`p:${id}`, [p, "a0"])], { dev }));
        const plan = projectPlan("P", logOf(root, ...branch("L", left), ...branch("R", right)));
        [...plan.items.values()].forEach((it) => {
          const p = it.place.parent;
          if (p !== null) expect(plan.items.get(p)?.kind).toBe("group");
        });
        expect(() => derive(plan, new Set(), "2026-11-08")).not.toThrow();
      }),
    );
  });

  it("refuses a task shorter than one working day", () => {
    const log = logOf(act("a0", [], [...plan0, ...item("T", "task", "T", null, "a0", ["2026-11-16", 0, "todo", 0, "later"])]));
    expect(() => projectPlan("P", log)).toThrow(new Error("Task T has a duration under 1 working day"));
  });
});

describe("trashRoots", () => {
  it("names an item whose parent is not in the plan", () => {
    const plan = projectPlan("P", groups());
    const c = plan.items.get("C") as Item;
    const broken: PlanState = { ...plan, items: new Map([["C", { ...c, trashed: true, place: { parent: "Q", order: "a0" } }]]) };
    expect(() => trashRoots(broken)).toThrow(new Error("Item C has a parent Q that is not in the plan"));
  });
});

describe("applyWrites", () => {
  const cases: [string, Write[]][] = [
    ["a head rename", [w("n:C", "Build it")]],
    ["a move", [w("p:D", ["G", "a1"])]],
    ["a group trash", [w("e:G", { k: "group", t: true })]],
    ["a create", item("N", "milestone", "New", "G", "a2", sched("2026-12-01", 0))],
    ["a calendar change", [w("cc:Z", ["2026-12-24", "2026-12-31", "Offsite"]), w("cw", [1, 2, 3])]],
    ["a link removal", [w("l:C>D", null)]],
  ];

  it.each(cases)("equals projectPlan after adding %s", (_, writes) => {
    const log = groups();
    const a = act("h1", log.heads, writes);
    const after = projectPlan("P", withAction(log, a));
    expect(applyWrites(projectPlan("P", log), a.w)).toEqual(after);
  });

  it("lets the children of a trashed group follow it", () => {
    const log = groups();
    const plan = applyWrites(projectPlan("P", log), [w("e:G", { k: "group", t: true })]);
    expect(plan.items.get("C")?.trashed).toBe(true);
    expect(applyWrites(plan, [w("e:G", { k: "group", t: false })]).items.get("C")?.trashed).toBe(false);
  });

  it("refuses activity writes", () => {
    expect(() => applyWrites(projectPlan("P", groups()), [w("a:a0", false, "undo")])).toThrow(new Error("applyWrites cannot apply a:a0"));
  });

  it("refuses a plan it did not project", () => {
    const plan = projectPlan("P", groups());
    expect(() => applyWrites({ ...plan }, [w("n:C", "X")])).toThrow(new Error("applyWrites needs a plan made by projectPlan or applyWrites"));
  });

  it("refuses two writes to one unit, as the log does", () => {
    const log = groups();
    const writes = [w("n:C", "First"), w("n:C", "Second")];
    expect(() => applyWrites(projectPlan("P", log), writes)).toThrow(new Error("applyWrites: n:C written twice"));
    expect(log.fork().add([act("h1", log.heads, writes)]).refused.map((r) => r.id)).toEqual(["h1"]);
  });
});
