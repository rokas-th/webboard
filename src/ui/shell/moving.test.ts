import { describe, expect, it } from "vitest";
import { localLineText, moveAllLabel } from "./moving";

describe("the local line's copy", () => {
  it.each([
    [1, "1 plan is on this device only. Move it to the space to see it on other devices.", "Move it"],
    [2, "2 plans are on this device only. Move them to the space to see them on other devices.", "Move both"],
    [3, "3 plans are on this device only. Move them to the space to see them on other devices.", "Move all 3"],
  ])("%i plans", (n, text, label) => {
    expect([localLineText(n), moveAllLabel(n)]).toEqual([text, label]);
  });
});
