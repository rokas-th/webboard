import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { fmtShort, isCalendarDate, toIso, type Day } from "../../domain/dates";
import type { Item, ItemId, PlanState, Schedule, Status } from "../../domain/model";
import { childrenOf } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { toast } from "../common/Toast";
import { planGroupPath } from "../list/groups";
import { READ_ONLY, useRun, type Run } from "../run";
import { derivedStatus } from "../status";
import { LinksEditor } from "./LinksEditor";
import { bindTextarea, type NoteBinding } from "./noteBinding";
import { TextField } from "./TextField";

export const TOP_LEVEL = "Top level";

const STATUSES: readonly { v: Status; label: string }[] = [
  { v: "todo", label: "Not started" },
  { v: "doing", label: "In progress" },
  { v: "done", label: "Done" },
];

const KIND: Readonly<Record<Item["kind"], string>> = { task: "TASK", milestone: "MILESTONE", group: "GROUP" };

const statusOf = (v: string): Status => {
  const found = STATUSES.find((s) => s.v === v);
  if (found === undefined) throw new Error(`ItemPanel: no status ${v}`);
  return found.v;
};

const statusLabel = (s: Status): string => {
  const found = STATUSES.find((x) => x.v === s);
  if (found === undefined) throw new Error(`ItemPanel: no status ${s}`);
  return found.label;
};

export function groupOptions(plan: PlanState, item: ItemId): { id: ItemId | null; label: string }[] {
  const walk = (parent: ItemId | null): { id: ItemId | null; label: string }[] =>
    childrenOf(plan, parent)
      .filter((g) => g.kind === "group" && !g.trashed && g.id !== item)
      .flatMap((g) => [{ id: g.id, label: planGroupPath(plan, g.id) }, ...walk(g.id)]);
  return [{ id: null, label: TOP_LEVEL }, ...walk(null)];
}

const dayText = (m: ReadonlyMap<ItemId, Day>, it: Item, what: string): string => {
  const d = m.get(it.id);
  if (d === undefined) throw new Error(`ItemPanel: scheduled item ${it.id} has no derived ${what}`);
  return fmtShort(toIso(d));
};

const scheduleOf = (it: Item): Schedule => {
  if (it.schedule === null) throw new Error(`ItemPanel: item ${it.id} has no schedule`);
  return it.schedule;
};

function ProgressField(p: { value: number; readOnly: boolean; onCommit(v: number): boolean }) {
  const [draft, setDraft] = useState(p.value);
  useEffect(() => setDraft(p.value), [p.value]);
  if (p.readOnly) return <span className="val">{p.value} %</span>;
  const commit = (): void => {
    if (draft === p.value) return;
    if (!p.onCommit(draft)) setDraft(p.value);
  };
  return (
    <span className="inline">
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        aria-label="Progress"
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className="val">{draft} %</span>
    </span>
  );
}

function GroupFields(p: { view: PlanView; item: Item }) {
  const plan = p.view.plan;
  const start = p.view.derived.start.get(p.item.id);
  const end = p.view.derived.end.get(p.item.id);
  const kids = childrenOf(plan, p.item.id).filter((c) => !c.trashed).length;
  const progress = p.view.derived.progress.get(p.item.id);
  return (
    <>
      <div className="fields">
        <label>Span</label>
        <span className="val">{start === undefined || end === undefined ? "—" : `${fmtShort(toIso(start))} – ${fmtShort(toIso(end))}`}</span>
        <label>Items</label>
        <span className="val">{kids}</span>
      </div>
      {progress !== undefined && <p className="val-line">{`Progress ${progress} %`}</p>}
      <p className="note">A group's dates come from the items in it.</p>
    </>
  );
}

function ScheduleFields(p: { view: PlanView; item: Item; readOnly: boolean; run: Run }) {
  const it = p.item;
  const sc = scheduleOf(it);
  const statusId = useId();
  const dated = sc.start !== null && !it.trashed;
  const milestone = it.kind === "milestone";
  const shownStatus = (): Status => {
    if (it.trashed) return sc.status;
    return derivedStatus(p.view, it.id, "ItemPanel");
  };
  const schedule = (set: Partial<Schedule>): boolean => p.run.run({ t: "schedule", item: it.id, set }) !== null;
  return (
    <div className="fields">
      <label>{milestone ? "Date" : "Start"}</label>
      <TextField
        type="date"
        className="date-input"
        label={milestone ? "Date" : "Start"}
        value={sc.start ?? ""}
        readOnly={p.readOnly}
        onCommit={(next) => isCalendarDate(next) && schedule({ start: next })}
      />
      {!milestone && (
        <>
          <label>Duration</label>
          <span className="inline">
            {!p.readOnly && (
              <button
                type="button"
                className="step"
                aria-label="Shorter by one working day"
                disabled={sc.dur <= 1}
                onClick={() => p.run.run({ t: "resize", item: it.id, dur: sc.dur - 1 })}
              >
                −
              </button>
            )}
            <span className="val">
              {sc.dur} {sc.dur === 1 ? "working day" : "working days"}
            </span>
            {!p.readOnly && (
              <button type="button" className="step" aria-label="Longer by one working day" onClick={() => p.run.run({ t: "resize", item: it.id, dur: sc.dur + 1 })}>
                +
              </button>
            )}
          </span>
          <label>End</label>
          <span className="val">{dated ? dayText(p.view.derived.end, it, "end") : "—"}</span>
        </>
      )}
      <label htmlFor={statusId}>Status</label>
      {milestone ? (
        <span className="val">
          {shownStatus() === "done" ? "reached" : "open"} <span className="dimc">· from its predecessors</span>
        </span>
      ) : p.readOnly ? (
        <span className="val">{statusLabel(sc.status)}</span>
      ) : (
        <select
          id={statusId}
          value={sc.status}
          onChange={(e) => {
            const next = statusOf(e.target.value);
            if (next !== sc.status) schedule({ status: next });
          }}
        >
          {STATUSES.map((s) => (
            <option key={s.v} value={s.v}>
              {s.label}
            </option>
          ))}
        </select>
      )}
      {!milestone && (
        <>
          <label>Progress</label>
          <ProgressField value={sc.progress} readOnly={p.readOnly} onCommit={(v) => schedule({ progress: v })} />
        </>
      )}
    </div>
  );
}

