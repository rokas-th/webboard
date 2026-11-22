import { describe, expect, it } from "vitest";
import { LogState } from "../log/state";
import type { Action, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf } from "../test/planCtx";
import { itemOfUnit, subjectOf } from "./settle";

const w = (u: string, v: unknown): Write => ({ u, v, c: "own" });

const ROOT: Write[] = [w("pn", "MESA 1.0"), w("cw", [1, 2, 3, 4, 5]), w("cr", null)];

const planOf = (...rest: Action[]) => {
  const log = new LogState(planRules);
  expect(log.add([act("a0", [], ROOT), ...rest]).refused).toEqual([]);
  return { log, plan: ctxOf(log, "d1", "2026-11-09").view.plan };
};

describe("settle subjects", () => {
  it("names a live step, a removed step from its last written value, and a step never written", () => {
    const { log, plan } = planOf(act("s1", ["a0"], [w("ws:qa", { n: "QA", c: "amber", o: "a1V" })]), act("s2", ["s1"], [w("ws:qa", null), w("ws:now", null), w("ws:zz", null)]));
    expect(subjectOf(log, [plan], [], ["ws:next"])).toBe("the step “Next”");
    expect(subjectOf(log, [plan], [], ["ws:qa"])).toBe("the removed step “QA”");
    expect(subjectOf(log, [plan], [], ["ws:now"])).toBe("the removed step “Now”");
    expect(subjectOf(log, [plan], [], ["ws:zz"])).toBe("a removed step");
  });

  it("names a live person, a removed person from its last written value, and a person never written", () => {
    const { log, plan } = planOf(
      act("s1", ["a0"], [w("pp:mira", { n: "Mira Okafor", i: "MO", c: "cyan", o: "a0" }), w("pp:ole", { n: "Ole Berg", i: "OB", c: "lime", o: "a1" })]),
      act("s2", ["s1"], [w("pp:ole", null), w("pp:zz", null)]),
    );
    expect(subjectOf(log, [plan], [], ["pp:mira"])).toBe("the person “Mira Okafor”");
    expect(subjectOf(log, [plan], [], ["pp:ole"])).toBe("the removed person “Ole Berg”");
    expect(subjectOf(log, [plan], [], ["pp:zz"])).toBe("a removed person");
  });

  it("reads an assignees unit as its item's unit", () => {
    expect(itemOfUnit("pa:A")).toBe("A");
    expect(itemOfUnit("pp:mira")).toBeNull();
  });
});
