import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_STYLE, toDay, weekday } from "../../domain/dates";
import type { PlanSession } from "../../store/session";
import { deleteClash } from "../../test/fixtures/deleteClash";
import { fs, testSession, type SeedItem } from "../../test/session";
import { ghostIds } from "../ghosts";
import { pct, printRows, printScale } from "./sheet";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const SEED: readonly SeedItem[] = [
  { id: "g1", name: "Kitchen", kind: "group" },
  { id: "a", name: "Fit", parent: "g1", start: "2026-11-10", dur: 3 },
  { id: "g2", name: "Inner", kind: "group", parent: "g1" },
  { id: "b", name: "Tile", parent: "g2", start: "2026-11-16", dur: 2, deps: [fs("a")] },
  { id: "x", name: "Old", parent: "g2", start: "2026-11-16", dur: 1 },
  { id: "g3", name: "Gone", kind: "group" },
  { id: "c", name: "Inside gone", parent: "g3", start: "2026-11-16", dur: 1 },
  { id: "m", name: "Gate", kind: "milestone", start: "2026-11-20" },
  { id: "u", name: "Later" },
];

const d = (iso: string): number => toDay(iso);

describe("printRows (product-8)", () => {
  it("lists every live item in tree order with its depth, leaving the Trash out", async () => {
    const t = await testSession(SEED);
    sessions.push(t.session);
    t.session.apply({ t: "trash", items: ["x", "g3"] });
    const rows = printRows(t.session.view());
    expect(rows.map((r) => [r.id, r.depth, r.kind])).toEqual([
      ["g1", 0, "group"],
      ["a", 1, "task"],
      ["g2", 1, "group"],
      ["b", 2, "task"],
      ["m", 0, "milestone"],
      ["u", 0, "task"],
    ]);
    const span = new Map(rows.map((r) => [r.id, r.span]));
    expect(span.get("a")).toEqual({ start: d("2026-11-10"), end: d("2026-11-12") });
    expect(span.get("g1")).toEqual({ start: d("2026-11-10"), end: d("2026-11-17") });
    expect(span.get("m")).toEqual({ start: d("2026-11-20"), end: d("2026-11-20") });
    expect(span.get("u")).toBeNull();
  });

  it("leaves a ghost out", async () => {
    const { t, p } = await deleteClash();
    sessions.push(t.session, p.session);
    const view = t.session.view();
    expect([...ghostIds(view)]).toEqual(["A"]);
    expect(printRows(view).map((r) => r.id)).toEqual(["B"]);
  });
});

describe("pct", () => {
  it("places a day as a percent of the span", () => {
    expect(pct(10, 10, 20)).toBe(0);
    expect(pct(15, 10, 20)).toBe(25);
    expect(pct(30, 10, 20)).toBe(100);
  });
});

describe("printScale", () => {
  const span = (first: string, days: number): [number, number] => [d(first), d(first) + days - 1];

  it("ticks Mondays up to 62 days, with the year on the first tick and each new year", () => {
    const [first, last] = span("2026-12-02", 62);
    const ticks = printScale(first, last, 1, LOG_STYLE);
    expect(ticks[0]).toEqual({ at: d("2026-12-07"), label: "7 Dec 2026" });
    expect(ticks[1]).toEqual({ at: d("2026-12-14"), label: "14 Dec" });
    expect(ticks.find((x) => x.at === d("2027-01-04"))).toEqual({ at: d("2027-01-04"), label: "4 Jan 2027" });
    expect(ticks.find((x) => x.at === d("2027-01-11"))?.label).toBe("11 Jan");
    expect(ticks.every((x) => x.at >= first && x.at <= last && weekday(x.at) === 1)).toBe(true);
    expect(ticks).toHaveLength(9);
  });

  it("a Sunday week starts on Sunday", () => {
    const [first, last] = span("2026-12-02", 62);
    const ticks = printScale(first, last, 7, LOG_STYLE);
    expect(ticks.slice(0, 2)).toEqual([
      { at: d("2026-12-06"), label: "6 Dec 2026" },
      { at: d("2026-12-13"), label: "13 Dec" },
    ]);
    expect(ticks.find((x) => x.at === d("2027-01-03"))?.label).toBe("3 Jan 2027");
    expect(ticks.every((x) => weekday(x.at) === 7)).toBe(true);
  });

  it("labels weeks in the chosen date format", () => {
    const [first, last] = span("2026-12-02", 62);
    expect(printScale(first, last, 1, { format: "iso", order: "dm" }).slice(0, 2).map((x) => x.label)).toEqual(["2026-12-07", "2026-12-14"]);
    expect(printScale(first, last, 1, { format: "dmy", order: "dm" }).slice(4, 6).map((x) => x.label)).toEqual(["4.1.2027", "11.1.2027"]);
    expect(printScale(first, last, 1, { format: "system", order: "md" }).slice(0, 2).map((x) => x.label)).toEqual(["Dec 7 2026", "Dec 14"]);
  });

  it("ticks months from 63 to 550 days", () => {
    const [first, last] = span("2026-12-02", 63);
    expect(printScale(first, last, 1, LOG_STYLE)).toEqual([
      { at: d("2027-01-01"), label: "Jan 2027" },
      { at: d("2027-02-01"), label: "Feb" },
    ]);
    const [f2, l2] = span("2026-11-15", 550);
    const months = printScale(f2, l2, 1, LOG_STYLE);
    expect(months[0]).toEqual({ at: d("2026-12-01"), label: "Dec 2026" });
    expect(months.map((x) => x.label)).toContain("Jan 2027");
    expect(months.map((x) => x.label)).toContain("Jan 2028");
    expect(months).toHaveLength(18);
  });

  it("ticks quarters from 551 days", () => {
    const [first, last] = span("2026-11-15", 551);
    expect(printScale(first, last, 1, LOG_STYLE).map((x) => x.label)).toEqual(["Q1 2027", "Q2", "Q3", "Q4", "Q1 2028", "Q2"]);
  });
});
