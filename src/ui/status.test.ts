import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../store/session";
import { testSession } from "../test/session";
import { derivedStatus } from "./status";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe("derivedStatus", () => {
  it("reads an item's derived status and names the caller when there is none", async () => {
    const t = await testSession([
      { name: "A", start: "2026-11-10", dur: 3, status: "doing" },
      { name: "G", kind: "group" },
    ]);
    sessions.push(t.session);
    const view = t.session.view();
    expect(derivedStatus(view, "A", "PlanPanel")).toBe("doing");
    expect(() => derivedStatus(view, "G", "PlanPanel")).toThrow(new Error("PlanPanel: item G has no derived status"));
  });
});
