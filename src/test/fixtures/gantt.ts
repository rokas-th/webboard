type Task = Record<string, unknown>;

export const GANTT_FILE = "Fixture Plan 20260901.gantt";

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

export function ganttSource(tasks?: readonly Task[]): Record<string, unknown> {
  return {
    data: tasks ?? [
      {
        TaskID: 1,
        TaskName: "Phase",
        StartDate: "2026-09-07T06:00:00.000Z",
        EndDate: "2026-09-18T15:00:00.000Z",
        Duration: 10,
        DurationUnit: "day",
        Progress: 0,
        Predecessor: null,
        resources: [],
        color: "#999999",
        info: "",
        subtasks: [
          leaf(2, "Survey", "2026-09-07", "2026-09-11", 5, { Progress: 100, info: "<p>Site &amp; access</p>" }),
          leaf(3, "Build", "2026-09-14", "2026-09-18", 5, { Progress: 40, Predecessor: "2FS" }),
          leaf(4, "Handover", "2026-09-18", "2026-09-18", 0, { Predecessor: "3FF" }),
        ],
      },
    ],
    resources: [],
    projectStartDate: null,
    projectEndDate: null,
    advanced: {
      timezone: "Europe/Zurich",
      timezoneOffset: -60,
      dependencyConflict: "Add Offset to Dependency",
      workWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      workTime: [
        { from: 8, to: 12 },
        { from: 13, to: 17 },
      ],
      holidays: [],
    },
  };
}

export function ganttWithPeople(): Record<string, unknown> {
  return {
    ...ganttSource([
      {
        TaskID: 1,
        TaskName: "Phase",
        StartDate: "2026-09-07T06:00:00.000Z",
        EndDate: "2026-09-18T15:00:00.000Z",
        Duration: 10,
        DurationUnit: "day",
        Progress: 0,
        Predecessor: null,
        resources: [],
        color: "#999999",
        info: "",
        subtasks: [
          leaf(2, "Survey", "2026-09-07", "2026-09-11", 5, { Progress: 100, info: "<p>Site &amp; access</p>", resources: [{ resourceId: "r1", resourceName: "Mira Okafor" }] }),
          leaf(3, "Build", "2026-09-14", "2026-09-18", 5, {
            Progress: 40,
            Predecessor: "2FS",
            resources: [
              { resourceId: "r2", resourceName: "Ole Berg" },
              { resourceId: "r1", resourceName: "Mira Okafor" },
            ],
          }),
          leaf(4, "Handover", "2026-09-18", "2026-09-18", 0, { Predecessor: "3FF" }),
        ],
      },
    ]),
    resources: [
      { resourceId: "r1", resourceName: "Mira Okafor" },
      { resourceId: "r2", resourceName: "Ole Berg" },
    ],
  };
}

export const textBytes = (text: string): Uint8Array => Uint8Array.from(new TextEncoder().encode(text));

export const ganttBytes = (source: unknown = ganttSource()): Uint8Array => textBytes(JSON.stringify(source));
