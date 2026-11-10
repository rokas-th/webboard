import { generateNKeysBetween } from "fractional-indexing";
import * as Y from "yjs";
import type { Calendar } from "../domain/calendar";
import { toDay, toIso, type IsoDate, type Weekday } from "../domain/dates";
import { derive } from "../domain/derive";
import { linkKey, type Baseline, type Item, type ItemId, type Link, type LinkKey, type LinkType, type PlanState, type Status } from "../domain/model";
import type { Conflict } from "../domain/schedule";
import { newId } from "../log/ids";
import { LogState } from "../log/state";
import type { Action, DeviceId, SessionId } from "../log/types";
import { choices, heldItems } from "../plan/choices";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { linkEnds, name as nameCodec, stateWrites } from "../plan/units";
import { PlanDoc } from "../store/doc";
import { buildImport, encodeWbx } from "../store/file";
import { newPlanId } from "../store/plan-id";

export class GanttError extends Error {}

export interface GanttCounts {
  groups: number;
  tasks: number;
  milestones: number;
  links: number;
  notes: number;
}

export interface GanttPlan {
  plan: PlanState;
  action: Action;
  newNotes: readonly ItemId[];
  notes: ReadonlyMap<ItemId, string>;
  bytes: Uint8Array;
  counts: GanttCounts;
  dropped: readonly string[];
}

export const BASELINE_NAME = "Imported plan";

type Raw = Record<string, unknown>;

interface Resource {
  name: string;
  unit: boolean;
}

interface Pred {
  id: number;
  type: LinkType;
  lag: number;
}

interface Leaf {
  kind: "task" | "milestone";
  start: IsoDate;
  end: IsoDate;
  dur: number;
  progress: number;
  preds: readonly Pred[];
}

interface Source {
  id: number;
  name: string;
  note: string;
  resources: readonly Resource[];
  coloured: boolean;
  parent: number | null;
  leaf: Leaf | null;
}

const TOP_KEYS = ["data", "resources", "projectStartDate", "projectEndDate", "advanced"];
const TASK_KEYS = ["TaskID", "TaskName", "StartDate", "EndDate", "Duration", "DurationUnit", "Progress", "Predecessor", "resources", "color", "info", "subtasks"];
const RESOURCE_KEYS = ["resourceId", "resourceName", "unit"];
const DISPLAY_KEYS = ["columns", "zoomLevel", "timezoneOffset", "dependencyConflict", "dateFormat", "timeFormat", "firstDayOfWeek"];
const ADVANCED_KEYS = ["timezone", "workWeek", "workTime", "holidays", ...DISPLAY_KEYS];
const LINK_TYPES: readonly LinkType[] = ["FS", "SS", "FF", "SF"];
const LAG_UNITS = ["day", "days"];
const DAYS: Readonly<Record<string, Weekday>> = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const ENTRY = /^(\d+)\s*([A-Za-z]+)(?:\s*([+-])\s*(\S+)\s+([A-Za-z]+))?$/;
const STAMP = / (\d{4})(\d{2})(\d{2})$/;
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const BREAK = /<br\s*\/?>/gi;
const BLOCK_END = /<\/(?:p|div|li|ul|ol|h[1-6]|tr|table|blockquote|pre)\s*>/gi;
const TAG = /<\/?[A-Za-z][^>]*>/g;
const ENTITY = /&(#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;

const fail = (where: string, message: string): GanttError => new GanttError(`${where}: ${message}`);

const show = (v: unknown): string => (v === undefined ? "nothing" : JSON.stringify(v));

const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const recordOf = (where: string, v: unknown): Raw => {
  if (!isRecord(v)) throw fail(where, `is not an object: ${show(v)}`);
  return v;
};

const onlyKeys = (r: Raw, keys: readonly string[], unknown: (k: string) => GanttError): void => {
  const extra = Object.keys(r).find((k) => !keys.includes(k));
  if (extra !== undefined) throw unknown(extra);
};

const listOf = (where: string, field: string, v: unknown): readonly unknown[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw fail(where, `${field} is not a list: ${show(v)}`);
  return v;
};

const textOf = (where: string, field: string, v: unknown): string => {
  if (typeof v !== "string") throw fail(where, `${field} is not text: ${show(v)}`);
  return v;
};

const wholeNumber = (where: string, field: string, v: unknown, min: number, max = Infinity): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw fail(where, `${field} is not a whole number ${max === Infinity ? `of at least ${min}` : `from ${min} to ${max}`}: ${show(v)}`);
  }
  return v;
};

