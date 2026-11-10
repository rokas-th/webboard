import { afterEach, describe, expect, it, vi } from "vitest";
import { toDay, toIso } from "../../domain/dates";
import type { PlanSession } from "../../store/session";
import { testSession } from "../../test/session";
import { FIT_MAX, FIT_MIN, LEAD, PPD, ROW, fitPpd, geometry, leadFor, pinched } from "./geometry";

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

describe("fit zoom", () => {
  it("divides the visible chart by the plan's days from a week before its first start to a week after its last end", async () => {
    const view = await viewOf(
      [
        { name: "A", start: "2026-12-01", dur: 2 },
        { name: "B", start: "2026-12-14", dur: 5 },
      ],
      { today: "2026-11-10" },
    );
    const days = toDay("2026-12-18") + 7 - (toDay("2026-12-01") - 7) + 1;
    expect(days).toBe(32);
    expect(fitPpd(view, 640)).toBe(20);
    const g = geometry(view, "F", 640);
    expect(g.ppd).toBe(20);
    expect(toIso(g.origin)).toBe(toIso(geometry(view, "W").origin));
    expect(g.x(toDay("2026-12-01") - 7)).toBe(Math.round((toDay("2026-12-01") - 7 - g.origin) * 20));
    expect(fitPpd(view, 333)).toBeCloseTo(333 / 32, 10);
  });

  it("clamps to 2..40 px a day", async () => {
    const view = await viewOf([{ name: "A", start: "2026-11-10", dur: 1 }]);
    expect([FIT_MIN, FIT_MAX]).toEqual([2, 40]);
    expect(fitPpd(view, 100000)).toBe(40);
    expect(fitPpd(view, 0)).toBe(2);
  });

  it("takes today as the span of a plan with no dates", async () => {
    const view = await viewOf([{ name: "U" }]);
    expect(fitPpd(view, 150)).toBe(10);
  });

  it("needs the visible width, and the fixed zooms ignore it", async () => {
    const view = await viewOf([{ name: "A", start: "2026-11-10", dur: 1 }]);
    expect(() => geometry(view, "F")).toThrow("Fit zoom needs the visible chart width");
    expect(geometry(view, "W", 900).ppd).toBe(40);
  });
});

describe("pinched", () => {
  it("steps to the next fixed zoom by px a day, from any ppd", () => {
    expect([pinched(16, 1), pinched(16, -1), pinched(40, 1), pinched(6, -1)]).toEqual(["W", "Q", null, null]);
    expect([pinched(12, 1), pinched(12, -1), pinched(2, 1), pinched(40, -1), pinched(30, 1)]).toEqual(["M", "Q", "Q", "M", "W"]);
  });
});

describe("leadFor", () => {
  it("keeps the full lead when the visible chart is wide", () => {
    expect(LEAD).toBe(160);
    expect(leadFor(1140)).toBe(160);
    expect(leadFor(480)).toBe(160);
  });

  it("takes a third of a narrow visible chart, rounded down", () => {
    expect(leadFor(138)).toBe(46);
    expect(leadFor(479)).toBe(159);
  });

  it("is 0 for a chart with no visible width", () => {
    expect(leadFor(0)).toBe(0);
    expect(leadFor(-40)).toBe(0);
  });
});
