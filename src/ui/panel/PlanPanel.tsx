import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { fmtShort, toIso } from "../../domain/dates";
import { goneSet } from "../../domain/derive";
import type { Item, ItemId } from "../../domain/model";
import { childrenOf, trashRoots } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { useRun } from "../run";
import { derivedStatus } from "../status";
import { useUiValue, type SettingsSection } from "../state";
import { calendarSummary } from "./calendarText";
import { History } from "./History";
import { Trash } from "./Trash";

type SummaryPage = "summary" | "history" | "trash";

type SubPage = Exclude<SummaryPage, "summary">;

const PAGE_LABEL: Readonly<Record<SubPage, string>> = {
  history: "History",
  trash: "Trash",
};

function Stat(p: { k: string; v: number; tone?: "amber" | "magenta" }) {
  return (
    <>
      <span className="k">{p.k}</span>
      <span className={p.tone !== undefined && p.v > 0 ? `v ${p.tone}` : "v"} data-stat={p.k}>
        {p.v}
      </span>
    </>
  );
}

function spanText(view: PlanView): string | null {
  const starts = [...view.derived.start.values()];
  const ends = [...view.derived.end.values()];
  if (starts.length === 0 || ends.length === 0) return null;
  return `${fmtShort(toIso(Math.min(...starts)))} – ${fmtShort(toIso(Math.max(...ends)))}`;
}

function topProgress(view: PlanView, gone: ReadonlySet<ItemId>): number | null {
  const of = (it: Item): number[] => {
    if (it.kind === "group") {
      const p = view.derived.progress.get(it.id);
      return p === undefined ? [] : [p];
    }
    if (it.kind !== "task") return [];
    if (it.schedule === null) throw new Error(`PlanPanel: task ${it.id} has no schedule`);
    return [derivedStatus(view, it.id, "PlanPanel") === "done" ? 100 : it.schedule.progress];
  };
  const values = childrenOf(view.plan, null)
    .filter((it) => !gone.has(it.id))
    .flatMap(of);
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function SummaryRow(p: { page: SubPage; count: number; button: RefObject<HTMLButtonElement | null>; onOpen(): void }) {
  return (
    <button ref={p.button} type="button" className="summary-row" data-summary-row={p.page} disabled={p.page === "trash" && p.count === 0} onClick={p.onOpen}>
      <span className="summary-row-label">{PAGE_LABEL[p.page]}</span>
      <span className="summary-row-count mono">{p.count}</span>
      <span className="summary-row-go" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

function SettingsSummaryRow(p: { section: SettingsSection; label: string; value: ReactNode; onOpen(): void }) {
  return (
    <button type="button" className="summary-row" data-summary-row={p.section} onClick={p.onOpen}>
      <span className="summary-row-label">{p.label}</span>
      {p.value}
      <span className="summary-row-go" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

export function PlanPanel(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  const { setUi } = useUiValue();
  const [asked, setAsked] = useState<SummaryPage>("summary");
  const opener = useRef<SubPage | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const historyRow = useRef<HTMLButtonElement>(null);
  const trashRow = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const plan = view.plan;
  const trashCount = trashRoots(plan).length;
  if (asked === "trash" && trashCount === 0) setAsked("summary");
  const page: SummaryPage = asked === "trash" && trashCount === 0 ? "summary" : asked;
  useLayoutEffect(() => {
    const from = opener.current;
    if (from === null) return;
    const root = panel.current;
    if (root === null) throw new Error(`PlanPanel: the ${page} page rendered without its element`);
    const active = document.activeElement;
    if (active !== null && active !== document.body && !root.contains(active)) return;
    const wanted = page === "summary" ? (from === "history" ? historyRow.current : trashRow.current) : backButton.current;
    if (wanted === null) throw new Error(`PlanPanel: the ${page} page has no control to take focus back from ${from}`);
    const target = wanted.disabled ? historyRow.current : wanted;
    if (target === null) throw new Error("PlanPanel: the summary has no History row to take focus from the emptied Trash");
    target.focus();
  }, [page]);
  const open = (next: SubPage): void => {
    opener.current = next;
    setAsked(next);
  };
  if (page !== "summary") {
    return (
      <div ref={panel} className="panel plan-summary" data-summary-page={page}>
        <div className="summary-page-head">
          <button ref={backButton} type="button" className="summary-back" onClick={() => setAsked("summary")}>
            ‹ Plan
          </button>
        </div>
        {page === "history" ? <History session={p.session} readOnly={p.readOnly} /> : <Trash view={view} readOnly={p.readOnly} run={run} />}
      </div>
    );
  }
  const gone = goneSet(plan);
  const items = [...plan.items.values()].filter((i) => i.kind !== "group" && !gone.has(i.id));
  const statuses = items.map((i) => derivedStatus(view, i.id, "PlanPanel"));
  const done = statuses.filter((s) => s === "done").length;
  const todo = statuses.filter((s) => s === "todo").length;
  const doing = statuses.filter((s) => s === "doing").length;
  const unscheduled = items.filter((i) => i.schedule !== null && i.schedule.start === null).length;
  const late = items.filter((i) => view.derived.late.has(i.id)).length;
  const conflicts = view.derived.conflicts.filter((c) => c.kind !== "dayoff").length;
  const span = spanText(view);
  const progress = topProgress(view, gone);
  const calendarText = calendarSummary(plan.calendar);
  return (
    <div ref={panel} className="panel plan-summary" data-summary-page="summary">
      <h2>Plan</h2>
      <p className="summary-name" title={plan.name}>
        {plan.name}
      </p>
      {span !== null && <p className="summary-span mono">{span}</p>}
      {progress !== null && (
        <>
          <p className="summary-progress">{`Progress ${progress} %`}</p>
          <div className="summary-bar">
            <span style={{ width: `${progress}%` }} />
          </div>
        </>
      )}
      <div className="stat">
        <Stat k="Items" v={items.length} />
        <Stat k="Done" v={done} />
        <Stat k="Unscheduled" v={unscheduled} />
        <Stat k="Late" v={late} tone="amber" />
        <Stat k="Held" v={view.held.size} tone="amber" />
        <Stat k="Conflicts" v={conflicts} tone="magenta" />
        <Stat k="Not started" v={todo} />
        <Stat k="In progress" v={doing} />
      </div>
      <div className="summary-rows">
        <SettingsSummaryRow
          section="working-time"
          label="Working time"
          value={
            <span className="summary-row-value" title={calendarText}>
              {calendarText}
            </span>
          }
          onOpen={() => setUi({ settings: "working-time" })}
        />
        <SettingsSummaryRow section="baselines" label="Baselines" value={<span className="summary-row-count mono">{plan.baselines.size}</span>} onOpen={() => setUi({ settings: "baselines" })} />
        <SummaryRow page="history" count={p.session.history().length} button={historyRow} onOpen={() => open("history")} />
        <SummaryRow page="trash" count={trashCount} button={trashRow} onOpen={() => open("trash")} />
      </div>
    </div>
  );
}
