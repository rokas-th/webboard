import { generateNKeysBetween } from "fractional-indexing";
import { workCalendar, type Calendar, type Closure, type WorkCalendar } from "../domain/calendar";
import { toDay, toIso, yearOf, type Day, type IsoDate } from "../domain/dates";
import { EMPTY_PEOPLE, EMPTY_WORKFLOW, linkKey, type Baseline, type Item, type ItemId, type Link, type LinkKey, type PlanId, type PlanState, type Status } from "../domain/model";
import { earliest, endOf, type Sched } from "../domain/schedule";
import { newId } from "../log/ids";
import type { Action, DeviceId, SessionId } from "../log/types";
import { stateWrites } from "../plan/units";

export const EXAMPLE_NAME = "Example: Website relaunch";
export const EXAMPLE_LABEL = "Created the example plan";

const CLOSURE_NAME = "Team offsite";
const BASELINE_NAME = "Agreed plan";
const STRETCHED = "Visual design";
const AGREED_DUR = 3;
const LEAD = 3;
const REACH = 40;
const REACH_BACK_DAYS = 60;

interface Row {
  group: readonly string[];
  name: string;
  kind: "task" | "milestone";
  dur: number;
  status: Status;
  progress: number;
  from: readonly string[];
  note?: string;
}

const row = (group: readonly string[], name: string, kind: Row["kind"], dur: number, status: Status, progress: number, from: readonly string[], note?: string): Row =>
  note === undefined ? { group, name, kind, dur, status, progress, from } : { group, name, kind, dur, status, progress, from, note };

const ROWS: readonly Row[] = [
  row(["Discovery"], "Kickoff", "milestone", 0, "done", 100, [], "Agenda: goals, scope, roles. The slides are in the shared drive."),
  row(["Discovery"], "Stakeholder interviews", "task", 4, "done", 100, ["Kickoff"]),
  row(["Discovery"], "Requirements", "task", 3, "done", 100, ["Stakeholder interviews"]),
  row(["Design"], "Wireframes", "task", 4, "done", 100, ["Requirements"]),
  row(["Design"], "Visual design", "task", 5, "doing", 60, ["Wireframes"], "Two directions presented; the client prefers B. Waiting for the final logo files."),
  row(["Design"], "Design sign-off", "milestone", 0, "todo", 0, ["Visual design"]),
  row(["Build", "Backend"], "CMS setup", "task", 4, "done", 100, ["Requirements"]),
  row(["Build", "Backend"], "Content migration", "task", 5, "todo", 0, ["CMS setup", "Design sign-off"]),
  row(["Build", "Backend"], "Search", "task", 3, "todo", 0, ["CMS setup", "Design sign-off"]),
  row(["Build", "Frontend"], "Page templates", "task", 6, "doing", 30, ["Wireframes"]),
  row(["Build", "Frontend"], "Responsive pass", "task", 3, "todo", 0, ["Page templates", "Design sign-off"]),
  row(["Launch"], "QA and fixes", "task", 4, "todo", 0, ["Content migration", "Search", "Responsive pass"], "Test in Safari, Chrome and Firefox, on desktop and on a phone."),
  row(["Launch"], "Go live", "milestone", 0, "todo", 0, ["QA and fixes"]),
  row(["Launch"], "Retrospective", "task", 1, "todo", 0, ["Go live"]),
];

export function exampleYears(today: IsoDate): number[] {
  const y = yearOf(toDay(today));
  return yearOf(toDay(today) - REACH_BACK_DAYS) < y ? [y - 1, y, y + 1] : [y, y + 1];
}

type Dated = ReadonlyMap<string, Sched>;

function datesFrom(cal: WorkCalendar, anchor: Day, stretched: number): Dated {
  return ROWS.reduce((acc, r) => {
    const dur = r.name === STRETCHED ? stretched : r.dur;
    const draft: Sched = { id: r.name, kind: r.kind, start: anchor, dur, lock: null };
    const start =
      r.from.length === 0
        ? cal.snapF(anchor)
        : Math.max(
            ...r.from.map((f) => {
              const pred = acc.get(f);
              if (pred === undefined) throw new Error(`Example: ${f} comes after ${r.name}`);
              return earliest(draft, { from: f, to: r.name, type: "FS", lag: 0 }, pred, cal);
            }),
          );
    return new Map([...acc, [r.name, { ...draft, start }]]);
  }, new Map<string, Sched>());
}

function dateOf(dated: Dated, name: string): Sched {
  const s = dated.get(name);
  if (s === undefined) throw new Error(`Example: ${name} has no date`);
  return s;
}

const holds = (dated: Dated, cal: WorkCalendar, t: Day): boolean =>
  ROWS.every((r) => {
    const s = dateOf(dated, r.name);
    const end = endOf(s, cal);
    if (r.status === "done") return end < t;
    if (r.status === "doing") return s.start < t && t < end;
    return s.start > t;
  });

