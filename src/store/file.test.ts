import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Refused } from "../actions/intents";
import type { Closure } from "../domain/calendar";
import { derive } from "../domain/derive";
import { stepModeOf } from "../domain/steps";
import { linkKey, type Baseline, type Item, type ItemId, type Link, type PersonId, type PlanState, type StepId } from "../domain/model";
import { LogState } from "../log/state";
import type { Action, Write } from "../log/types";
import { choices } from "../plan/choices";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { fixedClock } from "../services/clock";
import { AppError } from "../services/ipc";
import type { GanttReport } from "../import/gantt";
import { act } from "../test/act";
import { memoryStore } from "../test/fixtures/store";
import { GANTT_FILE, ganttBytes, ganttSource, textBytes } from "../test/fixtures/gantt";
import { framed } from "../test/fixtures/framed";
import { VALID_WEBBOARD } from "../test/fixtures/webboard";
import { hold, offeredSettings, resetTauri, tauri, type Answer, type Call } from "../test/tauriMock";
import { decodeAction, encodeAction, PlanDoc } from "./doc";
import { backupFileNames, buildImport, decodeWbx, encodeWbx, exportBackup, exportIcs, exportListCsv, exportPlan, importPlan, unframe, type ImportResult } from "./file";
import { Registry } from "./registry";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const TODAY = "2026-11-09";
const SOURCE_ID = "P0000000000";

const own = (u: string, v: unknown): Write => ({ u, v, c: "own" });

const task = (id: string, name: string, parent: string | null, order: string): Write[] => [
  own(`e:${id}`, { k: "task", t: false }),
  own(`n:${id}`, name),
  own(`s:${id}`, ["2026-11-09", 3, "todo", 0, "now"]),
  own(`p:${id}`, [parent, order]),
];

const planHead = (name: string): Write[] => [own("pn", name), own("cw", [1, 2, 3, 4, 5]), own("cr", null)];

function fileOf(actions: readonly Action[], notes: Readonly<Record<string, string>> = {}, header: { name?: string } = {}): Uint8Array {
  const doc = new Y.Doc();
  const pd = new PlanDoc(doc);
  actions.forEach((a) => {
    const fresh = a.w.flatMap((w) => (w.u.startsWith("e:") && w.u.slice(2) in notes ? [w.u.slice(2)] : []));
    pd.append(a, fresh);
    fresh.forEach((item) => pd.note(item).insert(0, notes[item]));
  });
  const update = Y.encodeStateAsUpdate(doc);
  return encodeWbx({ planId: SOURCE_ID, name: header.name ?? "Bridge", exportedAt: "2026-11-08T14:05:00Z", updateLength: update.length }, update);
}

const logOf = (actions: Iterable<Action>): LogState => {
  const log = new LogState(planRules);
  log.add(actions);
  return log;
};

const FRESH_SOURCE: readonly Action[] = [
  act(
    "a0",
    [],
    [
      ...planHead("Bridge"),
      own("cc:C1", ["2026-12-24", "2026-12-26", "Holidays"]),
      own("e:G", { k: "group", t: false }),
      own("n:G", "Phase"),
      own("p:G", [null, "a0"]),
      ...task("T1", "Survey", "G", "a0"),
      own("r:T1", { "ticket:x/y#1": "" }),
      ...task("T2", "Build", "G", "a1"),
      own("l:T1>T2", ["FS", 2]),
      own("b:B1", { name: "Kickoff", at: "2026-11-09", dates: { T1: { start: "2026-11-09", dur: 3 }, T2: { start: "2026-11-16", dur: 3 } } }),
    ],
    { dev: "dev-A" },
  ),
];

const FRESH_NOTES = { T1: "check permits" };

const freshFile = (): Uint8Array => fileOf(FRESH_SOURCE, FRESH_NOTES);

const importOf = (bytes: Uint8Array, fileName = "Bridge.webboard"): ImportResult => buildImport(bytes, fileName, "dev-A", "ses-A", 1000);

const importedPlan = (r: ImportResult): PlanState => projectPlan(r.planId, logOf([r.action]));

function renamed(plan: PlanState, back: (id: string) => string, id: string): PlanState {
  return {
    id,
    name: plan.name,
    items: new Map(
      [...plan.items.values()].map((i): [string, Item] => [
        back(i.id),
        { ...i, id: back(i.id), place: { parent: i.place.parent === null ? null : back(i.place.parent), order: i.place.order } },
      ]),
    ),
    links: new Map([...plan.links.values()].map((l): [string, Link] => [linkKey(back(l.from), back(l.to)), { ...l, from: back(l.from), to: back(l.to) }])),
    calendar: {
      ...plan.calendar,
      closures: new Map([...plan.calendar.closures.values()].map((c): [string, Closure] => [back(c.id), { ...c, id: back(c.id) }])),
    },
    baselines: new Map(
      [...plan.baselines.values()].map((b): [string, Baseline] => [
        back(b.id),
        { ...b, id: back(b.id), dates: Object.fromEntries(Object.entries(b.dates).map(([k, d]) => [back(k), d])) },
      ]),
    ),
    workflow: {
      steps: plan.workflow.steps,
      items: new Map([...plan.workflow.items].map(([item, step]): [ItemId, StepId | null] => [back(item), step])),
    },
    people: {
      persons: plan.people.persons,
      assignees: new Map([...plan.people.assignees].map(([item, ids]): [ItemId, readonly PersonId[] | null] => [back(item), ids])),
    },
    defaults: plan.defaults === null ? null : { ...plan.defaults, group: plan.defaults.group === null ? null : back(plan.defaults.group) },
  };
}

const inverse = (m: ReadonlyMap<string, string>) => {
  const inv = new Map([...m].map(([a, b]) => [b, a]));
  return (id: string): string => {
    const old = inv.get(id);
    if (old === undefined) throw new Error(`No source id for ${id}`);
    return old;
  };
};

const idsOf = (plan: PlanState): Set<string> =>
  new Set([...plan.items.keys(), ...plan.links.keys(), ...plan.calendar.closures.keys(), ...plan.baselines.keys(), plan.id]);

const unreviewed = (report: GanttReport): Promise<void> => Promise.reject(new Error(`no report expected, got one for ${report.fileName}`));

