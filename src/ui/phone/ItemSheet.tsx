import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { normalizeName } from "../../actions/build";
import { Refused } from "../../actions/intents";
import { toDay, type Day } from "../../domain/dates";
import type { Horizon, Item, ItemId, Link, LinkType, Status } from "../../domain/model";
import { linkKey, MAX_LAG, MAX_TASK_DUR } from "../../domain/model";
import { DUR_NOT_WHOLE, LAG_NOT_WHOLE } from "../copy";
import { durText } from "../panel/ItemPanel";
import { EndField, WholeField } from "../panel/typed";
import { wouldLoop } from "../../domain/schedule";
import { childrenOf, liveLinks } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { ChoiceBanner } from "../choices/ChoiceBanner";
import { itemChoices } from "../choices/describe";
import { FixActions } from "../choices/FixActions";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { PlaceFields } from "../panel/ItemPanel";
import { lagText } from "../panel/LinksEditor";
import { bindTextarea } from "../panel/noteBinding";
import { TextField } from "../panel/TextField";
import { OpenChoice, useRun, type Run } from "../run";
import { derivedStatus } from "../status";
import { dayLabelNear } from "../timeline/dayText";
import { useReadOnly } from "./readOnly";

const STATUSES: readonly { v: Status; label: string }[] = [
  { v: "todo", label: "Not started" },
  { v: "doing", label: "In progress" },
  { v: "done", label: "Done" },
];

const TYPES: readonly LinkType[] = ["FS", "SS", "FF", "SF"];

const HORIZONS: readonly { v: Horizon; label: string }[] = [
  { v: "now", label: "Now" },
  { v: "next", label: "Next" },
  { v: "later", label: "Later" },
];

const horizonOf = (v: string): Horizon => {
  const found = HORIZONS.find((h) => h.v === v);
  if (found === undefined) throw new Error(`ItemSheet: no horizon ${v}`);
  return found.v;
};

const horizonText = (h: Horizon): string => {
  const found = HORIZONS.find((x) => x.v === h);
  if (found === undefined) throw new Error(`ItemSheet: no horizon ${h}`);
  return found.label;
};

const WHOLE = /^-?\d+$/;

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

const endOf = (view: PlanView, id: ItemId): Day => {
  const d = view.derived.end.get(id);
  if (d === undefined) throw new Error(`ItemSheet: scheduled item ${id} has no derived end`);
  return d;
};

function Stepper(p: { label: string; value: string; valueClass: string; readOnly: boolean; less: (() => void) | null; more: (() => void) | null; children?: ReactNode }) {
  return (
    <span className="inline">
      {!p.readOnly && (
        <button type="button" className="step" aria-label={`${p.label} −1${p.label === "Start" ? " working day" : ""}`} disabled={p.less === null} onClick={p.less ?? undefined}>
          −
        </button>
      )}
      {!p.readOnly && p.children}
      <span className={p.valueClass}>{p.value}</span>
      {!p.readOnly && (
        <button type="button" className="step" aria-label={`${p.label} +1${p.label === "Start" ? " working day" : ""}`} disabled={p.more === null} onClick={p.more ?? undefined}>
          +
        </button>
      )}
    </span>
  );
}

