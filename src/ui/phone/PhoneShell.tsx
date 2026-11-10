import { useCallback, useMemo, useState } from "react";
import type { Clock } from "../../services/clock";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { Toasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { NewPlanButton } from "../shell/Sidebar";
import { usePlanFiles, usePlanSelection, type PlanMain } from "../shell/selection";
import { UiContext, useUi, useUiValue } from "../state";
import { Timeline } from "../timeline/Timeline";
import { ItemSheet } from "./ItemSheet";
import { PhoneList } from "./PhoneList";

type PhoneView = "list" | "timeline";

const VIEWS: readonly (readonly [PhoneView, string])[] = [
  ["list", "List"],
  ["timeline", "Timeline"],
];

function OpenPlan(p: { session: PlanSession }) {
  const { ui, setUi } = useUiValue();
  const [view, setView] = useState<PhoneView>("list");
  const selected = ui.selected !== null && p.session.view().plan.items.has(ui.selected) ? ui.selected : null;
  return (
    <>
      <div className="phone-main">
        {view === "list" ? <PhoneList session={p.session} onOpen={(id) => setUi({ selected: id })} /> : <Timeline session={p.session} readOnly />}
      </div>
      <div className="seg phone-views" role="tablist" aria-label="Views">
        {VIEWS.map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "active" : undefined} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </div>
      {selected !== null && <ItemSheet key={selected} session={p.session} item={selected} onClose={() => setUi({ selected: null })} />}
    </>
  );
}

function Main(p: { registry: Registry; main: PlanMain; open(id: string): void }) {
  const { creating, importing, newPlan, importPlan } = usePlanFiles(p.registry, p.open);
  const m = p.main;
  if (m.k === "empty") {
    return (
      <div className="empty-state">
        <div className="empty-actions">
          <NewPlanButton creating={creating} onNew={newPlan} />
          <button type="button" disabled={importing} onClick={importPlan}>
            {importing ? <span className="dim">Importing…</span> : "Import plan…"}
          </button>
        </div>
      </div>
    );
  }
  if (m.k === "opening") return null;
  if (m.k === "incomplete") return <p className="main-note">{m.message}</p>;
  if (m.k === "failed") {
    const recorded = p.registry.failures().get(m.id) === m.error;
    return (
      <div className="banner bad">
        <span className="banner-text">{m.error.message}</span>
        <button type="button" className="button-small" onClick={() => (recorded ? void p.registry.retryPlan(m.id) : p.open(m.id))}>
          Try again
        </button>
      </div>
    );
  }
  return <OpenPlan key={m.id} session={m.session} />;
}

function PhoneBody(p: { registry: Registry }) {
  const { setUi } = useUiValue();
  const { main, open } = usePlanSelection(p.registry);
  const openChoice = useCallback(
    (choice: string, side?: string) => setUi({ dialog: side === undefined ? { t: "choice", id: choice } : { t: "choice", id: choice, side } }),
    [setUi],
  );
  return (
    <OpenChoice.Provider value={openChoice}>
      <div className="app phone">
        <Main registry={p.registry} main={main} open={open} />
        <Toasts />
      </div>
    </OpenChoice.Provider>
  );
}

export function PhoneShell(p: { registry: Registry; clock: Clock }) {
  const [ui, setUi] = useUi();
  const uiValue = useMemo(() => ({ ui, setUi }), [ui, setUi]);
  return (
    <UiContext.Provider value={uiValue}>
      <PhoneBody registry={p.registry} />
    </UiContext.Provider>
  );
}
