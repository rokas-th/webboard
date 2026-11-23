import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_STYLE, toDay } from "../../domain/dates";
import { peopleOf } from "../../domain/people";
import { stepsOf } from "../../domain/steps";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem, type TestSession } from "../../test/session";
import { columnById, COLUMNS, rowContext, type RowContext } from "./columns";
import type { ColumnId } from "./prefs";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const SEED: readonly SeedItem[] = [
  { id: "g", name: "Site works", kind: "group" },
  { id: "a", name: "Pour footings", parent: "g", start: "2026-11-02", dur: 3 },
  { id: "m", name: "Dome set", kind: "milestone", parent: "g", start: "2026-11-20" },
  { id: "b", name: "Build", start: "2026-11-10", dur: 2, status: "doing", progress: 40, note: "Order the crane\nthen the bolts", deps: [fs("a")] },
  { id: "u", name: "Undated", horizon: "next" },
  { id: "d", name: "Done one", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  { id: "x", name: "Orphan", horizon: "now" },
];

const CREW: readonly (readonly [string, string])[] = [
  ["Mira Okafor", "MO"],
  ["Ana Ruiz", "AR"],
  ["Ole Berg", "OB"],
  ["Kai Moss", "KM"],
  ["Dana Lee", "DL"],
];

const made = async (): Promise<TestSession> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  const ids: Record<string, string> = {};
  act(() => {
    CREW.forEach(([name, initials]) => {
      const known = peopleOf(t.session.view().plan);
      t.session.apply({ t: "person", op: "add", name, initials, colour: "sky", after: known.length === 0 ? null : known[known.length - 1].id });
    });
    peopleOf(t.session.view().plan).forEach((p) => {
      ids[p.initials] = p.id;
    });
    t.session.apply({ t: "assign", items: ["a"], person: ids.AR });
    ["MO", "AR", "OB", "KM"].forEach((who) => t.session.apply({ t: "assign", items: ["b"], person: ids[who] }));
    t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "lime", after: "later" });
  });
  const qa = stepsOf(t.session.view().plan).find((s) => s.name === "QA");
  if (qa === undefined) throw new Error("no QA step");
  const phone = await t.peer("iphone");
  sessions.push(phone.session);
  phone.session.apply({ t: "assign", items: ["m"], person: ids.DL });
  phone.session.apply({ t: "toStep", items: ["x"], step: qa.id });
  act(() => {
    t.session.apply({ t: "person", op: "remove", person: ids.DL, to: null });
    t.session.apply({ t: "step", op: "delete", step: qa.id, to: null });
    phone.sync();
  });
  return t;
};

const ctxOf = (t: TestSession): RowContext => rowContext(t.session.view(), (id) => t.session.note(id).toString(), null, LOG_STYLE);

const cell = (ctx: RowContext, col: ColumnId, id: string): [string, number | string | null] => {
  const spec = columnById(col);
  return [spec.value(ctx, id), spec.sortKey(ctx, id)];
};

