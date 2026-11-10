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

export interface Resource {
  name: string;
  id: boolean;
  unit: boolean;
}

export interface Pred {
  id: number;
  type: LinkType;
  lag: number;
}

export interface Leaf {
  kind: "task" | "milestone";
  start: IsoDate;
  end: IsoDate;
  dur: number;
  progress: number;
  preds: readonly Pred[];
}

export interface Source {
  id: number;
  name: string;
  note: string;
  resources: readonly Resource[];
  coloured: boolean;
  parent: number | null;
  leaf: Leaf | null;
}

export interface GanttCheck {
  sources: readonly Source[];
  ids: ReadonlyMap<number, ItemId>;
  today: IsoDate;
}

export interface GanttPlan {
  plan: PlanState;
  action: Action;
  newNotes: readonly ItemId[];
  notes: ReadonlyMap<ItemId, string>;
  bytes: Uint8Array;
  counts: GanttCounts;
  dropped: readonly string[];
  check: GanttCheck;
}

export const BASELINE_NAME = "Imported plan";

type Raw = Record<string, unknown>;

const TOP_KEYS = ["data", "resources", "projectStartDate", "projectEndDate", "advanced"];
const TASK_KEYS = ["TaskID", "TaskName", "StartDate", "EndDate", "Duration", "DurationUnit", "Progress", "Predecessor", "resources", "color", "info", "subtasks"];
const RESOURCE_KEYS = ["resourceId", "resourceName", "unit"];
const DISPLAY_KEYS = ["columns", "zoomLevel", "dateFormat", "timeFormat", "firstDayOfWeek"];
const ADVANCED_KEYS = ["timezone", "timezoneOffset", "dependencyConflict", "workWeek", "workTime", "holidays", ...DISPLAY_KEYS];
const LINK_TYPES: readonly LinkType[] = ["FS", "SS", "FF", "SF"];
const LAG_UNITS = ["day", "days"];
const DAYS: Readonly<Record<string, Weekday>> = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const ENTRY = /^(\d+)\s*([A-Za-z]+)(?:\s*([+-])\s*(\S+)\s+([A-Za-z]+))?$/;
const STAMP = / (\d{4})(\d{2})(\d{2})$/;
const LATIN1 = (
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo " +
  "frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve " +
  "Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc " +
  "euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
).split(" ");
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ...Object.fromEntries(LATIN1.map((n, i) => [n, String.fromCodePoint(0xa0 + i)])),
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  euro: "€",
};
const ENTITY = /&(#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;
const TAGS = ["p", "br", "div", "span", "b", "strong", "i", "em", "u", "ul", "ol", "li"];
const BLOCKS = ["p", "div", "ul", "ol", "li"];
const ATTRIBUTES = ["style", "class"];
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const TOKEN = /<!--|<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s"'=<>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>|</g;

const fail = (where: string, message: string): GanttError => new GanttError(`${where}: ${message}`);

const show = (v: unknown): string => (v === undefined ? "nothing" : JSON.stringify(v));

const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

const isLinkType = (v: string): v is LinkType => (LINK_TYPES as readonly string[]).includes(v);

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const lookup = <K, V>(map: ReadonlyMap<K, V>, key: K, what: string): V => {
  const v = map.get(key);
  if (v === undefined) throw new Error(`The converter has no ${what} for ${String(key)}`);
  return v;
};

const recordOf = (where: string, v: unknown): Raw => {
  if (!isRecord(v)) throw fail(where, `is not an object: ${show(v)}`);
  return v;
};

const onlyKeys = (r: Raw, keys: readonly string[], unknown: (k: string) => GanttError): void => {
  const extra = Object.keys(r).find((k) => !keys.includes(k));
  if (extra !== undefined) throw unknown(extra);
};

const listOf = (where: string, field: string, v: unknown): readonly unknown[] => {
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

const partOf = (parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes, where: string): string => {
  const p = parts.find((x) => x.type === type);
  if (p === undefined) throw new GanttError(`${where} has no ${type}`);
  return p.value;
};

export function localDate(instant: unknown, tz: string, where: string): IsoDate {
  if (typeof instant !== "string" || !INSTANT.test(instant)) throw new GanttError(`${where} is not a UTC instant like 2026-09-01T06:00:00.000Z: ${show(instant)}`);
  const at = new Date(instant);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 19) !== instant.slice(0, 19)) throw new GanttError(`${where} is not a real date and time: ${show(instant)}`);
  const parts = formatter(tz).formatToParts(at);
  const zoned = `${where} in ${tz}`;
  return `${partOf(parts, "year", zoned)}-${partOf(parts, "month", zoned)}-${partOf(parts, "day", zoned)}`;
}

