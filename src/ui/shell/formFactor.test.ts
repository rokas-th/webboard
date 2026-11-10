import { describe, expect, it } from "vitest";
import { formFactor, type FormFactor } from "./formFactor";

describe("formFactor", () => {
  const cases: readonly (readonly [number, number, FormFactor])[] = [
    [390, 390, "phone"],
    [844, 390, "phone"],
    [820, 820, "compact"],
    [1023, 834, "compact"],
    [1024, 834, "full"],
    [1180, 820, "full"],
    [1366, 1024, "full"],
    [900, 1080, "compact"],
  ];

  it.each(cases)("width %i, short screen side %i → %s", (width, screenShort, want) => {
    expect(formFactor({ width, screenShort })).toBe(want);
  });
});
