import { useCallback, useId, useMemo, useState, type ReactElement } from "react";
import type { Clock } from "../../services/clock";
import type { Registry } from "../../store/registry";
import { usePlanView, type PlanSession } from "../../store/session";
import { HeldChip } from "../choices/HeldChip";
import { Toasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { NewPlanButton } from "../shell/Sidebar";
import { usePlanFiles, usePlanSelection, type PlanMain } from "../shell/selection";
import { UiContext, useUi, useUiValue, type DialogState } from "../state";
import { Timeline } from "../timeline/Timeline";
import { ChoiceSheet } from "./ChoiceSheet";
import { ItemSheet } from "./ItemSheet";
import { PhoneList } from "./PhoneList";

type PhoneView = "list" | "timeline";

const VIEWS: readonly (readonly [PhoneView, string])[] = [
  ["list", "List"],
  ["timeline", "Timeline"],
];

function HeldCount(p: { session: PlanSession }) {
  const view = usePlanView(p.session);
  const { setUi } = useUiValue();
  if (view.held.size === 0) return null;
  return (
    <div className="phone-head">
      <HeldChip view={view} onChoose={(id) => setUi({ dialog: { t: "choice", id } })} />
    </div>
  );
}

function PlanDialog(p: { session: PlanSession; dialog: DialogState; local: string; onClose(): void }): ReactElement {
  const d = p.dialog;
  switch (d.t) {
    case "choice":
      return (
        <ChoiceSheet
          key={`${p.session.view().plan.id}:${d.id}:${d.side ?? ""}`}
          session={p.session}
          id={d.id}
          side={d.side}
          local={p.local}
          onClose={p.onClose}
        />
      );
    case "sync":
    case "calendar":
    case "palette":
    case "revert":
    case "about":
      throw new Error(`PhoneShell cannot show dialog ${d.t}`);
  }
}

function OpenPlan(p: { session: PlanSession; local: string }) {
  const { ui, setUi } = useUiValue();
  const [view, setView] = useState<PhoneView>("list");
  const base = useId();
  const tabId = (v: PhoneView): string => `${base}-tab-${v}`;
  const panelId = `${base}-panel`;
  const selected = ui.selected !== null && p.session.view().plan.items.has(ui.selected) ? ui.selected : null;
  const dialog = ui.dialog;
  const closeDialog = useCallback(() => setUi({ dialog: null }), [setUi]);
  return (
    <>
      <HeldCount session={p.session} />
      <div id={panelId} className="phone-main" role="tabpanel" aria-labelledby={tabId(view)}>
        {view === "list" ? <PhoneList session={p.session} onOpen={(id) => setUi({ selected: id })} /> : <Timeline session={p.session} readOnly />}
      </div>
      <div className="seg phone-views" role="tablist" aria-label="Views">
        {VIEWS.map(([v, label]) => (
          <button
            key={v}
            id={tabId(v)}
            type="button"
            role="tab"
            aria-selected={view === v}
            aria-controls={panelId}
            className={view === v ? "active" : undefined}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
      </div>
      {dialog !== null ? (
        <PlanDialog session={p.session} dialog={dialog} local={p.local} onClose={closeDialog} />
      ) : (
        selected !== null && <ItemSheet key={selected} session={p.session} item={selected} local={p.local} onClose={() => setUi({ selected: null })} />
      )}
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
  if (m.k === "failed" || m.k === "error") {
    const recorded = m.k === "failed" && m.recorded;
    return (
      <div className="banner bad">
        <span className="banner-text">{m.k === "failed" ? m.error.message : m.message}</span>
        <button type="button" className="button-small" onClick={() => (recorded ? void p.registry.retryPlan(m.id) : p.open(m.id))}>
          Try again
        </button>
      </div>
    );
  }
  return <OpenPlan key={m.id} session={m.session} local={p.registry.device.name} />;
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
