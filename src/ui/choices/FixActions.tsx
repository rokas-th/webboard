import { q } from "../../actions/copy";
import { schedView } from "../../domain/derive";
import type { ItemId, LinkType } from "../../domain/model";
import { lagThatHolds, type Conflict } from "../../domain/schedule";
import type { PlanView } from "../../store/doc";
import type { Run } from "../run";
import { dayLabel } from "../timeline/Chart";

const LOCKED: Readonly<Record<LinkType, (pred: string) => string>> = {
  FS: (pred) => `Started before ${pred} finished`,
  SS: (pred) => `Started before ${pred} started`,
  FF: (pred) => `Finished before ${pred} finished`,
  SF: (pred) => `Finished before ${pred} started`,
};

const signed = (n: number): string => (n < 0 ? `−${-n}` : String(n));

const nameOf = (view: PlanView, id: ItemId): string => {
  const it = view.plan.items.get(id);
  if (it === undefined) throw new Error(`No item ${id}`);
  return it.name;
};

const linkOf = (view: PlanView, k: string) => {
  const link = view.plan.links.get(k);
  if (link === undefined) throw new Error(`Conflict link ${k} is not in the plan`);
  return link;
};

const mine = (view: PlanView, item: ItemId, c: Conflict): boolean => {
  if (c.kind === "early") return c.succ === item;
  if (c.kind === "dayoff") return c.item === item;
  return linkOf(view, c.link).to === item;
};

function holdingLag(view: PlanView, c: Extract<Conflict, { kind: "early" }>): number {
  const sv = schedView(view.plan, view.held);
  const succ = sv.items.get(c.succ);
  const pred = sv.items.get(c.pred);
  if (succ === undefined || pred === undefined) throw new Error(`Conflict on ${c.link} has an end with no schedule`);
  return lagThatHolds(succ, linkOf(view, c.link), pred, sv.cal);
}

function Fix(p: { view: PlanView; conflict: Conflict; readOnly: boolean; run: Run }) {
  const c = p.conflict;
  const fix = (how: "push" | "shorten" | "remove"): void => {
    p.run.run({ t: "fix", conflict: c, how });
  };
  const line = (text: string, cls: string, buttons: readonly (readonly [string, () => void])[]) => (
    <div className="conflict-line">
      <p className={cls}>{text}</p>
      {!p.readOnly && (
        <div className="actions">
          {buttons.map(([label, onClick]) => (
            <button key={label} type="button" className="button-small" onClick={onClick}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  if (c.kind === "dayoff") {
    return line(`Starts on a day off — shown from ${dayLabel(c.shownFrom)}`, "dayoff-text", [["Snap to next working day", () => p.run.run({ t: "snap", item: c.item })]]);
  }
  if (c.kind === "loop") {
    return line(`The link from ${q(nameOf(p.view, linkOf(p.view, c.link).from))} is part of a loop.`, "conflict-text", [["Remove the link", () => fix("remove")]]);
  }
  const pred = q(nameOf(p.view, c.pred));
  if (c.succLock === "done" || c.succLock === "doing") {
    const type = linkOf(p.view, c.link).type;
    return line(LOCKED[type](pred), "conflict-text", [
      [`Shorten the lag to ${signed(holdingLag(p.view, c))}`, () => fix("shorten")],
      ["Remove the link", () => fix("remove")],
    ]);
  }
  const text = `Starts earlier than the link from ${pred} allows.`;
  if (c.succLock === "held") return line(text, "conflict-text", [["Open the choice", () => fix("push")]]);
  return line(text, "conflict-text", [[`Push ${q(nameOf(p.view, c.succ))} to ${dayLabel(c.need)}`, () => fix("push")]]);
}

export function FixActions(p: { view: PlanView; item: ItemId; readOnly: boolean; run: Run }) {
  const found = p.view.derived.conflicts.filter((c) => mine(p.view, p.item, c));
  if (found.length === 0) return null;
  return (
    <div className="conflicts">
      {found.map((c) => (
        <Fix key={c.kind === "dayoff" ? "dayoff" : `${c.kind}:${c.link}`} view={p.view} conflict={c} readOnly={p.readOnly} run={p.run} />
      ))}
    </div>
  );
}