const xname = (c: Call): string | null => new Headers(c.options?.headers).get("x-name");
const xformat = (c: Call): string | null => new Headers(c.options?.headers).get("x-format");
const xdoc = (c: Call): string | null => new Headers(c.options?.headers).get("x-doc");
const callsOf = (from: number, cmd: string): Call[] => tauri.calls.slice(from).filter((c) => c.cmd === cmd);
const appendsAfter = (from: number): Call[] => callsOf(from, "store_append");

function bodyWrites(c: Call): Write[] {
  if (!(c.args instanceof Uint8Array)) throw new Error(`${c.cmd} carried no bytes`);
  return Y.decodeUpdate(c.args)
    .structs.filter((s): s is Y.Item => s instanceof Y.Item && s.parentSub !== null)
    .flatMap((s) => [...decodeAction(s.parentSub as string, s.content.getContent()[0]).w]);
}

function namesWritten(c: Call): Record<string, string> {
  const s: unknown = c.args !== undefined && !(c.args instanceof Uint8Array) && !(c.args instanceof ArrayBuffer) && !Array.isArray(c.args) ? c.args.settings : undefined;
  if (typeof s !== "object" || s === null || !("names" in s) || typeof s.names !== "object" || s.names === null) throw new Error("settings_write without names");
  return s.names as Record<string, string>;
}

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

const fileState: { picked: { name: string; bytes: Uint8Array } | null | undefined; saved: unknown } = { picked: undefined, saved: undefined };

const pickFile = (name: string, bytes: Uint8Array): void => {
  fileState.picked = { name, bytes };
};

const outsideRust = (from: number): string[] =>
  tauri.calls.slice(from).flatMap((c) => (c.cmd.startsWith("file_") || c.cmd.startsWith("plugin:dialog") ? [c.cmd] : []));

function env(answers: Record<string, Answer> = {}): void {
  const mem = memoryStore();
  let settings: unknown = offeredSettings();
  resetTauri({
    ...mem.answers,
    settings_read: () => settings,
    settings_write: (args) => {
      settings = args !== undefined && !(args instanceof Uint8Array) && !(args instanceof ArrayBuffer) && !Array.isArray(args) ? args.settings : null;
      return null;
    },
    device_info: () => ({ deviceId: "dev-A", platform: "macos" }),
    holidays_year: () => {
      throw { code: "holidays.offline", message: "No connection to the holiday source." };
    },
    plan_import: () => {
      if (fileState.picked === undefined) throw new Error("this test set no plan_import answer");
      return fileState.picked === null ? new ArrayBuffer(0) : framed(fileState.picked.name, fileState.picked.bytes);
    },
    plan_export: () => {
      if (fileState.saved === undefined) throw new Error("this test set no plan_export answer");
      return fileState.saved;
    },
    ...answers,
  });
}

const opened: Registry[] = [];

async function registry(): Promise<Registry> {
  const r = await Registry.open({ clock: fixedClock(TODAY) });
  opened.push(r);
  return r;
}

beforeEach(() => {
  fileState.picked = undefined;
  fileState.saved = undefined;
  env();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((r) => r.close()));
});

describe("export", () => {
  it("sends the snapshot and the plan's name to plan_export and answers the written file name", async () => {
    const reg = await registry();
    const id = await reg.createPlan("Bridge");
    const session = await reg.session(id);
    session.apply({ t: "create", kind: "task", name: "Survey", parent: null, after: null, start: TODAY });
    fileState.saved = "Bridge.webboard";
    const from = tauri.calls.length;
    expect(await exportPlan(session)).toEqual({ name: "Bridge.webboard", unreadable: 0 });
    const exports = callsOf(from, "plan_export");
    expect(exports).toHaveLength(1);
    expect(xname(exports[0])).toBe(encodeURIComponent("Bridge"));
    expect(xformat(exports[0])).toBe("webboard");
    expect(outsideRust(from)).toEqual([]);
    const body = exports[0].args;
    if (!(body instanceof Uint8Array)) throw new Error("plan_export carried no bytes");
    expect([...body.subarray(0, 4)]).toEqual([0x57, 0x42, 0x58, 0x31]);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(4, true)).toBe(1);
    const { header, update } = decodeWbx(body);
    expect(header.updateLength).toBe(update.length);
    expect(header.planId).toBe(id);
    expect(header.name).toBe("Bridge");
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, update);
    expect(projectPlan(id, logOf(new PlanDoc(fresh).actions()))).toEqual(session.view().plan);
  });

  it("names the plan as it is when Export is chosen", async () => {
    const reg = await registry();
    const id = await reg.createPlan("Bridge");
    const session = await reg.session(id);
    const held = hold("plan_export");
    const from = tauri.calls.length;
    const saved = exportPlan(session);
    await flush();
    session.apply({ t: "planName", name: "Viaduct" });
    held.resolve("Bridge.webboard");
    expect(await saved).toEqual({ name: "Bridge.webboard", unreadable: 0 });
    const exports = callsOf(from, "plan_export");
    expect(exports).toHaveLength(1);
    expect(xname(exports[0])).toBe("Bridge");
    expect(outsideRust(from)).toEqual([]);
    const body = exports[0].args;
    if (!(body instanceof Uint8Array)) throw new Error("plan_export carried no bytes");
    const { header, update } = decodeWbx(body);
    expect(header.name).toBe("Bridge");
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, update);
    expect(projectPlan(id, logOf(new PlanDoc(fresh).actions())).name).toBe("Bridge");
  });

  it("leaves separators in the name to Rust", async () => {
    const reg = await registry();
    const session = await reg.session(await reg.createPlan("Q3/Bridge ü"));
    fileState.saved = "Q3-Bridge ü.webboard";
    const from = tauri.calls.length;
    expect(await exportPlan(session)).toEqual({ name: "Q3-Bridge ü.webboard", unreadable: 0 });
    expect(xname(callsOf(from, "plan_export")[0])).toBe(encodeURIComponent("Q3/Bridge ü"));
    expect(outsideRust(from)).toEqual([]);
  });

  it.each([
    [{}, "object"],
    [3, "number"],
    ["", "an empty string"],
  ])("refuses a plan_export answer of %j as ipc.shape", async (answer, shape) => {
    const reg = await registry();
    const session = await reg.session(await reg.createPlan("Bridge"));
    fileState.saved = answer;
    const failed = exportPlan(session);
    await expect(failed).rejects.toBeInstanceOf(AppError);
    await expect(failed).rejects.toMatchObject({ code: "ipc.shape", message: `plan_export answered ${shape} instead of a file name or null` });
  });

  it("refuses a plan name holding a lone surrogate before asking Rust", async () => {
    const reg = await registry();
    const session = await reg.session(await reg.createPlan("Bridge"));
    session.apply({ t: "planName", name: "A\uD800" });
    expect(session.view().plan.name).toBe("A\uD800");
    fileState.saved = "A.webboard";
    const from = tauri.calls.length;
    const failed = exportPlan(session);
    await expect(failed).rejects.toBeInstanceOf(AppError);
    await expect(failed).rejects.toMatchObject({
      code: "file.io",
      message: "The plan name holds a character that cannot be written to a file name; rename the plan and export again.",
    });
    expect(callsOf(from, "plan_export")).toHaveLength(0);
  });

  it("answers null when the save dialog is cancelled", async () => {
    const reg = await registry();
    const session = await reg.session(await reg.createPlan("Bridge"));
    fileState.saved = null;
    const from = tauri.calls.length;
    expect(await exportPlan(session)).toBeNull();
    expect(callsOf(from, "plan_export")).toHaveLength(1);
    expect(outsideRust(from)).toEqual([]);
  });

  it("rejects with Rust's error when the file cannot be written", async () => {
    const reg = await registry();
    const session = await reg.session(await reg.createPlan("Bridge"));
    tauri.answers.plan_export = () => {
      throw { code: "file.io", message: "Could not write /Users/a/Bridge.webboard: No space left on device." };
    };
    const from = tauri.calls.length;
    const failed = exportPlan(session);
    await expect(failed).rejects.toBeInstanceOf(AppError);
    expect(outsideRust(from)).toEqual([]);
    await expect(failed).rejects.toMatchObject({ code: "file.io", message: "Could not write /Users/a/Bridge.webboard: No space left on device." });
  });
});

