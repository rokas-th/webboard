import { describe, expect, it, vi } from "vitest";
import type { Item, ItemId, PlanState } from "../domain/model";
import { LogState } from "../log/state";
import { childrenOf, projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { buildImport } from "../store/file";
import { convertGantt, defaultPlanName, htmlToText, localDate, readBack, type GanttPlan } from "./gantt";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

type Task = Record<string, unknown>;

const FILE = "Fixture Plan 20260901.gantt";

const leaf = (id: number, name: string, start: string, end: string, dur: number, extra: Task = {}): Task => ({
  TaskID: id,
  TaskName: name,
  StartDate: `${start}T06:00:00.000Z`,
  EndDate: `${end}T15:00:00.000Z`,
  Duration: dur,
  DurationUnit: "day",
  Progress: 0,
  Predecessor: "",
  resources: [],
  color: "#3366ff",
  info: "",
  subtasks: [],
  ...extra,
});

const group = (id: number, name: string, subtasks: Task[], extra: Task = {}): Task => ({
  TaskID: id,
  TaskName: name,
  StartDate: "2026-09-07T06:00:00.000Z",
  EndDate: "2026-09-23T15:00:00.000Z",
  Duration: 13,
  DurationUnit: "day",
  Progress: 37,
  Predecessor: null,
  resources: [],
  color: "#999999",
  info: "",
  subtasks,
  ...extra,
});

const tasks = (): Task[] => [
  group(
    1,
    "Phase A",
    [
      leaf(2, "Design", "2026-09-07", "2026-09-11", 5, {
        Progress: 100,
        info: "<p>Fish &amp; chips</p><p>Line&nbsp;two<br>three &#38; &#x41;</p>",
        resources: [
          { resourceId: "r1", resourceName: "Lab", unit: 100 },
          { resourceId: "r2", resourceName: "QA" },
        ],
      }),
      leaf(3, "Build", "2026-09-14", "2026-09-18", 5, { Progress: 40, Predecessor: "2FS" }),
      leaf(4, "Review", "2026-09-18", "2026-09-18", 0, { Predecessor: "3FF" }),
    ],
    { info: "<p>Group info</p>" },
  ),
  group(5, "Phase B", [
    leaf(7, "Parallel", "2026-09-16", "2026-09-18", 3, { Predecessor: "3SS+2 days", info: "plain text note" }),
    group(6, "Sub", [
      leaf(8, "Late", "2026-09-22", "2026-09-23", 2, { Predecessor: "3FS+1 day, 7FS-1 days" }),
      leaf(9, "Back", "2026-09-22", "2026-09-22", 1, { Predecessor: "8SF" }),
    ]),
  ]),
];

const source = (data: Task[] = tasks(), advanced: Task = {}, top: Task = {}): Record<string, unknown> => ({
  data,
  resources: [{ resourceId: "r1", resourceName: "Lab" }],
  projectStartDate: null,
  projectEndDate: null,
  advanced: {
    columns: [],
    zoomLevel: 0,
    timezone: "Europe/Zurich",
    timezoneOffset: -60,
    dependencyConflict: "Add Offset to Dependency",
    dateFormat: "yyyy-MM-dd",
    timeFormat: "HH:mm",
    firstDayOfWeek: 0,
    workWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    workTime: [
      { from: 8, to: 12 },
      { from: 13, to: 17 },
    ],
    holidays: [],
    ...advanced,
  },
  ...top,
});

const convert = (src: unknown = source(), fileName = FILE, name?: string): GanttPlan =>
  convertGantt({ text: JSON.stringify(src), fileName, name, dev: "dev-G", ses: "ses-G", now: Date.UTC(2026, 10, 10) });

const mutate = (id: number, patch: Task): Task[] => {
  const walk = (ts: Task[]): Task[] =>
    ts.map((t) => (t.TaskID === id ? { ...t, ...patch } : Array.isArray(t.subtasks) ? { ...t, subtasks: walk(t.subtasks as Task[]) } : t));
  return walk(tasks());
};

const project = (g: GanttPlan): PlanState => {
  const log = new LogState(planRules);
  expect(log.add([g.action]).refused).toEqual([]);
  return projectPlan(g.plan.id, log);
};

const byName = (plan: PlanState, name: string): Item => {
  const hits = [...plan.items.values()].filter((i) => i.name === name);
  if (hits.length !== 1) throw new Error(`${hits.length} items are named ${name}`);
  return hits[0];
};

const linkOf = (plan: PlanState, from: string, to: string) => {
  const f = byName(plan, from).id;
  const t = byName(plan, to).id;
  return [...plan.links.values()].find((l) => l.from === f && l.to === t);
};

describe("convertGantt", () => {
  it("builds groups, tasks and milestones with nesting and source order", () => {
    const plan = project(convert());
    const names = (parent: ItemId | null): string[] => childrenOf(plan, parent).map((i) => i.name);
    expect(plan.name).toBe("Fixture Plan");
    expect(names(null)).toEqual(["Phase A", "Phase B"]);
    expect(names(byName(plan, "Phase A").id)).toEqual(["Design", "Build", "Review"]);
    expect(names(byName(plan, "Phase B").id)).toEqual(["Parallel", "Sub"]);
    expect(names(byName(plan, "Sub").id)).toEqual(["Late", "Back"]);
    expect(byName(plan, "Phase A").kind).toBe("group");
    expect(byName(plan, "Phase A").schedule).toBeNull();
    expect(byName(plan, "Review").kind).toBe("milestone");
    expect(byName(plan, "Review").schedule).toEqual({ start: "2026-09-18", dur: 0, status: "todo", progress: 0, horizon: "later" });
    expect(byName(plan, "Build").kind).toBe("task");
    expect(byName(plan, "Build").schedule).toEqual({ start: "2026-09-14", dur: 5, status: "doing", progress: 40, horizon: "later" });
    expect(byName(plan, "Design").schedule).toEqual({ start: "2026-09-07", dur: 5, status: "done", progress: 100, horizon: "later" });
    expect(byName(plan, "Late").schedule).toEqual({ start: "2026-09-22", dur: 2, status: "todo", progress: 0, horizon: "later" });
  });

  it("maps every predecessor form to a link", () => {
    const plan = project(convert());
    expect(plan.links.size).toBe(6);
    expect(linkOf(plan, "Design", "Build")).toMatchObject({ type: "FS", lag: 0 });
    expect(linkOf(plan, "Build", "Review")).toMatchObject({ type: "FF", lag: 0 });
    expect(linkOf(plan, "Build", "Parallel")).toMatchObject({ type: "SS", lag: 2 });
    expect(linkOf(plan, "Build", "Late")).toMatchObject({ type: "FS", lag: 1 });
    expect(linkOf(plan, "Parallel", "Late")).toMatchObject({ type: "FS", lag: -1 });
    expect(linkOf(plan, "Late", "Back")).toMatchObject({ type: "SF", lag: 0 });
  });

  it("sets the calendar from the work week with no region, closures or holidays", () => {
    const plan = project(convert(source(tasks(), { workWeek: ["Friday", "Monday", "Tuesday", "Wednesday", "Thursday"] })));
    expect(plan.calendar.region).toBeNull();
    expect(plan.calendar.workdays).toEqual([1, 2, 3, 4, 5]);
    expect(plan.calendar.closures.size).toBe(0);
    expect(plan.calendar.tuning.size).toBe(0);
    expect(plan.calendar.holidays.size).toBe(0);
  });

  it("turns info and resources into notes, groups included, and gives an empty item no note", () => {
    const g = convert();
    const plan = project(g);
    const noteOf = (name: string): string | undefined => g.notes.get(byName(plan, name).id);
    expect(noteOf("Design")).toBe("Fish & chips\nLine two\nthree & A\nResources: Lab, QA");
    expect(noteOf("Parallel")).toBe("plain text note");
    expect(noteOf("Phase A")).toBe("Group info");
    expect(noteOf("Build")).toBeUndefined();
    expect(noteOf("Phase B")).toBeUndefined();
    expect([...g.newNotes].sort()).toEqual([...plan.items.keys()].sort());
    expect(g.counts).toEqual({ groups: 3, tasks: 5, milestones: 1, links: 6, notes: 3 });
  });

  it("writes a resources-only note when info is empty", () => {
    const g = convert(source(mutate(3, { resources: [{ resourceId: 7, resourceName: "Shop" }] })));
    expect(g.notes.get(byName(project(g), "Build").id)).toBe("Resources: Shop");
  });

  it("records one baseline named Imported plan at the file's date stamp", () => {
    const plan = project(convert());
    const [b] = [...plan.baselines.values()];
    expect(plan.baselines.size).toBe(1);
    expect(b.name).toBe("Imported plan");
    expect(b.at).toBe("2026-09-01");
    const leaves = [...plan.items.values()].filter((i) => i.kind !== "group");
    expect(Object.keys(b.dates).sort()).toEqual(leaves.map((i) => i.id).sort());
    expect(b.dates[byName(plan, "Late").id]).toEqual({ start: "2026-09-22", dur: 2 });
    expect(b.dates[byName(plan, "Review").id]).toEqual({ start: "2026-09-18", dur: 0 });
  });

  it("dates the baseline at the earliest start when the file name has no stamp", () => {
    const plan = project(convert(source(), "Fixture.gantt"));
    expect(plan.name).toBe("Fixture");
    expect([...plan.baselines.values()][0].at).toBe("2026-09-07");
  });

  it("takes the plan name from the name option", () => {
    expect(project(convert(source(), FILE, "Bridge plan")).name).toBe("Bridge plan");
  });

  it("names what it dropped", () => {
    expect(convert().dropped).toEqual([
      "TaskID on 9 items",
      "color on 9 items",
      "group dates, duration and progress on 3 groups (WebBoard derives group spans)",
      "resources[].unit on 1 resource",
      "the top-level resources list (1 entry)",
      "advanced.workTime",
      "advanced display settings: columns, zoomLevel, timezoneOffset, dependencyConflict, dateFormat, timeFormat, firstDayOfWeek",
    ]);
  });

  it("takes the start from the local date in the file's time zone", () => {
    const g = convert(source(mutate(2, { StartDate: "2026-09-06T22:30:00.000Z" })));
    expect(byName(project(g), "Design").schedule?.start).toBe("2026-09-07");
  });
});

describe("localDate", () => {
  it("reads the local calendar date across daylight saving time", () => {
    expect(localDate("2026-07-15T21:30:00.000Z", "Europe/Zurich", "Task 1 StartDate")).toBe("2026-07-15");
    expect(localDate("2026-07-15T22:30:00.000Z", "Europe/Zurich", "Task 1 StartDate")).toBe("2026-07-16");
    expect(localDate("2026-01-15T22:30:00.000Z", "Europe/Zurich", "Task 1 StartDate")).toBe("2026-01-15");
    expect(localDate("2026-01-15T23:30:00.000Z", "Europe/Zurich", "Task 1 StartDate")).toBe("2026-01-16");
  });
});

describe("htmlToText", () => {
  it("strips tags, decodes entities and ends blocks with newlines", () => {
    expect(htmlToText("<p>a &lt;b&gt; &quot;c&quot; &apos;d&#39;</p><div>e</div><p><br></p>", "Task 1 info")).toBe("a <b> \"c\" 'd'\ne");
    expect(htmlToText("<p><br></p>", "Task 1 info")).toBe("");
    expect(htmlToText("x & y < z", "Task 1 info")).toBe("x & y < z");
  });

  it("refuses an entity it cannot decode", () => {
    expect(() => htmlToText("a &bogus; b", "Task 4 info")).toThrow(/Task 4 info.*&bogus;/);
  });
});

describe("defaultPlanName", () => {
  it("drops the extension and a trailing date stamp", () => {
    expect(defaultPlanName("Fixture Plan 20260901.gantt")).toBe("Fixture Plan");
    expect(defaultPlanName("Plan.gantt")).toBe("Plan");
    expect(defaultPlanName("Plan 2026.gantt")).toBe("Plan 2026");
  });
});

describe("convertGantt refuses what it cannot map", () => {
  const refuses = (src: unknown, pattern: RegExp, fileName = FILE): void => {
    expect(() => convert(src, fileName)).toThrow(pattern);
  };

  it("an unknown DurationUnit", () => refuses(source(mutate(3, { DurationUnit: "hour" })), /Task 3: DurationUnit .*"hour"/));
  it("a link type outside FS, SS, FF and SF", () => refuses(source(mutate(3, { Predecessor: "2XS" })), /Task 3: Predecessor .*link type "XS"/));
  it("a lag unit other than days", () => refuses(source(mutate(3, { Predecessor: "2FS+3 hours" })), /Task 3: Predecessor .*lag unit "hours"/));
  it("a lag that is not a whole number", () => refuses(source(mutate(3, { Predecessor: "2FS+1.5 days" })), /Task 3: Predecessor .*lag "1.5"/));
  it("an unreadable predecessor entry", () => refuses(source(mutate(3, { Predecessor: "FS2" })), /Task 3: Predecessor .*"FS2"/));
  it("a predecessor naming an unknown TaskID", () => refuses(source(mutate(3, { Predecessor: "99FS" })), /Task 3: Predecessor names unknown TaskID 99/));
  it("a predecessor naming itself", () => refuses(source(mutate(3, { Predecessor: "3FS" })), /Task 3: Predecessor names the task itself/));
  it("the same predecessor twice", () => refuses(source(mutate(3, { Predecessor: "2FS,2SS" })), /Task 3: Predecessor names TaskID 2 twice/));
  it("a non-integer duration", () => refuses(source(mutate(3, { Duration: 2.5 })), /Task 3: Duration .*2\.5/));
  it("a negative duration", () => refuses(source(mutate(3, { Duration: -1 })), /Task 3: Duration .*-1/));
  it("progress above 100", () => refuses(source(mutate(3, { Progress: 101 })), /Task 3: Progress .*101/));
  it("progress below 0", () => refuses(source(mutate(3, { Progress: -1 })), /Task 3: Progress .*-1/));
  it("a fractional progress", () => refuses(source(mutate(3, { Progress: 33.5 })), /Task 3: Progress .*33\.5/));
  it("an unparseable StartDate", () => refuses(source(mutate(3, { StartDate: "next Monday" })), /Task 3: StartDate .*"next Monday"/));
  it("an impossible EndDate", () => refuses(source(mutate(3, { EndDate: "2026-02-30T15:00:00.000Z" })), /Task 3: EndDate .*2026-02-30/));
  it("a non-empty holidays list", () => refuses(source(tasks(), { holidays: [{ date: "2026-12-25" }] }), /advanced\.holidays/));
  it("a workWeek day it cannot name", () => refuses(source(tasks(), { workWeek: ["Monday", "Funday"] }), /advanced\.workWeek: .*"Funday"/));
  it("a workWeek naming a day twice", () => refuses(source(tasks(), { workWeek: ["Monday", "Monday"] }), /advanced\.workWeek: .*"Monday" twice/));
  it("an empty workWeek", () => refuses(source(tasks(), { workWeek: [] }), /advanced\.workWeek/));
  it("an unknown time zone", () => refuses(source(tasks(), { timezone: "Mars/Olympus" }), /advanced\.timezone: .*Mars\/Olympus/));
  it("a group with a predecessor", () => refuses(source(mutate(6, { Predecessor: "2FS" })), /Task 6: .*group.*Predecessor/));
  it("a predecessor naming a group", () => refuses(source(mutate(3, { Predecessor: "6FS" })), /Task 3: Predecessor names TaskID 6, a group/));
  it("a duplicate TaskID", () => refuses(source(mutate(3, { TaskID: 2 })), /TaskID 2 appears twice/));
  it("a task field it does not know", () => refuses(source(mutate(3, { Baseline: "x" })), /Task 3: unknown field Baseline/));
  it("a top-level field it does not know", () => refuses(source(tasks(), {}, { calendars: [] }), /unknown top-level field calendars/));
  it("an advanced field it does not know", () => refuses(source(tasks(), { exceptions: [] }), /unknown field advanced\.exceptions/));
  it("a project start date", () => refuses(source(tasks(), {}, { projectStartDate: "2026-09-01T06:00:00.000Z" }), /projectStartDate/));
  it("a task name WebBoard cannot hold", () => refuses(source(mutate(3, { TaskName: " Build" })), /Task 3: TaskName/));
  it("text that is not JSON", () => expect(() => convertGantt({ text: "{", fileName: FILE, dev: "d", ses: "s", now: 0 })).toThrow(/not JSON/));
  it("a plan name WebBoard cannot hold", () => expect(() => convert(source(), FILE, "")).toThrow(/plan name/));
});

describe("the fidelity check", () => {
  it("refuses a plan whose dates differ from the source, listing every mismatch", () => {
    const src = source(mutate(3, { EndDate: "2026-09-17T15:00:00.000Z" }));
    expect(() => convert(src)).toThrow(
      "WebBoard would show different dates than the .gantt file:\n- Task 3 Build: source 2026-09-14 → 2026-09-17, WebBoard 2026-09-14 → 2026-09-18",
    );
  });

  it("refuses a plan WebBoard would show in conflict", () => {
    expect(() => convert(source(mutate(3, { Predecessor: "2FS+1 days" })))).toThrow(/conflict.*Task 2 Design → Task 3 Build/s);
  });

  it("refuses a start on a day off", () => {
    expect(() => convert(source(mutate(9, { StartDate: "2026-09-19T06:00:00.000Z", EndDate: "2026-09-19T15:00:00.000Z" })))).toThrow(
      /Task 9 Back: source 2026-09-19 → 2026-09-19, WebBoard 2026-09-21 → 2026-09-21/,
    );
  });
});

describe("the .wbx round trip", () => {
  it("reads back through buildImport as the same plan", () => {
    const g = convert();
    const r = buildImport(g.bytes, "Fixture Plan 20260901.wbx", "dev-B", "ses-B", 9);
    const log = new LogState(planRules);
    expect(log.add([r.action]).refused).toEqual([]);
    const back = projectPlan(r.planId, log);
    const to = (id: ItemId): ItemId => {
      const m = r.idMap.get(id);
      if (m === undefined) throw new Error(`no new id for ${id}`);
      return m;
    };
    expect(back.name).toBe(g.plan.name);
    expect(back.items).toEqual(
      new Map(
        [...g.plan.items.values()].map((i): [ItemId, Item] => [
          to(i.id),
          { ...i, id: to(i.id), place: { parent: i.place.parent === null ? null : to(i.place.parent), order: i.place.order } },
        ]),
      ),
    );
    expect([...back.links.values()].sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1))).toEqual(
      [...g.plan.links.values()].map((l) => ({ ...l, from: to(l.from), to: to(l.to) })).sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1)),
    );
    expect(back.calendar).toEqual(g.plan.calendar);
    expect([...back.baselines.values()]).toEqual(
      [...g.plan.baselines.values()].map((b) => ({
        ...b,
        id: to(b.id),
        dates: Object.fromEntries(Object.entries(b.dates).map(([k, d]) => [to(k), d])),
      })),
    );
    expect(new Map([...r.notes].filter(([, t]) => t !== ""))).toEqual(new Map([...g.notes].map(([k, t]) => [to(k), t])));
    expect([...r.newNotes].sort()).toEqual([...back.items.keys()].sort());
  });

  it("counts the read-back plan the way the conversion counted it", () => {
    const g = convert();
    expect(readBack(g.bytes, "Fixture Plan 20260901.wbx")).toEqual(g.counts);
  });
});
