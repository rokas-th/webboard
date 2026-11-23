import { describe, expect, it } from "vitest";
import { derive, schedView } from "./derive";
import type { Calendar } from "./calendar";
import { toDay, type IsoDate } from "./dates";
import { EMPTY_PEOPLE, EMPTY_WORKFLOW, linkKey, type Baseline, type Horizon, type Item, type ItemId, type ItemKind, type Link, type PlanState, type Status } from "./model";
import type { Conflict } from "./schedule";
import { CH_ZH, CH_ZH_2026 } from "../test/fixtures/calendars";
import { ln } from "../test/fixtures/sched";

const TODAY = "2026-11-09";

interface Spec {
  kind?: ItemKind;
  parent?: ItemId | null;
  start?: IsoDate | null;
  dur?: number;
  status?: Status;
  progress?: number;
  horizon?: Horizon;
  trashed?: boolean;
}

const item = (id: ItemId, s: Spec = {}): Item => {
  const kind = s.kind ?? "task";
  return {
    id,
    kind,
    name: id,
    trashed: s.trashed ?? false,
    schedule:
      kind === "group"
        ? null
        : {
            start: s.start === undefined ? "2026-11-09" : s.start,
            dur: kind === "milestone" ? 0 : (s.dur ?? 1),
            status: s.status ?? "todo",
            progress: s.progress ?? 0,
            horizon: s.horizon ?? "later",
          },
    place: { parent: s.parent ?? null, order: "a0" },
    refs: {},
  };
};

const group = (id: ItemId, s: Spec = {}): Item => item(id, { ...s, kind: "group" });
const mile = (id: ItemId, s: Spec = {}): Item => item(id, { ...s, kind: "milestone" });

const plan = (
  items: readonly Item[],
  links: readonly Link[] = [],
  o: { calendar?: Calendar; baselines?: readonly Baseline[] } = {},
): PlanState => ({
  id: "P",
  name: "Plan",
  items: new Map(items.map((i) => [i.id, i] as const)),
  links: new Map(links.map((l) => [linkKey(l.from, l.to), l] as const)),
  calendar: o.calendar ?? CH_ZH,
  baselines: new Map((o.baselines ?? []).map((b) => [b.id, b] as const)),
  workflow: EMPTY_WORKFLOW,
  people: EMPTY_PEOPLE,
  defaults: null,
});

const NONE: ReadonlySet<ItemId> = new Set();

