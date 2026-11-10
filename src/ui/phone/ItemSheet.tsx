import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Item, ItemId, Link, LinkType, Status } from "../../domain/model";
import { linkKey } from "../../domain/model";
import { wouldLoop } from "../../domain/schedule";
import { childrenOf, liveLinks } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { FixActions } from "../choices/FixActions";
import { Sheet } from "../common/Sheet";
import { lagText } from "../panel/LinksEditor";
import { bindTextarea } from "../panel/noteBinding";
import { useRun, type Run } from "../run";
import { derivedStatus } from "../status";
import { dayLabel } from "../timeline/dayText";

const STATUSES: readonly { v: Status; label: string }[] = [
  { v: "todo", label: "Not started" },
  { v: "doing", label: "In progress" },
  { v: "done", label: "Done" },
];

const TYPES: readonly LinkType[] = ["FS", "SS", "FF", "SF"];

const typeOf = (v: string): LinkType => {
  const found = TYPES.find((t) => t === v);
  if (found === undefined) throw new Error(`ItemSheet: no link type ${v}`);
  return found;
};

const statusText = (s: Status): string => {
  const found = STATUSES.find((x) => x.v === s);
  if (found === undefined) throw new Error(`ItemSheet: no status ${s}`);
  return found.label;
};

const nameOf = (view: PlanView, id: ItemId): string => {
  const it = view.plan.items.get(id);
  if (it === undefined) throw new Error(`ItemSheet: no item ${id}`);
  return it.name;
};

function useReadOnly(session: PlanSession): boolean {
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  return useSyncExternalStore(subscribe, () => session.readOnly);
}

function Stepper(p: { label: string; value: string; valueClass: string; readOnly: boolean; less: (() => void) | null; more: () => void }) {
  return (
    <span className="inline">
      {!p.readOnly && (
        <button type="button" className="step" aria-label={`${p.label} −1${p.label === "Start" ? " working day" : ""}`} disabled={p.less === null} onClick={p.less ?? undefined}>
          −
        </button>
      )}
      <span className={p.valueClass}>{p.value}</span>
      {!p.readOnly && (
        <button type="button" className="step" aria-label={`${p.label} +1${p.label === "Start" ? " working day" : ""}`} onClick={p.more}>
          +
        </button>
      )}
    </span>
  );
}