const checkedName = (where: string, field: string, v: unknown): string => {
  const s = textOf(where, field, v);
  try {
    return nameCodec.dec(s);
  } catch (e) {
    throw fail(where, `${field} cannot be a WebBoard name (${e instanceof Error ? e.message : String(e)})`);
  }
};

const formatter = (tz: string): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch (e) {
    if (e instanceof RangeError) throw fail("advanced.timezone", `is not an IANA time zone: ${show(tz)}`);
    throw e;
  }
};

export function localDate(instant: unknown, tz: string, where: string): IsoDate {
  if (typeof instant !== "string" || !INSTANT.test(instant)) throw new GanttError(`${where} is not a UTC instant like 2026-09-01T06:00:00.000Z: ${show(instant)}`);
  const at = new Date(instant);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 19) !== instant.slice(0, 19)) throw new GanttError(`${where} is not a real date and time: ${show(instant)}`);
  const parts = formatter(tz).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    if (p === undefined) throw new GanttError(`${where} has no ${type} in ${tz}`);
    return p.value;
  };
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const decodeEntity = (where: string, whole: string, body: string): string => {
  if (body.startsWith("#")) {
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0) throw fail(where, `holds an entity that is no character: ${whole}`);
    return String.fromCodePoint(code);
  }
  const named = ENTITIES[body];
  if (named === undefined) throw fail(where, `holds an entity it cannot decode: ${whole}`);
  return named;
};

export function htmlToText(html: string, where: string): string {
  return html
    .replace(BREAK, "\n")
    .replace(BLOCK_END, "\n")
    .replace(TAG, "")
    .replace(ENTITY, (whole, body: string) => decodeEntity(where, whole, body))
    .replace(/\r\n?/g, "\n")
    .trim();
}

