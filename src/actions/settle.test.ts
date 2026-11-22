import { describe, expect, it } from "vitest";
import { LogState } from "../log/state";
import type { Action, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf } from "../test/planCtx";
import { subjectOf } from "./settle";

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
});