describe("export the List as CSV", () => {
  const CSV = "\uFEFFName,Start\r\nDome set,2026-11-06\r\n";

  it("sends the text as UTF-8 bytes under the plan's name and List, as csv, and answers the written file name", async () => {
    fileState.saved = "MESA 1.0 List.csv";
    const from = tauri.calls.length;
    expect(await exportListCsv("MESA 1.0", CSV)).toBe("MESA 1.0 List.csv");
    const exports = callsOf(from, "plan_export");
    expect(exports).toHaveLength(1);
    expect([xname(exports[0]), xformat(exports[0])]).toEqual([encodeURIComponent("MESA 1.0 List"), "csv"]);
    const args = exports[0].args;
    if (!ArrayBuffer.isView(args)) throw new Error("plan_export carried no bytes");
    const body = new Uint8Array(args.buffer, args.byteOffset, args.byteLength);
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(body)).toBe(CSV);
    expect(outsideRust(from)).toEqual([]);
  });

  it("leaves separators in the name to Rust", async () => {
    fileState.saved = "Q3-Bridge ü List.csv";
    const from = tauri.calls.length;
    expect(await exportListCsv("Q3/Bridge ü", CSV)).toBe("Q3-Bridge ü List.csv");
    expect(xname(callsOf(from, "plan_export")[0])).toBe(encodeURIComponent("Q3/Bridge ü List"));
  });

  it("answers null when the save dialog is cancelled", async () => {
    fileState.saved = null;
    expect(await exportListCsv("MESA 1.0", CSV)).toBeNull();
  });

  it("refuses a plan name holding a lone surrogate before asking Rust", async () => {
    fileState.saved = "A List.csv";
    const from = tauri.calls.length;
    const failed = exportListCsv("A\uD800", CSV);
    await expect(failed).rejects.toMatchObject({
      code: "file.io",
      message: "The plan name holds a character that cannot be written to a file name; rename the plan and export again.",
    });
    expect(callsOf(from, "plan_export")).toHaveLength(0);
  });

  it("rejects with Rust's error when the file cannot be written", async () => {
    tauri.answers.plan_export = () => {
      throw { code: "file.io", message: "Could not write /Users/a/MESA 1.0 List.csv: No space left on device." };
    };
    await expect(exportListCsv("MESA 1.0", CSV)).rejects.toMatchObject({ code: "file.io", message: "Could not write /Users/a/MESA 1.0 List.csv: No space left on device." });
  });
});

const bodyOf = (c: Call): Uint8Array => {
  const args = c.args;
  if (!ArrayBuffer.isView(args)) throw new Error("plan_export carried no bytes");
  return new Uint8Array(args.buffer, args.byteOffset, args.byteLength);
};

describe("export milestones as ICS", () => {
  const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

  it("sends the text as UTF-8 under the plan's name and Milestones, as ics, and answers the written file name", async () => {
    fileState.saved = "MESA 1.0 Milestones.ics";
    const from = tauri.calls.length;
    expect(await exportIcs("MESA 1.0", ICS)).toBe("MESA 1.0 Milestones.ics");
    const exports = callsOf(from, "plan_export");
    expect(exports).toHaveLength(1);
    expect([xname(exports[0]), xformat(exports[0])]).toEqual([encodeURIComponent("MESA 1.0 Milestones"), "ics"]);
    expect(new TextDecoder().decode(bodyOf(exports[0]))).toBe(ICS);
    expect(outsideRust(from)).toEqual([]);
  });

  it("answers null when the save dialog is cancelled", async () => {
    fileState.saved = null;
    expect(await exportIcs("MESA 1.0", ICS)).toBeNull();
  });

  it("refuses a plan name holding a lone surrogate before asking Rust", async () => {
    const from = tauri.calls.length;
    await expect(exportIcs("A\uD800", ICS)).rejects.toMatchObject({
      code: "file.io",
      message: "The plan name holds a character that cannot be written to a file name; rename the plan and export again.",
    });
    expect(callsOf(from, "plan_export")).toHaveLength(0);
  });
});

