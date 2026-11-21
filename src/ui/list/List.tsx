import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { fmtShort, toIso, type Day } from "../../domain/dates";
import type { Item, ItemId, Link } from "../../domain/model";
import { liveLinks } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { EMPTY_PLAN } from "../copy";
import { ghostIds } from "../ghosts";
import { useUiValue } from "../state";
import { useDetail } from "../detail/DetailContext";
import { isClick } from "../timeline/gesture";
import { listGroups, statusLabel, type StatusLabel } from "./groups";

const HEADS: readonly string[] = ["Item", "Start", "End", "Days", "Status", "Depends on"];

const STATUS_CLASS: Readonly<Record<StatusLabel, string>> = {
  conflict: "st conflict",
  held: "st held",
  late: "st late",
  "in progress": "st doing",
  done: "st done",
  "not started": "st todo",
};

const itemOf = (view: PlanView, id: ItemId): Item => {
  const item = view.plan.items.get(id);
  if (item === undefined) throw new Error(`List: no item ${id}`);
  return item;
};

const dateOf = (m: ReadonlyMap<ItemId, Day>, id: ItemId, what: string): string => {
  const d = m.get(id);
  if (d === undefined) throw new Error(`List: scheduled item ${id} has no ${what}`);
  return fmtShort(toIso(d));
};

const lagText = (lag: number): string => (lag === 0 ? "" : `${lag > 0 ? "+" : ""}${lag}d`);

export const depsOf = (view: PlanView, links: readonly Link[], id: ItemId): string =>
  links
    .filter((l) => l.to === id)
    .map((l) => `${itemOf(view, l.from).name} ${l.type}${lagText(l.lag)}`)
    .join(", ");

export function List(p: { session: PlanSession }) {
  const view = usePlanView(p.session);
  const { ui } = useUiValue();
  const detail = useDetail();
  const down = useRef<{ id: ItemId; x: number; y: number } | null>(null);
  const sections = listGroups(view);
  const ghosts = ghostIds(view);
  const links = liveLinks(view.plan);

  const onDown = (e: ReactPointerEvent<HTMLTableRowElement>, id: ItemId): void => {
    down.current = e.button === 0 ? { id, x: e.clientX, y: e.clientY } : null;
  };

  const onUp = (e: ReactPointerEvent<HTMLTableRowElement>, id: ItemId): void => {
    const d = down.current;
    down.current = null;
    if (d === null || d.id !== id || !isClick(d, { x: e.clientX, y: e.clientY })) return;
    detail.press({ item: id, x: e.clientX, y: e.clientY, at: performance.now() });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTableRowElement>, id: ItemId): void => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (e.key === "Enter") detail.rename(id);
    else detail.promote(id);
  };

  const row = (id: ItemId) => {
    const item = itemOf(view, id);
    const label = statusLabel(view, id);
    const milestone = item.kind === "milestone";
    const ghost = ghosts.has(id);
    const dated = !ghost && item.schedule !== null && item.schedule.start !== null;
    const classes = [ghost ? "ghost-row" : "", ui.selected === id ? "selected" : ""].filter((c) => c !== "").join(" ");
    return (
      <tr
        key={id}
        className={classes === "" ? undefined : classes}
        data-lrow={id}
        tabIndex={0}
        onPointerDown={(e) => onDown(e, id)}
        onPointerUp={(e) => onUp(e, id)}
        onPointerCancel={() => {
          down.current = null;
        }}
        onKeyDown={(e) => onKey(e, id)}
      >
        <td className="item">
          <span className="list-name">{milestone ? `◆ ${item.name}` : item.name}</span>
        </td>
        <td>{dated ? dateOf(view.derived.start, id, "start") : ""}</td>
        <td>{dated && !milestone ? dateOf(view.derived.end, id, "end") : ""}</td>
        <td>{ghost || item.schedule === null || milestone ? "" : item.schedule.dur}</td>
        <td>
          <span className={STATUS_CLASS[label]}>{label}</span>
        </td>
        <td className="wrap">{ghost ? "" : depsOf(view, links, id)}</td>
      </tr>
    );
  };

  return (
    <div className="list-wrap">
      <table className="list">
        <thead>
          <tr>
            {HEADS.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.flatMap((s) => [
            <tr key={`grp:${s.group ?? ""}`} className="grp">
              <td colSpan={HEADS.length}>{s.name}</td>
            </tr>,
            ...s.items.map(row),
          ])}
        </tbody>
      </table>
      {sections.length === 0 && <p className="note">{EMPTY_PLAN}</p>}
    </div>
  );
}