function anchorFor(cal: WorkCalendar, t: Day, dur: number): Day {
  const lead = cal.subWork(t, LEAD);
  const doing = ROWS.filter((r) => r.status === "doing");
  const anchor = Array.from({ length: REACH + 1 }, (_, n) => cal.subWork(t, n)).find((a) => {
    const dated = datesFrom(cal, a, dur);
    return doing.every((r) => dateOf(dated, r.name).start === lead);
  });
  if (anchor === undefined) throw new Error(`Example: no anchor day starts the doing work on ${toIso(lead)}`);
  if (!holds(datesFrom(cal, anchor, dur), cal, t)) throw new Error(`Example: with the doing work from ${toIso(lead)}, not all work is done before, doing across or todo after ${toIso(t)}`);
  return anchor;
}

interface Node {
  key: string;
  name: string;
  parent: string | null;
}

function groupNodes(): Node[] {
  const paths = ROWS.flatMap((r) => r.group.map((_, i) => r.group.slice(0, i + 1)));
  const keys = [...new Set(paths.map((p) => p.join("›")))];
  return keys.map((k) => {
    const parts = k.split("›");
    return { key: k, name: parts[parts.length - 1], parent: parts.length === 1 ? null : parts.slice(0, -1).join("›") };
  });
}

export function buildExample(a: { id: PlanId; dev: DeviceId; ses: SessionId; now: number; today: IsoDate; calendar: Calendar }): {
  action: Action;
  newNotes: readonly ItemId[];
  notes: ReadonlyMap<ItemId, string>;
} {
  const base = workCalendar(a.calendar);
  const t0 = base.snapF(toDay(a.today));
  const closure: Closure = { id: newId(), from: toIso(base.addWork(t0, 6)), to: toIso(base.addWork(t0, 7)), name: CLOSURE_NAME };
  const calendar: Calendar = { ...a.calendar, closures: new Map([...a.calendar.closures, [closure.id, closure]]) };
  const cal = workCalendar(calendar);
  const t = cal.snapF(toDay(a.today));
  const stretched = ROWS.find((r) => r.name === STRETCHED);
  if (stretched === undefined) throw new Error(`Example: no row ${STRETCHED}`);
  const anchor = anchorFor(cal, t, stretched.dur);
  const dated = datesFrom(cal, anchor, stretched.dur);
  const agreed = datesFrom(cal, anchor, AGREED_DUR);

  const groups = groupNodes();
  const ids = new Map([...groups.map((g) => g.key), ...ROWS.map((r) => r.name)].map((k): [string, ItemId] => [k, newId()]));
  const idOf = (k: string): ItemId => {
    const id = ids.get(k);
    if (id === undefined) throw new Error(`Example: no id for ${k}`);
    return id;
  };
  const nodes: Node[] = [...groups, ...ROWS.map((r) => ({ key: r.name, name: r.name, parent: r.group.join("›") }))];
  const parents = [...new Set(nodes.map((n) => n.parent))];
  const orders = new Map(
    parents.flatMap((p) => {
      const kids = nodes.filter((n) => n.parent === p);
      const keys = generateNKeysBetween(null, null, kids.length);
      return kids.map((k, i): [string, string] => [k.key, keys[i]]);
    }),
  );
  const orderOf = (k: string): string => {
    const o = orders.get(k);
    if (o === undefined) throw new Error(`Example: no order for ${k}`);
    return o;
  };
  const placeOf = (n: Node): Item["place"] => ({ parent: n.parent === null ? null : idOf(n.parent), order: orderOf(n.key) });

  const items = new Map<ItemId, Item>([
    ...groups.map((g): [ItemId, Item] => [idOf(g.key), { id: idOf(g.key), kind: "group", name: g.name, trashed: false, schedule: null, place: placeOf(g), refs: {} }]),
    ...ROWS.map((r): [ItemId, Item] => {
      const id = idOf(r.name);
      const s = dateOf(dated, r.name);
      return [
        id,
        {
          id,
          kind: r.kind,
          name: r.name,
          trashed: false,
          schedule: { start: toIso(s.start), dur: s.dur, status: r.status, progress: r.progress, horizon: "later" },
          place: placeOf({ key: r.name, name: r.name, parent: r.group.join("›") }),
          refs: {},
        },
      ];
    }),
  ]);
  const links = new Map(
    ROWS.flatMap((r) =>
      r.from.map((f): [LinkKey, Link] => {
        const from = idOf(f);
        const to = idOf(r.name);
        return [linkKey(from, to), { from, to, type: "FS", lag: 0 }];
      }),
    ),
  );
  const baseline: Baseline = {
    id: newId(),
    name: BASELINE_NAME,
    at: toIso(anchor),
    dates: Object.fromEntries(
      ROWS.map((r) => {
        const s = dateOf(agreed, r.name);
        return [idOf(r.name), { start: toIso(s.start), dur: s.dur }];
      }),
    ),
  };
  const plan: PlanState = { id: a.id, name: EXAMPLE_NAME, items, links, calendar, baselines: new Map([[baseline.id, baseline]]), workflow: EMPTY_WORKFLOW, people: EMPTY_PEOPLE, defaults: null };
  const action: Action = { id: newId(), dev: a.dev, ses: a.ses, at: a.now, par: [], lbl: EXAMPLE_LABEL, w: stateWrites(plan, "own", () => false) };
  const notes = new Map(ROWS.flatMap((r): [ItemId, string][] => (r.note === undefined ? [] : [[idOf(r.name), r.note]])));
  return { action, newNotes: [...items.keys()], notes };
}