describe("back up all plans", () => {
  const WHEN = new Date(2026, 10, 23, 9, 30, 0);

  it("names each plan's file after the plan, turning separators into dashes and trimming trailing dots", () => {
    expect(backupFileNames(["MESA 1.0", "Q3/Q4 \\ Bridge", "Plan v2...", "Kuppel ü"])).toEqual([
      "MESA 1.0.webboard",
      "Q3-Q4 - Bridge.webboard",
      "Plan v2.webboard",
      "Kuppel ü.webboard",
    ]);
  });

  it("numbers a repeated name, case-insensitively, from (2)", () => {
    expect(backupFileNames(["Survey", "survey", "SURVEY.", "Survey (2)", "Other"])).toEqual([
      "Survey.webboard",
      "survey (2).webboard",
      "SURVEY (3).webboard",
      "Survey (2) (2).webboard",
      "Other.webboard",
    ]);
  });

  it("refuses a name with nothing left before the extension, or a lone surrogate", () => {
    expect(() => backupFileNames(["Fine", "..."])).toThrow(new AppError("file.io", "The plan “...” has no name to back up under; rename it and back up again."));
    expect(() => backupFileNames(["A\uD800"])).toThrow(
      new AppError("file.io", "The plan name “A\uD800” holds a character that cannot be written to a file name; rename the plan and back up again."),
    );
  });

  it("sends one zip of every plan's .webboard under WebBoard backup and today's date, as zip", async () => {
    const reg = await registry();
    const one = await reg.session(await reg.createPlan("MESA 1.0"));
    const two = await reg.session(await reg.createPlan("Survey"));
    fileState.saved = "WebBoard backup 2026-11-23.zip";
    const from = tauri.calls.length;
    expect(await exportBackup([one, two], "2026-11-23", WHEN)).toEqual({ name: "WebBoard backup 2026-11-23.zip", plans: 2, unreadable: 0 });
    const exports = callsOf(from, "plan_export");
    expect(exports).toHaveLength(1);
    expect([xname(exports[0]), xformat(exports[0])]).toEqual([encodeURIComponent("WebBoard backup 2026-11-23"), "zip"]);
    const zip = bodyOf(exports[0]);
    const end = new DataView(zip.buffer, zip.byteOffset + zip.length - 22, 22);
    expect([end.getUint32(0, true), end.getUint16(8, true)]).toEqual([0x06054b50, 2]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const nameLength = view.getUint16(26, true);
    const size = view.getUint32(18, true);
    expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLength))).toBe("MESA 1.0.webboard");
    const first = decodeWbx(zip.slice(30 + nameLength, 30 + nameLength + size));
    expect([first.header.planId, first.header.name]).toEqual([one.view().plan.id, "MESA 1.0"]);
    expect(outsideRust(from)).toEqual([]);
  });

  it("answers null when the save dialog is cancelled", async () => {
    const reg = await registry();
    const one = await reg.session(await reg.createPlan("MESA 1.0"));
    fileState.saved = null;
    expect(await exportBackup([one], "2026-11-23", WHEN)).toBeNull();
  });
});