const baseName = (fileName: string): string => {
  const file = fileName.slice(fileName.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
};

export function defaultPlanName(fileName: string): string {
  return baseName(fileName).replace(STAMP, "");
}

const stampOf = (fileName: string): IsoDate | null => {
  const m = STAMP.exec(baseName(fileName));
  if (m === null) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  try {
    toDay(d);
  } catch (e) {
    if (e instanceof RangeError) throw fail("file name", `its date stamp ${m[1]}${m[2]}${m[3]} is not a calendar date`);
    throw e;
  }
  return d;
};

const parsePreds = (where: string, v: unknown): Pred[] => {
  if (v === undefined || v === null) return [];
  const text = textOf(where, "Predecessor", v).trim();
  if (text === "") return [];
  return text.split(",").map((raw) => {
    const entry = raw.trim();
    const m = ENTRY.exec(entry);
    if (m === null) throw fail(where, `Predecessor entry ${show(entry)} is not <TaskID><type>[+|-<n> days]`);
    const [, id, type, sign, amount, unit] = m;
    if (!(LINK_TYPES as readonly string[]).includes(type)) throw fail(where, `Predecessor entry ${show(entry)} has link type ${show(type)}, not one of ${LINK_TYPES.join(", ")}`);
    if (sign === undefined) return { id: Number(id), type: type as LinkType, lag: 0 };
    if (!LAG_UNITS.includes(unit)) throw fail(where, `Predecessor entry ${show(entry)} has lag unit ${show(unit)}, not day or days`);
    if (!/^\d+$/.test(amount)) throw fail(where, `Predecessor entry ${show(entry)} has lag ${show(amount)}, not a whole number of days`);
    const n = Number(amount);
    return { id: Number(id), type: type as LinkType, lag: sign === "-" ? -n : n };
  });
};

const parseResources = (where: string, v: unknown): Resource[] =>
  listOf(where, "resources", v).map((x, i) => {
    const field = `resources[${i}]`;
    const r = recordOf(`${where} ${field}`, x);
    onlyKeys(r, RESOURCE_KEYS, (k) => fail(where, `unknown field ${field}.${k}`));
    return { name: textOf(where, `${field}.resourceName`, r.resourceName), unit: "unit" in r };
  });

const noteOf = (where: string, info: unknown, resources: readonly Resource[]): string => {
  const text = info === undefined || info === null ? "" : htmlToText(textOf(where, "info", info), `${where} info`);
  const line = resources.length === 0 ? "" : `Resources: ${resources.map((r) => r.name).join(", ")}`;
  return [text, line].filter((s) => s !== "").join("\n");
};

const parseLeaf = (where: string, t: Raw, tz: string): Leaf => {
  if (t.DurationUnit !== "day") throw fail(where, `DurationUnit is ${show(t.DurationUnit)}, not "day"`);
  const dur = wholeNumber(where, "Duration", t.Duration, 0);
  return {
    kind: dur === 0 ? "milestone" : "task",
    start: localDate(t.StartDate, tz, `${where}: StartDate`),
    end: localDate(t.EndDate, tz, `${where}: EndDate`),
    dur,
    progress: wholeNumber(where, "Progress", t.Progress, 0, 100),
    preds: parsePreds(where, t.Predecessor),
  };
};

const flatten = (data: readonly unknown[], parent: number | null, tz: string, seen: Set<number>): Source[] =>
  data.flatMap((x, i) => {
    const t = recordOf(parent === null ? `data[${i}]` : `the subtasks[${i}] of Task ${parent}`, x);
    const id = wholeNumber(`data entry ${show(t.TaskID)}`, "TaskID", t.TaskID, 0);
    if (seen.has(id)) throw new GanttError(`TaskID ${id} appears twice`);
    seen.add(id);
    const where = `Task ${id}`;
    onlyKeys(t, TASK_KEYS, (k) => fail(where, `unknown field ${k}`));
    const subtasks = listOf(where, "subtasks", t.subtasks);
    const resources = parseResources(where, t.resources);
    const node: Source = {
      id,
      name: checkedName(where, "TaskName", t.TaskName),
      note: noteOf(where, t.info, resources),
      resources,
      coloured: t.color !== undefined && t.color !== null,
      parent,
      leaf: subtasks.length === 0 ? parseLeaf(where, t, tz) : null,
    };
    if (node.leaf === null && parsePreds(where, t.Predecessor).length > 0) throw fail(where, "is a group (it has subtasks), and WebBoard cannot link a group, but it has a Predecessor");
    return [node, ...flatten(subtasks, id, tz, seen)];
  });

const parseWorkWeek = (v: unknown): Weekday[] => {
  const where = "advanced.workWeek";
  if (!Array.isArray(v) || v.length === 0) throw fail(where, `is not a non-empty list of day names: ${show(v)}`);
  const days = v.map((d) => {
    const day = typeof d === "string" ? DAYS[d] : undefined;
    if (day === undefined) throw fail(where, `names a day it cannot read: ${show(d)}`);
    return day;
  });
  const twice = v.find((d, i) => v.indexOf(d) !== i);
  if (twice !== undefined) throw fail(where, `names ${show(twice)} twice`);
  return [...days].sort((a, b) => a - b);
};

interface Parsed {
  tz: string;
  workdays: Weekday[];
  sources: Source[];
  topResources: number;
  workTime: boolean;
  display: string[];
}

const parseSource = (text: string): Parsed => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new GanttError(`The .gantt file is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const top = recordOf("The .gantt file", raw);
  onlyKeys(top, TOP_KEYS, (k) => new GanttError(`The .gantt file has an unknown top-level field ${k}`));
  ["projectStartDate", "projectEndDate"].forEach((k) => {
    if (top[k] !== undefined && top[k] !== null) throw fail(k, `is set (${show(top[k])}); WebBoard has no project date bounds to put it in`);
  });
  const adv = recordOf("advanced", top.advanced);
  onlyKeys(adv, ADVANCED_KEYS, (k) => new GanttError(`The .gantt file has an unknown field advanced.${k}`));
  if (listOf("advanced", "holidays", adv.holidays).length > 0) throw fail("advanced.holidays", `is not empty (${show(adv.holidays)}); the converter maps no holidays`);
  const tz = textOf("advanced", "timezone", adv.timezone);
  formatter(tz);
  const workdays = parseWorkWeek(adv.workWeek);
  const data = listOf("The .gantt file", "data", top.data);
  if (data.length === 0) throw new GanttError("The .gantt file has no tasks in data");
  return {
    tz,
    workdays,
    sources: flatten(data, null, tz, new Set()),
    topResources: listOf("The .gantt file", "resources", top.resources).length,
    workTime: adv.workTime !== undefined,
    display: DISPLAY_KEYS.filter((k) => k in adv),
  };
};

const statusOf = (progress: number): Status => (progress === 100 ? "done" : progress === 0 ? "todo" : "doing");

export function countsOf(plan: PlanState, notes: ReadonlyMap<ItemId, string>): GanttCounts {
  const kinds = [...plan.items.values()].map((i) => i.kind);
  return {
    groups: kinds.filter((k) => k === "group").length,
    tasks: kinds.filter((k) => k === "task").length,
    milestones: kinds.filter((k) => k === "milestone").length,
    links: plan.links.size,
    notes: [...notes.values()].filter((t) => t !== "").length,
  };
}

const droppedOf = (p: Parsed): string[] => {
  const groups = p.sources.filter((s) => s.leaf === null).length;
  const coloured = p.sources.filter((s) => s.coloured).length;
  const units = p.sources.flatMap((s) => s.resources).filter((r) => r.unit).length;
  return [
    `TaskID on ${plural(p.sources.length, "item")}`,
    ...(coloured === 0 ? [] : [`color on ${plural(coloured, "item")}`]),
    ...(groups === 0 ? [] : [`group dates, duration and progress on ${plural(groups, "group")} (WebBoard derives group spans)`]),
    ...(units === 0 ? [] : [`resources[].unit on ${plural(units, "resource")}`]),
    ...(p.topResources === 0 ? [] : [`the top-level resources list (${plural(p.topResources, "entry", "entries")})`]),
    ...(p.workTime ? ["advanced.workTime"] : []),
    ...(p.display.length === 0 ? [] : [`advanced display settings: ${p.display.join(", ")}`]),
  ];
};

const describeConflict = (c: Conflict, label: (id: ItemId) => string, plan: PlanState): string => {
  if (c.kind === "dayoff") return `${label(c.item)} starts on a day off and shows from ${toIso(c.shownFrom)}`;
  const { from, to } = linkEnds(`l:${c.link}`);
  const l = plan.links.get(c.link);
  const kind = l === undefined ? "" : ` (${l.type}${l.lag === 0 ? "" : l.lag > 0 ? `+${l.lag}` : l.lag})`;
  return c.kind === "loop"
    ? `the link ${label(from)} → ${label(to)}${kind} is part of a loop`
    : `the link ${label(from)} → ${label(to)}${kind} needs ${label(to)} to start on ${toIso(c.need)} or later`;
};

const checkFidelity = (built: PlanState, action: Action, sources: readonly Source[], ids: ReadonlyMap<number, ItemId>, today: IsoDate): void => {
  const log = new LogState(planRules);
  const delta = log.add([action]);
  if (delta.refused.length > 0) throw new GanttError(`WebBoard refuses the plan: ${delta.refused.map((r) => r.message).join("; ")}`);
  const plan = projectPlan(built.id, log);
  const cs = choices(log, plan, new Map());
  const held = heldItems(cs, plan);
  const derived = derive(plan, held, today);
  const taskOf = new Map([...ids].map(([task, item]): [ItemId, Source] => [item, sources.find((s) => s.id === task) as Source]));
  const label = (item: ItemId): string => {
    const s = taskOf.get(item);
    if (s === undefined) throw new Error(`No source task for item ${item}`);
    return `Task ${s.id} ${s.name}`;
  };
  const idOf = (s: Source): ItemId => ids.get(s.id) as ItemId;
  const leaves = sources.filter((s): s is Source & { leaf: Leaf } => s.leaf !== null);
  const dates = leaves.flatMap((s) => {
    const start = derived.start.get(idOf(s));
    const end = derived.end.get(idOf(s));
    if (start === undefined || end === undefined) return [`- ${label(idOf(s))}: source ${s.leaf.start} → ${s.leaf.end}, WebBoard leaves it unscheduled`];
    return toIso(start) === s.leaf.start && toIso(end) === s.leaf.end
      ? []
      : [`- ${label(idOf(s))}: source ${s.leaf.start} → ${s.leaf.end}, WebBoard ${toIso(start)} → ${toIso(end)}`];
  });
  const states = [
    ...[...held].map((item) => `- ${label(item)} is held by an open choice`),
    ...(cs.length === 0 ? [] : [`- WebBoard opens ${plural(cs.length, "choice")}: ${cs.map((c) => c.kind).join(", ")}`]),
    ...derived.conflicts.map((c) => `- ${describeConflict(c, label, plan)}`),
  ];
  const parts = [
    ...(dates.length === 0 ? [] : [`WebBoard would show different dates than the .gantt file:\n${dates.join("\n")}`]),
    ...(states.length === 0 ? [] : [`WebBoard would show the plan in conflict or held:\n${states.join("\n")}`]),
  ];
  if (parts.length > 0) throw new GanttError(parts.join("\n"));
};

const encode = (plan: PlanState, action: Action, newNotes: readonly ItemId[], notes: ReadonlyMap<ItemId, string>, now: number): Uint8Array => {
  const doc = new Y.Doc();
  const planDoc = new PlanDoc(doc);
  doc.transact(() => {
    planDoc.append(action, newNotes);
    notes.forEach((text, item) => planDoc.note(item).insert(0, text));
  });
  const update = Y.encodeStateAsUpdate(doc);
  return encodeWbx({ planId: plan.id, name: plan.name, exportedAt: new Date(now).toISOString(), updateLength: update.length }, update);
};

export function convertGantt(a: { text: string; fileName: string; name?: string; dev: DeviceId; ses: SessionId; now: number }): GanttPlan {
  const parsed = parseSource(a.text);
  const { sources } = parsed;
  const planName = checkedName("The plan name", "plan name", a.name ?? defaultPlanName(a.fileName));
  const ids = new Map(sources.map((s): [number, ItemId] => [s.id, newId()]));
  const byTask = new Map(sources.map((s): [number, Source] => [s.id, s]));
  const idOf = (task: number): ItemId => ids.get(task) as ItemId;
  const parents = [...new Set(sources.map((s) => s.parent))];
  const orders = new Map(
    parents.flatMap((p) => {
      const kids = sources.filter((s) => s.parent === p);
      const keys = generateNKeysBetween(null, null, kids.length);
      return kids.map((k, i): [number, string] => [k.id, keys[i]]);
    }),
  );
  const links = new Map(
    sources.flatMap((s) => {
      const leaf = s.leaf;
      if (leaf === null) return [];
      const where = `Task ${s.id}`;
      return leaf.preds.map((p, i): [LinkKey, Link] => {
        const pred = byTask.get(p.id);
        if (pred === undefined) throw fail(where, `Predecessor names unknown TaskID ${p.id}`);
        if (pred.id === s.id) throw fail(where, "Predecessor names the task itself");
        if (pred.leaf === null) throw fail(where, `Predecessor names TaskID ${p.id}, a group (it has subtasks), and WebBoard cannot link a group`);
        if (leaf.preds.findIndex((q) => q.id === p.id) !== i) throw fail(where, `Predecessor names TaskID ${p.id} twice`);
        const from = idOf(p.id);
        const to = idOf(s.id);
        return [linkKey(from, to), { from, to, type: p.type, lag: p.lag }];
      });
    }),
  );
  const items = new Map(
    sources.map((s): [ItemId, Item] => {
      const id = idOf(s.id);
      const place = { parent: s.parent === null ? null : idOf(s.parent), order: orders.get(s.id) as string };
      if (s.leaf === null) return [id, { id, kind: "group", name: s.name, trashed: false, schedule: null, place, refs: {} }];
      const status = statusOf(s.leaf.progress);
      return [
        id,
        {
          id,
          kind: s.leaf.kind,
          name: s.name,
          trashed: false,
          schedule: { start: s.leaf.start, dur: s.leaf.dur, status, progress: s.leaf.progress, horizon: "later" },
          place,
          refs: {},
        },
      ];
    }),
  );
  const leaves = sources.flatMap((s) => (s.leaf === null ? [] : [{ s, leaf: s.leaf }]));
  const earliestStart = leaves.map((x) => x.leaf.start).sort()[0];
  if (earliestStart === undefined) throw new GanttError("The .gantt file has no task or milestone");
  const at = stampOf(a.fileName) ?? earliestStart;
  const baseline: Baseline = {
    id: newId(),
    name: BASELINE_NAME,
    at,
    dates: Object.fromEntries(leaves.map(({ s, leaf }) => [idOf(s.id), { start: leaf.start, dur: leaf.dur }])),
  };
  const calendar: Calendar = { region: null, workdays: parsed.workdays, closures: new Map(), tuning: new Map(), holidays: new Map() };
  const plan: PlanState = { id: newPlanId(), name: planName, items, links, calendar, baselines: new Map([[baseline.id, baseline]]) };
  const action: Action = { id: newId(), dev: a.dev, ses: a.ses, at: a.now, par: [], lbl: `Converted from ${a.fileName}`, w: stateWrites(plan, "own", () => false) };
  checkFidelity(plan, action, sources, ids, at);
  const notes = new Map(sources.flatMap((s): [ItemId, string][] => (s.note === "" ? [] : [[idOf(s.id), s.note]])));
  const newNotes = [...items.keys()];
  return {
    plan,
    action,
    newNotes,
    notes,
    bytes: encode(plan, action, newNotes, notes, a.now),
    counts: countsOf(plan, notes),
    dropped: droppedOf(parsed),
  };
}

export function readBack(bytes: Uint8Array, fileName: string): GanttCounts {
  const r = buildImport(bytes, fileName, newId(), newId(), Date.now());
  const log = new LogState(planRules);
  const delta = log.add([r.action]);
  if (delta.refused.length > 0) throw new GanttError(`The written plan does not read back: ${delta.refused.map((x) => x.message).join("; ")}`);
  return countsOf(projectPlan(r.planId, log), r.notes);
}
