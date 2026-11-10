import { useCallback, useId, useMemo, useState } from "react";
import type { Clock } from "../../services/clock";
import type { Registry } from "../../store/registry";
import { usePlanView, type PlanSession } from "../../store/session";
import { heldChoice } from "../choices/describe";
import { Toasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { NewPlanButton } from "../shell/Sidebar";
import { usePlanFiles, usePlanSelection, type PlanMain } from "../shell/selection";
import { UiContext, useUi, useUiValue } from "../state";
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
  const open = (): void => {
    const c = heldChoice(view);
    if (c === null) throw new Error("No open choice holds the held items");
    setUi({ dialog: { t: "choice", id: c.id } });
  };
  return (
    <div className="phone-head">
      <button type="button" className="chip chip-amber" onClick={open}>
        {view.held.size} held
      </button>
    </div>
  );
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
      {dialog !== null && dialog.t === "choice" ? (
        <ChoiceSheet
          key={`${p.session.view().plan.id}:${dialog.id}:${dialog.side ?? ""}`}
          session={p.session}
          id={dialog.id}
          side={dialog.side}
          local={p.local}
          onClose={closeDialog}
        />
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
