import { describe, expect, it } from "vitest";
import type { PersonValue } from "../domain/model";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import { act } from "../test/act";
import { formerPeople, lastNonNull, lastPersonValue } from "./former";
import { projectPlan } from "./project";
import { planRules } from "./rules";

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const HEAD: Write[] = [w("pn", "MESA 1.0"), w("cw", [1, 2, 3, 4, 5]), w("cr", null)];

const task = (id: string, order: string): Write[] => [
  w(`e:${id}`, { k: "task", t: false }),
  w(`n:${id}`, `Task ${id}`),
  w(`s:${id}`, ["2026-11-10", 3, "todo", 0, "later"]),
  w(`p:${id}`, [null, order]),
];

const MIRA: PersonValue = { n: "Mira Okafor", i: "MO", c: "cyan", o: "a1" };
const OLE: PersonValue = { n: "Ole Berg", i: "OB", c: "lime", o: "a0" };

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  expect(log.add(actions).refused).toEqual([]);
  expect(log.pending).toEqual([]);
  return log;
};

describe("lastPersonValue", () => {
  it("takes the last non-null value, skipping a later removal", () => {
    const log = logOf(
      act("a0", [], [...HEAD, w("pp:mira", { ...MIRA, n: "Mira" })]),
      act("r", ["a0"], [w("pp:mira", MIRA)]),
      act("x", ["r"], [w("pp:mira", null)]),
    );
    expect(lastPersonValue(log, "mira")).toEqual(MIRA);
  });

  it("reads inactive writers: an undone add still names the person", () => {
    const log = logOf(act("a0", [], HEAD), act("add", ["a0"], [w("pp:mira", MIRA)]), act("u", ["add"], [w("a:add", false, "undo")], { meta: { undo: "add" } }));
    expect(log.unit("pp:mira")).toBeUndefined();
    expect(lastPersonValue(log, "mira")).toEqual(MIRA);
  });

  it("is null for an id never written, or written only as null", () => {
    const log = logOf(act("a0", [], [...HEAD, w("pp:gone", null)]));
    expect(lastPersonValue(log, "gone")).toBeNull();
    expect(lastPersonValue(log, "nobody")).toBeNull();
  });
});

describe("lastNonNull", () => {
  it("decodes the last non-null write of any unit with its codec, reading inactive writers", () => {
    const QA = { n: "QA", c: "amber", o: "a1V" };
    const log = logOf(
      act("a0", [], [...HEAD, w("ws:qa", QA)]),
      act("s", ["a0"], [w("ws:qa", { ...QA, n: "Checks" })]),
      act("x", ["s"], [w("ws:qa", null)]),
      act("u", ["x"], [w("a:s", false, "undo")], { meta: { undo: "s" } }),
    );
    expect(lastNonNull(log, "ws:qa", "step")).toEqual({ ...QA, n: "Checks" });
    expect(lastNonNull(log, "ws:none", "step")).toBeNull();
  });

  it("throws when a writer's value does not decode with the codec named", () => {
    const log = logOf(act("a0", [], [...HEAD, w("pp:mira", MIRA)]));
    expect(() => lastNonNull(log, "pp:mira", "step")).toThrow("pp:mira: value has unknown fields i");
  });
});

describe("formerPeople", () => {
  it("covers every stored id that is not live, with its last value, and leaves out live and never-named ids", () => {
    const log = logOf(
      act("a0", [], [...HEAD, ...task("A", "a0"), ...task("B", "a1"), w("pp:mira", MIRA), w("pp:ole", OLE), w("pp:zed", { ...OLE, n: "Zed Lund", i: "ZL" })]),
      act("x", ["a0"], [w("pp:mira", null), w("pa:A", ["mira", "ole"]), w("pa:B", ["nobody", "zed"])]),
    );
    const plan = projectPlan("P", log);
    expect(formerPeople(log, plan)).toEqual(new Map([["mira", MIRA]]));
  });

  it("is empty for a plan without assignees", () => {
    const log = logOf(act("a0", [], [...HEAD, w("pp:mira", null)]));
    expect(formerPeople(log, projectPlan("P", log))).toEqual(new Map());
  });
});
