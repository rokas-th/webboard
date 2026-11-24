import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import type { ItemId, PlanId } from "../../domain/model";
import { usesNativeAlert } from "../../services/alert";
import { haptic } from "../../services/haptics";
import type { TabBarStatus, TabPick } from "../../services/tabBar";
import { useTheme } from "../../theme/ThemeContext";
import { tokensOf } from "../../theme/presets";
import type { Clock } from "../../services/clock";
import type { Registry } from "../../store/registry";
import { useNotes, usePlanView, type PlanSession } from "../../store/session";
import type { SyncState } from "../../sync/manager";
import { canReload, stopsArrival } from "../../sync/reload";
import { docName, useSyncState } from "../../sync/SyncProvider";
import { useSheetOpen } from "../common/Sheet";
import { toast, Toasts } from "../common/Toast";
import { DetailContext, type DetailApi } from "../detail/DetailContext";
import { stepPatch, tabSearch } from "../detail/order";
import { ghostIds } from "../ghosts";
import { useBoardPrefs } from "../board/prefs";
import type { NoteText } from "../list/columns";
import { useListPrefs } from "../list/prefs";
import { OpenChoice } from "../run";
import { ConvertedReport } from "../shell/ConvertedReport";
import { moveAllToSpace } from "../shell/moving";
import { FailedPlanView } from "../shell/PlanFailed";
import { PurgeConfirm } from "../shell/PurgeConfirm";
import { usePlanFiles, usePlanSelection, type PlanFiles, type PlanMain } from "../shell/selection";
import { ExampleButton, NewPlanButton } from "../shell/Sidebar";
import { RemovedBanner } from "../sync/RemovedBanner";
import { SyncActionButtons, syncMessage } from "../sync/SyncPanes";
import { useDevice, useMe } from "../DeviceProvider";
import { UiContext, useUi, useUiValue, type DialogState, type SyncPane, type ViewKind } from "../state";
import { useCanHover } from "../theme/ThemePanel";
import { Settings, type SettingsCloser } from "../settings/Settings";
import { Timeline, usePhoneOutline } from "../timeline/Timeline";
import { toastRemoteTrash } from "../trashed";
import { ChoiceSheet } from "./ChoiceSheet";
import { RevertDialog } from "../panel/History";
import { ItemSheet } from "./ItemSheet";
import { PhoneBoard } from "./PhoneBoard";
import { PhoneList } from "./PhoneList";
import { useNativeTabBar } from "./nativeTabBar";
import { PHONE_VIEWS, phoneViewPatch, scrollToStart } from "./views";
import { PhoneStatus } from "./PhoneStatus";
import { PhoneTopBar } from "./PhoneTopBar";
import { CreateError, ImportButton, NEW_PLAN, PlansSheet } from "./PlansSheet";