describe("fresh ids", () => {
  it("imports the current state under new ids", () => {
    const source = projectPlan(SOURCE_ID, logOf(FRESH_SOURCE));
    const r = importOf(freshFile());
    const plan = importedPlan(r);
    expect(r.planId).not.toBe(SOURCE_ID);
    const before = idsOf(source);
    expect([...idsOf(plan)].filter((x) => before.has(x))).toEqual([]);
    expect(new Set(r.idMap.keys())).toEqual(new Set(["G", "T1", "T2", "C1", "B1"]));
    expect(renamed(plan, inverse(r.idMap), SOURCE_ID)).toEqual(source);
    const t1 = r.idMap.get("T1");
    const t2 = r.idMap.get("T2");
    if (t1 === undefined || t2 === undefined) throw new Error("T1 or T2 has no new id");
    expect(plan.items.get(t1)?.refs).toEqual({ "ticket:x/y#1": "" });
    expect(Object.keys(plan.baselines.get(r.idMap.get("B1") ?? "")?.dates ?? {}).sort()).toEqual([t1, t2].sort());
    expect(r.newNotes).toEqual([t1]);
    expect(r.notes).toEqual(new Map([[t1, "check permits"]]));
    expect(r.action.lbl).toBe("Imported from Bridge.webboard");
    expect(r.action.meta).toEqual({ imported: "Bridge.webboard" });
    expect(r.action.par).toEqual([]);
    expect(r.action.w.some((w) => w.u.startsWith("a:"))).toBe(false);
  });

  it("a .webboard with ws and wi round-trips them (item ids remapped, step ids kept), format version 1", () => {
    const stepped: readonly Action[] = [
      ...FRESH_SOURCE,
      act(
        "a1",
        ["a0"],
        [own("ws:review", { n: "Review", c: "violet", o: "a1V", l: 4 }), own("ws:later", null), own("wi:T1", "review"), own("wi:T2", null)],
        { dev: "dev-A" },
      ),
    ];
    const bytes = fileOf(stepped, FRESH_NOTES);
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)).toBe(1);
    const source = projectPlan(SOURCE_ID, logOf(stepped));
    const r = importOf(bytes);
    const plan = importedPlan(r);
    const t1 = r.idMap.get("T1");
    const t2 = r.idMap.get("T2");
    if (t1 === undefined || t2 === undefined) throw new Error("T1 or T2 has no new id");
    expect(new Set(r.idMap.keys())).toEqual(new Set(["G", "T1", "T2", "C1", "B1"]));
    expect(plan.workflow).toEqual({
      steps: new Map([
        ["later", null],
        ["review", { n: "Review", c: "violet", o: "a1V", l: 4 }],
      ]),
      items: new Map<ItemId, StepId | null>([
        [t1, "review"],
        [t2, null],
      ]),
    });
    expect(renamed(plan, inverse(r.idMap), SOURCE_ID)).toEqual(source);
    const stepWrites = r.action.w.filter((w) => w.u.startsWith("ws:") || w.u.startsWith("wi:"));
    expect(new Map(stepWrites.map((w) => [w.u, w]))).toEqual(
      new Map([
        ["ws:later", own("ws:later", null)],
        ["ws:review", own("ws:review", { n: "Review", c: "violet", o: "a1V", l: 4 })],
        [`wi:${t1}`, own(`wi:${t1}`, "review")],
        [`wi:${t2}`, own(`wi:${t2}`, null)],
      ]),
    );
    expect(stepWrites).toHaveLength(4);
  });

  it("a plan without units imports by dates", () => {
    const r = importOf(freshFile());
    const plan = importedPlan(r);
    expect(plan.workflow).toEqual({ steps: new Map(), items: new Map() });
    expect(r.action.w.some((w) => w.u.startsWith("ws:") || w.u.startsWith("wi:"))).toBe(false);
    expect(stepModeOf(plan)).toBe("dates");
  });

  it("a .webboard with pp and pa round-trips them (item ids remapped, person ids kept), format version 1", () => {
    const mira = { n: "Mira Okafor", i: "MO", c: "cyan", o: "a1" };
    const peopled: readonly Action[] = [
      ...FRESH_SOURCE,
      act("a1", ["a0"], [own("pp:mira", mira), own("pp:ole", null), own("pa:T1", ["mira", "ole"]), own("pa:T2", null)], { dev: "dev-A" }),
    ];
    const bytes = fileOf(peopled, FRESH_NOTES);
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)).toBe(1);
    const source = projectPlan(SOURCE_ID, logOf(peopled));
    const r = importOf(bytes);
    const plan = importedPlan(r);
    const t1 = r.idMap.get("T1");
    const t2 = r.idMap.get("T2");
    if (t1 === undefined || t2 === undefined) throw new Error("T1 or T2 has no new id");
    expect(new Set(r.idMap.keys())).toEqual(new Set(["G", "T1", "T2", "C1", "B1"]));
    expect(plan.people).toEqual({
      persons: new Map([
        ["mira", mira],
        ["ole", null],
      ]),
      assignees: new Map<ItemId, readonly PersonId[] | null>([
        [t1, ["mira", "ole"]],
        [t2, null],
      ]),
    });
    expect(renamed(plan, inverse(r.idMap), SOURCE_ID)).toEqual(source);
    const peopleWrites = r.action.w.filter((w) => w.u.startsWith("pp:") || w.u.startsWith("pa:"));
    expect(new Map(peopleWrites.map((w) => [w.u, w]))).toEqual(
      new Map([
        ["pp:mira", own("pp:mira", mira)],
        ["pp:ole", own("pp:ole", null)],
        [`pa:${t1}`, own(`pa:${t1}`, ["mira", "ole"])],
        [`pa:${t2}`, own(`pa:${t2}`, null)],
      ]),
    );
    expect(peopleWrites).toHaveLength(4);
  });

  it("a plan without people imports with none", () => {
    const r = importOf(freshFile());
    expect(importedPlan(r).people).toEqual({ persons: new Map(), assignees: new Map() });
    expect(r.action.w.some((w) => w.u.startsWith("pp:") || w.u.startsWith("pa:"))).toBe(false);
  });

  it("a .webboard with pd round-trips it (group remapped, person and step ids kept), format version 1", () => {
    const pd = { dur: 5, dated: false, who: "mira", group: "G", step: "review" };
    const defaulted: readonly Action[] = [...FRESH_SOURCE, act("a1", ["a0"], [own("pd", pd)], { dev: "dev-A" })];
    const bytes = fileOf(defaulted, FRESH_NOTES);
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)).toBe(1);
    const source = projectPlan(SOURCE_ID, logOf(defaulted));
    const r = importOf(bytes);
    const plan = importedPlan(r);
    const g = r.idMap.get("G");
    if (g === undefined) throw new Error("G has no new id");
    expect(g).not.toBe("G");
    expect(plan.defaults).toEqual({ ...pd, group: g });
    expect(renamed(plan, inverse(r.idMap), SOURCE_ID)).toEqual(source);
    expect(r.action.w.filter((w) => w.u === "pd")).toEqual([own("pd", { ...pd, group: g })]);
  });

  it("a .webboard whose pd names a group no longer in the plan imports with the plan root, not a dangling id", () => {
    const pd = { dur: 5, dated: false, who: "mira", group: "Z9", step: "review" };
    const defaulted: readonly Action[] = [...FRESH_SOURCE, act("a1", ["a0"], [own("pd", pd)], { dev: "dev-A" })];
    const r = importOf(fileOf(defaulted, FRESH_NOTES));
    expect(r.idMap.has("Z9")).toBe(false);
    expect(importedPlan(r).defaults).toEqual({ ...pd, group: null });
    expect(r.action.w.filter((w) => w.u === "pd")).toEqual([own("pd", { ...pd, group: null })]);
  });

  it("a plan without pd imports with null defaults", () => {
    const r = importOf(freshFile());
    expect(importedPlan(r).defaults).toBeNull();
    expect(r.action.w.some((w) => w.u === "pd")).toBe(false);
  });

  it("a second import shares no id with the first", () => {
    const a = importOf(freshFile());
    const b = importOf(freshFile());
    const first = new Set([...idsOf(importedPlan(a)), a.action.id]);
    expect([...idsOf(importedPlan(b)), b.action.id].filter((x) => first.has(x))).toEqual([]);
  });

  it("import is the root", async () => {
    const reg = await registry();
    const r = importOf(freshFile());
    const id = await reg.createPlanFrom(r);
    const session = await reg.session(id);
    await (await reg.doc(id)).flush();
    const history = session.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ label: "Imported from Bridge.webboard", root: true, active: true });
    const from = tauri.calls.length;
    const message = "The action that created this plan cannot be reverted.";
    expect(() => session.revert(history[0].id)).toThrow(new Refused(message));
    expect(() => session.previewRevert(history[0].id)).toThrow(new Refused(message));
    await flush();
    expect(appendsAfter(from).filter((c) => xdoc(c) === id)).toHaveLength(0);
  });

  it("keeps each item's own trash under a trashed group", async () => {
    const source: Action[] = [
      ...FRESH_SOURCE,
      act("a1", ["a0"], [own("e:T1", { k: "task", t: true })], { dev: "dev-A" }),
      act("a2", ["a1"], [own("e:G", { k: "group", t: true })], { dev: "dev-A" }),
    ];
    const r = importOf(fileOf(source));
    const g = r.idMap.get("G");
    const t1 = r.idMap.get("T1");
    const t2 = r.idMap.get("T2");
    if (g === undefined || t1 === undefined || t2 === undefined) throw new Error("G, T1 or T2 has no new id");
    const existenceOf = (id: string): unknown => r.action.w.find((w) => w.u === `e:${id}`)?.v;
    expect(existenceOf(g)).toEqual({ k: "group", t: true });
    expect(existenceOf(t1)).toEqual({ k: "task", t: true });
    expect(existenceOf(t2)).toEqual({ k: "task", t: false });
    const reg = await registry();
    const id = await reg.createPlanFrom(r);
    const session = await reg.session(id);
    expect([...session.view().plan.items.values()].every((i) => i.trashed)).toBe(true);
    session.apply({ t: "restore", items: [g] });
    const items = session.view().plan.items;
    expect(items.get(g)?.trashed).toBe(false);
    expect(items.get(t1)?.trashed).toBe(true);
    expect(items.get(t2)?.trashed).toBe(false);
  });

  it("an item whose creation was reverted imports trashed on its own", () => {
    const source: Action[] = [
      act("a0", [], [...planHead("Bridge"), ...task("T1", "Survey", null, "a0")], { dev: "dev-A" }),
      act("a1", ["a0"], task("T2", "Build", null, "a1"), { dev: "dev-A" }),
      act("a2", ["a1"], [own("n:T2", "Build again")], { dev: "dev-A" }),
      act("a3", ["a2"], [{ u: "a:a1", v: false, c: "revert" }], { dev: "dev-A" }),
    ];
    expect(projectPlan(SOURCE_ID, logOf(source)).items.get("T2")?.trashed).toBe(true);
    const r = importOf(fileOf(source));
    const t2 = r.idMap.get("T2");
    if (t2 === undefined) throw new Error("T2 has no new id");
    expect(r.action.w.find((w) => w.u === `e:${t2}`)?.v).toEqual({ k: "task", t: true });
    expect(importedPlan(r).items.get(t2)).toMatchObject({ name: "Build again", trashed: true });
  });

  it("stamps the import action with the registry clock", async () => {
    const clock = fixedClock(TODAY);
    const reg = await Registry.open({ clock });
    opened.push(reg);
    const id = await reg.createPlanFrom(importOf(freshFile()));
    const actions = new PlanDoc((await reg.doc(id)).ydoc).actions();
    expect([...actions].map((a) => a.at)).toEqual([clock.now()]);
  });

  it("createPlanFrom lists and caches", async () => {
    const reg = await registry();
    const from = tauri.calls.length;
    const r = importOf(freshFile());
    const id = await reg.createPlanFrom(r);
    await flush();
    const local = appendsAfter(from).filter((c) => xdoc(c) === "local");
    expect(local).toHaveLength(1);
    expect(bodyWrites(local[0])).toEqual([own("ip:" + id, { t: false })]);
    expect(reg.plans().find((p) => p.id === id)).toMatchObject({ id, trashed: false, name: "Bridge" });
    expect(callsOf(from, "settings_write").filter((c) => namesWritten(c)[id] === "Bridge")).toHaveLength(1);
    const note = r.idMap.get("T1");
    if (note === undefined) throw new Error("T1 has no new id");
    expect((await reg.session(id)).note(note).toString()).toBe("check permits");
  });
});

