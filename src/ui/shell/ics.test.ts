import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_STYLE } from "../../domain/dates";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem, type TestSession } from "../../test/session";
import { rowContext } from "../list/columns";
import { foldLine, icsOf, icsText } from "./ics";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const STAMP = Date.UTC(2026, 10, 23, 14, 37, 58, 412);

const made = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return t;
};

const ctxOf = (t: TestSession) => rowContext(t.session.view(), (id) => t.session.note(id).toString(), null, LOG_STYLE);

const octets = (s: string): number => new TextEncoder().encode(s).length;

const unfolded = (text: string): string[] => text.replace(/\r\n /g, "").split("\r\n");

describe("icsOf", () => {
  it("writes each dated milestone in plan order as an all-day transparent event, with CRLF line ends", async () => {
    const t = await made([
      { id: "g", name: "Site", kind: "group" },
      { id: "a", name: "Pour the pier", parent: "g", start: "2026-11-02", dur: 2 },
      { id: "m1", name: "Pier poured", kind: "milestone", parent: "g", start: "2026-11-04", dur: 0, deps: [fs("a")] },
      { id: "m2", name: "Opening night", kind: "milestone", start: "2027-01-15", dur: 0 },
    ]);
    t.session.apply({ t: "planName", name: "MESA 1.0" });
    const plan = t.session.view().plan.id;
    const out = icsOf(ctxOf(t), STAMP);
    expect([out.events, out.undated]).toEqual([2, 0]);
    expect(out.text.endsWith("\r\n")).toBe(true);
    expect(out.text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(out.text.split("\r\n")).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//WebBoard//Milestones//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:MESA 1.0",
      "BEGIN:VEVENT",
      `UID:${plan}-m1@webboard`,
      "DTSTAMP:20261123T143758Z",
      "DTSTART;VALUE=DATE:20261104",
      "DTEND;VALUE=DATE:20261105",
      "SUMMARY:Pier poured",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
      "BEGIN:VEVENT",
      `UID:${plan}-m2@webboard`,
      "DTSTAMP:20261123T143758Z",
      "DTSTART;VALUE=DATE:20270115",
      "DTEND;VALUE=DATE:20270116",
      "SUMMARY:Opening night",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]);
  });

  it("escapes backslash, semicolon and comma in the summary and the calendar name", async () => {
    const t = await made([{ id: "m", name: "Dome; set, phase\\2", kind: "milestone", start: "2026-11-13", dur: 0 }]);
    t.session.apply({ t: "planName", name: "Q3, Q4; C:\\plans" });
    const lines = unfolded(icsOf(ctxOf(t), STAMP).text);
    expect(lines).toContain("SUMMARY:Dome\\; set\\, phase\\\\2");
    expect(lines).toContain("X-WR-CALNAME:Q3\\, Q4\\; C:\\\\plans");
  });

  it("escapes every kind of newline as \\n", () => {
    expect(icsText("one\ntwo\r\nthree\rfour\\n")).toBe("one\\ntwo\\nthree\\nfour\\\\n");
  });

  it("folds a long line at 75 octets without splitting a character", async () => {
    const name = `Kuppel ${"ü".repeat(29)}🔭${"ü".repeat(40)} fertig`;
    const t = await made([{ id: "m", name, kind: "milestone", start: "2026-11-13", dur: 0 }]);
    const text = icsOf(ctxOf(t), STAMP).text;
    const physical = text.split("\r\n");
    expect(physical.every((l) => octets(l) <= 75)).toBe(true);
    const summary = physical.findIndex((l) => l.startsWith("SUMMARY:"));
    const folded = physical.slice(summary, summary + 4);
    expect(folded.map((l) => l.startsWith(" "))).toEqual([false, true, true, false]);
    expect(folded.slice(0, 3).map(octets)).toEqual([73, 75, 18]);
    expect(folded[1].startsWith(" 🔭")).toBe(true);
    expect(folded.slice(0, 3).every((l) => !/[\uD800-\uDBFF]$|^ ?[\uDC00-\uDFFF]/.test(l))).toBe(true);
    expect(unfolded(text)).toContain(`SUMMARY:${name}`);
    expect(foldLine("x".repeat(75))).toBe("x".repeat(75));
    expect(foldLine("x".repeat(76))).toBe(`${"x".repeat(75)}\r\n x`);
  });

  it("leaves undated milestones out and counts them", async () => {
    const t = await made([
      { id: "m1", name: "Dated", kind: "milestone", start: "2026-11-13", dur: 0 },
      { id: "m2", name: "Some day", kind: "milestone" },
      { id: "m3", name: "Later", kind: "milestone", start: null },
      { id: "a", name: "A task without a date" },
    ]);
    const out = icsOf(ctxOf(t), STAMP);
    expect([out.events, out.undated]).toEqual([1, 2]);
    expect(unfolded(out.text).filter((l) => l.startsWith("SUMMARY:"))).toEqual(["SUMMARY:Dated"]);
  });

  it("answers no events for a plan without milestones, with a calendar that is still whole", async () => {
    const t = await made([{ id: "a", name: "Task", start: "2026-11-13", dur: 2 }]);
    const out = icsOf(ctxOf(t), STAMP);
    expect([out.events, out.undated]).toEqual([0, 0]);
    expect(out.text).not.toContain("BEGIN:VEVENT");
    expect(out.text.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("leaves out a milestone in the Trash and a ghost", async () => {
    const t = await made([
      { id: "S", name: "Sprint 4", kind: "group" },
      { id: "r", name: "Review done", kind: "milestone", parent: "S", start: "2026-11-10", dur: 0 },
      { id: "x", name: "Binned", kind: "milestone", start: "2026-11-11", dur: 0 },
      { id: "k", name: "Kept", kind: "milestone", start: "2026-11-16", dur: 0 },
    ]);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["S"] });
    t.session.apply({ t: "trash", items: ["x"] });
    p.session.apply({ t: "rename", item: "r", name: "Review 2" });
    p.sync();
    const ctx = ctxOf(t);
    expect(ctx.ghosts.has("r")).toBe(true);
    const out = icsOf(ctx, STAMP);
    expect([out.events, out.undated]).toEqual([1, 0]);
    expect(unfolded(out.text).filter((l) => l.startsWith("SUMMARY:"))).toEqual(["SUMMARY:Kept"]);
  });
});