const offsetAt = (tz: string, at: number): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const n = (type: Intl.DateTimeFormatPartTypes): number => Number(partOf(parts, type, `The time in ${tz}`));
  return (at - Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"))) / 60000;
};

export function standardOffset(tz: string, year: number): number {
  return Math.max(...Array.from({ length: 12 }, (_, month) => offsetAt(tz, Date.UTC(year, month, 1, 12))));
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

const decodeText = (text: string, where: string): string => text.replace(ENTITY, (whole, body: string) => decodeEntity(where, whole, body));

const indexOf = (m: RegExpMatchArray): number => {
  if (m.index === undefined) throw new Error(`The match ${m[0]} has no index`);
  return m.index;
};

const endLine = (out: string): string => (out === "" || out.endsWith("\n") ? out : `${out}\n`);

const readTag = (out: string, m: RegExpMatchArray, html: string, where: string): string => {
  const at = indexOf(m);
  if (m[0] === "<!--") throw fail(where, `holds a comment (<!--); the converter keeps no hidden text`);
  if (m[2] === undefined) throw fail(where, `holds a < that starts no allow-listed tag: ${show(html.slice(at, at + 20))}`);
  const tag = m[2].toLowerCase();
  if (!TAGS.includes(tag)) throw fail(where, `holds the tag ${m[0]}, which the converter does not read (it reads ${TAGS.join(", ")})`);
  const odd = [...m[3].matchAll(ATTRIBUTE)].map((a) => a[1]).find((a) => !ATTRIBUTES.includes(a.toLowerCase()));
  if (odd !== undefined) throw fail(where, `holds the attribute ${odd} in ${m[0]}; only ${ATTRIBUTES.join(" and ")} are allowed`);
  if (tag === "br") return `${out}\n`;
  if (!BLOCKS.includes(tag)) return out;
  if (m[1] === "/") return endLine(out);
  return tag === "li" ? `${endLine(out)}• ` : endLine(out);
};

export function htmlToText(html: string, where: string): string {
  const tokens = [...html.matchAll(TOKEN)];
  const ends = [0, ...tokens.map((m) => indexOf(m) + m[0].length)];
  const out = tokens.reduce((acc, m, i) => readTag(acc + decodeText(html.slice(ends[i], indexOf(m)), where), m, html, where), "");
  return (out + decodeText(html.slice(ends[tokens.length]), where)).replace(/\n{3,}/g, "\n\n").trim();
}

export function infoToText(info: string, where: string): string {
  const text = info.trim();
  return text.startsWith("<") ? htmlToText(text, where) : text;
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
    if (!isLinkType(type)) throw fail(where, `Predecessor entry ${show(entry)} has link type ${show(type)}, not one of ${LINK_TYPES.join(", ")}`);
    if (sign === undefined) return { id: Number(id), type, lag: 0 };
    if (!LAG_UNITS.includes(unit)) throw fail(where, `Predecessor entry ${show(entry)} has lag unit ${show(unit)}, not day or days`);
    if (!/^\d+$/.test(amount)) throw fail(where, `Predecessor entry ${show(entry)} has lag ${show(amount)}, not a whole number of days`);
    const n = Number(amount);
    return { id: Number(id), type, lag: sign === "-" ? -n : n };
  });
};

const parseResources = (where: string, v: unknown): Resource[] =>
  listOf(where, "resources", v).map((x, i) => {
    const field = `resources[${i}]`;
    const r = recordOf(`${where} ${field}`, x);
    onlyKeys(r, RESOURCE_KEYS, (k) => fail(where, `unknown field ${field}.${k}`));
    const name = textOf(where, `${field}.resourceName`, r.resourceName);
    if (name.trim() === "") throw fail(where, `${field}.resourceName is blank`);
    return { name, id: "resourceId" in r, unit: "unit" in r };
  });