describe("interim values", () => {
  it("imports the interim value of an open choice and no choice", () => {
    const source: Action[] = [
      act("a0", [], [...planHead("Bridge"), ...task("A", "A", null, "a0")], { dev: "dev-A" }),
      act("b1", ["a0"], [own("n:A", "North")], { dev: "dev-A" }),
      act("b2", ["a0"], [own("n:A", "South")], { dev: "dev-B" }),
    ];
    const sourceLog = logOf(source);
    const sourcePlan = projectPlan(SOURCE_ID, sourceLog);
    expect(choices(sourceLog, sourcePlan, new Map())).toHaveLength(1);
    const r = importOf(fileOf(source));
    const log = logOf([r.action]);
    const plan = projectPlan(r.planId, log);
    const a = r.idMap.get("A");
    if (a === undefined) throw new Error("A has no new id");
    expect(plan.items.get(a)?.name).toBe(sourcePlan.items.get("A")?.name);
    expect(choices(log, plan, new Map())).toEqual([]);
  });
});

describe("loops import", () => {
  it("a loop merged from two devices imports with two loop conflicts", () => {
    const source: Action[] = [
      act("a0", [], [...planHead("Bridge"), ...task("A", "A", null, "a0"), ...task("B", "B", null, "a1")], { dev: "dev-A" }),
      act("b1", ["a0"], [own("l:A>B", ["FS", 0])], { dev: "dev-A" }),
      act("b2", ["a0"], [own("l:B>A", ["FS", 0])], { dev: "dev-B" }),
    ];
    const r = importOf(fileOf(source));
    const plan = importedPlan(r);
    const a = r.idMap.get("A");
    const b = r.idMap.get("B");
    if (a === undefined || b === undefined) throw new Error("A or B has no new id");
    const loops = derive(plan, new Set(), TODAY).conflicts.flatMap((c) => (c.kind === "loop" ? [c.link] : []));
    expect(loops.sort()).toEqual([linkKey(a, b), linkKey(b, a)].sort());
  });
});

const withHeader = (header: string, update: Uint8Array): Uint8Array => {
  const h = new TextEncoder().encode(header);
  const out = new Uint8Array(12 + h.length + update.length);
  out.set([0x57, 0x42, 0x58, 0x31], 0);
  new DataView(out.buffer).setUint32(4, 1, true);
  new DataView(out.buffer).setUint32(8, h.length, true);
  out.set(h, 12);
  out.set(update, 12 + h.length);
  return out;
};

const seededBytes = (length: number, seed: number): Uint8Array => {
  let s = seed;
  return Uint8Array.from({ length }, () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s >> 16;
  });
};

