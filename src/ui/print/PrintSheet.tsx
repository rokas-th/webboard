import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { fmtNear, toDay, toIso, type Day } from "../../domain/dates";
import type { Item, ItemId } from "../../domain/model";
import { liveLinks } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { countedConflicts } from "../choices/HeadCounts";
import { statusLabel } from "../list/groups";
import { derivedStatus } from "../status";
import { depsOf } from "../list/columns";
import { fitSpan } from "../timeline/geometry";
import { pct, printRows, printScale, type PrintRow } from "./sheet";

const HEADS: readonly (readonly [string, string])[] = [
  ["Item", "print-item"],
  ["Start", "print-date"],
  ["End", "print-date"],
  ["Days", "print-days"],
  ["Status", "print-status"],
  ["Depends on", "print-deps"],
];

const INDENT_MM = 4;

const itemOf = (view: PlanView, id: ItemId): Item => {
  const it = view.plan.items.get(id);
  if (it === undefined) throw new Error(`Print: no item ${id}`);
  return it;
};

const conflictsText = (n: number): string => (n === 0 ? "" : ` · ${n} ${n === 1 ? "conflict" : "conflicts"}`);

function subtitle(view: PlanView, rows: readonly PrintRow[]): string {
  const spans = rows.flatMap((r) => (r.span === null ? [] : [r.span]));
  const near = (d: Day): string => fmtNear(toIso(d), view.today);
  const range = spans.length === 0 ? "" : `${near(Math.min(...spans.map((s) => s.start)))} → ${near(Math.max(...spans.map((s) => s.end)))} · `;
  return `${range}printed ${fmtNear(view.today, view.today)}${conflictsText(countedConflicts(view).length)}`;
}

function Bar(p: { row: PrintRow; done: boolean; first: Day; days: number }) {
  const span = p.row.span;
  if (span === null) return null;
  const done = p.done ? " done" : "";
  if (p.row.kind === "milestone") {
    return (
      <span className={`print-ms${done}`} style={{ left: `${pct(span.start, p.first, p.days)}%` }}>
        ◆
      </span>
    );
  }
  return (
    <span
      className={`print-bar${p.row.kind === "group" ? " group" : done}`}
      style={{ left: `${pct(span.start, p.first, p.days)}%`, width: `${((span.end - span.start + 1) / p.days) * 100}%` }}
    />
  );
}

function SheetBody(p: { view: PlanView }) {
  const { view } = p;
  const rows = printRows(view);
  const links = liveLinks(view.plan);
  const { first, last } = fitSpan(view);
  const days = last - first + 1;
  const today = toDay(view.today);
  const todayLine = today >= first && today <= last ? <span className="print-today" style={{ left: `${pct(today, first, days)}%` }} /> : null;
  const near = (d: Day): string => fmtNear(toIso(d), view.today);
  const line = (r: PrintRow) => {
    const it = itemOf(view, r.id);
    const group = r.kind === "group";
    const milestone = r.kind === "milestone";
    const status = group ? null : statusLabel(view, r.id);
    return (
      <tr key={r.id} data-prow={r.id} className={group ? "print-group" : undefined}>
        <td>
          <span className="print-name" style={{ paddingLeft: `${r.depth * INDENT_MM}mm` }}>
            {milestone ? `◆ ${it.name}` : it.name}
          </span>
        </td>
        <td>{r.span === null ? "" : near(r.span.start)}</td>
        <td>{r.span === null || milestone ? "" : near(r.span.end)}</td>
        <td>{group || milestone || it.schedule === null ? "" : it.schedule.dur}</td>
        <td>{status ?? ""}</td>
        <td>{group ? "" : depsOf(view, links, r.id)}</td>
        <td className="print-chart">
          <div className="print-track">
            {todayLine}
            <Bar row={r} done={!group && derivedStatus(view, r.id, "PrintSheet") === "done"} first={first} days={days} />
          </div>
        </td>
      </tr>
    );
  };
  return (
    <>
      <h1>{view.plan.name}</h1>
      <p className="print-sub">{subtitle(view, rows)}</p>
      <table className="print-table">
        <thead>
          <tr>
            {HEADS.map(([h, cls], n) => (
              <th key={n} className={cls}>
                {h}
              </th>
            ))}
            <th className="print-chart">
              <div className="print-scale">
                {printScale(first, last).map((t) => (
                  <span key={t.at} className="print-tick" style={{ left: `${pct(t.at, first, days)}%` }}>
                    {t.label}
                  </span>
                ))}
              </div>
            </th>
          </tr>
        </thead>
        <tbody>{rows.map(line)}</tbody>
      </table>
    </>
  );
}

export function PrintSheet(p: { view: PlanView; onDone(): void }) {
  const done = useRef(p.onDone);
  done.current = p.onDone;
  useEffect(() => {
    const after = (): void => done.current();
    window.addEventListener("afterprint", after);
    return () => window.removeEventListener("afterprint", after);
  }, []);
  return createPortal(
    <div className="print-sheet">
      <SheetBody view={p.view} />
    </div>,
    document.body,
  );
}
