import { describe, expect, it, vi } from "vitest";
import type { Item, ItemId, PlanState } from "../domain/model";
import { LogState } from "../log/state";
import { childrenOf, projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { buildImport } from "../store/file";
import { convertGantt, defaultPlanName, htmlToText, infoToText, localDate, readBack, standardOffset, type GanttPlan } from "./gantt";

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
      "resources[].resourceId on 2 resources",
      "resources[].unit on 1 resource",
      "the top-level resources list (1 entry)",
      "advanced.workTime",
      "advanced display settings: columns, zoomLevel, dateFormat, timeFormat, firstDayOfWeek",
      'dependencyConflict "Add Offset to Dependency" (a scheduling option of the source tool; WebBoard keeps its own link rules)',
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

describe("standardOffset", () => {
  it("gives the standard-time offset in getTimezoneOffset's sign", () => {
    expect(standardOffset("Europe/Zurich", 2026)).toBe(-60);
    expect(standardOffset("America/New_York", 2026)).toBe(300);
    expect(standardOffset("Australia/Sydney", 2026)).toBe(-600);
    expect(standardOffset("UTC", 2026)).toBe(0);
  });
});

describe("infoToText", () => {
  it("keeps plain text verbatim apart from the trim", () => {
    expect(infoToText("  x &amp; y < z <b>w</b>\r\n  ", "Task 1 info")).toBe("x &amp; y < z <b>w</b>");
  });

  it("reads text that starts with < as HTML", () => {
    expect(infoToText("  <p>a &amp; b</p>  ", "Task 1 info")).toBe("a & b");
  });
});

describe("htmlToText", () => {
  it("strips allow-listed tags, decodes entities and ends blocks with newlines", () => {
    expect(htmlToText("<p>a &lt;b&gt; &quot;c&quot; &apos;d&#39;</p><div>e</div><p><br></p>", "Task 1 info")).toBe("a <b> \"c\" 'd'\ne");
    expect(htmlToText("<p><br></p>", "Task 1 info")).toBe("");
    expect(htmlToText('<p style="color: red" class="x"><b>bold</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u> <span>t</span></p>', "Task 1 info")).toBe(
      "bold s i e u t",
    );
  });

  it("turns list items into bullet lines", () => {
    expect(htmlToText("<p>Steps</p><ul><li>one</li><li>two</li></ul><ol><li>three</li></ol><p>after</p>", "Task 1 info")).toBe(
      "Steps\n• one\n• two\n• three\nafter",
    );
    expect(htmlToText("text<ul><li>one</li></ul>", "Task 1 info")).toBe("text\n• one");
  });

  it("collapses runs of three or more newlines to two", () => {
    expect(htmlToText("<p>a</p><p><br></p><p><br></p><p><br></p><p>b</p>", "Task 1 info")).toBe("a\n\nb");
    expect(htmlToText("<p>a<br><br>b</p>", "Task 1 info")).toBe("a\n\nb");
  });

  it("decodes numeric entities, decimal and hex", () => {
    expect(htmlToText("<p>&#65;&#x42;&#X43;&#128512;</p>", "Task 1 info")).toBe("ABC\u{1F600}");
  });

  it("decodes the Latin-1 and typographic named entities", () => {
    expect(htmlToText("<p>&auml;&ouml;&uuml;&Auml;&Ouml;&Uuml;&szlig;&eacute;&egrave;&agrave;&ccedil;&deg;&plusmn;&times;</p>", "Task 1 info")).toBe(
      "äöüÄÖÜßéèàç°±×",
    );
    expect(htmlToText("<p>w&nbsp;x&ndash;&mdash;&lsquo;&rsquo;&ldquo;&rdquo;&hellip;&euro;&copy;&yuml;&iexcl;</p>", "Task 1 info")).toBe(
      "w\u00a0x–—‘’“”…€©ÿ¡",
    );
    expect(htmlToText("<p>&amp;&lt;&gt;&quot;&apos;</p>", "Task 1 info")).toBe("&<>\"'");
  });

  it("refuses an entity it cannot decode", () => {
    expect(() => htmlToText("<p>a &bogus; b</p>", "Task 4 info")).toThrow(/Task 4 info.*&bogus;/);
  });

  it("refuses a numeric entity outside Unicode", () => {
    expect(() => htmlToText("<p>&#x110000;</p>", "Task 4 info")).toThrow(/Task 4 info.*&#x110000;/);
    expect(() => htmlToText("<p>&#99999999999;</p>", "Task 4 info")).toThrow(/Task 4 info.*&#99999999999;/);
  });

  it("refuses a tag outside the allow-list", () => {
    expect(() => htmlToText('<p><a href="x">link</a></p>', "Task 4 info")).toThrow(/Task 4 info.*<a href="x">/);
    expect(() => htmlToText("<p><h1>t</h1></p>", "Task 4 info")).toThrow(/Task 4 info.*<h1>/);
  });

  it("refuses an attribute other than style or class", () => {
    expect(() => htmlToText('<p onclick="x()">t</p>', "Task 4 info")).toThrow(/Task 4 info.*attribute onclick/);
  });

  it("refuses a comment", () => {
    expect(() => htmlToText("<p>a<!-- hidden --></p>", "Task 4 info")).toThrow(/Task 4 info.*<!--/);
  });

  it("refuses a < that starts no allow-listed tag", () => {
    expect(() => htmlToText("<p>a < b</p>", "Task 4 info")).toThrow(/Task 4 info.*"< b<\/p>"/);
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
  it("a duration above 3650 days", () => refuses(source(mutate(3, { Duration: 3651 })), /Task 3: Duration is not a whole number from 0 to 3650: 3651/));
  it("a lag above 1000 days", () => refuses(source(mutate(3, { Predecessor: "2FS+1001 days" })), /Task 3: Predecessor entry "2FS\+1001 days" has a lag beyond 1000 working days either way/));
  it("a lead above 1000 days", () => refuses(source(mutate(3, { Predecessor: "2SS-1001 days" })), /Task 3: Predecessor entry "2SS-1001 days" has a lag beyond 1000 working days either way/));
  it("a StartDate before 1900", () =>
    refuses(source(mutate(3, { StartDate: "1899-12-29T06:00:00.000Z" })), /Task 3: StartDate 1899-12-29 is not a date from 1900-01-01 to 2199-12-31/));
  it("a StartDate after 2199", () =>
    refuses(source(mutate(3, { StartDate: "2200-01-05T06:00:00.000Z", EndDate: "2200-01-06T15:00:00.000Z" })), /Task 3: StartDate 2200-01-05 is not a date from 1900-01-01 to 2199-12-31/));
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
  it("a project end date", () => refuses(source(tasks(), {}, { projectEndDate: "2026-12-01T06:00:00.000Z" }), /projectEndDate: is set/));
  it("a resources[] field it does not know", () =>
    refuses(source(mutate(3, { resources: [{ resourceId: "r1", resourceName: "Lab", cost: 5 }] })), /Task 3: unknown field resources\[0\]\.cost/));
  it("a blank resourceName", () =>
    refuses(source(mutate(3, { resources: [{ resourceId: "r1", resourceName: "  " }] })), /Task 3: resources\[0\]\.resourceName is blank/));
  it("a task without resources", () => {
    const data = mutate(3, {});
    const phase = data[0].subtasks as Task[];
    delete phase[1].resources;
    refuses(source(data), /Task 3: resources is not a list: nothing/);
  });
  it("a task whose resources are null", () => refuses(source(mutate(3, { resources: null })), /Task 3: resources is not a list: null/));
  it("a file without top-level resources", () => {
    const src = source();
    delete src.resources;
    refuses(src, /The \.gantt file: resources is not a list: nothing/);
  });
  it("empty data", () => refuses(source([]), /no tasks in data/));
  it("data that is missing", () => {
    const src = source();
    delete src.data;
    refuses(src, /The \.gantt file: data is not a list: nothing/);
  });
  it("a file-name stamp that is not a real date", () => refuses(source(), /file name: its date stamp 20260230 is not a calendar date/, "Fixture Plan 20260230.gantt"));
  it("a file-name stamp outside 1900 to 2199", () =>
    refuses(source(), /file name: its date stamp 22000105 is not a date from 1900-01-01 to 2199-12-31/, "Fixture Plan 22000105.gantt"));
  it("a numeric entity outside Unicode", () => refuses(source(mutate(3, { info: "<p>&#x110000;</p>" })), /Task 3 info.*&#x110000;/));
  it("a tag outside the allow-list in info", () => refuses(source(mutate(3, { info: "<p><img src=x></p>" })), /Task 3 info.*<img src=x>/));
  it("a task that is not an object", () => refuses(source([5 as unknown as Task]), /data\[0\]: is not an object: 5/));
  it("a subtask that is not an object", () => refuses(source([group(1, "G", ["x" as unknown as Task])]), /the subtasks\[0\] of Task 1: is not an object: "x"/));
  it("a missing advanced", () => {
    const src = source();
    delete src.advanced;
    refuses(src, /advanced: is not an object: nothing/);
  });
  it("an advanced that is not an object", () => refuses(source(tasks(), {}, { advanced: [] }), /advanced: is not an object: \[\]/));
  it("a missing holidays", () => refuses(source(tasks(), { holidays: undefined }), /advanced: holidays is not a list: nothing/));
  it("a missing workWeek", () => refuses(source(tasks(), { workWeek: undefined }), /advanced\.workWeek: is not a non-empty list of day names: nothing/));
  it("a timezoneOffset that is not the time zone's standard offset", () =>
    refuses(source(tasks(), { timezoneOffset: -120 }), /advanced\.timezoneOffset is -120, but Europe\/Zurich's standard-time offset is -60/));
  it("a timezoneOffset that is not a number", () =>
    refuses(source(tasks(), { timezoneOffset: "-60" }), /advanced\.timezoneOffset is "-60", but Europe\/Zurich's standard-time offset is -60/));
  it("a dependencyConflict that is not text", () => refuses(source(tasks(), { dependencyConflict: 3 }), /advanced: dependencyConflict is not text: 3/));
});

describe("advanced.timezoneOffset", () => {
  it("is accepted when it is the time zone's standard offset", () => {
    expect(convert(source(tasks(), { timezone: "America/New_York", timezoneOffset: 300 })).counts.tasks).toBe(5);
  });

  it("may be absent", () => {
    expect(convert(source(tasks(), { timezoneOffset: undefined })).counts.tasks).toBe(5);
  });
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

  it("refuses a milestone stored done whose predecessors are not all done", () => {
    expect(() => convert(source(mutate(4, { Progress: 100 })))).toThrow(
      "WebBoard would show a different status than the .gantt file:\n- Task 4 Review: the .gantt file gives done, WebBoard derives todo",
    );
  });

  it("refuses a milestone stored todo whose predecessors are all done", () => {
    expect(() => convert(source(mutate(4, { Predecessor: "2FF" })))).toThrow(
      "WebBoard would show a different status than the .gantt file:\n- Task 4 Review: the .gantt file gives todo, WebBoard derives done",
    );
  });

  it("refuses a start on a day off", () => {
    expect(() => convert(source(mutate(9, { StartDate: "2026-09-19T06:00:00.000Z", EndDate: "2026-09-19T15:00:00.000Z" })))).toThrow(
      /Task 9 Back: source 2026-09-19 → 2026-09-19, WebBoard 2026-09-21 → 2026-09-21/,
    );
  });
});

describe("the .webboard round trip", () => {
  it("reads back through buildImport as the same plan", () => {
    const g = convert();
    const r = buildImport(g.bytes, "Fixture Plan 20260901.webboard", "dev-B", "ses-B", 9);
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
    expect(readBack(g.bytes, "Fixture Plan 20260901.webboard", g)).toEqual(g.counts);
  });
});

describe("readBack", () => {
  const OUT = "Fixture Plan 20260901.webboard";
  const withItem = (g: GanttPlan, name: string, patch: (i: Item) => Item): GanttPlan => ({
    ...g,
    plan: { ...g.plan, items: new Map([...g.plan.items].map(([id, i]): [ItemId, Item] => [id, i.name === name ? patch(i) : i])) },
  });

  it("refuses bytes whose plan name differs", () => {
    const g = convert();
    expect(() => readBack(g.bytes, OUT, { ...g, plan: { ...g.plan, name: "Other" } })).toThrow(/plan name reads back as "Fixture Plan", not "Other"/);
  });

  it("refuses bytes whose item kind, name, parent, order or schedule differs", () => {
    const g = convert();
    const other = byName(g.plan, "Phase B").id;
    expect(() => readBack(g.bytes, OUT, withItem(g, "Build", (i) => ({ ...i, schedule: i.schedule && { ...i.schedule, dur: 6 } })))).toThrow(
      /Task 3 Build: schedule reads back as/,
    );
    expect(() => readBack(g.bytes, OUT, withItem(g, "Build", (i) => ({ ...i, kind: "milestone" })))).toThrow(/Task 3 Build: kind reads back as "task", not "milestone"/);
    expect(() => readBack(g.bytes, OUT, withItem(g, "Build", (i) => ({ ...i, name: "Built" })))).toThrow(/Task 3 Build: name reads back as "Build", not "Built"/);
    expect(() => readBack(g.bytes, OUT, withItem(g, "Build", (i) => ({ ...i, place: { ...i.place, parent: other } })))).toThrow(/Task 3 Build: parent reads back as/);
    expect(() => readBack(g.bytes, OUT, withItem(g, "Build", (i) => ({ ...i, place: { ...i.place, order: "zz" } })))).toThrow(/Task 3 Build: order reads back as/);
  });

  it("refuses bytes whose link type or lag differs", () => {
    const g = convert();
    const links = new Map([...g.plan.links].map(([k, l]) => [k, l.lag === 2 ? { ...l, lag: 3 } : l.type === "SF" ? { ...l, type: "FS" as const } : l]));
    expect(() => readBack(g.bytes, OUT, { ...g, plan: { ...g.plan, links } })).toThrow(
      /link Task 3 Build → Task 7 Parallel reads back as SS\+2, not SS\+3[\s\S]*link Task 8 Late → Task 9 Back reads back as SF, not FS/,
    );
  });

  it("refuses bytes whose calendar differs", () => {
    const g = convert();
    expect(() => readBack(g.bytes, OUT, { ...g, plan: { ...g.plan, calendar: { ...g.plan.calendar, workdays: [1, 2, 3, 4] } } })).toThrow(/calendar reads back as/);
  });

  it("refuses bytes whose baseline differs", () => {
    const g = convert();
    const baselines = new Map([...g.plan.baselines].map(([k, b]) => [k, { ...b, at: "2026-09-02" }]));
    expect(() => readBack(g.bytes, OUT, { ...g, plan: { ...g.plan, baselines } })).toThrow(/baseline Imported plan reads back as/);
  });

  it("refuses bytes whose note text differs", () => {
    const g = convert();
    const notes = new Map([...g.notes].map(([k, t]): [ItemId, string] => [k, `${t}!`]));
    expect(() => readBack(g.bytes, OUT, { ...g, notes })).toThrow(/Task 7 Parallel: note reads back as "plain text note", not "plain text note!"/);
  });

  it("runs the fidelity check on the imported plan", () => {
    const g = convert();
    const sources = g.check.sources.map((s) => (s.id === 3 && s.leaf !== null ? { ...s, leaf: { ...s.leaf, end: "2026-09-17" } } : s));
    expect(() => readBack(g.bytes, OUT, { ...g, check: { ...g.check, sources } })).toThrow(
      "WebBoard would show different dates than the .gantt file:\n- Task 3 Build: source 2026-09-14 → 2026-09-17, WebBoard 2026-09-14 → 2026-09-18",
    );
  });
});
