import { describe, expect, it } from "vitest";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { BUILT_IN_DEFAULTS, defaultsOf, projectDefaults, type DefaultNames } from "./defaults";
import type { DefaultsValue, PlanState } from "./model";

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const HEAD: Write[] = [w("pn", "MESA 1.0"), w("cw", [1, 2, 3, 4, 5]), w("cr", null)];

const group = (id: string, name: string, parent: string | null, order: string, trashed = false): Write[] => [
  w(`e:${id}`, { k: "group", t: trashed }),
  w(`n:${id}`, name),
  w(`p:${id}`, [parent, order]),
];

const task = (id: string, name: string, parent: string | null, order: string): Write[] => [
  w(`e:${id}`, { k: "task", t: false }),
  w(`n:${id}`, name),
  w(`s:${id}`, ["2026-11-10", 3, "todo", 0, "later"]),
  w(`p:${id}`, [parent, order]),
];

const MIRA = { n: "Mira Okafor", i: "MO", c: "cyan", o: "a0" };
const REVIEW = { n: "Review", c: "amber", o: "a15" };

const NO_NAMES: DefaultNames = { who: null, group: null, step: null };

const planOf = (writes: readonly Write[], pd?: DefaultsValue): PlanState => {
  const log = new LogState(planRules);
  const actions: Action[] = [act("a0", [], [...HEAD, ...writes, ...(pd === undefined ? [] : [w("pd", pd)])])];
  expect(log.add(actions).refused).toEqual([]);
  return projectPlan("P", log);
};

const BASE: Write[] = [
  ...group("g1", "Commission", null, "a0"),
  ...group("g2", "Mirror cell", "g1", "a0"),
  ...task("t1", "Polish mirror", "g2", "a0"),
  w("pp:mira", MIRA),
  w("pp:dana", null),
  w("ws:review", REVIEW),
  w("ws:qa", null),
];

const stored = (o: Partial<DefaultsValue>): DefaultsValue => ({ dur: 5, dated: false, who: null, group: null, step: null, ...o });

describe("defaultsOf", () => {
  it("is the built-in value when the plan stores none", () => {
    const plan = planOf(BASE);
    expect(plan.defaults).toBeNull();
    expect(defaultsOf(plan)).toBe(BUILT_IN_DEFAULTS);
    expect(BUILT_IN_DEFAULTS).toEqual({ dur: 3, dated: true, who: null, group: null, step: null });
  });

  it("is the stored value", () => {
    const value = stored({ who: "mira" });
    expect(defaultsOf(planOf(BASE, value))).toEqual(value);
  });
});

describe("projectDefaults", () => {
  it("without pd is the built-in value with nothing gone", () => {
    expect(projectDefaults(planOf(BASE), NO_NAMES)).toEqual({ ...BUILT_IN_DEFAULTS, stored: null, gone: [] });
  });

  it("follows a live person, a live group and a live open step", () => {
    const value = stored({ who: "mira", group: "g2", step: "review" });
    expect(projectDefaults(planOf(BASE, value), NO_NAMES)).toEqual({ ...value, stored: value, gone: [] });
  });

  it("follows a virtual step that is still open", () => {
    const value = stored({ step: "next" });
    expect(projectDefaults(planOf(BASE, value), NO_NAMES)).toEqual({ ...value, stored: value, gone: [] });
  });

  it("names a removed person, named and unnamed", () => {
    const named = stored({ who: "dana" });
    expect(projectDefaults(planOf(BASE, named), { ...NO_NAMES, who: "Dana Lee" })).toEqual({
      ...named,
      who: null,
      stored: named,
      gone: [{ field: "who", id: "dana", name: "Dana Lee", why: "removed" }],
    });
    const unnamed = stored({ who: "zed" });
    expect(projectDefaults(planOf(BASE, unnamed), NO_NAMES).gone).toEqual([{ field: "who", id: "zed", name: null, why: "removed" }]);
  });

  it("names a trashed group and a group under a trashed ancestor", () => {
    const own = stored({ group: "g1" });
    const trashedOwn = planOf([...BASE.filter((x) => x.u !== "e:g1"), w("e:g1", { k: "group", t: true })], own);
    expect(projectDefaults(trashedOwn, NO_NAMES)).toEqual({ ...own, group: null, stored: own, gone: [{ field: "group", id: "g1", name: "Commission", why: "trashed" }] });
    const inner = stored({ group: "g2" });
    const trashedAbove = planOf([...BASE.filter((x) => x.u !== "e:g1"), w("e:g1", { k: "group", t: true })], inner);
    expect(projectDefaults(trashedAbove, NO_NAMES).gone).toEqual([{ field: "group", id: "g2", name: "Mirror cell", why: "trashed" }]);
  });

  it("calls a group missing when it is absent, named from the log or unnamed, and says an item that is not a group is one", () => {
    const absent = stored({ group: "g9" });
    expect(projectDefaults(planOf(BASE, absent), { ...NO_NAMES, group: "Dome" })).toEqual({
      ...absent,
      group: null,
      stored: absent,
      gone: [{ field: "group", id: "g9", name: "Dome", why: "missing" }],
    });
    expect(projectDefaults(planOf(BASE, absent), NO_NAMES).gone).toEqual([{ field: "group", id: "g9", name: null, why: "missing" }]);
    const notGroup = stored({ group: "t1" });
    expect(projectDefaults(planOf(BASE, notGroup), { ...NO_NAMES, group: "Polish mirror" }).gone).toEqual([{ field: "group", id: "t1", name: "Polish mirror", why: "notGroup" }]);
  });

  it("names a deleted step, named and unnamed, and a completing step", () => {
    const deleted = stored({ step: "qa" });
    expect(projectDefaults(planOf(BASE, deleted), { ...NO_NAMES, step: "Checks" })).toEqual({
      ...deleted,
      step: null,
      stored: deleted,
      gone: [{ field: "step", id: "qa", name: "Checks", why: "deleted" }],
    });
    const never = stored({ step: "zz" });
    expect(projectDefaults(planOf(BASE, never), NO_NAMES).gone).toEqual([{ field: "step", id: "zz", name: null, why: "deleted" }]);
    const completes = stored({ step: "done" });
    expect(projectDefaults(planOf(BASE, completes), NO_NAMES).gone).toEqual([{ field: "step", id: "done", name: "Done", why: "completes" }]);
  });

  it("lists every gone field in the order who, group, step", () => {
    const value = stored({ who: "dana", group: "g9", step: "qa" });
    expect(projectDefaults(planOf(BASE, value), { who: "Dana Lee", group: null, step: "Checks" }).gone.map((g) => g.field)).toEqual(["who", "group", "step"]);
  });

  it("by dates the step is neither followed nor gone", () => {
    const datesOnly = BASE.filter((x) => !x.u.startsWith("ws:"));
    expect(projectDefaults(planOf(datesOnly, stored({ step: "review" })), NO_NAMES)).toEqual({
      ...stored({ step: "review" }),
      step: null,
      stored: stored({ step: "review" }),
      gone: [],
    });
    expect(projectDefaults(planOf(datesOnly, stored({ step: "zz" })), { ...NO_NAMES, step: "Gone" }).gone).toEqual([]);
  });
});
