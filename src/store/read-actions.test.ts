import { describe, expect, it } from "vitest";
import { act } from "../test/act";
import { encodeAction } from "./doc";
import { readActions } from "./read-actions";

const accept = (): void => {};

describe("readActions", () => {
  it("a valid entry lands in ok", () => {
    const a = act("a1", [], [{ u: "pn", v: "Plan", c: "own" }], { dev: "dev-B" });
    expect(readActions([["a1", encodeAction(a)]], accept)).toEqual({ ok: [a], unreadable: [] });
  });

  it("a malformed lbl is unreadable", () => {
    const raw = ["dev-B", "s-1", 0, [], 5, []];
    expect(readActions([["d1", raw]], accept)).toEqual({ ok: [], unreadable: [{ id: "d1", dev: "dev-B", error: "Action d1 has a malformed lbl" }] });
  });

  it("a throwing check is unreadable", () => {
    const a = act("a1", [], [{ u: "pn", v: "Plan", c: "own" }], { dev: "dev-B" });
    const check = (): void => {
      throw new Error("x");
    };
    expect(readActions([["a1", encodeAction(a)]], check)).toEqual({ ok: [], unreadable: [{ id: "a1", dev: "dev-B", error: "x" }] });
  });

  it("a raw value that is not an array has no device", () => {
    expect(readActions([["a1", { dev: "dev-B" }]], accept)).toEqual({ ok: [], unreadable: [{ id: "a1", dev: null, error: "Action a1 has a malformed dev" }] });
  });

  it("a thrown value that is not an Error is rethrown", () => {
    const a = act("a1", [], [{ u: "pn", v: "Plan", c: "own" }]);
    const check = (): void => {
      throw "boom";
    };
    expect(() => readActions([["a1", encodeAction(a)]], check)).toThrow("boom");
  });
});
