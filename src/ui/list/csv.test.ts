import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonId } from "../../domain/model";
import { peopleOf } from "../../domain/people";
import { stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem } from "../../test/session";
import { columnById, rowContext, type RowContext } from "./columns";
import { csvCell, listCsv } from "./csv";
import { DEFAULT_LIST_PREFS, type ColumnId, type ListPrefs } from "./prefs";
import { LOG_STYLE } from "../../domain/dates";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const BOM = "﻿";

const SEED: readonly SeedItem[] = [
  { id: "g", name: "Site, north", kind: "group" },
  { id: "a", name: "Pour the pier", parent: "g", start: "2026-11-02", dur: 2, progress: 40, note: "Line one\nLine \"two\"" },
  { id: "b", name: "Bolt the dome", parent: "g", start: "2026-11-10", dur: 3, deps: [fs("a")] },
  { id: "m", name: "Dome set", kind: "milestone", start: "2026-11-13", dur: 0, deps: [fs("b")] },
  { id: "u", name: "=SUM(A1)" },
  { id: "d", name: "-2 spare bolts", start: "2026-11-02", dur: 1, status: "done", progress: 100, note: "  keep dry " },
];

const COLS: readonly ColumnId[] = ["name", "step", "assignees", "start", "end", "days", "progress", "late", "kind", "note"];

const prefs = (over: Partial<ListPrefs> = {}): ListPrefs => ({
  ...DEFAULT_LIST_PREFS,
  cols: COLS.map((id) => ({ id, w: columnById(id).defaultWidth })),
  scope: "all",
  group: "none",
  ...over,
});

interface Made {
  ctx: RowContext;
  ids: Readonly<Record<string, PersonId>>;
  as(me: PersonId | null): RowContext;
}

const made = async (): Promise<Made> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  const ids: Record<string, PersonId> = {};
  act(() => {
    [
      ["Mira Okafor", "MO"],
      ["Ana Ruiz", "AR"],
      ["Dana Lee", "DL"],
    ].forEach(([name, initials]) => {
      const known = peopleOf(t.session.view().plan);
      t.session.apply({ t: "person", op: "add", name, initials, colour: "sky", after: known.length === 0 ? null : known[known.length - 1].id });
    });
    peopleOf(t.session.view().plan).forEach((p) => {
      ids[p.initials] = p.id;
    });
    t.session.apply({ t: "assign", items: ["a"], person: ids.MO });
    t.session.apply({ t: "assign", items: ["a"], person: ids.AR });
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "lime", after: "later" });
    t.session.apply({ t: "toStep", items: ["b"], step: "next" });
  });
  const qa = stepsOf(t.session.view().plan).find((s) => s.name === "QA");
  if (qa === undefined) throw new Error("no QA step");
  const phone = await t.peer("iphone");
  sessions.push(phone.session);
  phone.session.apply({ t: "assign", items: ["b"], person: ids.DL });
  phone.session.apply({ t: "toStep", items: ["u"], step: qa.id });
  act(() => {
    t.session.apply({ t: "person", op: "remove", person: ids.DL, to: null });
    t.session.apply({ t: "step", op: "delete", step: qa.id, to: null });
    phone.sync();
  });
  const as = (me: PersonId | null): RowContext => rowContext(t.session.view(), (id) => t.session.note(id).toString(), me, LOG_STYLE);
  return { ctx: as(null), ids, as };
};

const lines = (text: string): string[] => {
  expect(text.startsWith(BOM)).toBe(true);
  expect(text.endsWith("\r\n")).toBe(true);
  return text.slice(BOM.length, -2).split("\r\n");
};

describe("csvCell", () => {
  it.each([
    ["plain", "plain"],
    ["", ""],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ["one\ntwo", '"one\ntwo"'],
    ["one\r\ntwo", '"one\r\ntwo"'],
    [" lead", '" lead"'],
    ["trail ", '"trail "'],
    ["mid space", "mid space"],
  ])("quotes %j as %j", (cell, out) => {
    expect(csvCell(cell)).toBe(out);
  });

  it.each([
    ["=SUM(A1)", "'=SUM(A1)"],
    ["+1", "'+1"],
    ["-2", "'-2"],
    ["@cmd", "'@cmd"],
    ["\tx", "'\tx"],
    ["\rx", "\"'\rx\""],
    ["=a,b", "\"'=a,b\""],
    ["a=b", "a=b"],
  ])("guards the formula start of %j as %j", (cell, out) => {
    expect(csvCell(cell)).toBe(out);
  });
});

