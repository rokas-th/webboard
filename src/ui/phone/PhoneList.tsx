import { useId, useState } from "react";
import { fmtShort, toIso } from "../../domain/dates";
import type { Horizon, Item, ItemId } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { ghostIds } from "../ghosts";
import { listGroups, statusLabel, type StatusLabel } from "../list/groups";

export const PHONE_EMPTY_PLAN = "No items yet. Add one with +.";

type Bucket = Horizon | "all";

const BUCKETS: readonly (readonly [Bucket, string])[] = [
  ["all", "All"],
  ["now", "Now"],
  ["next", "Next"],
  ["later", "Later"],
];

const HORIZONS: readonly Horizon[] = ["now", "next", "later"];

const STATUS_CLASS: Readonly<Record<StatusLabel, string>> = {
  conflict: "st conflict",
  held: "st held",
  late: "st late",
  "in progress": "st doing",
  done: "st dim",
  "not started": "st",
};

const titleOf = (b: Bucket): string => {
  const found = BUCKETS.find(([k]) => k === b);
  if (found === undefined) throw new Error(`PhoneList: no bucket ${b}`);
  return found[1];
};

const itemOf = (view: PlanView, id: ItemId): Item => {
  const it = view.plan.items.get(id);
  if (it === undefined) throw new Error(`PhoneList: no item ${id}`);
  return it;
};

function horizonOf(view: PlanView, ghosts: ReadonlySet<ItemId>, id: ItemId): Horizon | null {
  if (ghosts.has(id)) return null;
  const derived = view.derived.horizon.get(id);
  if (derived !== undefined) return derived;
  const s = itemOf(view, id).schedule;
  if (s === null || s.start !== null || s.status === "done") return null;
  return s.horizon;
}

const countText = (n: number, bucket: Bucket): string => `${n} ${n === 1 ? "item" : "items"} in ${titleOf(bucket)}.`;

export function PhoneList(p: { session: PlanSession; onOpen: (item: ItemId) => void }) {
  const view = usePlanView(p.session);
  const [bucket, setBucket] = useState<Bucket>("now");
  const base = useId();
  const ghosts = ghostIds(view);
  const all = listGroups(view);
  const inBucket = (b: Bucket, id: ItemId): boolean => b === "all" || horizonOf(view, ghosts, id) === b;
  const countOf = (b: Bucket): number => all.reduce((n, s) => n + s.items.filter((id) => inBucket(b, id)).length, 0);
  const total = countOf("all");
  const sections = all
    .map((s) => ({ ...s, items: s.items.filter((id) => inBucket(bucket, id)) }))
    .filter((s) => s.items.length > 0 || (bucket === "all" && s.group !== null));
  const dayoff = new Set(view.derived.conflicts.flatMap((c) => (c.kind === "dayoff" ? [c.item] : [])));

  const emptyLine = (): string | null => {
    if (total === 0) return bucket === "all" && sections.length > 0 ? null : PHONE_EMPTY_PLAN;
    if (bucket === "all" || sections.length > 0) return null;
    const at = HORIZONS.indexOf(bucket);
    const order: Bucket[] = [...HORIZONS.slice(at + 1), ...HORIZONS.slice(0, at), "all"];
    const next = order.find((b) => countOf(b) > 0);
    if (next === undefined) throw new Error("PhoneList: the plan has items but no bucket holds them");
    return `Nothing in ${titleOf(bucket)}. ${countText(countOf(next), next)}`;
  };

  const startOf = (it: Item, ghost: boolean): string | null => {
    if (ghost || it.schedule === null || it.schedule.start === null) return null;
    const d = view.derived.start.get(it.id);
    if (d === undefined) throw new Error(`PhoneList: scheduled item ${it.id} has no start`);
    return fmtShort(toIso(d));
  };

  const row = (id: ItemId) => {
    const it = itemOf(view, id);
    const ghost = ghosts.has(id);
    const start = startOf(it, ghost);
    const label = statusLabel(view, id);
    const classes = ["prow", ghost ? "ghost-row" : "", dayoff.has(id) ? "dayoff" : ""].filter((c) => c !== "").join(" ");
    return (
      <li key={id}>
        <button type="button" className={classes} onClick={() => p.onOpen(id)}>
          <span className="prow-name">{it.name}</span>
          {start !== null && <span className="prow-start">{start}</span>}
          <span className={STATUS_CLASS[label]}>{label}</span>
        </button>
      </li>
    );
  };

  const line = emptyLine();
  const tabId = (b: Bucket): string => `${base}-tab-${b}`;
  const panelId = `${base}-panel`;
  return (
    <div className="phone-list">
      <div className="seg phone-buckets" role="tablist" aria-label="Horizon">
        {BUCKETS.map(([b, title]) => (
          <button
            key={b}
            id={tabId(b)}
            type="button"
            role="tab"
            aria-selected={bucket === b}
            aria-controls={panelId}
            className={bucket === b ? "active" : undefined}
            onClick={() => setBucket(b)}
          >
            {title}
          </button>
        ))}
      </div>
      <div id={panelId} className="phone-bucket" role="tabpanel" aria-labelledby={tabId(bucket)}>
        {line !== null && <p className="dim">{line}</p>}
        {sections.map((s) => {
          const group = s.group;
          return (
            <section key={group ?? ""} className="psec">
              {group === null ? (
                <h2 className="psec-title">{s.name}</h2>
              ) : (
                <button type="button" className="psec-title" onClick={() => p.onOpen(group)}>
                  {s.name}
                </button>
              )}
              {s.items.length > 0 && <ul className="prows">{s.items.map(row)}</ul>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
