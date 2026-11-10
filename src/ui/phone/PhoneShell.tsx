import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import type { ItemId, PlanId } from "../../domain/model";
import type { Clock } from "../../services/clock";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { toast, Toasts } from "../common/Toast";
import { ghostIds } from "../ghosts";
import { OpenChoice } from "../run";
import { FailedPlanView } from "../shell/PlanFailed";
import { usePlanFiles, usePlanSelection, type PlanFiles, type PlanMain } from "../shell/selection";
import { NewPlanButton } from "../shell/Sidebar";
import { UiContext, useUi, useUiValue, type DialogState } from "../state";
import { Timeline } from "../timeline/Timeline";
import { remoteTrashText } from "../trashed";
import { ChoiceSheet } from "./ChoiceSheet";
import { ItemSheet } from "./ItemSheet";
import { PhoneList } from "./PhoneList";
import { PhoneTopBar } from "./PhoneTopBar";
import { CreateError, ImportButton, NEW_PLAN, PlansSheet } from "./PlansSheet";

type PhoneView = "list" | "timeline";

const VIEWS: readonly (readonly [PhoneView, string])[] = [
  ["list", "List"],
  ["timeline", "Timeline"],
];

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

function useSheetLetGo(session: PlanSession, device: string): void {
  const { ui, setUi } = useUiValue();
  const selected = useRef<ItemId | null>(ui.selected);
  useEffect(() => {
    selected.current = ui.selected;
  }, [ui.selected]);
  useEffect(
    () =>
      session.subscribe(() => {
        const item = selected.current;
        if (item === null) return;
        const view = session.view();
        const it = view.plan.items.get(item);
        if (it !== undefined && (!it.trashed || ghostIds(view).has(item))) return;
        selected.current = null;
        setUi({ selected: null, naming: null });
        if (it === undefined) return;
        const notice = remoteTrashText(session, item, device);
        if (notice !== null) toast(notice);
      }),
    [session, device, setUi],
  );
}

function OpenPlan(p: { session: PlanSession; registry: Registry }) {
  const { ui, setUi } = useUiValue();
  const [view, setView] = useState<PhoneView>("list");
  const base = useId();
  const tabId = (v: PhoneView): string => `${base}-tab-${v}`;
  const panelId = `${base}-panel`;
  const local = p.registry.device.name;
  useSheetLetGo(p.session, p.registry.device.deviceId);
  const selected = ui.selected !== null && p.session.view().plan.items.has(ui.selected) ? ui.selected : null;
  const dialog = ui.dialog;
  const closeDialog = useCallback(() => setUi({ dialog: null }), [setUi]);
  const named = useCallback(() => setUi({ naming: null }), [setUi]);
  return (
    <>
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
        <PlanDialog session={p.session} dialog={dialog} local={local} onClose={closeDialog} />
      ) : (
        selected !== null && (
          <ItemSheet
            key={selected}
            session={p.session}
            item={selected}
            local={local}
            naming={ui.naming === selected}
            onNamed={named}
            onClose={() => setUi({ selected: null })}
          />
        )
      )}
    </>
  );
}

function Main(p: {
  registry: Registry;
  main: PlanMain;
  files: PlanFiles;
  error: string | null;
  onNew(name: string): void;
  open(id: PlanId): void;
  trash(id: PlanId): void;
}) {
  const m = p.main;
  if (m.k === "empty") {
    return (
      <div className="empty-state">
        <div className="empty-actions">
          <NewPlanButton creating={p.files.creating} onNew={() => p.onNew(NEW_PLAN)} />
          <ImportButton files={p.files} />
        </div>
        <CreateError error={p.error} />
      </div>
    );
  }
  if (m.k === "opening") return null;
  if (m.k === "incomplete") return <p className="main-note">{m.message}</p>;
  if (m.k === "failed") {
    return (
      <FailedPlanView
        registry={p.registry}
        id={m.id}
        error={m.error}
        reloadEnabled
        frame="sheet"
        onRetry={() => (m.recorded ? void p.registry.retryPlan(m.id) : p.open(m.id))}
        onTrash={p.trash}
      />
    );
  }
  if (m.k === "error") {
    return (
      <div className="banner bad">
        <span className="banner-text">{m.message}</span>
        <button type="button" className="button-small" onClick={() => p.open(m.id)}>
          Try again
        </button>
      </div>
    );
  }
  return <OpenPlan key={m.id} session={m.session} registry={p.registry} />;
}

function listedName(registry: Registry, id: PlanId | null): string | null {
  if (id === null) return null;
  const listing = registry.plans().find((l) => l.id === id);
  if (listing === undefined) throw new Error(`Plan ${id} is not listed`);
  return listing.name ?? "Loading…";
}

function PhoneBody(p: { registry: Registry; clock: Clock }) {
  const { ui, setUi } = useUiValue();
  const { main, open, trashOwn } = usePlanSelection(p.registry);
  const [plans, setPlans] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const closePlans = useCallback(() => {
    setPlans(false);
    setSheetError(null);
  }, []);
  const openPlan = useCallback(
    (id: PlanId) => {
      closePlans();
      setEmptyError(null);
      open(id);
    },
    [closePlans, open],
  );
  const files = usePlanFiles(p.registry, openPlan);
  const createFrom =
    (set: (message: string | null) => void) =>
    (name: string): void => {
      set(null);
      files.newPlan(name, set);
    };
  const openChoice = useCallback(
    (choice: string, side?: string) => setUi({ dialog: side === undefined ? { t: "choice", id: choice } : { t: "choice", id: choice, side } }),
    [setUi],
  );
  const trash = (id: PlanId): void => void trashOwn(id);
  const session = main.k === "open" ? main.session : null;
  return (
    <OpenChoice.Provider value={openChoice}>
      <div className="app phone">
        <PhoneTopBar
          name={listedName(p.registry, main.k === "empty" ? null : main.id)}
          session={session}
          today={() => p.clock.today()}
          onPlans={() => setPlans(true)}
          onChoose={(choice) => openChoice(choice)}
          onCreated={(id) => setUi({ selected: id, naming: id })}
        />
        <Main registry={p.registry} main={main} files={files} error={emptyError} onNew={createFrom(setEmptyError)} open={open} trash={trash} />
        {plans && (
          <PlansSheet
            registry={p.registry}
            selected={ui.plan}
            files={files}
            error={sheetError}
            onNew={createFrom(setSheetError)}
            onOpen={openPlan}
            onTrash={trash}
            onClose={closePlans}
          />
        )}
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
      <PhoneBody registry={p.registry} clock={p.clock} />
    </UiContext.Provider>
  );
}