describe("listCsv", () => {
  it("writes the shown titles, then one row per item, ISO dates, bare numbers, names and the whole note", async () => {
    const { ctx } = await made();
    const { text, rows } = listCsv(ctx, prefs());
    expect(rows).toBe(5);
    expect(lines(text)).toEqual([
      "Name,Step,Assignees,Start,End,Days,Progress,Late by,Kind,Note",
      'Pour the pier,Now,Mira Okafor; Ana Ruiz,2026-11-02,2026-11-03,2,40,4,Task,"Line one\nLine ""two"""',
      "Bolt the dome,Next,Former: Dana Lee,2026-11-10,2026-11-12,3,0,,Task,",
      "Dome set,Now,,2026-11-13,,,0,,Milestone,",
      "'=SUM(A1),,,,,3,0,,Task,",
      "'-2 spare bolts,Done,,2026-11-02,2026-11-02,1,100,,Task,\"  keep dry \"",
    ]);
  });

  it("follows the column order, the scope, the chips and the sort", async () => {
    const { ctx } = await made();
    const cols = (["name", "kind", "start"] as const).map((id) => ({ id, w: columnById(id).defaultWidth }));
    const open = listCsv(ctx, prefs({ cols, scope: "open", sort: [{ id: "name", dir: "desc" }] }));
    expect([open.rows, lines(open.text)]).toEqual([4, ["Name,Kind,Start", "Pour the pier,Task,2026-11-02", "Dome set,Milestone,2026-11-13", "Bolt the dome,Task,2026-11-10", "'=SUM(A1),Task,"]]);
    const milestones = listCsv(ctx, prefs({ cols, chips: [{ f: "kind", v: "milestone" }] }));
    expect([milestones.rows, lines(milestones.text)]).toEqual([1, ["Name,Kind,Start", "Dome set,Milestone,2026-11-13"]]);
    const grouped = listCsv(ctx, prefs({ cols, group: "step", scope: "all" }));
    expect(lines(grouped.text).slice(1).map((l) => l.split(",")[0])).toEqual(["'=SUM(A1)", "Pour the pier", "Dome set", "Bolt the dome", "'-2 spare bolts"]);
  });

  it("writes Mine as the List shows it: the open items of a live me, and nothing for any other me", async () => {
    const { ids, as } = await made();
    const cols = [{ id: "name" as const, w: 300 }];
    const mine = (me: PersonId | null) => listCsv(as(me), prefs({ cols, scope: "mine" }));
    expect([mine(ids.AR).rows, lines(mine(ids.AR).text)]).toEqual([1, ["Name", "Pour the pier"]]);
    expect([mine(null).rows, mine(ids.DL).rows, mine("nobody").rows]).toEqual([0, 0, 0]);
    expect(lines(mine(null).text)).toEqual(["Name"]);
  });

  it("writes the header alone and counts no rows when nothing is in scope", async () => {
    const { ctx } = await made();
    const none = listCsv(ctx, prefs({ scope: "done", chips: [{ f: "kind", v: "milestone" }] }));
    expect(none).toEqual({ text: `${BOM}Name,Step,Assignees,Start,End,Days,Progress,Late by,Kind,Note\r\n`, rows: 0 });
  });

  it("leaves a ghost row out", async () => {
    const t = await testSession([
      { id: "S", name: "Sprint 4", kind: "group" },
      { id: "r", name: "Review", parent: "S", start: "2026-11-10", dur: 3 },
      { id: "x", name: "Other", start: "2026-11-16", dur: 2 },
    ]);
    sessions.push(t.session);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["S"] });
    p.session.apply({ t: "rename", item: "r", name: "Review 2" });
    p.sync();
    const ctx = rowContext(t.session.view(), (id) => t.session.note(id).toString(), null, LOG_STYLE);
    expect(ctx.ghosts.has("r")).toBe(true);
    const out = listCsv(ctx, prefs({ cols: [{ id: "name", w: 300 }] }));
    expect([out.rows, lines(out.text)]).toEqual([1, ["Name", "Other"]]);
  });
});
