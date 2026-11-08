import { expect, it } from "vitest";
import { linkKey } from "./model";

it("linkKey joins from and to with >", () => {
  expect(linkKey("a", "b")).toBe("a>b");
});
