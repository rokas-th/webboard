import { describe, expect, it } from "vitest";
import { need } from "./need";

describe("need", () => {
  it("returns a present key's value, also a stored null or 0", () => {
    const m = new Map<string, number | null>([
      ["a", 7],
      ["z", 0],
      ["n", null],
    ]);
    expect(need(m, "a", "start")).toBe(7);
    expect(need(m, "z", "start")).toBe(0);
    expect(need(m, "n", "start")).toBeNull();
  });

  it("throws naming what is missing and for which item", () => {
    expect(() => need(new Map<string, number>(), "k3f9a", "start")).toThrow(new Error("no start for item k3f9a"));
  });
});
