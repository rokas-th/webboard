import { afterEach, describe, expect, it, vi } from "vitest";
import { toDay, toIso } from "../../domain/dates";
import type { PlanSession } from "../../store/session";
import { testSession } from "../../test/session";
import { PPD, ROW, geometry } from "./geometry";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const viewOf = async (...a: Parameters<typeof testSession>) => {
  const t = await testSession(...a);
  sessions.push(t.session);
  return t.session.view();
};

describe("geometry", () => {
  it("has the mockup's scale", () => {
    expect(PPD).toEqual({ W: 40, M: 16, Q: 6 });
    expect(ROW).toBe(34);
  });

  it("starts on the Monday a week before the earliest start, today in range", async () => {
    const view = await viewOf([{ name: "A", start: "2026-11-11", dur: 2 }]);
    const g = geometry(view, "W");
    expect(toIso(g.origin)).toBe("2026-11-02");
    expect([g.x(g.origin + 3), geometry(view, "M").x(g.origin + 3), geometry(view, "Q").x(g.origin + 3)]).toEqual([120, 48, 18]);
  });

  it("runs five weeks past the latest end and keeps an earlier today in range", async () => {
    const view = await viewOf([{ name: "A", start: "2026-12-01", dur: 2 }], { today: "2026-11-18" });
    const g = geometry(view, "M");
    expect(toIso(g.origin)).toBe("2026-11-09");
    expect(toIso(g.origin + g.days - 1)).toBe(toIso(toDay("2026-12-02") + 35));
    expect(g.ppd).toBe(16);
    expect(g.width).toBe(g.days * 16);
  });

  it("maps pixels back to days and spans items", async () => {
    const view = await viewOf([
      { id: "g", name: "G", kind: "group" },
      { id: "a", name: "A", parent: "g", start: "2026-11-11", dur: 2 },
      { id: "u", name: "U" },
    ]);
    const g = geometry(view, "W");
    expect(toIso(g.dayAt(0))).toBe("2026-11-02");
    expect(toIso(g.dayAt(39))).toBe("2026-11-02");
    expect(toIso(g.dayAt(200))).toBe("2026-11-07");
    expect(g.span("a")).toEqual({ start: toDay("2026-11-11"), end: toDay("2026-11-12") });
    expect(g.span("g")).toEqual({ start: toDay("2026-11-11"), end: toDay("2026-11-12") });
    expect(g.span("u")).toBeNull();
    expect(g.cal.isWork(toDay("2026-11-14"))).toBe(false);
  });
});
