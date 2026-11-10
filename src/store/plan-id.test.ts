import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../log/ids";
import { memoryStore } from "../test/fixtures/store";
import { VALID_WEBBOARD } from "../test/fixtures/webboard";
import { offeredSettings, resetTauri } from "../test/tauriMock";
import { buildImport } from "./file";
import { newPlanId } from "./plan-id";
import { Registry } from "./registry";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("../log/ids", async (importOriginal) => {
  const m = await importOriginal<typeof import("../log/ids")>();
  return { ...m, newId: vi.fn(m.newId) };
});

const { newId: drawn } = await vi.importActual<typeof import("../log/ids")>("../log/ids");

const colliding = (count: number): (() => string) => {
  let left = count;
  return () => {
    const id = drawn();
    if (left === 0) return id;
    left -= 1;
    return "ix-" + id.slice(3);
  };
};

const opened: Registry[] = [];

beforeEach(() => {
  resetTauri({
    ...memoryStore().answers,
    settings_read: offeredSettings,
    settings_write: () => null,
    device_info: () => ({ deviceId: "dev-A", platform: "macos" }),
  });
});

afterEach(async () => {
  vi.mocked(newId).mockReset();
  await Promise.all(opened.splice(0).map((r) => r.close()));
});

describe("plan ids never start with ix-", () => {
  it("newPlanId redraws until an id does not start with ix-", () => {
    const draws = ["ix-Qm3pLk9aZ", "ix-aaaaaaaa", "Qm3pLk9aZab", "unused00000"];
    const draw = vi.fn(() => {
      const next = draws.shift();
      if (next === undefined) throw new Error("no draw left");
      return next;
    });
    expect(newPlanId(draw)).toBe("Qm3pLk9aZab");
    expect(draw).toHaveBeenCalledTimes(3);
    expect(newPlanId(() => "x-Qm3pLk9aZ")).toBe("x-Qm3pLk9aZ");
  });

  it("createPlan redraws a plan id that starts with ix-", async () => {
    const r = await Registry.open();
    opened.push(r);
    vi.mocked(newId).mockImplementation(colliding(16));
    const id = await r.createPlan("Beta");
    vi.mocked(newId).mockReset();
    expect(id.startsWith("ix-")).toBe(false);
    expect(r.plans().map((p) => p.id)).toEqual([id]);
    expect(r.localSpaces()).toEqual([]);
    expect((await r.session(id)).view().plan.name).toBe("Beta");
  });

  it("buildImport redraws a plan id that starts with ix-", () => {
    vi.mocked(newId).mockImplementation(colliding(16));
    const r = buildImport(VALID_WEBBOARD.bytes, "Bridge.webboard", "dev-A", "ses-A", 1000);
    expect(r.planId.startsWith("ix-")).toBe(false);
  });
});
