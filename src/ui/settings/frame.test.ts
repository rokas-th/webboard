import { describe, expect, it } from "vitest";
import type { Os } from "../../platform";
import type { PlanListMode } from "../shell/planListMode";
import { settingsFrame } from "./frame";

describe("the Settings frame", () => {
  it.each<[Os, PlanListMode, "modal" | "sheet"]>([
    ["macos", "column", "modal"],
    ["macos", "overlay", "modal"],
    ["macos", "sheet", "modal"],
    ["macos", "phone", "sheet"],
    ["linux", "column", "modal"],
    ["linux", "overlay", "modal"],
    ["linux", "sheet", "modal"],
    ["linux", "phone", "sheet"],
    ["ios", "column", "modal"],
    ["ios", "overlay", "modal"],
    ["ios", "sheet", "sheet"],
    ["ios", "phone", "sheet"],
  ])("on %s with the %s list is a %s", (os, listMode, frame) => {
    expect(settingsFrame(os, listMode)).toBe(frame);
  });
});
