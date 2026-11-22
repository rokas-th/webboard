import { describe, expect, it } from "vitest";
import { LogState } from "../log/state";
import type { Action, Write } from "../log/types";
import { formerPeople } from "../plan/former";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import type { PersonValue, PlanState } from "./model";
import { initialsOf, peopleOf, personNameKey, projectPeople, storedAssigneesOf } from "./people";

const w = (u: string, v: unknown): Write => ({ u, v, c: "own" });

const task = (id: string, order: string, parent: string | null = null): Write[] => [
  w(`e:${id}`, { k: "task", t: false }),
  w(`n:${id}`, `Task ${id}`),
  w(`s:${id}`, ["2026-11-10", 3, "todo", 0, "later"]),
  w(`p:${id}`, [parent, order]),
];

const group = (id: string, order: string): Write[] => [w(`e:${id}`, { k: "group", t: false }), w(`n:${id}`, `Group ${id}`), w(`p:${id}`, [null, order])];

const HEAD: Write[] = [w("pn", "MESA 1.0"), w("cw", [1, 2, 3, 4, 5]), w("cr", null)];

const MIRA: PersonValue = { n: "Mira Okafor", i: "MO", c: "cyan", o: "a1" };
const OLE: PersonValue = { n: "Ole Berg", i: "OB", c: "lime", o: "a0" };
const ANA: PersonValue = { n: "Ana Ruiz", i: "AR", c: "amber", o: "a1" };

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  expect(log.add(actions).refused).toEqual([]);
  expect(log.pending).toEqual([]);
  return log;
};

const planOf = (...writes: Write[][]): PlanState => projectPlan("P", logOf(act("a0", [], [...HEAD, ...writes.flat()])));

describe("peopleOf", () => {
  it("lists live people by order, then id, and leaves out removed ones", () => {
    const plan = planOf([w("pp:mira", MIRA), w("pp:ole", OLE), w("pp:ana", ANA), w("pp:gone", null)]);
    expect(peopleOf(plan)).toEqual([
      { id: "ole", name: "Ole Berg", initials: "OB", colour: "lime", order: "a0" },
      { id: "ana", name: "Ana Ruiz", initials: "AR", colour: "amber", order: "a1" },
      { id: "mira", name: "Mira Okafor", initials: "MO", colour: "cyan", order: "a1" },
    ]);
    expect(peopleOf(planOf())).toEqual([]);
  });
});

describe("storedAssigneesOf", () => {
  it("reads the stored list, and an empty list for absent, null and []", () => {
    const plan = planOf(task("A", "a0"), task("B", "a1"), task("C", "a2"), task("D", "a3"), [w("pa:A", ["mira", "ole"]), w("pa:B", null), w("pa:C", [])]);
    expect(storedAssigneesOf(plan, "A")).toEqual(["mira", "ole"]);
    expect(storedAssigneesOf(plan, "B")).toEqual([]);
    expect(storedAssigneesOf(plan, "C")).toEqual([]);
    expect(storedAssigneesOf(plan, "D")).toEqual([]);
  });
});

describe("initialsOf", () => {
  it.each([
    ["Mira Okafor", "MO"],
    ["Lab", "L"],
    ["ana de la Ruiz", "AR"],
    ["ßa", "ß"],
    ["ole  berg", "OB"],
    ["🔭 Scope", "🔭S"],
  ])("%s gives %s", (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });

  it("throws for a name without a word", () => {
    expect(() => initialsOf("  ")).toThrow('No initials for the name "  "');
  });
});

describe("personNameKey", () => {
  it("compares names case-insensitively", () => {
    expect(personNameKey("Mira Okafor")).toBe(personNameKey("mira okafor"));
    expect(personNameKey("Mira")).not.toBe(personNameKey("Mila"));
  });
});

describe("projectPeople", () => {
  it("lists live assignees in Settings order, then former ones by id, for every item with a non-empty list, trashed included", () => {
    const plan = planOf(
      task("A", "a0"),
      task("B", "a1"),
      task("C", "a2").map((x) => (x.u === "e:C" ? w("e:C", { k: "task", t: true }) : x)),
      group("G", "a3"),
      [w("pp:mira", MIRA), w("pp:ole", OLE), w("pp:zed", null)],
      [w("pa:A", ["mira", "ole", "yan", "zed"]), w("pa:B", null), w("pa:C", ["mira"])],
    );
    expect(plan.items.get("C")?.trashed).toBe(true);
    const former = new Map<string, PersonValue>([["zed", { n: "Zed Lund", i: "ZL", c: "coral", o: "a5" }]]);
    const p = projectPeople(plan, former);
    const ole = { id: "ole", name: "Ole Berg", initials: "OB", colour: "lime", order: "a0" };
    const mira = { id: "mira", name: "Mira Okafor", initials: "MO", colour: "cyan", order: "a1" };
    expect(p.people).toEqual([ole, mira]);
    expect(p.assignees).toEqual(
      new Map([
        [
          "A",
          [
            { kind: "live", person: ole },
            { kind: "live", person: mira },
            { kind: "former", id: "yan", name: null, initials: null, colour: null },
            { kind: "former", id: "zed", name: "Zed Lund", initials: "ZL", colour: "coral" },
          ],
        ],
        ["C", [{ kind: "live", person: mira }]],
      ]),
    );
    expect(p.problems).toEqual([]);
  });

  it("yields one assignee for every stored id, none dropped", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const plan = planOf(task("A", "a0"), [w("pp:c", { ...MIRA, o: "a2" }), w("pp:f", { ...OLE, o: "a1" }), w("pa:A", ids)]);
    const listed = projectPeople(plan, new Map()).assignees.get("A");
    if (listed === undefined) throw new Error("A has no assignees");
    expect(listed).toHaveLength(8);
    expect(listed.map((x) => (x.kind === "live" ? x.person.id : x.id))).toEqual(["f", "c", "a", "b", "d", "e", "g", "h"]);
  });

  it("reports live people whose names differ only in case as sameName, as data", () => {
    const plan = planOf([w("pp:mira", MIRA), w("pp:mira2", { ...MIRA, n: "mira okafor", o: "a2" }), w("pp:ole", OLE)]);
    expect(projectPeople(plan, new Map()).problems).toEqual([{ kind: "sameName", people: ["mira", "mira2"] }]);
  });

  it("takes former values from the log, including an undone add, and a never-written id has no name", () => {
    const log = logOf(
      act("a0", [], [...HEAD, ...task("A", "a0")]),
      act("add", ["a0"], [w("pp:mira", MIRA)]),
      act("as", ["add"], [w("pa:A", ["mira", "nobody"])], { dev: "d2" }),
      act("u", ["as"], [{ u: "a:add", v: false, c: "undo" }], { meta: { undo: "add" } }),
    );
    const plan = projectPlan("P", log);
    expect(plan.people.persons.size).toBe(0);
    const p = projectPeople(plan, formerPeople(log, plan));
    expect(p.assignees.get("A")).toEqual([
      { kind: "former", id: "mira", name: "Mira Okafor", initials: "MO", colour: "cyan" },
      { kind: "former", id: "nobody", name: null, initials: null, colour: null },
    ]);
  });
});
