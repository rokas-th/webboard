import { describe, expect, it } from "vitest";
import { createClickPair, PAIR_MS, PAIR_PX, type ClickMark } from "./clickPair";

const mark = (item: string, x: number, y: number, at: number): ClickMark => ({
  item,
  x,
  y,
  at,
});

describe("createClickPair", () => {
  it("pairs within 400 ms and 6 px", () => {
    expect([PAIR_MS, PAIR_PX]).toEqual([400, 6]);
    const pair = createClickPair();
    expect(pair.press(mark("a", 100, 100, 1000))).toBe("single");
    expect(pair.press(mark("a", 106, 100, 1400))).toBe("double");
    const again = createClickPair();
    expect(again.press(mark("a", 0, 0, 0))).toBe("single");
    expect(again.press(mark("a", 3, 4, 0))).toBe("double");
  });

  it("401 ms, 7 px or another item is single", () => {
    const late = createClickPair();
    late.press(mark("a", 0, 0, 1000));
    expect(late.press(mark("a", 0, 0, 1401))).toBe("single");
    const far = createClickPair();
    far.press(mark("a", 0, 0, 1000));
    expect(far.press(mark("a", 7, 0, 1100))).toBe("single");
    const other = createClickPair();
    other.press(mark("a", 0, 0, 1000));
    expect(other.press(mark("b", 0, 0, 1100))).toBe("single");
    expect(other.press(mark("b", 0, 0, 1200))).toBe("double");
    const reset = createClickPair();
    reset.press(mark("a", 0, 0, 1000));
    reset.reset();
    expect(reset.press(mark("a", 0, 0, 1100))).toBe("single");
    const backwards = createClickPair();
    backwards.press(mark("a", 0, 0, 1000));
    expect(backwards.press(mark("a", 0, 0, 999))).toBe("single");
  });

  it("a third press is single", () => {
    const pair = createClickPair();
    expect([pair.press(mark("a", 0, 0, 0)), pair.press(mark("a", 0, 0, 100)), pair.press(mark("a", 0, 0, 200)), pair.press(mark("a", 0, 0, 300))]).toEqual([
      "single",
      "double",
      "single",
      "double",
    ]);
  });
});