describe("malformed refused", () => {
  const valid = VALID_WEBBOARD.bytes;
  const headerLength = new DataView(valid.buffer, valid.byteOffset).getUint32(8, true);
  const { update } = decodeWbx(valid);
  const version2 = valid.slice();
  new DataView(version2.buffer).setUint32(4, 2, true);
  const zz = fileOf([act("a0", [], [...planHead("Bridge"), own("zz:1", 1)], { dev: "dev-A" })]);
  const zzDamaged = fileOf([act("a0", [], [...planHead("Bridge"), own("zz:1", 1), own("n:T1", 7)], { dev: "dev-A" })]);
  const unknownMeta = (version: number): Uint8Array => {
    const doc = new Y.Doc();
    doc.getMap("actions").set("a0", [...encodeAction(act("a0", [], planHead("Bridge"), { dev: "dev-A" })), { split: "T1" }]);
    const u = Y.encodeStateAsUpdate(doc);
    const bytes = encodeWbx({ planId: SOURCE_ID, name: "Bridge", exportedAt: "2026-11-08T14:05:00Z", updateLength: u.length }, u);
    new DataView(bytes.buffer).setUint32(4, version, true);
    return bytes;
  };
  const truncatedText = (n: number, m: number) => `This file is incomplete (${n} of ${m} bytes); export it again.`;
  const cases: [string, Uint8Array, string, string | RegExp][] = [
    ["PNG", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]), "import.foreign", "This file is not a WebBoard plan."],
    ["PK", Uint8Array.from([0x50, 0x4b]), "import.foreign", "This file is not a WebBoard plan."],
    ["WBX2", Uint8Array.from([0x57, 0x42, 0x58, 0x32, 1, 0, 0, 0]), "import.foreign", "This file is not a WebBoard plan."],
    ["empty", new Uint8Array(), "import.truncated", truncatedText(0, 12)],
    ["WBX", valid.slice(0, 3), "import.truncated", truncatedText(3, 12)],
    ["cut at 8", valid.slice(0, 8), "import.truncated", truncatedText(8, 12)],
    ["inside the header", valid.slice(0, 20), "import.truncated", truncatedText(20, 12 + headerLength)],
    ["10 bytes short", valid.slice(0, valid.length - 10), "import.truncated", truncatedText(valid.length - 10, valid.length)],
    ["version 2", version2, "import.newer", "This file comes from a newer WebBoard (format 2); update WebBoard to open it."],
    ["an action this WebBoard cannot read", unknownMeta(1), "import.corrupt", "This file is damaged: Action a0 has a malformed meta"],
    ["the same action in format 2", unknownMeta(2), "import.newer", "This file comes from a newer WebBoard (format 2); update WebBoard to open it."],
    ["broken header JSON", withHeader('{"planId":', update), "import.corrupt", /^This file is damaged: its header is not readable: /],
    ["random update", withHeader(JSON.stringify({ ...decodeWbx(valid).header }), seededBytes(update.length, 20261109)), "import.corrupt", /^This file is damaged: \S/],
    ["extra bytes", Uint8Array.from([...valid, 0, 0]), "import.corrupt", "This file is damaged: 2 bytes follow the plan"],
    ["zz:1", zz, "import.unknown_units", "This plan uses data this WebBoard does not know (zz:1); update WebBoard to open it."],
    [
      "zz:1 and damage",
      zzDamaged,
      "import.unknown_units",
      "This plan uses data this WebBoard does not know (zz:1); update WebBoard to open it. It is also damaged: n:T1: name is not a string: 7",
    ],
  ];

  it.each(cases)("%s", async (_name, bytes, code, message) => {
    const reg = await registry();
    const from = tauri.calls.length;
    const before = reg.plans();
    pickFile("Bad.webboard", bytes);
    const caught = await importPlan(reg, unreviewed).then(
      () => null,
      (e: unknown) => e,
    );
    if (!(caught instanceof AppError)) throw new Error(`importPlan did not reject with an AppError: ${String(caught)}`);
    expect(caught.code).toBe(code);
    if (typeof message === "string") expect(caught.message).toBe(message);
    else expect(caught.message).toMatch(message);
    await flush();
    expect(appendsAfter(from)).toHaveLength(0);
    expect(reg.plans()).toEqual(before);
  });
});

describe("import through plan_import", () => {
  it("reads the framed answer and creates one plan", async () => {
    expect([...VALID_WEBBOARD.bytes.subarray(0, 4)]).toEqual([0x57, 0x42, 0x58, 0x31]);
    const reg = await registry();
    const from = tauri.calls.length;
    const before = reg.plans().map((p) => p.id);
    pickFile("My Plan ü.webboard", VALID_WEBBOARD.bytes);
    const imported = await importPlan(reg, unreviewed);
    if (imported === null) throw new Error("importPlan resolved null");
    const id = imported.planId;
    expect(imported.converted).toBeNull();
    const reads = callsOf(from, "plan_import");
    expect(reads).toHaveLength(1);
    expect(reads[0].args).toBeUndefined();
    expect(reads[0].options).toBeUndefined();
    expect(outsideRust(from)).toEqual([]);
    expect(reg.plans().map((p) => p.id)).toEqual([...before, id]);
    const session = await reg.session(id);
    expect(session.view().plan.name).toBe(VALID_WEBBOARD.plan.name);
    expect([...session.view().plan.items.values()].filter((i) => !i.trashed)).toHaveLength(VALID_WEBBOARD.plan.items);
    expect(session.history()[0].label).toBe("Imported from My Plan ü.webboard");
  });

  it("imports nothing when the open dialog is cancelled", async () => {
    const reg = await registry();
    const from = tauri.calls.length;
    const before = reg.plans();
    fileState.picked = null;
    expect(await importPlan(reg, unreviewed)).toBeNull();
    expect(callsOf(from, "plan_import")).toHaveLength(1);
    expect(appendsAfter(from)).toHaveLength(0);
    expect(reg.plans()).toEqual(before);
  });

  it("refuses an answer too short to hold a file name and creates nothing", async () => {
    const reg = await registry();
    const from = tauri.calls.length;
    const before = reg.plans();
    tauri.answers.plan_import = () => new Uint8Array([3, 0]).buffer;
    await expect(importPlan(reg, unreviewed)).rejects.toMatchObject({
      code: "ipc.shape",
      message: "plan_import answered 2 bytes, which do not hold a file name and its file",
    });
    await flush();
    expect(appendsAfter(from)).toHaveLength(0);
    expect(reg.plans()).toEqual(before);
  });
});