const noteOf = (where: string, info: unknown, resources: readonly Resource[]): string => {
  const text = info === undefined || info === null ? "" : infoToText(textOf(where, "info", info), `${where} info`);
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
    const subtasks = t.subtasks === undefined ? [] : listOf(where, "subtasks", t.subtasks);
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

const checkOffset = (adv: Raw, tz: string, year: number): void => {
  if (!("timezoneOffset" in adv)) return;
  const want = standardOffset(tz, year);
  if (adv.timezoneOffset !== want) throw new GanttError(`advanced.timezoneOffset is ${show(adv.timezoneOffset)}, but ${tz}'s standard-time offset is ${want}`);
};

interface Parsed {
  tz: string;
  workdays: Weekday[];
  sources: Source[];
  topResources: number;
  workTime: boolean;
  display: string[];
  dependencyConflict: string | null;
}

const parseSource = (text: string, year: number): Parsed => {
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
  checkOffset(adv, tz, year);
  const workdays = parseWorkWeek(adv.workWeek);
  const dependencyConflict = "dependencyConflict" in adv ? textOf("advanced", "dependencyConflict", adv.dependencyConflict) : null;
  const data = listOf("The .gantt file", "data", top.data);
  if (data.length === 0) throw new GanttError("The .gantt file has no tasks in data");
  return {
    tz,
    workdays,
    sources: flatten(data, null, tz, new Set()),
    topResources: listOf("The .gantt file", "resources", top.resources).length,
    workTime: adv.workTime !== undefined,
    display: DISPLAY_KEYS.filter((k) => k in adv),
    dependencyConflict,
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
  const resources = p.sources.flatMap((s) => s.resources);
  const ids = resources.filter((r) => r.id).length;
  const units = resources.filter((r) => r.unit).length;
  return [
    `TaskID on ${plural(p.sources.length, "item")}`,
    ...(coloured === 0 ? [] : [`color on ${plural(coloured, "item")}`]),
    ...(groups === 0 ? [] : [`group dates, duration and progress on ${plural(groups, "group")} (WebBoard derives group spans)`]),
    ...(ids === 0 ? [] : [`resources[].resourceId on ${plural(ids, "resource")}`]),
    ...(units === 0 ? [] : [`resources[].unit on ${plural(units, "resource")}`]),
    ...(p.topResources === 0 ? [] : [`the top-level resources list (${plural(p.topResources, "entry", "entries")})`]),
    ...(p.workTime ? ["advanced.workTime"] : []),
    ...(p.display.length === 0 ? [] : [`advanced display settings: ${p.display.join(", ")}`]),
    ...(p.dependencyConflict === null
      ? []
      : [`dependencyConflict ${show(p.dependencyConflict)} (a scheduling option of the source tool; WebBoard keeps its own link rules)`]),
  ];
};

const lagText = (l: { type: LinkType; lag: number }): string => `${l.type}${l.lag === 0 ? "" : l.lag > 0 ? `+${l.lag}` : l.lag}`;

const labeller = (sources: readonly Source[], ids: ReadonlyMap<number, ItemId>): ((item: ItemId) => string) => {
  const taskOf = new Map(sources.map((s): [ItemId, Source] => [lookup(ids, s.id, "item id"), s]));
  return (item) => {
    const s = lookup(taskOf, item, "source task");
    return `Task ${s.id} ${s.name}`;
  };
};

const describeConflict = (c: Conflict, label: (id: ItemId) => string, plan: PlanState): string => {
  if (c.kind === "dayoff") return `${label(c.item)} starts on a day off and shows from ${toIso(c.shownFrom)}`;
  const { from, to } = linkEnds(`l:${c.link}`);
  const l = plan.links.get(c.link);
  const kind = l === undefined ? "" : ` (${lagText(l)})`;
  return c.kind === "loop"
    ? `the link ${label(from)} → ${label(to)}${kind} is part of a loop`
    : `the link ${label(from)} → ${label(to)}${kind} needs ${label(to)} to start on ${toIso(c.need)} or later`;
};

const logOf = (action: Action, what: string): LogState => {
  const log = new LogState(planRules);
  const delta = log.add([action]);
  if (delta.refused.length > 0) throw new GanttError(`${what}: ${delta.refused.map((r) => r.message).join("; ")}`);
  return log;
};

const checkFidelity = (log: LogState, plan: PlanState, check: GanttCheck): void => {
  const { sources, ids, today } = check;
  const cs = choices(log, plan, new Map());
  const held = heldItems(cs, plan);
  const derived = derive(plan, held, today);
  const label = labeller(sources, ids);
  const leaves = sources.flatMap((s) => (s.leaf === null ? [] : [{ item: lookup(ids, s.id, "item id"), leaf: s.leaf }]));
  const dates = leaves.flatMap(({ item, leaf }) => {
    const start = derived.start.get(item);
    const end = derived.end.get(item);
    if (start === undefined || end === undefined) return [`- ${label(item)}: source ${leaf.start} → ${leaf.end}, WebBoard leaves it unscheduled`];
    return toIso(start) === leaf.start && toIso(end) === leaf.end ? [] : [`- ${label(item)}: source ${leaf.start} → ${leaf.end}, WebBoard ${toIso(start)} → ${toIso(end)}`];
  });
  const statuses = leaves.flatMap(({ item, leaf }) => {
    const mapped = statusOf(leaf.progress);
    const shown = derived.status.get(item);
    return shown === mapped ? [] : [`- ${label(item)}: the .gantt file gives ${mapped}, WebBoard derives ${shown ?? "no status"}`];
  });
  const states = [
    ...[...held].map((item) => `- ${label(item)} is held by an open choice`),
    ...(cs.length === 0 ? [] : [`- WebBoard opens ${plural(cs.length, "choice")}: ${cs.map((c) => c.kind).join(", ")}`]),
    ...derived.conflicts.map((c) => `- ${describeConflict(c, label, plan)}`),
  ];
  const parts = [
    ...(dates.length === 0 ? [] : [`WebBoard would show different dates than the .gantt file:\n${dates.join("\n")}`]),
    ...(statuses.length === 0 ? [] : [`WebBoard would show a different status than the .gantt file:\n${statuses.join("\n")}`]),
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
  const parsed = parseSource(a.text, new Date(a.now).getUTCFullYear());
  const { sources } = parsed;
  const planName = checkedName("The plan name", "plan name", a.name ?? defaultPlanName(a.fileName));
  const ids = new Map(sources.map((s): [number, ItemId] => [s.id, newId()]));
  const byTask = new Map(sources.map((s): [number, Source] => [s.id, s]));
  const idOf = (task: number): ItemId => lookup(ids, task, "item id");
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
      const place = { parent: s.parent === null ? null : idOf(s.parent), order: lookup(orders, s.id, "order key") };
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
  const check: GanttCheck = { sources, ids, today: at };
  const log = logOf(action, "WebBoard refuses the plan");
  checkFidelity(log, projectPlan(plan.id, log), check);
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
    check,
  };
}

const canonical = (v: unknown): unknown => {
  if (v instanceof Map) return [...v].map(([k, x]): [string, unknown] => [String(k), canonical(x)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (Array.isArray(v)) return v.map(canonical);
  if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
};

const canonText = (v: unknown): string => JSON.stringify(canonical(v));

const differs = (what: string, got: unknown, want: unknown): string[] => (canonText(got) === canonText(want) ? [] : [`- ${what} reads back as ${canonText(got)}, not ${canonText(want)}`]);

export function readBack(bytes: Uint8Array, fileName: string, g: GanttPlan): GanttCounts {
  const r = buildImport(bytes, fileName, newId(), newId(), Date.now());
  const log = logOf(r.action, "The written plan does not read back");
  const back = projectPlan(r.planId, log);
  const to = (id: string): string => lookup(r.idMap, id, "read-back id");
  const label = labeller(g.check.sources, g.check.ids);
  const items = [...g.plan.items.values()].flatMap((i) => {
    const b = back.items.get(to(i.id));
    if (b === undefined) return [`- ${label(i.id)} does not read back`];
    return [
      ...differs(`${label(i.id)}: kind`, b.kind, i.kind),
      ...differs(`${label(i.id)}: name`, b.name, i.name),
      ...differs(`${label(i.id)}: parent`, b.place.parent, i.place.parent === null ? null : to(i.place.parent)),
      ...differs(`${label(i.id)}: order`, b.place.order, i.place.order),
      ...differs(`${label(i.id)}: schedule`, b.schedule, i.schedule),
      ...differs(`${label(i.id)}: note`, r.notes.get(to(i.id)) ?? "", g.notes.get(i.id) ?? ""),
    ];
  });
  const links = [...g.plan.links.values()].flatMap((l) => {
    const b = back.links.get(linkKey(to(l.from), to(l.to)));
    const what = `link ${label(l.from)} → ${label(l.to)}`;
    if (b === undefined) return [`- ${what} does not read back`];
    return lagText(b) === lagText(l) ? [] : [`- ${what} reads back as ${lagText(b)}, not ${lagText(l)}`];
  });
  const baselines = [...g.plan.baselines.values()].flatMap((b) => {
    const want = { id: to(b.id), name: b.name, at: b.at, dates: Object.fromEntries(Object.entries(b.dates).map(([k, d]) => [to(k), d])) };
    return differs(`baseline ${b.name}`, back.baselines.get(to(b.id)) ?? null, want);
  });
  const mismatches = [
    ...differs("plan name", back.name, g.plan.name),
    ...differs("the number of items", back.items.size, g.plan.items.size),
    ...items,
    ...differs("the number of links", back.links.size, g.plan.links.size),
    ...links,
    ...differs("calendar", back.calendar, g.plan.calendar),
    ...differs("the number of baselines", back.baselines.size, g.plan.baselines.size),
    ...baselines,
  ];
  if (mismatches.length > 0) throw new GanttError(`The written plan does not read back as the converted plan:\n${mismatches.join("\n")}`);
  checkFidelity(log, back, { ...g.check, ids: new Map([...g.check.ids].map(([task, item]): [number, ItemId] => [task, to(item)])) });
  return countsOf(back, r.notes);
}