describe("columns", () => {
  it("registers the fourteen columns in order, with their sizes and alignment", () => {
    expect(COLUMNS.map((c) => [c.id, c.title, c.minWidth, c.defaultWidth, c.align, c.pinned])).toEqual([
      ["name", "Name", 180, 300, "start", true],
      ["step", "Step", 90, 140, "start", false],
      ["status", "Status", 90, 110, "start", false],
      ["assignees", "Assignees", 110, 170, "start", false],
      ["start", "Start", 72, 88, "end", false],
      ["end", "End", 72, 88, "end", false],
      ["days", "Days", 56, 64, "end", false],
      ["progress", "Progress", 90, 110, "start", false],
      ["late", "Late by", 70, 84, "end", false],
      ["deps", "Depends on", 120, 180, "start", false],
      ["blocks", "Blocks", 120, 180, "start", false],
      ["group", "Group", 110, 160, "start", false],
      ["kind", "Kind", 80, 90, "start", false],
      ["note", "Note", 140, 240, "start", false],
    ]);
  });

  it("throws instead of showing a date through a context that carries no date style, and still sorts and writes CSV through it", async () => {
    const t = await made();
    const bare = rowContext(t.session.view(), (id) => t.session.note(id).toString(), null, null);
    const styled = rowContext(t.session.view(), (id) => t.session.note(id).toString(), null, { format: "iso", order: "dm" });
    expect(() => columnById("start").value(bare, "a")).toThrow("List: this row context orders and filters only, so it has no date style to show a date in");
    expect(() => columnById("end").value(bare, "a")).toThrow("no date style");
    expect([columnById("start").value(styled, "a"), columnById("start").csv(bare, "a"), columnById("name").value(bare, "a")]).toEqual(["2026-11-02", "2026-11-02", "Pour footings"]);
  });

  it("throws for a column that is not registered", () => {
    expect(() => columnById("owner")).toThrow("No List column owner");
  });

  it("gives each column's value and sort key", async () => {
    const ctx = ctxOf(await made());
    expect(cell(ctx, "name", "a")).toEqual(["Pour footings", "pour footings"]);
    expect([cell(ctx, "step", "a"), cell(ctx, "step", "u"), cell(ctx, "step", "d"), cell(ctx, "step", "x")]).toEqual([
      ["Now", 0],
      ["Review", 1],
      ["Done", 3],
      ["No step", -1],
    ]);
    expect(["a", "b", "u", "d"].map((id) => cell(ctx, "status", id))).toEqual([
      ["late", 2],
      ["in progress", 3],
      ["not started", 4],
      ["done", 5],
    ]);
    expect(["a", "b", "m", "u"].map((id) => cell(ctx, "assignees", id))).toEqual([
      ["Ana Ruiz", 1],
      ["Mira Okafor, Ana Ruiz, Ole Berg, Kai Moss", 0],
      ["Former: Dana Lee", 4],
      ["", null],
    ]);
    expect([cell(ctx, "start", "a"), cell(ctx, "end", "a"), cell(ctx, "start", "m"), cell(ctx, "end", "m"), cell(ctx, "start", "u"), cell(ctx, "end", "u")]).toEqual([
      ["2 Nov", toDay("2026-11-02")],
      ["4 Nov", toDay("2026-11-04")],
      ["20 Nov", toDay("2026-11-20")],
      ["", null],
      ["", null],
      ["", null],
    ]);
    expect([cell(ctx, "days", "a"), cell(ctx, "days", "m"), cell(ctx, "days", "u")]).toEqual([
      ["3", 3],
      ["", null],
      ["3", 3],
    ]);
    expect([cell(ctx, "progress", "b"), cell(ctx, "progress", "a")]).toEqual([
      ["40%", 40],
      ["0%", 0],
    ]);
    expect([cell(ctx, "late", "a"), cell(ctx, "late", "b"), cell(ctx, "late", "d")]).toEqual([
      ["3 d", 3],
      ["", null],
      ["", null],
    ]);
    expect([cell(ctx, "deps", "b"), cell(ctx, "deps", "a"), cell(ctx, "blocks", "a"), cell(ctx, "blocks", "b")]).toEqual([
      ["Pour footings FS", "pour footings fs"],
      ["", null],
      ["Build FS", "build fs"],
      ["", null],
    ]);
    expect([cell(ctx, "group", "a"), cell(ctx, "group", "b")]).toEqual([
      ["Site works", 0],
      ["", null],
    ]);
    expect([cell(ctx, "kind", "a"), cell(ctx, "kind", "m")]).toEqual([
      ["Task", 0],
      ["Milestone", 1],
    ]);
    expect([cell(ctx, "note", "b"), cell(ctx, "note", "a")]).toEqual([
      ["Order the crane", "order the crane"],
      ["", null],
    ]);
  });

  it("counts Late by in working days, a weekend and a closure not counted", async () => {
    const t = await testSession([{ id: "a", name: "A", start: "2026-11-02", dur: 3 }], {
      today: "2026-11-16",
      calendar: { closures: new Map([["c1", { id: "c1", name: "Shut", from: "2026-11-12", to: "2026-11-12" }]]) },
    });
    sessions.push(t.session);
    expect(cell(ctxOf(t), "late", "a")).toEqual(["7 d", 7]);
  });

  it("shows 0 d for an item that ended on Friday and is looked at on Saturday: no working day has passed", async () => {
    const t = await testSession([{ id: "a", name: "A", start: "2026-11-02", dur: 5 }], { today: "2026-11-07" });
    sessions.push(t.session);
    const ctx = ctxOf(t);
    expect([ctx.view.derived.late.has("a"), cell(ctx, "late", "a")]).toEqual([true, ["0 d", 0]]);
  });

  it("throws for a late item that ends on or after today, rather than invent a figure", async () => {
    const t = await testSession([{ id: "a", name: "A", start: "2026-11-02", dur: 5 }], { today: "2026-11-07" });
    sessions.push(t.session);
    const ctx = ctxOf(t);
    expect(() => columnById("late").value({ ...ctx, today: toDay("2026-11-06") }, "a")).toThrow("List: item a is marked late, but it ends on or after today");
  });

  it("throws for a step with no rank rather than sort it as No step", async () => {
    const ctx = ctxOf(await made());
    expect(() => columnById("step").sortKey({ ...ctx, stepRank: new Map() }, "a")).toThrow("List: step now has no rank");
  });

  it("says a done item without a completing step sits in its stored step", async () => {
    const t = await made();
    act(() => {
      t.session.apply({ t: "step", op: "completes", step: "done", completes: false });
    });
    expect(cell(ctxOf(t), "step", "d")).toEqual(["Later", 2]);
  });

  it("renders a step's swatch, up to three avatars and the first name with the rest counted, and a milestone's diamond", async () => {
    const ctx = ctxOf(await made());
    const shown = (col: ColumnId, id: string): HTMLElement => render(<div data-cell="">{columnById(col).render(ctx, id, "")}</div>).container;
    const who = shown("assignees", "b");
    expect([[...who.querySelectorAll(".avatar")].map((a) => a.textContent), who.querySelector(".who-names")?.textContent]).toEqual([["MO", "AR", "OB"], "Mira Okafor +3"]);
    const former = shown("assignees", "m");
    expect([[...former.querySelectorAll(".avatar")].map((a) => a.className), former.querySelector(".who-names")?.textContent]).toEqual([["avatar former"], "Former: Dana Lee"]);
    const step = shown("step", "u");
    expect([step.querySelector(".cell-step .swatch") !== null, step.textContent]).toEqual([true, "Review"]);
    const none = shown("step", "x");
    expect([none.querySelector(".dim")?.textContent]).toEqual(["No step"]);
    expect(shown("name", "m").querySelector(".list-name")?.textContent).toBe("◆ Dome set");
  });

  it("fills only Name and Status for a ghost row", async () => {
    const t = await testSession([
      { id: "S", name: "Sprint 4", kind: "group" },
      { id: "r", name: "Review", parent: "S", start: "2026-11-10", dur: 3, status: "doing", note: "kept" },
    ]);
    sessions.push(t.session);
    const p = await t.peer("iphone");
    sessions.push(p.session);
    t.session.apply({ t: "trash", items: ["S"] });
    p.session.apply({ t: "rename", item: "r", name: "Review 2" });
    p.sync();
    const ctx = ctxOf(t);
    expect(COLUMNS.map((c) => [c.id, ...cell(ctx, c.id, "r")])).toEqual(
      COLUMNS.map((c) => (c.id === "name" ? ["name", "Review 2", "review 2"] : c.id === "status" ? ["status", "held", 1] : [c.id, "", null])),
    );
  });
});
