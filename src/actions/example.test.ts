import { describe, expect, it } from "vitest";
import { workCalendar, type Calendar, type WorkCalendar } from "../domain/calendar";
import { toDay, toIso, type Day, type IsoDate } from "../domain/dates";
import { derive, schedView } from "../domain/derive";
import type { Item, ItemId, PlanState } from "../domain/model";
import { earliest, endOf } from "../domain/schedule";
import { LogState } from "../log/state";
import { childrenOf, projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { CH_ZH } from "../test/fixtures/calendars";
import { buildExample, exampleYears } from "./example";

const PLAN = "planExample";

const plainCalendar = (): Calendar => ({ region: null, workdays: [1, 2, 3, 4, 5], closures: new Map(), tuning: new Map(), holidays: new Map() });

const TABLE: readonly (readonly [string, string, string, number, string, number, readonly string[]])[] = [
  ["Discovery", "Kickoff", "milestone", 0, "done", 100, []],
  ["Discovery", "Stakeholder interviews", "task", 4, "done", 100, ["Kickoff"]],
  ["Discovery", "Requirements", "task", 3, "done", 100, ["Stakeholder interviews"]],
  ["Design", "Wireframes", "task", 4, "done", 100, ["Requirements"]],
  ["Design", "Visual design", "task", 5, "doing", 60, ["Wireframes"]],
  ["Design", "Design sign-off", "milestone", 0, "todo", 0, ["Visual design"]],
  ["Build › Backend", "CMS setup", "task", 4, "done", 100, ["Requirements"]],
  ["Build › Backend", "Content migration", "task", 5, "todo", 0, ["CMS setup", "Design sign-off"]],
  ["Build › Backend", "Search", "task", 3, "todo", 0, ["CMS setup", "Design sign-off"]],
  ["Build › Frontend", "Page templates", "task", 6, "doing", 30, ["Wireframes"]],
  ["Build › Frontend", "Responsive pass", "task", 3, "todo", 0, ["Page templates", "Design sign-off"]],
  ["Launch", "QA and fixes", "task", 4, "todo", 0, ["Content migration", "Search", "Responsive pass"]],
  ["Launch", "Go live", "milestone", 0, "todo", 0, ["QA and fixes"]],
  ["Launch", "Retrospective", "task", 1, "todo", 0, ["Go live"]],
];

const NOTES: Readonly<Record<string, string>> = {
  Kickoff: "Agenda: goals, scope, roles. The slides are in the shared drive.",
  "Visual design": "Two directions presented; the client prefers B. Waiting for the final logo files.",
  "QA and fixes": "Test in Safari, Chrome and Firefox, on desktop and on a phone.",
};

interface Projected {
  ex: ReturnType<typeof buildExample>;
  plan: PlanState;
  derived: ReturnType<typeof derive>;
  cal: WorkCalendar;
  base: WorkCalendar;
  t: Day;
  byName(name: string): Item;
}

function project(today: IsoDate, calendar: Calendar): Projected {
  const ex = buildExample({ id: PLAN, dev: "dev-A", ses: "s-A", now: 7, today, calendar });
  const log = new LogState(planRules);
  expect(log.add([ex.action]).refused).toEqual([]);
  const plan = projectPlan(PLAN, log);
  const derived = derive(plan, new Set(), today);
  const cal = workCalendar(plan.calendar);
  const base = workCalendar(calendar);
  const byName = (name: string): Item => {
    const hits = [...plan.items.values()].filter((i) => i.name === name);
    if (hits.length !== 1) throw new Error(`${hits.length} items are named ${name}`);
    return hits[0];
  };
  return { ex, plan, derived, cal, base, t: cal.snapF(toDay(today)), byName };
}

const CASES: readonly (readonly [string, IsoDate, Calendar, IsoDate])[] = [
  ["a weekday", "2026-11-10", plainCalendar(), "2026-11-10"],
  ["a Saturday", "2026-11-14", plainCalendar(), "2026-11-16"],
  ["a public holiday in a region", "2026-12-25", CH_ZH, "2026-12-28"],
];

const startOfItem = (p: Projected, name: string): Day => {
  const s = p.derived.start.get(p.byName(name).id);
  if (s === undefined) throw new Error(`${name} has no start`);
  return s;
};

const endOfItem = (p: Projected, name: string): Day => {
  const e = p.derived.end.get(p.byName(name).id);
  if (e === undefined) throw new Error(`${name} has no end`);
  return e;
};

describe.each(CASES)("the example plan, today on %s", (_, today, calendar, firstWorkday) => {
  it("is one root action labelled Created the example plan, written as own state", () => {
    const { ex, plan } = project(today, calendar);
    expect(ex.action.par).toEqual([]);
    expect(ex.action.lbl).toBe("Created the example plan");
    expect(ex.action.dev).toBe("dev-A");
    expect(ex.action.ses).toBe("s-A");
    expect(ex.action.at).toBe(7);
    expect(ex.action.meta).toBeUndefined();
    expect(new Set(ex.action.w.map((w) => w.c))).toEqual(new Set(["own"]));
    expect(plan.name).toBe("Example: Website relaunch");
  });

  it("holds the R1 table: groups, nesting, kinds, durations, statuses, links and notes", () => {
    const p = project(today, calendar);
    const names = (parent: ItemId | null): string[] => childrenOf(p.plan, parent).map((i) => i.name);
    const group = (name: string): Item => {
      const g = p.byName(name);
      expect(g.kind).toBe("group");
      expect(g.schedule).toBeNull();
      return g;
    };
    expect(names(null)).toEqual(["Discovery", "Design", "Build", "Launch"]);
    expect(names(group("Build").id)).toEqual(["Backend", "Frontend"]);
    const outline = (parent: ItemId | null, path: readonly string[]): (readonly [string, Item])[] =>
      childrenOf(p.plan, parent).flatMap((i) => (i.kind === "group" ? outline(i.id, [...path, i.name]) : [[path.join(" › "), i] as const]));
    const rows = outline(null, [])
      .map(([path, i]) => {
        const s = i.schedule;
        if (s === null) throw new Error(`${i.name} has no schedule`);
        const preds = [...p.plan.links.values()].filter((l) => l.to === i.id).map((l) => p.plan.items.get(l.from)?.name);
        return [path, i.name, i.kind, s.dur, s.status, s.progress, preds] as const;
      });
    const sortedPreds = (xs: readonly (string | undefined)[]): (string | undefined)[] => [...xs].sort();
    expect(rows.map(([g, n, k, d, st, pr, preds]) => [g, n, k, d, st, pr, sortedPreds(preds)])).toEqual(
      TABLE.map(([g, n, k, d, st, pr, preds]) => [g, n, k, d, st, pr, sortedPreds(preds)]),
    );
    expect(["Discovery", "Design", "Backend", "Frontend", "Launch"].map((g) => names(group(g).id))).toEqual([
      ["Kickoff", "Stakeholder interviews", "Requirements"],
      ["Wireframes", "Visual design", "Design sign-off"],
      ["CMS setup", "Content migration", "Search"],
      ["Page templates", "Responsive pass"],
      ["QA and fixes", "Go live", "Retrospective"],
    ]);
    expect([...p.plan.links.values()].every((l) => l.type === "FS" && l.lag === 0)).toBe(true);
    expect(p.plan.links.size).toBe(TABLE.reduce((n, row) => n + row[6].length, 0));
    expect(p.plan.items.size).toBe(TABLE.length + 6);
    expect([...p.plan.items.values()].every((i) => !i.trashed && Object.keys(i.refs).length === 0)).toBe(true);
    expect(new Set(p.ex.newNotes)).toEqual(new Set(p.plan.items.keys()));
    expect(p.ex.newNotes).toHaveLength(p.plan.items.size);
    expect(Object.fromEntries([...p.ex.notes].map(([id, text]) => [p.plan.items.get(id)?.name, text]))).toEqual(NOTES);
  });

  it("has no conflicts, no day-off markers and nothing late", () => {
    const p = project(today, calendar);
    expect(p.derived.conflicts).toEqual([]);
    expect(p.derived.late.size).toBe(0);
    expect(p.derived.missingYears).toEqual([]);
    [...schedView(p.plan, new Set()).items.values()].forEach((s) => {
      expect(p.cal.isWork(s.start), toIso(s.start)).toBe(true);
      expect(p.cal.isWork(endOf(s, p.cal)), toIso(endOf(s, p.cal))).toBe(true);
    });
  });

  it("starts every item on the earliest day its links allow", () => {
    const p = project(today, calendar);
    const view = schedView(p.plan, new Set());
    const sched = (id: ItemId) => {
      const s = view.items.get(id);
      if (s === undefined) throw new Error(`${id} is not scheduled`);
      return s;
    };
    [...view.items.values()].forEach((s) => {
      const into = view.links.filter((l) => l.to === s.id);
      if (into.length === 0) return;
      expect(toIso(s.start), p.plan.items.get(s.id)?.name).toBe(toIso(Math.max(...into.map((l) => earliest(s, l, sched(l.from), p.cal)))));
    });
  });

  it("ends done work before today's first working day, runs doing work from before it to after it and starts todo work after it", () => {
    const p = project(today, calendar);
    expect(toIso(p.t)).toBe(firstWorkday);
    const named = (keep: (row: (typeof TABLE)[number]) => boolean): string[] => TABLE.filter(keep).map((row) => row[1]);
    expect(named((row) => row[4] === "doing")).toEqual(["Visual design", "Page templates"]);
    expect(named((row) => row[4] === "todo" && row[2] === "milestone")).toEqual(["Design sign-off", "Go live"]);
    named((row) => row[4] === "done").forEach((name) => expect(endOfItem(p, name) < p.t, name).toBe(true));
    named((row) => row[4] === "doing").forEach((name) => {
      expect(startOfItem(p, name) < p.t, name).toBe(true);
      expect(endOfItem(p, name) > p.t, name).toBe(true);
    });
    named((row) => row[4] === "todo").forEach((name) => expect(startOfItem(p, name) > p.t, name).toBe(true));
  });

  it("starts Visual design and Page templates 3 working days before today's first working day, so Kickoff sits 15 working days before it", () => {
    const p = project(today, calendar);
    const lead = toIso(p.cal.subWork(p.t, 3));
    expect([toIso(startOfItem(p, "Visual design")), toIso(startOfItem(p, "Page templates"))]).toEqual([lead, lead]);
    expect(toIso(startOfItem(p, "Kickoff"))).toBe(toIso(p.cal.subWork(p.t, 15)));
    expect(toIso(startOfItem(p, "Search"))).toBe(toIso(p.cal.after(endOfItem(p, "Design sign-off"))));
  });

  it("closes the 6th and 7th working days after today's first working day for the Team offsite, and dates skip them", () => {
    const p = project(today, calendar);
    const closures = [...p.plan.calendar.closures.values()];
    expect(closures.map((c) => [c.name, c.from, c.to])).toEqual([["Team offsite", toIso(p.base.addWork(p.t, 6)), toIso(p.base.addWork(p.t, 7))]]);
    expect(p.cal.workBetween(toDay(closures[0].from), toDay(closures[0].to))).toBe(0);
    expect(p.plan.calendar.region).toEqual(calendar.region);
    expect(p.plan.calendar.workdays).toEqual([1, 2, 3, 4, 5]);
    expect([...p.plan.calendar.holidays.keys()]).toEqual([...calendar.holidays.keys()]);
    const s = startOfItem(p, "Content migration");
    const e = endOfItem(p, "Content migration");
    const [from, to] = [toDay(closures[0].from), toDay(closures[0].to)];
    expect(s < from && to < e, `${toIso(s)}..${toIso(e)} around ${closures[0].from}..${closures[0].to}`).toBe(true);
    expect(toIso(e)).toBe(toIso(p.cal.addWork(s, 4)));
    expect(toIso(e)).toBe(toIso(p.base.addWork(p.base.addWork(s, 4), 2)));
    expect(p.cal.workBetween(s, e)).toBe(5);
  });

  it("keeps the Agreed plan baseline: the same dates with Visual design at 3 days, so Design sign-off and the work that waits on it slip", () => {
    const p = project(today, calendar);
    const baselines = [...p.plan.baselines.values()];
    expect(baselines.map((b) => b.name)).toEqual(["Agreed plan"]);
    const b = baselines[0];
    expect(b.at).toBe(toIso(startOfItem(p, "Kickoff")));
    const view = schedView(p.plan, new Set());
    expect(new Set(Object.keys(b.dates))).toEqual(new Set(view.items.keys()));
    const id = (name: string): ItemId => p.byName(name).id;
    expect(b.dates[id("Visual design")].dur).toBe(3);
    const planned = (sid: ItemId) => {
      const s = view.items.get(sid);
      const d = b.dates[sid];
      if (s === undefined || d === undefined) throw new Error(`${sid} is not in the baseline`);
      return { ...s, start: toDay(d.start), dur: d.dur };
    };
    [...view.items.keys()].forEach((sid) => {
      const name = p.plan.items.get(sid)?.name;
      if (name !== "Visual design") expect(b.dates[sid].dur, name).toBe(view.items.get(sid)?.dur);
      const into = view.links.filter((l) => l.to === sid);
      const want = into.length === 0 ? toDay(b.dates[sid].start) : Math.max(...into.map((l) => earliest(planned(sid), l, planned(l.from), p.cal)));
      expect(b.dates[sid].start, name).toBe(toIso(want));
    });
    const slip = p.derived.slip(b.id);
    const slipOf = (name: string): number | undefined => slip.get(id(name));
    expect(Object.fromEntries(TABLE.map((row) => [row[1], slipOf(row[1])]))).toEqual({
      Kickoff: 0,
      "Stakeholder interviews": 0,
      Requirements: 0,
      Wireframes: 0,
      "Visual design": 0,
      "Design sign-off": 2,
      "CMS setup": 0,
      "Content migration": 2,
      Search: 2,
      "Page templates": 0,
      "Responsive pass": 0,
      "QA and fixes": 1,
      "Go live": 1,
      Retrospective: 1,
    });
  });

  it("makes fresh ids for every creation", () => {
    const a = project(today, calendar);
    const b = project(today, calendar);
    const idsOf = (p: Projected): string[] => [p.ex.action.id, ...p.plan.items.keys(), ...p.plan.calendar.closures.keys(), ...p.plan.baselines.keys()];
    const shared = idsOf(a).filter((x) => idsOf(b).includes(x));
    expect(shared).toEqual([]);
  });
});

describe("exampleYears", () => {
  it("warms this year and next, and last year when the example reaches back into it", () => {
    expect(exampleYears("2026-11-10")).toEqual([2026, 2027]);
    expect(exampleYears("2027-01-12")).toEqual([2026, 2027, 2028]);
    expect(exampleYears("2027-03-01")).toEqual([2026, 2027, 2028]);
    expect(exampleYears("2027-03-02")).toEqual([2027, 2028]);
  });
});
