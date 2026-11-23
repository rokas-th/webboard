import { fmtShort, toIso, type DateStyle, type Day } from "../../domain/dates";
import type { Item, ItemId } from "../../domain/model";
import type { PlanView } from "../../store/doc";
import { useDateStyle } from "../DeviceProvider";
import { groupPath, statusLabel, type StatusLabel } from "../list/groups";
import { assigneeName, cardPeople } from "../people/assign";
import { Avatar } from "../people/Avatar";
import { assigneesLabel, moreText } from "../people/text";
import { nearnessOf, type BoardLayout } from "./layout";
import { LATE, soonText } from "./text";

const DOT: Readonly<Record<StatusLabel, string>> = {
  conflict: "dot conflict",
  held: "dot held",
  late: "dot late",
  "in progress": "dot doing",
  done: "dot",
  "not started": "dot",
};

const dayOf = (m: ReadonlyMap<ItemId, Day>, id: ItemId, what: string, style: DateStyle): string => {
  const d = m.get(id);
  if (d === undefined) throw new Error(`Board: scheduled item ${id} has no ${what}`);
  return fmtShort(toIso(d), style);
};

function When(p: { view: PlanView; item: Item }) {
  const style = useDateStyle();
  const sc = p.item.schedule;
  if (sc === null) throw new Error(`Board: item ${p.item.id} has no schedule`);
  if (sc.start === null) return <span className="unsched">unscheduled</span>;
  const start = dayOf(p.view.derived.start, p.item.id, "start", style);
  if (p.item.kind === "milestone") return <span className="when">◆ {start}</span>;
  return <span className="when">{`${start} – ${dayOf(p.view.derived.end, p.item.id, "end", style)}`}</span>;
}

function Near(p: { view: PlanView; layout: BoardLayout; item: Item }) {
  const near = nearnessOf(p.view, p.layout.mode, p.item);
  if (near === null) return null;
  if (near.kind === "late") return <span className="badge late">{LATE}</span>;
  return <span className="badge soon">{soonText(near.days)}</span>;
}

const groupName = (view: PlanView, item: Item): string | null => (item.place.parent === null ? null : groupPath(view, item.place.parent));

function CardPeople(p: { view: PlanView; item: Item }) {
  const list = p.view.people.assignees.get(p.item.id) ?? [];
  const shown = cardPeople(list);
  if (shown === null) return null;
  const label = assigneesLabel(list.map(assigneeName));
  return (
    <span className="card-people" role="img" aria-label={label} title={label}>
      <Avatar assignee={shown.first} />
      {shown.more > 0 && <span className="avatar-more">{moreText(shown.more)}</span>}
    </span>
  );
}

export function CardBody(p: { view: PlanView; layout: BoardLayout; item: Item }) {
  const group = groupName(p.view, p.item);
  return (
    <>
      <div className="card-top">
        <span className={DOT[statusLabel(p.view, p.item.id)]} />
        <span className="card-name">{p.item.name}</span>
      </div>
      <div className="card-meta">
        <When view={p.view} item={p.item} />
        {group !== null && <span className="card-group">{group}</span>}
        <Near view={p.view} layout={p.layout} item={p.item} />
        <CardPeople view={p.view} item={p.item} />
      </div>
    </>
  );
}
