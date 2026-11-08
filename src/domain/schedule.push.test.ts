import { describe, expect, it } from "vitest";
import { loopLinks, push, wouldLoop, type Lock, type PushResult } from "./schedule";
import { toIso } from "./dates";
import { ln, PUSH_PLAN, task, view } from "../test/fixtures/sched";

const isoMoves = (r: PushResult): Record<string, string> =>
  Object.fromEntries([...r.moves].map(([id, d]) => [id, toIso(d)]));

describe("loopLinks", () => {
  it("loopLinks finds cycles and self-links", () => {
    const links = [ln("a", "b"), ln("b", "c"), ln("c", "a"), ln("c", "d"), ln("d", "d")];
    expect(loopLinks(links)).toEqual(new Set(["a>b", "b>c", "c>a", "d>d"]));
  });
});

describe("wouldLoop", () => {
  it("wouldLoop names the loop", () => {
    const links = [ln("a", "b"), ln("b", "c")];
    expect(wouldLoop(links, ln("c", "a"))).toEqual(["c", "a", "b"]);
    expect(wouldLoop(links, ln("a", "c"))).toBeNull();
    expect(wouldLoop(links, ln("a", "a"))).toEqual(["a"]);
    expect(wouldLoop(links, ln("a", "b", "SS"))).toBeNull();
  });
});

describe("push", () => {
  it("4 moved, stopped at held", () => {
    const r = push(PUSH_PLAN, ["A"]);
    expect(isoMoves(r)).toEqual({
      B: "2026-11-16",
      C: "2026-11-19",
      D: "2026-11-17",
      E: "2026-11-20",
    });
    expect(r.stopped).toEqual([{ id: "H", reason: "held" }]);
  });

  it.each<Lock>(["done", "doing"])("done and doing stop the same way (%s)", (lock) => {
    const v = view(
      [task("A", "2026-11-02", 10), task("Z", "2026-11-09", 2, lock), task("Y", "2026-11-11", 1)],
      [ln("A", "Z"), ln("Z", "Y")],
    );
    const r = push(v, ["A"]);
    expect(r.moves.size).toBe(0);
    expect(r.stopped).toEqual([{ id: "Z", reason: lock }]);
  });

  it("loop links are ignored", () => {
    const v = view(
      [
        task("A", "2026-11-02", 10),
        task("B", "2026-11-02", 1),
        task("L1", "2026-11-02", 1),
        task("L2", "2026-11-02", 1),
      ],
      [ln("A", "B"), ln("B", "L1"), ln("L1", "L2"), ln("L2", "L1")],
    );
    const r = push(v, ["A"]);
    expect(isoMoves(r)).toEqual({ B: "2026-11-16", L1: "2026-11-17" });
    expect(r.stopped).toEqual([]);
  });

  it("a root that violates its own predecessor stays", () => {
    const v = view([task("U", "2026-10-26", 3), task("A", "2026-10-27", 2)], [ln("U", "A")]);
    const r = push(v, ["A"]);
    expect(r.moves.size).toBe(0);
    expect(r.stopped).toEqual([]);
  });

  it("a later successor is untouched", () => {
    const v = view([task("A", "2026-11-02", 10), task("B", "2026-11-23", 2)], [ln("A", "B")]);
    const r = push(v, ["A"]);
    expect(r.moves.size).toBe(0);
    expect(r.stopped).toEqual([]);
  });

  it("a lone self-link terminates", () => {
    const v = view([task("A", "2026-11-02", 10)], [ln("A", "A")]);
    const r = push(v, ["A"]);
    expect(r.moves.size).toBe(0);
    expect(r.stopped).toEqual([]);
  });
});
