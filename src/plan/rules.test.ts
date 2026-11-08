import { describe, expect, it } from "vitest";
import { planRules } from "./rules";
import type { Write } from "../log/types";
import { LogState } from "../log/state";
import { act } from "../test/act";

const year = (fetchedAt: string, kind = "public") => ({
  region: "oh:CH:CH-ZH",
  year: 2027,
  days: [{ date: "2027-01-01", name: "Neujahrstag", kind, sourceId: "oh-1", scope: null }],
  fetchedAt,
});

const push = (start: string | null): Write => ({ u: "s:x", v: [start, 3, "todo", 0, "later"], c: "push" });

describe("planRules.same", () => {
  it("ignores fetchedAt of a holiday year but not its days", () => {
    expect(planRules.same("ch:2027", year("2026-11-01"), year("2026-11-08"))).toBe(true);
    expect(planRules.same("ch:2027", year("2026-11-01"), year("2026-11-01", "optional"))).toBe(false);
    expect(planRules.same("ch:2027", year("2026-11-01"), { ...year("2026-11-01"), region: "oh:CH:CH-BE" })).toBe(false);
    expect(planRules.same("ch:2027", null, null)).toBe(true);
    expect(planRules.same("ch:2027", null, year("2026-11-01"))).toBe(false);
  });

  it("compares other values deeply, ignoring key order", () => {
    expect(planRules.same("r:x", { a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
    expect(planRules.same("r:x", { a: "1" }, { a: "1", b: "2" })).toBe(false);
    expect(planRules.same("s:x", ["2026-11-16", 3, "todo", 0, "later"], ["2026-11-16", 3, "todo", 0, "later"])).toBe(true);
    expect(planRules.same("s:x", ["2026-11-16", 3, "todo", 0, "later"], ["2026-11-17", 3, "todo", 0, "later"])).toBe(false);
    expect(planRules.same("l:a>b", null, ["FS", 0])).toBe(false);
    expect(planRules.same("a:x", false, false)).toBe(true);
  });

  it("throws on an unknown unit", () => {
    expect(() => planRules.same("x:1", 1, 1)).toThrow("Unknown unit key “x:1”");
  });
});

describe("planRules.mergeDerived", () => {
  it("keeps the later start of a schedule and returns one of its inputs", () => {
    const early = push("2026-11-16");
    const late = push("2026-11-20");
    expect(planRules.mergeDerived("s:x", early, late)).toBe(late);
    expect(planRules.mergeDerived("s:x", late, early)).toBe(late);
    const tie = push("2026-11-16");
    expect(planRules.mergeDerived("s:x", early, tie)).toBe(tie);
    expect(planRules.mergeDerived("s:x", tie, early)).toBe(early);
  });

  it("refuses derived writes to every other unit and schedules without a start", () => {
    const w: Write = { u: "n:x", v: "A", c: "push" };
    expect(() => planRules.mergeDerived("n:x", w, w)).toThrow("Derived write to n:x");
    expect(() => planRules.mergeDerived("p:x", w, w)).toThrow("Derived write to p:x");
    expect(() => planRules.mergeDerived("s:x", push(null), push("2026-11-16"))).toThrow("s:x");
  });

  it("merges concurrent pushes inside a LogState to the later start", () => {
    const log = new LogState(planRules);
    const s = (start: string): Write => ({ u: "s:x", v: [start, 3, "todo", 0, "later"], c: "push" });
    log.add([act("a0", [], [{ u: "s:x", v: ["2026-11-16", 3, "todo", 0, "later"], c: "own" }]), act("p1", ["a0"], [s("2026-11-20")]), act("p2", ["a0"], [s("2026-11-18")], { dev: "d2" })]);
    expect(log.unit("s:x")).toEqual({ value: ["2026-11-20", 3, "todo", 0, "later"], from: "p1", clash: null });
  });
});
