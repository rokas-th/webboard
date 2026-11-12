import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import type { ItemId, PlanId } from "../../domain/model";
import type { Clock } from "../../services/clock";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import type { SyncState } from "../../sync/manager";
import { canReload, stopsArrival } from "../../sync/reload";
import { docName, useSyncState } from "../../sync/SyncProvider";
import { About } from "../common/About";
import { toast, Toasts } from "../common/Toast";
import { ghostIds } from "../ghosts";
import { OpenChoice } from "../run";
import { ConvertedReport } from "../shell/ConvertedReport";
import { moveAllToSpace } from "../shell/moving";
import { FailedPlanView } from "../shell/PlanFailed";
import { PurgeConfirm } from "../shell/PurgeConfirm";
import { usePlanFiles, usePlanSelection, type PlanFiles, type PlanMain } from "../shell/selection";
import { ExampleButton, NewPlanButton } from "../shell/Sidebar";
import { RemovedBanner } from "../sync/RemovedBanner";
import { SyncActionButtons, SyncDialog, syncMessage } from "../sync/SyncDialog";
import { UiContext, useUi, useUiValue, type DialogState, type SyncPane } from "../state";
import { canHover, ThemePanel } from "../theme/ThemePanel";
import { Timeline } from "../timeline/Timeline";
import { toastRemoteTrash } from "../trashed";
import { ChoiceSheet } from "./ChoiceSheet";
import { RevertDialog } from "../panel/History";
import { ItemSheet } from "./ItemSheet";
import { PhoneList } from "./PhoneList";
import { PhoneStatus } from "./PhoneStatus";
import { PhoneTopBar } from "./PhoneTopBar";
import { CalendarSheet } from "./PlanSheet";
import { CreateError, ImportButton, NEW_PLAN, PlansSheet } from "./PlansSheet";

type PhoneView = "list" | "timeline";

const VIEWS: readonly (readonly [PhoneView, string])[] = [
  ["list", "List"],
  ["timeline", "Timeline"],
];

function PlanDialog(p: { session: PlanSession; registry: Registry; clock: Clock; dialog: DialogState; local: string; onClose(): void }): ReactElement | null {
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
    case "calendar":
      return <CalendarSheet key={p.session.view().plan.id} session={p.session} registry={p.registry} clock={p.clock} onClose={p.onClose} />;
    case "revert":
      return <RevertDialog key={d.id} session={p.session} id={d.id} frame="sheet" onClose={p.onClose} />;
    case "about":
    case "sync":
      return null;
    case "palette":
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
        toastRemoteTrash(session, item, device);
      }),
    [session, device, setUi],
  );
}

