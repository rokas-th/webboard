import { expect, it } from "vitest";
import { newId } from "./ids";

const byteLength = (id: string): number => {
  const b64 = id.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)).length;
};

it("newId is 11 base64url characters", () => {
  expect(newId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
});

it("100,000 ids are distinct", () => {
  const ids = new Set(Array.from({ length: 100_000 }, newId));
  expect(ids.size).toBe(100_000);
});

it("newId decodes to 8 bytes", () => {
  Array.from({ length: 1000 }, newId).forEach((id) => expect(byteLength(id)).toBe(8));
});