describe("unframe", () => {
  const caught = (b: Uint8Array): unknown => {
    try {
      unframe(b);
    } catch (e) {
      return e;
    }
    throw new Error("unframe did not throw");
  };

  it("splits the name from the file", () => {
    const { name, bytes } = unframe(new Uint8Array(framed("Bridge ü.webboard", Uint8Array.from([1, 2, 3]))));
    expect(name).toBe("Bridge ü.webboard");
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it.each([1, 2, 3])("refuses a frame of %i bytes", (n) => {
    const e = caught(new Uint8Array(n));
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.shape", message: `plan_import answered ${n} bytes, which do not hold a file name and its file` });
  });

  it("refuses a name length past the end", () => {
    const b = new Uint8Array(framed("Bridge.webboard", Uint8Array.from([1, 2])));
    new DataView(b.buffer).setUint32(0, b.length, true);
    expect(caught(b)).toMatchObject({ code: "ipc.shape", message: `plan_import answered ${b.length} bytes, which do not hold a file name and its file` });
  });

  it("reads a frame whose name fills it as an empty file", () => {
    const { name, bytes } = unframe(new Uint8Array(framed("a.webboard", new Uint8Array(0))));
    expect(name).toBe("a.webboard");
    expect([...bytes]).toEqual([]);
  });

  it("refuses a name length one byte past the end", () => {
    const b = new Uint8Array(framed("a.webboard", new Uint8Array(0)));
    new DataView(b.buffer).setUint32(0, b.length - 3, true);
    expect(caught(b)).toMatchObject({ code: "ipc.shape", message: `plan_import answered ${b.length} bytes, which do not hold a file name and its file` });
  });

  it("refuses an empty file name", () => {
    const b = new Uint8Array(framed("", Uint8Array.from([1])));
    expect(caught(b)).toMatchObject({ code: "ipc.shape", message: "plan_import sent an empty file name" });
  });

  it("refuses a name that is not UTF-8", () => {
    const b = Uint8Array.from([2, 0, 0, 0, 0xc3, 0x28, 9]);
    expect(caught(b)).toMatchObject({ code: "ipc.shape", message: "plan_import sent a file name that is not UTF-8" });
  });
});

describe("import of a .gantt file", () => {
  const pick = async (name: string, bytes: Uint8Array): Promise<{ reg: Registry; from: number; before: readonly string[] }> => {
    const reg = await registry();
    const from = tauri.calls.length;
    const before = reg.plans().map((p) => p.id);
    pickFile(name, bytes);
    return { reg, from, before };
  };

  const reviewed = (reg: Registry, before: readonly string[]): { review: (report: GanttReport) => Promise<void>; seen: GanttReport[] } => {
    const seen: GanttReport[] = [];
    return {
      seen,
      review: async (report) => {
        expect(reg.plans().map((p) => p.id)).toEqual(before);
        seen.push(report);
      },
    };
  };

  it("converts the file, shows the report before any plan exists, then creates one plan", async () => {
    const { reg, from, before } = await pick(GANTT_FILE, ganttBytes());
    const { review, seen } = reviewed(reg, before);
    const imported = await importPlan(reg, review);
    expect(seen).toEqual([imported?.converted]);
    expect(appendsAfter(from).length).toBeGreaterThan(0);
    if (imported === null) throw new Error("importPlan resolved null");
    expect(reg.plans().map((p) => p.id)).toEqual([...before, imported.planId]);
    expect(imported.converted).toEqual({
      fileName: GANTT_FILE,
      name: "Fixture Plan",
      counts: { groups: 1, tasks: 2, milestones: 1, links: 2, notes: 1, people: 0, assignments: 0 },
      dropped: expect.arrayContaining(["TaskID on 4 items", "color on 4 items", "advanced.workTime"]),
    });
    const session = await reg.session(imported.planId);
    const plan = session.view().plan;
    expect(plan.name).toBe("Fixture Plan");
    expect([...plan.items.values()].filter((i) => !i.trashed).map((i) => `${i.kind} ${i.name}`).sort()).toEqual([
      "group Phase",
      "milestone Handover",
      "task Build",
      "task Survey",
    ]);
    expect(plan.links.size).toBe(2);
    expect([...plan.baselines.values()].map((b) => b.name)).toEqual(["Imported plan"]);
    expect(session.history()[0].label).toBe(`Imported from ${GANTT_FILE}`);
  });

  it("creates nothing while the report is open", async () => {
    const { reg, from, before } = await pick(GANTT_FILE, ganttBytes());
    let close = (): void => {
      throw new Error("the report never opened");
    };
    const importing = importPlan(reg, () => new Promise<void>((r) => (close = r)));
    await flush();
    expect(appendsAfter(from)).toHaveLength(0);
    expect(reg.plans().map((p) => p.id)).toEqual(before);
    close();
    const imported = await importing;
    if (imported === null) throw new Error("importPlan resolved null");
    expect(reg.plans().map((p) => p.id)).toEqual([...before, imported.planId]);
  });

  it("recognises the extension whatever its case", async () => {
    const { reg, before } = await pick("Fixture Plan.GANTT", ganttBytes());
    const imported = await importPlan(reg, reviewed(reg, before).review);
    expect(imported?.converted?.name).toBe("Fixture Plan");
  });

  const withHolidays = (): Record<string, unknown> => {
    const src = ganttSource();
    const advanced = src.advanced;
    if (typeof advanced !== "object" || advanced === null) throw new Error("the fixture has no advanced settings");
    return { ...src, advanced: { ...advanced, holidays: ["2026-09-08"] } };
  };

  const refusals: [string, () => Uint8Array, RegExp][] = [
    ["bytes that are not UTF-8", () => Uint8Array.from([0x7b, 0xff, 0x7d]), /^The \.gantt file is not UTF-8 text: /],
    ["text that is not JSON", () => textBytes("not json"), /^The \.gantt file is not JSON: /],
    ["a holiday list", () => ganttBytes(withHolidays()), /holidays/],
  ];

  it.each(refusals)("refuses %s as an AppError with the converter's message and creates nothing", async (_name, bytes, message) => {
    const { reg, from, before } = await pick(GANTT_FILE, bytes());
    const caught = await importPlan(reg, unreviewed).then(
      () => null,
      (e: unknown) => e,
    );
    if (!(caught instanceof AppError)) throw new Error(`importPlan did not reject with an AppError: ${String(caught)}`);
    expect(caught.code).toBe("import.gantt");
    expect(caught.message).toMatch(message);
    await flush();
    expect(appendsAfter(from)).toHaveLength(0);
    expect(reg.plans().map((p) => p.id)).toEqual(before);
  });

  it("keeps a multi-line fidelity refusal whole", async () => {
    const text = JSON.stringify(ganttSource()).replace("2026-09-11T15:00:00.000Z", "2026-09-10T15:00:00.000Z");
    const { reg } = await pick(GANTT_FILE, textBytes(text));
    const caught = await importPlan(reg, unreviewed).then(
      () => null,
      (e: unknown) => e,
    );
    if (!(caught instanceof AppError)) throw new Error(`importPlan did not reject with an AppError: ${String(caught)}`);
    expect(caught.message).toMatch(/^WebBoard would show different dates than the \.gantt file:\n- Task 2 Survey: /);
  });

  it("reads a .webboard file as a plan file even when it holds .gantt text", async () => {
    const { reg } = await pick("Fixture.webboard", ganttBytes());
    await expect(importPlan(reg, unreviewed)).rejects.toMatchObject({ code: "import.foreign" });
  });
});