function PlanDialog(p: { session: PlanSession; dialog: DialogState; local: string; onClose(): void }): ReactElement | null {
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
    case "revert":
      return <RevertDialog key={d.id} session={p.session} id={d.id} frame="sheet" onClose={p.onClose} />;
    case "palette":
    case "item":
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

const ViewIds = createContext<string | null>(null);

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const viewTabId = (base: string, v: ViewKind): string => `${base}-tab-${v}`;
const viewPanelId = (base: string): string => `${base}-panel`;

const useViewIds = (): string => {
  const base = useContext(ViewIds);
  if (base === null) throw new Error("PhoneViews: rendered outside an open plan's view ids");
  return base;
};

function PhoneViews(p: { value: ViewKind; onPick(v: ViewKind): void }) {
  const base = useViewIds();
  return (
    <div className="seg phone-views" role="tablist" aria-label="Views">
      {PHONE_VIEWS.map(([v, label]) => (
        <button
          key={v}
          id={viewTabId(base, v)}
          type="button"
          role="tab"
          aria-selected={p.value === v}
          aria-controls={viewPanelId(base)}
          className={p.value === v ? "active" : undefined}
          onClick={() => p.onPick(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ViewPanel(p: { view: ViewKind; session: PlanSession; outline: ReturnType<typeof usePhoneOutline>; onOpen(id: ItemId): void }) {
  switch (p.view) {
    case "timeline":
      return <Timeline session={p.session} outline={p.outline} readOnly />;
    case "board":
      return <PhoneBoard session={p.session} />;
    case "list":
      return <PhoneList session={p.session} onOpen={p.onOpen} />;
  }
}

function viewTitle(view: ViewKind): string {
  const found = PHONE_VIEWS.find(([v]) => v === view);
  if (found === undefined) throw new Error(`PhoneShell: no title for the view ${view}`);
  return found[1];
}

const webSwitch = (status: TabBarStatus): boolean => status.k === "off" || status.k === "failed";

function OpenPlan(p: { session: PlanSession; registry: Registry; clock: Clock; tabBar: TabBarStatus }) {
  const { ui, setUi } = useUiValue();
  const view = ui.view;
  const outline = usePhoneOutline();
  const base = useId();
  const local = p.registry.device.name;
  useSheetLetGo(p.session, p.registry.device.deviceId);
  const selected = ui.selected !== null && p.session.view().plan.items.has(ui.selected) ? ui.selected : null;
  const dialog = ui.dialog;
  const closeDialog = useCallback(() => setUi({ dialog: null }), [setUi]);
  const named = useCallback(() => setUi({ naming: null }), [setUi]);
  const planView = usePlanView(p.session);
  const listPrefs = useListPrefs(planView.plan.id);
  const boardPrefs = useBoardPrefs(planView.plan.id);
  const query = ui.query.trim();
  const notesSeen = useNotes(p.session, view !== "timeline" && query !== "");
  const session = p.session;
  const me = useMe(planView.plan.id);
  const order = useMemo(() => {
    const notes: NoteText = (id) => session.note(id).toString();
    return tabSearch(planView, { view, collapsed: ui.collapsed, query: ui.query }, boardPrefs, listPrefs, notes, me).order;
  }, [planView, view, ui.collapsed, ui.query, boardPrefs, listPrefs, session, notesSeen, me]);
  const follows = view === "timeline";
  const detailApi: DetailApi = {
    order,
    press: (m) => setUi(follows ? { selected: m.item, follow: m.item } : { selected: m.item }),
    promote: (id) => {
      throw new Error(`PhoneShell: the phone has no item modal to open ${id} in`);
    },
    rename: (item) => {
      throw new Error(`PhoneShell: the phone renames in the item sheet, not from a row, so ${item ?? "the selection"} has no rename here`);
    },
    step: (by) => {
      const patch = stepPatch(order, ui.selected, by, follows);
      if (patch !== null) setUi(patch);
    },
  };
  const web = webSwitch(p.tabBar);
  const panel = <ViewPanel view={view} session={p.session} outline={outline} onOpen={(id) => setUi({ selected: id })} />;
  return (
    <DetailContext.Provider value={detailApi}>
      {web ? (
        <div id={viewPanelId(base)} className="phone-main" role="tabpanel" aria-labelledby={viewTabId(base, view)}>
          {panel}
        </div>
      ) : (
        <div className="phone-main" role="region" aria-label={viewTitle(view)}>
          {panel}
        </div>
      )}
      {web && (
        <ViewIds.Provider value={base}>
          <PhoneViews
            value={view}
            onPick={(v) => {
              const patch = phoneViewPatch(view, v);
              if (patch !== null) setUi(patch);
            }}
          />
        </ViewIds.Provider>
      )}
      {dialog !== null ? (
        <PlanDialog session={p.session} dialog={dialog} local={local} onClose={closeDialog} />
      ) : (
        selected !== null && ui.settings === null && (
          <ItemSheet
            session={p.session}
            item={selected}
            local={local}
            naming={ui.naming === selected}
            onNamed={named}
            onClose={() => setUi({ selected: null })}
          />
        )
      )}
    </DetailContext.Provider>
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
  tabBar: TabBarStatus;
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
  return <OpenPlan key={m.id} session={m.session} registry={p.registry} clock={p.clock} tabBar={p.tabBar} />;
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
  const hover = useCanHover();
  const settingsCloser = useRef<SettingsCloser | null>(null);
  const openSync = (pane: SyncPane | null): void => {
    closePlans();
    setUi({ settings: "sync", syncPane: pane });
  };
  const planOpen = main.k === "open";
  const sheetOpen = useSheetOpen();
  const tint = tokensOf(useTheme().shown).cyan;
  const pick = ({ id, again }: TabPick): void => {
    if (again && id === ui.view) {
      scrollToStart(document, id, !window.matchMedia(REDUCED_MOTION).matches);
      return;
    }
    const patch = phoneViewPatch(ui.view, id);
    if (patch === null) return;
    setUi(patch);
    haptic("selection");
  };
  const tabBar = useNativeTabBar({ selected: ui.view, hidden: !planOpen || sheetOpen, tint }, pick, planOpen);
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
          tabBar={tabBar}
        />
        {plans && (
          <PlansSheet
            registry={p.registry}
            selected={ui.plan}
            hasPlan={session !== null}
            files={files}
            error={sheetError}
            onNew={newFromSheet}
            onOpen={openPlan}
            onTrash={trash}
            onPurge={setPurging}
            asking={usesNativeAlert() && purging !== null}
            onMoveAll={moveAll}
            onSync={openSync}
            onClose={closePlans}
          />
        )}
        {purging !== null && <PurgeConfirm registry={p.registry} id={purging} frame="sheet" onClose={() => setPurging(null)} />}
        {ui.settings !== null && (
          <Settings
            frame="sheet"
            section={ui.settings}
            root={ui.settingsRoot}
            onRoot={(r) => setUi({ settingsRoot: r })}
            row={ui.settingsRow}
            onRowShown={() => setUi({ settingsRow: null })}
            session={session}
            readOnly={session === null ? false : session.readOnly}
            clock={p.clock}
            hover={hover}
            closer={settingsCloser}
            files={files}
            onSection={(s) => setUi({ settings: s })}
            syncPane={ui.syncPane}
            onClose={() => setUi({ settings: null, settingsRow: null, settingsRoot: false, syncPane: null })}
            onSyncPane={(pane) => setUi({ syncPane: pane })}
            onTrashPlan={trash}
          />
        )}
        <ConvertedReport frame="sheet" />
        <Toasts />
      </div>
    </OpenChoice.Provider>
  );
}

export function PhoneShell(p: { registry: Registry; clock: Clock }) {
  const tab = useDevice().prefs.tab;
  const [ui, setUi] = useUi(tab);
  const uiValue = useMemo(() => ({ ui, setUi }), [ui, setUi]);
  return (
    <UiContext.Provider value={uiValue}>
      <PhoneBody registry={p.registry} clock={p.clock} />
    </UiContext.Provider>
  );
}
