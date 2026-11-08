import { expect, it, vi } from "vitest";
import { localToday } from "./dates";

vi.stubEnv("TZ", "Pacific/Auckland");

it("localToday follows the device zone, not UTC", () => {
  const instant = new Date("2026-11-08T11:30:00Z");
  expect(instant.getTimezoneOffset()).toBe(-780);
  expect(localToday(instant)).toBe("2026-11-09");
});