describe("derive", () => {
  it("horizon boundaries", () => {
    const d = derive(
      plan([
        item("N1", { start: "2026-11-23" }),
        item("N2", { start: "2026-11-24" }),
        item("N3", { start: "2027-01-04" }),
        item("N4", { start: "2027-01-05" }),
        item("D", { start: "2027-02-01", status: "doing" }),
        item("X", { start: "2026-11-10", status: "done" }),
        item("U", { start: null, horizon: "later" }),
        item("V", { start: null, horizon: "now" }),
      ]),
      NONE,
      TODAY,
    );
    expect(d.horizon).toEqual(
      new Map<ItemId, Horizon>([
        ["N1", "now"],
        ["N2", "next"],
        ["N3", "next"],
        ["N4", "later"],
        ["D", "now"],
        ["U", "later"],
        ["V", "now"],
      ]),
    );
    expect(d.horizon.has("X")).toBe(false);
  });

  it("an unscheduled doing item keeps its stored horizon", () => {
    const d = derive(plan([item("U", { start: null, status: "doing", horizon: "later" })]), NONE, TODAY);
    expect(d.status.get("U")).toBe("doing");
    expect(d.horizon.get("U")).toBe("later");
  });

  it("late", () => {
    const d = derive(
      plan([
        item("L1", { start: "2026-11-02", dur: 5 }),
        item("L2", { start: "2026-11-02", dur: 5, status: "done" }),
        mile("M", { start: "2026-11-06" }),
        item("L3", { start: "2026-11-03", dur: 5 }),
        item("U", { start: null }),
      ]),
      NONE,
      TODAY,
    );
    expect(d.end.get("L3")).toBe(toDay("2026-11-09"));
    expect(d.late).toEqual(new Set(["L1", "M"]));
  });

  it("milestone status", () => {
    const p = plan(
      [
        item("P1", { status: "done" }),
        item("P2", { status: "done" }),
        mile("M1"),
        item("Q1", { status: "done" }),
        item("Q2"),
        mile("M2"),
        item("R1", { status: "done" }),
        item("R2"),
        mile("M3", { status: "done" }),
        mile("M4", { status: "doing" }),
        item("X", { status: "done" }),
        mile("M5", { status: "doing" }),
        mile("M0"),
        item("Z", { trashed: true }),
        mile("M8", { status: "doing" }),
        item("T", { status: "doing" }),
      ],
      [
        ln("P1", "M1"),
        ln("P2", "M1"),
        ln("Q1", "M2"),
        ln("Q2", "M2"),
        ln("R1", "M3"),
        ln("R2", "M3"),
        ln("M5", "X"),
        ln("X", "M5"),
        ln("M1", "M0"),
        ln("Z", "M8"),
        ln("Q2", "T"),
      ],
    );
    const d = derive(p, NONE, TODAY);
    expect(d.status.get("M1")).toBe("done");
    expect(d.status.get("M2")).toBe("todo");
    expect(d.status.get("M3")).toBe("todo");
    expect(d.status.get("M4")).toBe("doing");
    expect(d.status.get("M5")).toBe("doing");
    expect(d.status.get("M0")).toBe("done");
    expect(d.status.get("M8")).toBe("doing");
    expect(d.status.get("T")).toBe("doing");
    expect(d.status.has("Z")).toBe(false);
    const v = schedView(p, NONE);
    expect(v.items.get("M4")?.lock).toBe("doing");
    expect(v.items.get("M5")?.lock).toBe("doing");
    expect(v.items.get("M3")?.lock).toBeNull();
    expect(v.items.get("M0")?.lock).toBe("done");
  });

  it("group spans", () => {
    const p = plan(
      [
        group("G"),
        item("T1", { parent: "G", start: "2026-11-02", dur: 5 }),
        item("T3", { parent: "G", start: "2027-03-01", dur: 5, trashed: true }),
        group("G2", { parent: "G" }),
        item("T2", { parent: "G2", start: "2026-11-16", dur: 5 }),
        group("GU"),
        item("UT", { parent: "GU", start: null, dur: 3 }),
        group("GT", { trashed: true }),
        group("GT2", { parent: "GT" }),
        item("TT", { parent: "GT2", start: "2026-11-02", dur: 2 }),
        mile("TM", { parent: "GT", start: "2026-11-04" }),
      ],
      [ln("TT", "T1"), ln("T1", "TM"), ln("T1", "T2"), ln("T1", "UT"), ln("T3", "T2")],
    );
    const d = derive(p, NONE, TODAY);
    expect([d.start.get("G"), d.end.get("G")]).toEqual([toDay("2026-11-02"), toDay("2026-11-20")]);
    expect([d.start.get("G2"), d.end.get("G2")]).toEqual([toDay("2026-11-16"), toDay("2026-11-20")]);
    expect(d.start.has("GU")).toBe(false);
    expect(d.end.has("GU")).toBe(false);
    ["GT", "GT2", "TT", "TM", "T3"].forEach((id) => {
      expect(d.start.has(id)).toBe(false);
      expect(d.end.has(id)).toBe(false);
      expect(d.status.has(id)).toBe(false);
      expect(d.horizon.has(id)).toBe(false);
      expect(d.late.has(id)).toBe(false);
      expect(d.progress.has(id)).toBe(false);
    });
    const named = d.conflicts.flatMap((c) => (c.kind === "dayoff" ? [c.item] : c.link.split(">")));
    ["GT", "GT2", "TT", "TM", "T3"].forEach((id) => expect(named).not.toContain(id));
    const v = schedView(p, NONE);
    expect([...v.items.keys()].sort()).toEqual(["T1", "T2"]);
    expect(v.links.map((l) => linkKey(l.from, l.to)).sort()).toEqual(["T1>T2", "T1>UT"]);
  });

  it("group progress is duration-weighted", () => {
    const d = derive(
      plan([
        group("G"),
        item("A", { parent: "G", dur: 2, progress: 50 }),
        item("B", { parent: "G", dur: 6, status: "done", progress: 30 }),
      ]),
      NONE,
      TODAY,
    );
    expect(d.progress.get("G")).toBe(88);
  });

  it("group progress is recursive", () => {
    const d = derive(
      plan([
        group("G"),
        item("T1", { parent: "G", dur: 2, progress: 50 }),
        item("T4", { parent: "G", dur: 10, progress: 100, trashed: true }),
        group("G2", { parent: "G" }),
        item("T2", { parent: "G2", dur: 6, status: "done" }),
        item("T3", { parent: "G2", start: null, dur: 4, progress: 0 }),
        mile("M", { parent: "G2", status: "done" }),
        group("G3"),
        mile("M3", { parent: "G3" }),
      ]),
      NONE,
      TODAY,
    );
    expect(d.progress.get("G2")).toBe(60);
    expect(d.progress.get("G")).toBe(58);
    expect(d.progress.has("G3")).toBe(false);
    expect(d.progress.has("T1")).toBe(false);
    expect(d.progress.size).toBe(2);
  });

  it("group progress throws when its tasks have no duration", () => {
    const p = plan([group("G"), item("A", { parent: "G", dur: 0 }), item("B", { parent: "G", dur: 0, trashed: true })]);
    expect(() => derive(p, NONE, TODAY)).toThrow(new Error("group G has tasks but no duration"));
  });

  it("locks", () => {
    const p = plan([
      item("H1"),
      item("H2", { status: "done" }),
      item("H3", { status: "doing" }),
      item("F"),
    ]);
    const v = schedView(p, new Set(["H1", "H2", "H3"]));
    expect(v.items.get("H1")?.lock).toBe("held");
    expect(v.items.get("H2")?.lock).toBe("done");
    expect(v.items.get("H3")?.lock).toBe("doing");
    expect(v.items.get("F")?.lock).toBeNull();
  });

  it("missingYears", () => {
    const items = [item("T", { start: "2027-01-04", dur: 2 })];
    const without: Calendar = { ...CH_ZH, holidays: new Map([[2026, CH_ZH_2026]]) };
    const d = derive(plan(items, [], { calendar: without }), NONE, TODAY);
    expect(d.end.get("T")).toBe(toDay("2027-01-05"));
    expect(d.missingYears).toEqual([2027]);
    expect(derive(plan(items), NONE, TODAY).missingYears).toEqual([]);
  });

  it("missingYears spans today when every item lies later", () => {
    const without: Calendar = { ...CH_ZH, holidays: new Map() };
    expect(derive(plan([item("T", { start: "2027-01-04" })], [], { calendar: without }), NONE, TODAY).missingYears).toEqual([
      2026, 2027,
    ]);
    expect(derive(plan([], [], { calendar: without }), NONE, TODAY).missingYears).toEqual([2026]);
  });

  it("slip", () => {
    const at = (id: string, start: IsoDate): Baseline => ({ id, name: id, at: "2026-10-01", dates: { T1: { start, dur: 5 }, U: { start, dur: 5 } } });
    const p = plan(
      [item("T1", { start: "2026-11-02", dur: 5 }), item("T2", { start: "2026-11-02" }), item("U", { start: null })],
      [],
      { baselines: [at("B1", "2026-10-29"), at("B2", "2026-11-04")] },
    );
    const d = derive(p, NONE, TODAY);
    expect(d.slip("B1")).toEqual(new Map([["T1", 2]]));
    expect(d.slip("B2")).toEqual(new Map([["T1", -2]]));
    expect(d.slip("B1").has("T2")).toBe(false);
    expect(d.slip("B1").has("U")).toBe(false);
    expect(() => d.slip("nope")).toThrow(new Error("no baseline nope"));
  });

  it("slip compares ends", () => {
    const base: Baseline = {
      id: "B",
      name: "B",
      at: "2026-11-01",
      dates: {
        A: { start: "2026-11-09", dur: 3 },
        B: { start: "2026-11-12", dur: 2 },
        C: { start: "2026-11-09", dur: 5 },
        M: { start: "2026-11-13", dur: 0 },
      },
    };
    const p = plan(
      [
        item("A", { start: "2026-11-09", dur: 8 }),
        item("B", { start: "2026-11-19", dur: 2 }),
        item("C", { start: "2026-11-09", dur: 3 }),
        mile("M", { start: "2026-11-17" }),
      ],
      [ln("A", "B")],
      { baselines: [base] },
    );
    expect(derive(p, NONE, TODAY).slip("B")).toEqual(
      new Map([
        ["A", 5],
        ["B", 5],
        ["C", -2],
        ["M", 2],
      ]),
    );
  });

  it("slip of a done task after a closure", () => {
    const base: Baseline = { id: "B", name: "B", at: "2026-11-01", dates: { T: { start: "2026-11-09", dur: 5 } } };
    const calendar: Calendar = { ...CH_ZH, closures: new Map([["c1", { id: "c1", from: "2026-11-11", to: "2026-11-11", name: "Closed" }]]) };
    const p = plan([item("T", { start: "2026-11-09", dur: 4, status: "done", progress: 100 })], [], { calendar, baselines: [base] });
    const d = derive(p, NONE, TODAY);
    expect(d.end.get("T")).toBe(toDay("2026-11-13"));
    expect(d.slip("B")).toEqual(new Map([["T", -1]]));
  });

  it("parent cycle", () => {
    const p = plan([group("G1", { parent: "G2" }), group("G2", { parent: "G1" }), item("T", { parent: "G1" })]);
    expect(() => derive(p, NONE, TODAY)).toThrow(new Error("parent cycle: G1, G2"));
  });

  it("unknown parent", () => {
    expect(() => derive(plan([item("T", { parent: "NOPE" })]), NONE, TODAY)).toThrow(new Error("unknown parent NOPE of T"));
  });

  it("parent that is not a group", () => {
    expect(() => derive(plan([item("A"), item("T", { parent: "A" })]), NONE, TODAY)).toThrow(new Error("parent A of T is not a group"));
  });

  it("conflicts cover the view, unscheduled items included", () => {
    const p = plan(
      [item("A", { start: "2026-11-02", dur: 5 }), item("B", { start: "2026-11-04", dur: 2 }), item("U", { start: null }), item("S", { start: "2026-11-14" })],
      [ln("A", "B"), ln("U", "A"), ln("A", "U")],
    );
    expect(derive(p, NONE, TODAY).conflicts).toEqual<Conflict[]>([
      { kind: "loop", link: "A>U" },
      { kind: "loop", link: "U>A" },
      { kind: "early", link: "A>B", pred: "A", succ: "B", need: toDay("2026-11-09"), succLock: null },
      { kind: "dayoff", item: "S", shownFrom: toDay("2026-11-16") },
    ]);
  });
});
