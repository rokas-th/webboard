import { open, save } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Refused } from "../actions/intents";
import type { Closure } from "../domain/calendar";
import { derive } from "../domain/derive";
import { linkKey, type Baseline, type Item, type Link, type PlanState } from "../domain/model";
import { LogState } from "../log/state";
import type { Action, Write } from "../log/types";
import { choices } from "../plan/choices";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { fixedClock } from "../services/clock";
import { AppError } from "../services/ipc";
import { act } from "../test/act";
import { memoryStore } from "../test/fixtures/store";
import { VALID_WEBBOARD } from "../test/fixtures/webboard";
import { resetTauri, tauri, type Answer, type Call } from "../test/tauriMock";
import { decodeAction, PlanDoc } from "./doc";
import { buildImport, decodeWbx, encodeWbx, exportPlan, importPlan, type ImportResult } from "./file";
import { Registry } from "./registry";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

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

const xpath = (c: Call): string | null => new Headers(c.options?.headers).get("x-path");
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

const fileState: { read: Uint8Array; written: Call[] } = { read: new Uint8Array(), written: [] };

function env(answers: Record<string, Answer> = {}): void {
  const mem = memoryStore();
  let settings: unknown = null;
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
    file_read: () => fileState.read.slice().buffer,
    file_write: () => null,
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
  env();
  vi.mocked(open).mockReset();
  vi.mocked(save).mockReset();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((r) => r.close()));
});

describe("export", () => {
  it("writes the plan through the save dialog", async () => {
    const reg = await registry();
    const id = await reg.createPlan("Bridge");
    const session = await reg.session(id);
    session.apply({ t: "create", kind: "task", name: "Survey", parent: null, after: null, start: TODAY });
    vi.mocked(save).mockResolvedValue("/Users/a/Bridge.webboard");
    const from = tauri.calls.length;
    expect(await exportPlan(session)).toBe("/Users/a/Bridge.webboard");
    expect(vi.mocked(save).mock.calls).toEqual([[{ defaultPath: "Bridge.webboard", filters: [{ name: "WebBoard plan", extensions: ["webboard"] }] }]]);
    const writes = callsOf(from, "file_write");
    expect(writes).toHaveLength(1);
    expect(xpath(writes[0])).toBe(encodeURIComponent("/Users/a/Bridge.webboard"));
    const body = writes[0].args;
    if (!(body instanceof Uint8Array)) throw new Error("file_write carried no bytes");
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

  it("names the plan as it is once the save dialog closes", async () => {
    const reg = await registry();
    const id = await reg.createPlan("Bridge");
    const session = await reg.session(id);
    let pick: (path: string) => void = () => {
      throw new Error("save was not called");
    };
    vi.mocked(save).mockReturnValue(new Promise<string>((resolve) => (pick = resolve)));
    const from = tauri.calls.length;
    const saved = exportPlan(session);
    await flush();
    session.apply({ t: "planName", name: "Viaduct" });
    pick("/Users/a/Bridge.webboard");
    expect(await saved).toBe("/Users/a/Bridge.webboard");
    const body = callsOf(from, "file_write")[0].args;
    if (!(body instanceof Uint8Array)) throw new Error("file_write carried no bytes");
    const { header, update } = decodeWbx(body);
    expect(header.name).toBe("Viaduct");
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, update);
    expect(projectPlan(id, logOf(new PlanDoc(fresh).actions())).name).toBe("Viaduct");
  });

  it("writes nothing on cancel", async () => {
    const reg = await registry();
    const session = await reg.session(await reg.createPlan("Bridge"));
    vi.mocked(save).mockResolvedValue(null);
    const from = tauri.calls.length;
    expect(await exportPlan(session)).toBeNull();
    expect(callsOf(from, "file_write")).toHaveLength(0);
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
    vi.mocked(open).mockResolvedValue("/Users/a/Bad.webboard");
    fileState.read = bytes;
    const caught = await importPlan(reg).then(
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

describe("import reads by header", () => {
  it("reads the picked file through x-path and creates one plan", async () => {
    expect([...VALID_WEBBOARD.bytes.subarray(0, 4)]).toEqual([0x57, 0x42, 0x58, 0x31]);
    const reg = await registry();
    const from = tauri.calls.length;
    const before = reg.plans().map((p) => p.id);
    vi.mocked(open).mockResolvedValue("/Users/a/My Plan.webboard");
    fileState.read = VALID_WEBBOARD.bytes;
    const id = await importPlan(reg);
    if (id === null) throw new Error("importPlan resolved null");
    const reads = callsOf(from, "file_read");
    expect(reads).toHaveLength(1);
    expect(reads[0].args).toEqual({});
    expect(xpath(reads[0])).toBe("%2FUsers%2Fa%2FMy%20Plan.webboard");
    expect(reg.plans().map((p) => p.id)).toEqual([...before, id]);
    const session = await reg.session(id);
    expect(session.view().plan.name).toBe(VALID_WEBBOARD.plan.name);
    expect([...session.view().plan.items.values()].filter((i) => !i.trashed)).toHaveLength(VALID_WEBBOARD.plan.items);
    expect(session.history()[0].label).toBe("Imported from My Plan.webboard");
  });

  it("decodes the file name of a file:// URL", async () => {
    const reg = await registry();
    const from = tauri.calls.length;
    const url = "file:///private/var/mobile/My%20Plan.webboard";
    vi.mocked(open).mockResolvedValue(url);
    fileState.read = VALID_WEBBOARD.bytes;
    const id = await importPlan(reg);
    if (id === null) throw new Error("importPlan resolved null");
    expect(xpath(callsOf(from, "file_read")[0])).toBe(encodeURIComponent(url));
    expect((await reg.session(id)).history()[0].label).toBe("Imported from My Plan.webboard");
  });

  it("cancel reads nothing", async () => {
    const reg = await registry();
    const from = tauri.calls.length;
    vi.mocked(open).mockResolvedValue(null);
    expect(await importPlan(reg)).toBeNull();
    expect(callsOf(from, "file_read")).toHaveLength(0);
  });
});
