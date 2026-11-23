import { describe, expect, it } from "vitest";
import { PHONE_VIEWS, phoneViewPatch } from "./views";

describe("PHONE_VIEWS", () => {
  it("is Timeline, Board, List in that order", () => {
    expect(PHONE_VIEWS).toEqual([
      ["timeline", "Timeline"],
      ["board", "Board"],
      ["list", "List"],
    ]);
  });
});

describe("phoneViewPatch", () => {
  it("is null for the view already shown", () => {
    expect(PHONE_VIEWS.map(([v]) => phoneViewPatch(v, v))).toEqual([null, null, null]);
  });

  it("clears the query on any move to the Timeline", () => {
    expect(phoneViewPatch("list", "timeline")).toEqual({ view: "timeline", query: "" });
    expect(phoneViewPatch("board", "timeline")).toEqual({ view: "timeline", query: "" });
  });

  it("keeps the query between List and Board and from the Timeline", () => {
    expect(phoneViewPatch("list", "board")).toEqual({ view: "board" });
    expect(phoneViewPatch("board", "list")).toEqual({ view: "list" });
    expect(phoneViewPatch("timeline", "list")).toEqual({ view: "list" });
  });
});