function OpenPlan(p: { session: PlanSession; registry: Registry; clock: Clock }) {
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
        <PlanDialog session={p.session} registry={p.registry} clock={p.clock} dialog={dialog} local={local} onClose={closeDialog} />
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
  clock: Clock;
  main: PlanMain;
  files: PlanFiles;
  sync: SyncState;
  error: string | null;
  onNew(name: string): void;
  onExample(): void;
  onSync(pane: SyncPane | null): void;
  open(id: PlanId): void;
  trash(id: PlanId): void;
}) {
  const m = p.main;
  if (m.k === "empty") {
    return (
      <div className="empty-state">
        <div className="empty-actions">
          <NewPlanButton creating={p.files.creating} onNew={() => p.onNew(NEW_PLAN)} />
          <ExampleButton creating={p.files.creating} onExample={p.onExample} />
          <ImportButton files={p.files} />
          <button type="button" onClick={() => p.onSync("join")}>
            Join with a code
          </button>
          <button type="button" onClick={() => p.onSync("setup")}>
            Set up sync
          </button>
        </div>
        <CreateError error={p.error} />
      </div>
    );
  }
  if (m.k === "opening") return null;
  if (m.k === "incomplete") {
    if (!stopsArrival(p.sync, m.id)) return <p className="main-note">{m.message}</p>;
    return (
      <div className="plan-stopped">
        <p className="sync-message bad">{syncMessage(p.sync, docName(p.registry))}</p>
        <SyncActionButtons holds={false}>
          <button type="button" onClick={() => p.onSync(null)}>
            Open sync
          </button>
        </SyncActionButtons>
      </div>
    );
  }
  if (m.k === "failed") {
    return (
      <FailedPlanView
        registry={p.registry}
        id={m.id}
        error={m.error}
        reloadEnabled={canReload(p.sync)}
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
  return <OpenPlan key={m.id} session={m.session} registry={p.registry} clock={p.clock} />;
}

function listedName(registry: Registry, main: PlanMain, selected: PlanId | null): string | null {
  if (main.k === "empty") return null;
  const listing = registry.plans().find((l) => l.id === main.id);
  if (listing !== undefined) return listing.name ?? "Loading…";
  if (main.id !== selected) return null;
  throw new Error(`Plan ${main.id} is not listed`);
}

function PhoneBody(p: { registry: Registry; clock: Clock }) {
  const { ui, setUi } = useUiValue();
  const { main, open, trashOwn } = usePlanSelection(p.registry);
  const { state: syncState } = useSyncState();
  const name = listedName(p.registry, main, ui.plan);
  const [plans, setPlans] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [purging, setPurging] = useState<PlanId | null>(null);
  const sheetShown = useRef(0);
  const showPlans = useCallback(() => {
    sheetShown.current += 1;
    setPlans(true);
  }, []);
  const closePlans = useCallback(() => {
    sheetShown.current += 1;
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
  const newFromEmpty = (name: string): void => {
    setEmptyError(null);
    files.newPlan(name, setEmptyError);
  };
  const exampleFromEmpty = (): void => {
    setEmptyError(null);
    files.newExample(setEmptyError);
  };
  const newFromSheet = (name: string): void => {
    setSheetError(null);
    const shown = sheetShown.current;
    files.newPlan(name, (message) => (sheetShown.current === shown ? setSheetError(message) : toast(message, "bad")));
  };
  const openChoice = useCallback(
    (choice: string, side?: string) => setUi({ dialog: side === undefined ? { t: "choice", id: choice } : { t: "choice", id: choice, side } }),
    [setUi],
  );
  const trash = (id: PlanId): void => void trashOwn(id);
  const moveAll = (ids: readonly PlanId[]): void => moveAllToSpace(p.registry, ids);
  const session = main.k === "open" ? main.session : null;
  const closeDialog = (): void => setUi({ dialog: null });
  const about = (): void => {
    closePlans();
    setUi({ dialog: { t: "about" } });
  };
  const openSync = (pane: SyncPane | null): void => {
    closePlans();
    setUi({ dialog: { t: "sync", pane } });
  };
  return (
    <OpenChoice.Provider value={openChoice}>
      <div className="app phone">
        <RemovedBanner session={session} />
        <PhoneTopBar
          name={name}
          session={session}
          files={files}
          today={() => p.clock.today()}
          onPlans={showPlans}
          onChoose={(choice) => openChoice(choice)}
          onCreated={(id) => setUi({ selected: id, naming: id })}
        />
        <PhoneStatus
          session={session}
          registry={p.registry}
          clock={p.clock}
          sync={{ state: syncState, open: () => openSync(null) }}
          onOpenItem={(id) => setUi({ selected: id })}
        />
        <Main
          registry={p.registry}
          clock={p.clock}
          main={main}
          files={files}
          sync={syncState}
          error={emptyError}
          onNew={newFromEmpty}
          onExample={exampleFromEmpty}
          onSync={openSync}
          open={open}
          trash={trash}
        />
        {plans && (
          <PlansSheet
            registry={p.registry}
            selected={ui.plan}
            files={files}
            error={sheetError}
            onNew={newFromSheet}
            onOpen={openPlan}
            onTrash={trash}
            onPurge={setPurging}
            onMoveAll={moveAll}
            onAbout={main.k === "empty" ? about : undefined}
            onSync={openSync}
            onClose={closePlans}
          />
        )}
        {ui.dialog !== null && ui.dialog.t === "about" && <About frame="sheet" onClose={closeDialog} />}
        {ui.dialog !== null && ui.dialog.t === "sync" && (
          <SyncDialog pane={ui.dialog.pane} frame="sheet" onPane={(pane) => setUi({ dialog: { t: "sync", pane } })} onClose={closeDialog} />
        )}
        {purging !== null && <PurgeConfirm registry={p.registry} id={purging} frame="sheet" onClose={() => setPurging(null)} />}
        {ui.theme && <ThemePanel frame="sheet" hover={canHover()} onClose={() => setUi({ theme: false })} />}
        <ConvertedReport frame="sheet" />
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