function ScheduleFields(p: { view: PlanView; item: Item; readOnly: boolean; run: Run }) {
  const it = p.item;
  const sc = it.schedule;
  if (sc === null) throw new Error(`ItemSheet: item ${it.id} has no schedule`);
  const start = p.view.derived.start.get(it.id);
  const milestone = it.kind === "milestone";
  const hasPreds = liveLinks(p.view.plan).some((l) => l.to === it.id);
  const dated = sc.start !== null && start !== undefined;
  const setStatus = (next: Status): void => {
    if (next !== sc.status) p.run.run({ t: "schedule", item: it.id, set: { status: next } });
  };
  return (
    <div className="fields">
      <label>{milestone ? "Date" : "Start"}</label>
      {dated ? (
        <Stepper
          label="Start"
          value={dayLabel(start)}
          valueClass="val isheet-start"
          readOnly={p.readOnly}
          less={() => p.run.run({ t: "move", items: [it.id], days: -1 })}
          more={() => p.run.run({ t: "move", items: [it.id], days: 1 })}
        />
      ) : (
        <span className="inline">
          <span className="val">—</span>
          {!p.readOnly && (
            <button type="button" className="button-small" onClick={() => p.run.run({ t: "schedule", item: it.id, set: { start: p.view.today } })}>
              Schedule
            </button>
          )}
        </span>
      )}
      {!milestone && (
        <>
          <label>Duration</label>
          <Stepper
            label="Duration"
            value={`${sc.dur} ${sc.dur === 1 ? "working day" : "working days"}`}
            valueClass="val"
            readOnly={p.readOnly}
            less={sc.dur <= 1 ? null : () => p.run.run({ t: "resize", item: it.id, dur: sc.dur - 1 })}
            more={() => p.run.run({ t: "resize", item: it.id, dur: sc.dur + 1 })}
          />
        </>
      )}
      <label>Status</label>
      {milestone && hasPreds ? (
        <span className="val">
          {derivedStatus(p.view, it.id, "ItemSheet") === "done" ? "reached" : "open"} <span className="dimc">· from its predecessors</span>
        </span>
      ) : p.readOnly ? (
        <span className="val">{statusText(sc.status)}</span>
      ) : (
        <div className="seg isheet-status" role="group" aria-label="Status">
          {STATUSES.map((s) => (
            <button key={s.v} type="button" aria-pressed={sc.status === s.v} className={sc.status === s.v ? "active" : undefined} onClick={() => setStatus(s.v)}>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkRow(p: { view: PlanView; link: Link; other: ItemId; readOnly: boolean; run: Run }) {
  const l = p.link;
  const set = (type: LinkType, lag: number): void => {
    p.run.run({ t: "link", from: l.from, to: l.to, type, lag });
  };
  return (
    <div className="ilink" data-link={linkKey(l.from, l.to)}>
      <span className="dep-name">{nameOf(p.view, p.other)}</span>
      {p.readOnly ? (
        <span className="val">{l.type}</span>
      ) : (
        <select
          aria-label="Link type"
          value={l.type}
          onChange={(e) => {
            const next = typeOf(e.target.value);
            if (next !== l.type) set(next, l.lag);
          }}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
      <span className="inline">
        {!p.readOnly && (
          <button type="button" className="step" aria-label="Lag −1" onClick={() => set(l.type, l.lag - 1)}>
            −
          </button>
        )}
        <span className="val">{lagText(l.lag)}</span>
        {!p.readOnly && (
          <button type="button" className="step" aria-label="Lag +1" onClick={() => set(l.type, l.lag + 1)}>
            +
          </button>
        )}
      </span>
      {!p.readOnly && (
        <button type="button" className="button-small" onClick={() => p.run.run({ t: "unlink", link: linkKey(l.from, l.to) })}>
          Remove
        </button>
      )}
    </div>
  );
}

function AddDependency(p: { view: PlanView; item: Item; run: Run }) {
  const plan = p.view.plan;
  const id = p.item.id;
  const live = liveLinks(plan);
  const linked = new Set(live.filter((l) => l.to === id).map((l) => l.from));
  const tree = (parent: ItemId | null): Item[] => childrenOf(plan, parent).flatMap((i) => [i, ...tree(i.id)]);
  const candidates = tree(null).filter(
    (o) => o.id !== id && o.kind !== "group" && !o.trashed && !linked.has(o.id) && wouldLoop(live, { from: o.id, to: id, type: "FS", lag: 0 }) === null,
  );
  const [from, setFrom] = useState<ItemId | null>(null);
  const [type, setType] = useState<LinkType>("FS");
  const [lag, setLag] = useState(0);
  if (candidates.length === 0) return null;
  const picked = candidates.find((c) => c.id === from) ?? candidates[0];
  return (
    <div className="isheet-add">
      <select aria-label="Predecessor" value={picked.id} onChange={(e) => setFrom(e.target.value)}>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <select aria-label="Type" value={type} onChange={(e) => setType(typeOf(e.target.value))}>
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <input type="number" aria-label="Lag" step={1} value={lag} onChange={(e) => setLag(Math.trunc(Number(e.target.value)))} />
      <button
        type="button"
        className="button-small"
        onClick={() => {
          if (p.run.run({ t: "link", from: picked.id, to: id, type, lag }) === null) return;
          setFrom(null);
          setType("FS");
          setLag(0);
        }}
      >
        Add a dependency
      </button>
    </div>
  );
}

function Links(p: { view: PlanView; item: Item; readOnly: boolean; run: Run }) {
  const live = liveLinks(p.view.plan);
  const id = p.item.id;
  const preds = live.filter((l) => l.to === id);
  const succs = live.filter((l) => l.from === id);
  return (
    <>
      <h2>Depends on</h2>
      {preds.length === 0 && <p className="note">Nothing.</p>}
      {preds.map((l) => (
        <LinkRow key={linkKey(l.from, l.to)} view={p.view} link={l} other={l.from} readOnly={p.readOnly} run={p.run} />
      ))}
      {!p.readOnly && !p.item.trashed && <AddDependency view={p.view} item={p.item} run={p.run} />}
      {succs.length > 0 && (
        <>
          <h2>Needed by</h2>
          {succs.map((l) => (
            <LinkRow key={linkKey(l.from, l.to)} view={p.view} link={l} other={l.to} readOnly={p.readOnly} run={p.run} />
          ))}
        </>
      )}
    </>
  );
}

function Note(p: { session: PlanSession; item: ItemId; readOnly: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) throw new Error("ItemSheet: the note rendered without its textarea");
    const b = bindTextarea(el, p.session.note(p.item));
    return () => b.dispose();
  }, [p.session, p.item]);
  return <textarea ref={ref} aria-label="Notes" placeholder="Anything worth knowing about this item" readOnly={p.readOnly} />;
}

export function ItemSheet(p: { session: PlanSession; item: ItemId; onClose: () => void }) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  const sessionReadOnly = useReadOnly(p.session);
  const it = view.plan.items.get(p.item);
  if (it === undefined) throw new Error(`ItemSheet: no item ${p.item}`);
  const readOnly = sessionReadOnly || it.trashed;
  const progress = view.derived.progress.get(it.id);
  return (
    <Sheet open title={it.name} onClose={p.onClose}>
      <div className="panel isheet">
        {it.kind === "group" ? (
          progress !== undefined && <p className="val-line">{`Progress ${progress} %`}</p>
        ) : (
          <>
            <ScheduleFields view={view} item={it} readOnly={readOnly} run={run} />
            <FixActions view={view} item={it.id} readOnly={readOnly} run={run} />
            <Links view={view} item={it} readOnly={readOnly} run={run} />
          </>
        )}
        <h2>Notes</h2>
        <Note session={p.session} item={it.id} readOnly={readOnly} />
      </div>
    </Sheet>
  );
}