function HorizonField(p: { item: Item; horizon: Horizon; readOnly: boolean; run: Run }) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>Horizon</label>
      {p.readOnly ? (
        <span className="val">{horizonText(p.horizon)}</span>
      ) : (
        <select
          id={id}
          value={p.horizon}
          onChange={(e) => {
            const next = horizonOf(e.target.value);
            if (next !== p.horizon) p.run.run({ t: "schedule", item: p.item.id, set: { horizon: next } });
          }}
        >
          {HORIZONS.map((h) => (
            <option key={h.v} value={h.v}>
              {h.label}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

function ScheduleFields(p: { view: PlanView; item: Item; readOnly: boolean; run: Run }) {
  const it = p.item;
  const sc = it.schedule;
  if (sc === null) throw new Error(`ItemSheet: item ${it.id} has no schedule`);
  const start = p.view.derived.start.get(it.id);
  const milestone = it.kind === "milestone";
  const hasPreds = liveLinks(p.view.plan).some((l) => l.to === it.id);
  if (sc.start !== null && !it.trashed && start === undefined) throw new Error(`ItemSheet: scheduled item ${it.id} has no derived start`);
  const setStatus = (next: Status): void => {
    if (next !== sc.status) p.run.run({ t: "schedule", item: it.id, set: { status: next } });
  };
  return (
    <div className="fields">
      <label>{milestone ? "Date" : "Start"}</label>
      {sc.start !== null ? (
        <Stepper
          label="Start"
          value={dayLabelNear(start ?? toDay(sc.start), p.view.today)}
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
      {sc.start === null && <HorizonField item={it} horizon={sc.horizon} readOnly={p.readOnly} run={p.run} />}
      {!milestone && (
        <>
          <label>Duration</label>
          <Stepper
            label="Duration"
            value={p.readOnly ? durText(sc.dur) : sc.dur === 1 ? "working day" : "working days"}
            valueClass="val"
            readOnly={p.readOnly}
            less={sc.dur <= 1 ? null : () => p.run.run({ t: "resize", item: it.id, dur: sc.dur - 1 })}
            more={sc.dur >= MAX_TASK_DUR ? null : () => p.run.run({ t: "resize", item: it.id, dur: sc.dur + 1 })}
          >
            <WholeField
              label="Duration"
              value={sc.dur}
              min={1}
              max={MAX_TASK_DUR}
              inputMode="numeric"
              notWhole={DUR_NOT_WHOLE}
              onCommit={(dur) => p.run.run({ t: "resize", item: it.id, dur }) !== null}
            />
          </Stepper>
          {sc.start !== null && !it.trashed && (
            <>
              <label>End</label>
              {p.readOnly ? (
                <span className="val">{dayLabelNear(endOf(p.view, it.id), p.view.today)}</span>
              ) : (
                <EndField view={p.view} item={it} label="End" run={p.run} />
              )}
            </>
          )}
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
        {p.readOnly ? (
          <span className="val">{lagText(l.lag)}</span>
        ) : (
          <WholeField label="Link lag" value={l.lag} min={-MAX_LAG} max={MAX_LAG} notWhole={LAG_NOT_WHOLE} onCommit={(lag) => p.run.run({ t: "link", from: l.from, to: l.to, type: l.type, lag }) !== null} />
        )}
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
  const [from, setFrom] = useState<{ id: ItemId; name: string } | null>(null);
  const [lost, setLost] = useState<string | null>(null);
  const [type, setType] = useState<LinkType>("FS");
  const [lag, setLag] = useState("0");
  if (from !== null && !candidates.some((c) => c.id === from.id)) {
    setFrom(null);
    setLost(from.name);
  }
  if (candidates.length === 0 && lost === null) return null;
  const pick = (value: string): void => {
    const found = candidates.find((c) => c.id === value);
    if (found === undefined) throw new Error(`ItemSheet: ${value} is not a predecessor candidate`);
    setFrom({ id: found.id, name: found.name });
    setLost(null);
  };
  const add = (chosen: ItemId): void => {
    if (!WHOLE.test(lag.trim())) {
      toast(LAG_NOT_WHOLE, "bad");
      return;
    }
    if (p.run.run({ t: "link", from: chosen, to: id, type, lag: Number(lag.trim()) }) === null) return;
    setFrom(null);
    setType("FS");
    setLag("0");
  };
  return (
    <div className="isheet-add">
      {lost !== null && <p className="dim">{`“${lost}” can no longer be added.`}</p>}
      <select aria-label="Predecessor" value={from === null ? "" : from.id} onChange={(e) => pick(e.target.value)}>
        <option value="" disabled>
          Choose a predecessor
        </option>
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
      <input type="number" aria-label="Lag" step={1} value={lag} onChange={(e) => setLag(e.target.value)} />
      <button type="button" className="button-small" disabled={from === null} onClick={from === null ? undefined : () => add(from.id)}>
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
    const session = p.session;
    const b = bindTextarea(el, session.note(p.item), () => session.readOnlyReason);
    return () => b.dispose();
  }, [p.session, p.item]);
  return <textarea ref={ref} aria-label="Notes" placeholder="Anything worth knowing about this item" readOnly={p.readOnly} />;
}

export function ItemSheet(p: { session: PlanSession; item: ItemId; local: string; naming?: boolean; onNamed?: () => void; onClose: () => void }) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  const open = useContext(OpenChoice);
  if (open === null) throw new Error("ItemSheet needs an OpenChoice provider");
  const sessionReadOnly = useReadOnly(p.session);
  const root = useRef<HTMLDivElement>(null);
  const { naming, onNamed } = p;
  useEffect(() => {
    if (naming !== true) return;
    const input = root.current?.querySelector(".title-input");
    if (!(input instanceof HTMLInputElement)) throw new Error(`ItemSheet: no name field to focus for ${p.item}`);
    input.focus();
    input.select();
    onNamed?.();
  }, [naming, onNamed, p.item]);
  const it = view.plan.items.get(p.item);
  if (it === undefined) throw new Error(`ItemSheet: no item ${p.item}`);
  const readOnly = sessionReadOnly || it.trashed;
  const progress = view.derived.progress.get(it.id);
  const rename = (next: string): boolean => {
    let name: string;
    try {
      name = normalizeName(next);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      toast(e.message, "bad");
      return false;
    }
    if (name === it.name) return false;
    return run.run({ t: "rename", item: it.id, name }) !== null;
  };
  const trash = (): void => {
    if (run.run({ t: "trash", items: [it.id] }) !== null) p.onClose();
  };
  return (
    <Sheet open title={it.name} onClose={p.onClose}>
      <div className="panel isheet" ref={root}>
        {itemChoices(view, it.id).map((c) => (
          <ChoiceBanner key={c.id} choice={c} local={p.local} onChoose={() => open(c.id)} />
        ))}
        <TextField className="title-input" label="Name" value={it.name} readOnly={readOnly} onCommit={rename} />
        {it.kind === "group" ? (
          progress !== undefined && <p className="val-line">{`Progress ${progress} %`}</p>
        ) : (
          <>
            <ScheduleFields view={view} item={it} readOnly={readOnly} run={run} />
            <FixActions view={view} item={it.id} readOnly={readOnly} run={run} />
          </>
        )}
        <PlaceFields plan={view.plan} item={it} readOnly={readOnly} run={run} />
        {it.kind !== "group" && <Links view={view} item={it} readOnly={readOnly} run={run} />}
        <h2>Notes</h2>
        <Note session={p.session} item={it.id} readOnly={readOnly} />
        {!readOnly && (
          <div className="actions">
            <button type="button" className="button-small button-danger" onClick={trash}>
              Move to Trash
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