function PlaceFields(p: { plan: PlanState; item: Item; readOnly: boolean; run: Run }) {
  const { plan, item: it } = p;
  const groupId = useId();
  const options = groupOptions(plan, it.id);
  const current = options.find((o) => o.id === it.place.parent);
  const currentLabel = it.place.parent === null ? TOP_LEVEL : planGroupPath(plan, it.place.parent);
  const siblings = childrenOf(plan, it.place.parent).filter((s) => !s.trashed || s.id === it.id);
  const at = siblings.findIndex((s) => s.id === it.id);
  if (at < 0) throw new Error(`ItemPanel: item ${it.id} is not among its parent's children`);
  const place = (parent: ItemId | null, after: ItemId | null): void => {
    p.run.run({ t: "place", item: it.id, parent, after });
  };
  const regroup = (value: string): void => {
    const parent = value === "" ? null : value;
    if (parent === it.place.parent) return;
    const rest = childrenOf(plan, parent).filter((c) => c.id !== it.id && !c.trashed);
    place(parent, rest.length === 0 ? null : rest[rest.length - 1].id);
  };
  return (
    <>
      <div className="fields">
        <label htmlFor={groupId}>Group</label>
        {p.readOnly || current === undefined ? (
          <span className="val">{currentLabel}</span>
        ) : (
          <select id={groupId} value={it.place.parent ?? ""} onChange={(e) => regroup(e.target.value)}>
            {options.map((o) => (
              <option key={o.id ?? ""} value={o.id ?? ""}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {!p.readOnly && (
        <div className="actions">
          <button type="button" className="button-small" disabled={at === 0} onClick={() => place(it.place.parent, at >= 2 ? siblings[at - 2].id : null)}>
            Move up
          </button>
          <button type="button" className="button-small" disabled={at === siblings.length - 1} onClick={() => place(it.place.parent, siblings[at + 1].id)}>
            Move down
          </button>
          {it.schedule !== null && it.schedule.start !== null && (
            <button type="button" className="button-small" onClick={() => p.run.run({ t: "schedule", item: it.id, set: { start: null } })}>
              Unschedule
            </button>
          )}
        </div>
      )}
    </>
  );
}

function Note(p: { session: PlanSession; item: ItemId; readOnly: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const binding = useRef<NoteBinding | null>(null);
  const readOnly = useRef(p.readOnly);
  readOnly.current = p.readOnly;
  useEffect(() => {
    const el = ref.current;
    if (el === null) throw new Error("Note rendered without its textarea");
    const b = bindTextarea(el, p.session.note(p.item));
    binding.current = b;
    return () => {
      binding.current = null;
      b.dispose();
    };
  }, [p.session, p.item]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    e.preventDefault();
    e.stopPropagation();
    if (readOnly.current) {
      if (p.session.readOnly) toast(READ_ONLY, "bad");
      return;
    }
    const b = binding.current;
    if (b === null) throw new Error("Note keys arrived before its binding");
    if (e.shiftKey) b.redo();
    else b.undo();
  };
  return <textarea ref={ref} aria-label="Notes" placeholder="Anything worth knowing about this item" readOnly={p.readOnly} onKeyDown={onKeyDown} />;
}

export function ItemPanel(p: { session: PlanSession; item: ItemId; readOnly?: boolean }) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  const it = view.plan.items.get(p.item);
  if (it === undefined) throw new Error(`ItemPanel: no item ${p.item}`);
  const readOnly = p.readOnly === true || it.trashed;
  return (
    <div className="panel">
      <span className="kind">{KIND[it.kind]}</span>
      <TextField
        className="title-input"
        label="Name"
        value={it.name}
        readOnly={readOnly}
        onCommit={(next) => run.run({ t: "rename", item: it.id, name: next }) !== null}
      />
      {it.kind === "group" ? <GroupFields view={view} item={it} /> : <ScheduleFields view={view} item={it} readOnly={readOnly} run={run} />}
      <PlaceFields plan={view.plan} item={it} readOnly={readOnly} run={run} />
      {it.kind !== "group" && <LinksEditor view={view} item={it} readOnly={readOnly} run={run} />}
      <h2>Notes</h2>
      <Note session={p.session} item={it.id} readOnly={readOnly} />
      {!readOnly && (
        <div className="actions">
          <button type="button" className="button-small button-danger" onClick={() => run.run({ t: "trash", items: [it.id] })}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
