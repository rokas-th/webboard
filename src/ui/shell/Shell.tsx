import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Refused } from "../../actions/intents";
import type { ItemId, PlanId } from "../../domain/model";
import { usesNativeAlert } from "../../services/alert";
import type { Clock } from "../../services/clock";
import { AppError } from "../../services/ipc";
import { SPACE_PREFIX } from "../../store/plan-id";
import type { PlanListing, Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { readPlatform, shortcutsUseCommand } from "../../platform";
import { openersFrom } from "../common/Dialog";
import { closeTopOverlay } from "../common/dismiss";
import { Sheet } from "../common/Sheet";
import { detailsOf } from "../common/errorText";
import { takeHapticFault } from "../../services/haptics";
import { toast, Toasts, toastWithoutHaptic } from "../common/Toast";
import { revealPatch } from "../choices/HeadCounts";
import { commands, type CommandCtx } from "../palette/commands";
import { isTyping, keyToCommand } from "../palette/keymap";
import { Palette } from "../palette/Palette";
import { PhoneShell } from "../phone/PhoneShell";
import { OpenChoice, runWith } from "../run";
import { UiContext, useUi, useUiValue, type SettingsTab } from "../state";
import { Board } from "../board/Board";
import { CalendarDialog } from "../calendar/CalendarDialog";
import { ChoiceDialog } from "../choices/ChoiceDialog";
import { ghostIds } from "../ghosts";
import { List } from "../list/List";
import { RevertDialog } from "../panel/History";
import { ItemPanel } from "../panel/ItemPanel";
import { PlanPanel } from "../panel/PlanPanel";
import { PrintSheet } from "../print/PrintSheet";
import { startPrint } from "../print/start";
import { useCanHover } from "../theme/ThemePanel";
import { closeSettings, SettingsPanel } from "../settings/SettingsPanel";
import { Timeline, type OutlineControl } from "../timeline/Timeline";
import { toastRemoteTrash } from "../trashed";
import { HolidayState } from "./HolidayState";
import { ListEdge } from "./ListEdge";
import { canReload, stopsArrival } from "../../sync/reload";
import { docName, useSyncState } from "../../sync/SyncProvider";
import { RemovedBanner } from "../sync/RemovedBanner";
import { SyncActionButtons, SyncDialog, syncMessage } from "../sync/SyncDialog";
import { FILES_STAY, PlanFailed, ReloadButton } from "./PlanFailed";
import { PlanHead } from "./PlanHead";
import { PlanMenu } from "./PlanMenu";
import { PaneDivider } from "./PaneDivider";
import { PANE_LIMITS, paneLayout } from "./paneLayout";
import { paneDevice, usePanes, type PaneDevice, type PaneKey, type PaneSet, type PaneState } from "./panes";
import { NOT_A_PANE_OVERLAY, PaneOverlay } from "./PlanOverlay";
import { useShellShape, type PlanListMode, type ToolbarTier } from "./planListMode";
import { ConvertedReport } from "./ConvertedReport";
import { PurgeConfirm } from "./PurgeConfirm";
import { ReloadConfirm } from "./ReloadConfirm";
import { moveAllToSpace } from "./moving";
import { messageOf, restorePlan, usePlanFiles, usePlanSelection } from "./selection";
import { ExampleButton, INSPECTOR_ID, NewPlanButton, PLAN_LIST_ID, Sidebar } from "./Sidebar";
import { listAttention } from "./sidebarAttention";
import { Toolbar } from "./Toolbar";
import { Tray } from "./Tray";
import { useUpdates, useUpdateState } from "./UpdateLine";
import { useNativeBackground, useNativeScheme, useTheme } from "../../theme/ThemeContext";

export interface ShellProps {
  registry: Registry;
  clock: Clock;
}

type CompactSheet = "plans" | "plan" | null;

type WideMode = Exclude<PlanListMode, "phone">;

type Drawer = Exclude<PaneKey, "outline">;

const DRAWER_PASS: ReadonlySet<string> = new Set(["sidebar", "inspector", "outline", "palette"]);

interface WindowSize {
  w: number;
  h: number;
}

const subscribeResize = (cb: () => void): (() => void) => {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
};

function stylesheetListWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w").trim();
  const px = /^(\d+(?:\.\d+)?)px$/.exec(raw);
  if (px === null) throw new Error(`list pane: the stylesheet's --sidebar-w is ${JSON.stringify(raw)}, not a px length`);
  return Number(px[1]);
}

function wideDevice(size: WindowSize): PaneDevice {
  const device = paneDevice(readPlatform(window), size.w, size.h);
  if (device === "phone") throw new Error("Shell: the wide shell has no pane record for a phone");
  return device;
}

function itemName(s: PlanSession, id: ItemId): string {
  const it = s.view().plan.items.get(id);
  if (it === undefined) throw new Error(`Shell: no item ${id}`);
  return it.name;
}

function Banner(p: { message: string; children?: ReactNode }) {
  return (
    <div className="banner bad">
      <span className="banner-text">{p.message}</span>
      {p.children}
    </div>
  );
}

function IndexBanner(p: { registry: Registry; error: AppError }) {
  const reloadable = canReload(useSyncState().state);
  const [confirm, setConfirm] = useState<string | null>(null);
  const doc = p.registry.indexErrorDoc();
  const space = p.error.code === "store.corrupt" && doc !== null && doc.startsWith(SPACE_PREFIX) ? doc : null;
  const readOnly = p.registry.spaceReadOnly();
  const offer = space !== null && !readOnly ? space : null;
  const asking = usesNativeAlert() && offer !== null && (confirm !== null || p.registry.reloading(offer));
  return (
    <Banner message={p.error.message}>
      <button type="button" className="button-small" disabled={asking} onClick={() => void p.registry.retryIndex()}>
        Try again
      </button>
      {offer !== null && <ReloadButton enabled={reloadable} small asking={asking} onOpen={() => setConfirm(offer)} />}
      {space !== null && readOnly && <span className="banner-note">{FILES_STAY}</span>}
      {confirm !== null && <ReloadConfirm registry={p.registry} docId={confirm} offered={offer === confirm} onClose={() => setConfirm(null)} />}
    </Banner>
  );
}

function ShownList(p: { children: ReactNode; onFocusOut(): void }) {
  const onFocusOut = useRef(p.onFocusOut);
  useLayoutEffect(() => {
    onFocusOut.current = p.onFocusOut;
  });
  useLayoutEffect(() => {
    const inList = (el: Element | null): boolean => openersFrom(el).some((x) => x.closest(`#${PLAN_LIST_ID}, [data-pane-divider="list"]`) !== null);
    let last = inList(document.activeElement);
    const onFocusIn = (e: FocusEvent): void => {
      last = inList(e.target instanceof Element ? e.target : null);
    };
    const onBlurOut = (e: FocusEvent): void => {
      if (e.relatedTarget !== null) return;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) last = false;
      });
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onBlurOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onBlurOut);
      const active = document.activeElement;
      if (active === null || active === document.body ? last : inList(active)) onFocusOut.current();
    };
  }, []);
  return <>{p.children}</>;
}

function WideBody(p: ShellProps & { listMode: WideMode; tier: ToolbarTier | null; size: WindowSize }) {
  const registry = p.registry;
  const listMode = p.listMode;
  const sheetBase = listMode === "sheet";
  const { state: syncState } = useSyncState();
  const updates = useUpdates();
  const updateState = useUpdateState(updates);
  const sidebarButton = useRef<HTMLButtonElement>(null);
  const inspectorButton = useRef<HTMLButtonElement>(null);
  const focusLeftList = useRef(false);
  const appBody = useRef<HTMLDivElement>(null);
  const { ui, setUi } = useUiValue();
  const theme = useTheme();
  const size = p.size;
  const listDefault = useSyncExternalStore(subscribeResize, stylesheetListWidth);
  const device = wideDevice(size);
  const { panes, setPane } = usePanes(device);
  const [drawerAsked, setDrawerAsked] = useState<Drawer | null>(null);
  const closeDrawer = useCallback(() => setDrawerAsked(null), []);
  const { main, open: selectPlan, trashOwn } = usePlanSelection(registry);
  const openPlan = useCallback(
    (id: PlanId): void => {
      selectPlan(id);
      closeDrawer();
    },
    [selectPlan, closeDrawer],
  );
  const files = usePlanFiles(registry, openPlan);
  const { creating, importing, importPlan } = files;
  const [namingPlan, setNamingPlan] = useState<PlanId | null>(null);
  const newPlan = (): void => files.newPlan("New plan", (message) => toast(message, "bad"), setNamingPlan);
  const newExample = (): void => files.newExample((message) => toast(message, "bad"));
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const [sheet, setSheet] = useState<CompactSheet>(null);
  const [printing, setPrinting] = useState(false);
  const [purging, setPurging] = useState<PlanId | null>(null);
  const drawerDroppedFocus = useRef<Drawer | null>(null);
  const selectedItem = useRef<ItemId | null>(ui.selected);

  const session = main.k === "open" && main.id === ui.plan ? main.session : null;

  const timeline = session !== null && ui.view === "timeline";
  const inspectorHolds = session !== null || ui.settings !== null;
  const layoutOf = (set: PaneSet) =>
    paneLayout({ window: size.w, base: listMode, timeline, panes: inspectorHolds ? set : { ...set, inspector: { ...set.inspector, open: false } }, listDefault });
  const layout = layoutOf(panes);
  const listDrawer = drawerAsked === "list" && layout.list.mode === "overlay";
  const inspectorDrawer = drawerAsked === "inspector" && layout.inspector.mode === "overlay" && session !== null;
  const drawerOpen = listDrawer || inspectorDrawer;
  useEffect(() => {
    if (drawerAsked === "list" && !listDrawer) setDrawerAsked(null);
    if (drawerAsked === "inspector" && !inspectorDrawer) setDrawerAsked(null);
  }, [drawerAsked, listDrawer, inspectorDrawer]);

  const commitPane = (key: PaneKey, next: PaneState): void => {
    if (key === "inspector" && !next.open && ui.settings !== null) closeSettings(theme, () => setUi({ settings: null }));
    setPane(key, next);
    if (device === "desk" && key === "list") setUi({ sidebarOpen: next.open, sidebarWidth: next.w });
  };
  const closeInspectorDrawer = (): void => {
    closeDrawer();
    setUi({ selected: null });
  };
  const togglePane = (key: Drawer): void => {
    const slot = layout[key];
    if (slot.mode === "sheet") throw new Error(`Shell: the ${key} pane has no toggle in the sheet form`);
    if (slot.mode === "overlay") {
      if (key === "inspector" && inspectorDrawer) closeInspectorDrawer();
      else setDrawerAsked((d) => (d === key ? null : key));
      return;
    }
    const was = panes[key];
    if (slot.mode === "column") {
      commitPane(key, { open: false, w: was.w });
      return;
    }
    const next: PaneState = { open: true, w: was.w };
    commitPane(key, next);
    if (layoutOf({ ...panes, [key]: next })[key].mode === "overlay") setDrawerAsked(key);
  };
  const toggleOutline = (): void => commitPane("outline", { open: !panes.outline.open, w: panes.outline.w });
  const outline: OutlineControl = {
    open: layout.outline.open,
    width: layout.outline.w,
    stored: panes.outline.w,
    min: PANE_LIMITS.outline.min,
    max: layout.caps.outline,
    def: PANE_LIMITS.outline.def,
    phone: false,
    onCommit: (next) => commitPane("outline", next),
  };
  const listOpen = layout.list.mode === "column" || listDrawer;
  const inspectorOpen = layout.inspector.mode === "column" || inspectorDrawer;

  const seenSelection = useRef<ItemId | null>(ui.selected);
  const inspectorMode = layout.inspector.mode;
  useEffect(() => {
    const was = seenSelection.current;
    seenSelection.current = ui.selected;
    if (ui.selected === null || ui.selected === was || inspectorMode !== "overlay") return;
    setDrawerAsked("inspector");
  }, [ui.selected, inspectorMode]);

  const seenSettings = useRef(ui.settings);
  const revealInspector = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    revealInspector.current = () => {
      if (listMode === "column" && !panes.inspector.open) commitPane("inspector", { open: true, w: panes.inspector.w });
    };
  });
  useLayoutEffect(() => {
    const was = seenSettings.current;
    seenSettings.current = ui.settings;
    if (was === null && ui.settings !== null) revealInspector.current();
  }, [ui.settings]);

  useEffect(() => {
    selectedItem.current = ui.selected;
  }, [ui.selected]);

  useEffect(() => {
    if (session === null || ui.selected === null || session.view().plan.items.has(ui.selected)) return;
    selectedItem.current = null;
    setUi({ selected: null });
  }, [session, ui.selected, tick, setUi]);

  useEffect(() => {
    if (session === null) return;
    const letGo = (): void => {
      const item = selectedItem.current;
      if (item === null) return;
      const view = session.view();
      const it = view.plan.items.get(item);
      if (it === undefined || !it.trashed || ghostIds(view).has(item)) return;
      selectedItem.current = null;
      setUi({ selected: null });
      toastRemoteTrash(session, item, registry.device.deviceId);
    };
    return session.subscribe(() => {
      bump();
      letGo();
    });
  }, [session, setUi, registry]);

  const openChoice = useCallback(
    (choice: string, side?: string) => setUi({ dialog: side === undefined ? { t: "choice", id: choice } : { t: "choice", id: choice, side } }),
    [setUi],
  );

  const closeDialog = useCallback(() => setUi({ dialog: null }), [setUi]);

  const clearNaming = useCallback(() => setUi({ naming: null }), [setUi]);

  const clearPlanNaming = useCallback(() => setNamingPlan(null), []);

  const plans = registry.plans();
  const listingOf = (id: PlanId): PlanListing | undefined => plans.find((l) => l.id === id);

  const moveToSpace = (id: PlanId): void => {
    try {
      registry.movePlanToSpace(id);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      toast(e.message, "bad");
      return;
    }
    toast("Moved to the space");
  };

  const moveAll = (ids: readonly PlanId[]): void => moveAllToSpace(registry, ids);

  const sel = ui.plan;
  const listing = sel === null ? undefined : listingOf(sel);
  const failure = sel === null ? undefined : registry.failures().get(sel);
  const indexError = registry.indexError();
  const settingsError = registry.settingsError();
  const readOnly = session?.readOnly ?? false;
  const platform = registry.device.platform;
  const mac = platform === "macos";
  const command = shortcutsUseCommand(readPlatform(window).os);
  const print = (): void => {
    void startPrint(platform, setPrinting);
  };

  const runner = useMemo(() => (session === null ? null : runWith(session, openChoice)), [session, openChoice]);

  const reveal = (target: ItemId | "today"): void => {
    if (target === "today") {
      setUi({ view: "timeline", reveal: "today" });
      return;
    }
    if (session === null) throw new Error("Shell: nothing to reveal without an open plan");
    setUi(revealPatch(session.view(), ui.collapsed, target));
  };

  const ctx: CommandCtx = {
    session,
    registry,
    ui,
    setUi,
    run: runner === null ? null : runner.run,
    undo: runner === null ? null : runner.undo,
    redo: runner === null ? null : runner.redo,
    readOnly,
    command,
    listMode,
    list: { open: listOpen, toggle: () => togglePane("list") },
    inspector: sheetBase ? null : { open: inspectorOpen, toggle: () => togglePane("inspector") },
    outline: { open: panes.outline.open, toggle: toggleOutline },
    clock: p.clock,
    select: openPlan,
    newPlan,
    newExample,
    reveal,
    print,
    updates,
    theme,
  };
  const ctxRef = useRef(ctx);
  const drawerRef = useRef(drawerOpen);
  useLayoutEffect(() => {
    ctxRef.current = ctx;
    drawerRef.current = drawerOpen;
  });

  const runCommand = useCallback((id: string): void => {
    const cmd = commands(ctxRef.current).find((c) => c.id === id);
    if (cmd === undefined) throw new Error(`Shell: no command ${id} here`);
    cmd.run();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const c = ctxRef.current;
      const target = e.target instanceof Element ? e.target : null;
      if (target !== null && target.closest('[role="menu"]') !== null && e.key !== "Escape") return;
      const typing = isTyping(e.target, e.key);
      const dialog = c.ui.dialog !== null || document.querySelector(`[aria-modal="true"]${NOT_A_PANE_OVERLAY}`) !== null;
      if (e.key === "Escape" && c.ui.settings !== null && !dialog && !typing) {
        e.preventDefault();
        closeSettings(c.theme, () => c.setUi({ settings: null }));
        return;
      }
      const id = keyToCommand(e, { command: c.command, typing, dialog, selected: c.ui.selected !== null, listMode: c.listMode });
      if (id === null || (drawerRef.current && !dialog && !DRAWER_PASS.has(id))) return;
      if (id === "close-dialog") {
        if (!closeTopOverlay()) c.setUi({ dialog: null });
        return;
      }
      if (id === "deselect") {
        c.setUi({ selected: null });
        return;
      }
      const cmd = commands(c).find((x) => x.id === id);
      if (cmd === undefined) return;
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const content = (() => {
    if (sel === null) {
      return (
        <div className="empty-state">
          <div className="empty-actions">
            <NewPlanButton creating={creating} onNew={() => newPlan()} />
            <ExampleButton creating={creating} onExample={newExample} />
            <button type="button" disabled={importing} onClick={importPlan}>
              {importing ? <span className="dim">Importing…</span> : "Import plan…"}
            </button>
            <button type="button" onClick={() => setUi({ dialog: { t: "sync", pane: "join" } })}>
              Join with a code
            </button>
            <button type="button" onClick={() => setUi({ dialog: { t: "sync", pane: "setup" } })}>
              Set up sync
            </button>
          </div>
        </div>
      );
    }
    if (failure !== undefined && (session === null || (listing !== undefined && !listing.loaded))) {
      return <PlanFailed registry={registry} id={sel} error={failure} onTrash={(id) => void trashOwn(id)} />;
    }
    if (main.k === "incomplete" && main.id === sel) {
      if (!stopsArrival(syncState, sel)) return <p className="main-note">{main.message}</p>;
      return (
        <div className="plan-stopped">
          <p className="sync-message bad">{syncMessage(syncState, docName(registry))}</p>
          <SyncActionButtons holds={false}>
            <button type="button" onClick={() => setUi({ dialog: { t: "sync", pane: null } })}>
              Open sync
            </button>
          </SyncActionButtons>
        </div>
      );
    }
    if ((main.k === "failed" || main.k === "error") && main.id === sel) {
      return (
        <Banner message={main.k === "failed" ? main.error.message : main.message}>
          <button type="button" className="button-small" onClick={() => openPlan(sel)}>
            Try again
          </button>
        </Banner>
      );
    }
    if (session === null) return null;
    return (
      <>
        {failure !== undefined && (
          <Banner message={failure.message}>
            <button type="button" className="button-small" onClick={() => void registry.retryPlan(sel)}>
              Try again
            </button>
          </Banner>
        )}
        <PlanHead
          session={session}
          local={registry.device.name}
          readOnly={readOnly}
          naming={namingPlan === session.view().plan.id}
          onNamed={clearPlanNaming}
          onChoose={(choice) => openChoice(choice)}
          menu={(open, setOpen) => (
            <PlanMenu
              session={session}
              registry={registry}
              open={open}
              onOpenChange={setOpen}
              onOpen={(id) => openPlan(id)}
              {...(platform === "ios" ? {} : { onPrint: print })}
            />
          )}
        >
          <HolidayState session={session} registry={registry} clock={p.clock} />
        </PlanHead>
        <div className="view">
          <div className="slot" data-slot={ui.view}>
            {ui.view === "timeline" && <Timeline session={session} outline={outline} readOnly={readOnly} />}
            {ui.view === "board" && <Board session={session} readOnly={readOnly} />}
            {ui.view === "list" && <List session={session} />}
          </div>
          {ui.view === "timeline" && <Tray session={session} readOnly={readOnly} />}
        </div>
      </>
    );
  })();

  const sidebar = (
    <Sidebar
      registry={registry}
      plans={plans}
      selected={sel}
      creating={creating}
      onNew={() => {
        setSheet(null);
        newPlan();
      }}
      onSelect={(id) => {
        setSheet(null);
        openPlan(id);
      }}
      onTrash={(id) => void trashOwn(id)}
      onRestore={(id) => restorePlan(registry, id)}
      onPurge={setPurging}
      asking={usesNativeAlert() && purging !== null}
      onMove={moveToSpace}
      onMoveAll={moveAll}
    />
  );

  const selectedItemShown = session !== null && ui.selected !== null && session.view().plan.items.has(ui.selected) ? ui.selected : null;
  const itemPanel = (item: ItemId, s: PlanSession) => (
    <ItemPanel key={item} session={s} item={item} local={registry.device.name} command={command} readOnly={readOnly} naming={ui.naming === item} onNamed={clearNaming} />
  );
  const closeSheet = (): void => setSheet(null);
  useEffect(() => {
    if (session === null && sheet === "plan") setSheet(null);
  }, [session, sheet]);
  useEffect(() => {
    if (!sheetBase) setSheet(null);
  }, [sheetBase]);
  const settingsInColumn = ui.settings !== null && listMode === "column" && layout.inspector.mode === "column";
  const settingsSheet = ui.settings !== null && (listMode !== "column" || layout.inspector.mode === "overlay");
  useEffect(() => {
    if (settingsSheet) setSheet(null);
  }, [settingsSheet]);
  const hover = useCanHover();
  const settingsPanel = (frame: "panel" | "sheet", tab: SettingsTab) => (
    <SettingsPanel
      frame={frame}
      tab={tab}
      hover={hover}
      onTab={(t) => setUi({ settings: t })}
      onClose={() => setUi({ settings: null })}
      onSync={(pane) => setUi({ settings: null, dialog: { t: "sync", pane } })}
    />
  );
  const sheets = sheetBase && ui.dialog === null && (
    <>
      <Sheet open={sheet === "plans"} title="Plans" onClose={closeSheet}>
        {sidebar}
      </Sheet>
      {session !== null && (
        <Sheet open={sheet === "plan"} title="Plan" onClose={closeSheet}>
          <PlanPanel session={session} readOnly={readOnly} />
        </Sheet>
      )}
      {session !== null && selectedItemShown !== null && (
        <Sheet key={selectedItemShown} open={sheet === null && ui.settings === null} title={itemName(session, selectedItemShown)} onClose={() => setUi({ selected: null })}>
          {itemPanel(selectedItemShown, session)}
        </Sheet>
      )}
    </>
  );

  const listColumn = layout.list.mode === "column" ? layout.list.w : null;
  const inspectorColumn = layout.inspector.mode === "column" && (session !== null || settingsInColumn) ? layout.inspector.w : null;
  const listDrawerW = layout.list.mode === "overlay" ? layout.list.w : null;
  const inspectorDrawerW = layout.inspector.mode === "overlay" ? layout.inspector.w : null;
  const listEdge = device !== "desk" && layout.list.mode === "overlay" && !drawerOpen;
  const listShown = listColumn !== null;
  useLayoutEffect(() => {
    if (listShown || !focusLeftList.current) return;
    focusLeftList.current = false;
    const button = sidebarButton.current;
    if (button === null) throw new Error("Shell: focus left the plan list, but the toolbar has no plan list button to take it");
    button.focus();
  }, [listShown]);
  const listSlotMode = layout.list.mode;
  const inspectorButtonShown = !sheetBase && session !== null;
  useLayoutEffect(() => {
    const dropped = drawerDroppedFocus.current;
    if (dropped === null) return;
    drawerDroppedFocus.current = null;
    const toInspector = dropped === "inspector" && inspectorButtonShown;
    const button = toInspector ? inspectorButton.current : sidebarButton.current;
    if (button === null) throw new Error(`Shell: the ${dropped} drawer left with focus, but the toolbar has no ${toInspector ? "Inspector" : "plan list"} button to take it`);
    button.focus();
  }, [listMode, listSlotMode, inspectorMode, inspectorButtonShown]);
  const attention = listAttention({ open: listOpen, plans, failures: registry.failures(), selected: sel, update: updateState });
  const sidebarToggle = sheetBase ? null : { open: listOpen, attention, button: sidebarButton, onToggle: () => togglePane("list") };
  const inspectorToggle = sheetBase ? null : { open: inspectorOpen, button: inspectorButton, onToggle: () => togglePane("inspector") };
  const bodyStyle: CSSProperties = {
    ...(listColumn !== null && panes.list.w !== null ? { "--sidebar-w": `${listColumn}px` } : {}),
    ...(inspectorColumn !== null && panes.inspector.w !== null ? { "--panel-w": `${inspectorColumn}px` } : {}),
  };
  const inspectorBody = (s: PlanSession) => (selectedItemShown !== null ? itemPanel(selectedItemShown, s) : <PlanPanel session={s} readOnly={readOnly} />);

  return (
    <OpenChoice.Provider value={openChoice}>
      <div className="app">
        <Toolbar
          session={session}
          readOnly={readOnly}
          ui={ui}
          setUi={setUi}
          mac={mac}
          command={command}
          onCommand={runCommand}
          tier={p.tier}
          compact={sheetBase ? { button: sidebarButton, onPlans: () => setSheet("plans"), onPlan: () => setSheet("plan") } : null}
          sidebar={sidebarToggle}
          inspector={inspectorToggle}
        />
        <div ref={appBody} className="app-body" style={bodyStyle}>
          {listEdge && <ListEdge onOpen={() => setDrawerAsked("list")} />}
          {listColumn !== null && (
            <ShownList
              onFocusOut={() => {
                focusLeftList.current = true;
              }}
            >
              {sidebar}
              <PaneDivider
                pane="list"
                side="start"
                label="Resize the plan list"
                controls={PLAN_LIST_ID}
                className="sidebar-resizer"
                draggingClass="sidebar-dragging"
                cssVar="--sidebar-w"
                host={appBody}
                width={listColumn}
                stored={panes.list.w}
                min={PANE_LIMITS.list.min}
                max={layout.caps.list}
                def={listDefault}
                onCommit={(next) => commitPane("list", next)}
              />
            </ShownList>
          )}
          <main className="main" inert={drawerOpen}>
            <RemovedBanner session={session} />
            {indexError !== null && <IndexBanner registry={registry} error={indexError} />}
            {registry.indexUnreadable().map((line) => (
              <p key={line} className="banner bad">
                {line}
              </p>
            ))}
            {settingsError !== null && (
              <Banner message={settingsError.message}>
                <button type="button" className="button-small" onClick={() => void registry.retrySettings()}>
                  Try again
                </button>
              </Banner>
            )}
            {content}
          </main>
          {inspectorColumn !== null && (
            <>
              <PaneDivider
                pane="inspector"
                side="end"
                label="Resize the inspector"
                controls={INSPECTOR_ID}
                className="inspector-resizer"
                draggingClass="inspector-dragging"
                cssVar="--panel-w"
                host={appBody}
                width={inspectorColumn}
                stored={panes.inspector.w}
                min={PANE_LIMITS.inspector.min}
                max={layout.caps.inspector}
                def={PANE_LIMITS.inspector.def}
                onCommit={(next) => commitPane("inspector", next)}
              />
              <div id={INSPECTOR_ID} className="slot slot-panel" data-slot="panel">
                {ui.settings !== null ? settingsPanel("panel", ui.settings) : session === null ? null : inspectorBody(session)}
              </div>
            </>
          )}
          {listDrawerW !== null && (
            <PaneOverlay
              kind="plan"
              label="Plans"
              open={listDrawer}
              button={sidebarButton}
              width={listDrawerW}
              onClose={closeDrawer}
              onFocusDropped={() => {
                drawerDroppedFocus.current = "list";
              }}
            >
              {sidebar}
            </PaneOverlay>
          )}
          {inspectorDrawerW !== null && session !== null && (
            <PaneOverlay
              kind="inspector"
              label="Inspector"
              open={inspectorDrawer}
              button={inspectorButton}
              width={inspectorDrawerW}
              onClose={closeInspectorDrawer}
              onFocusDropped={() => {
                drawerDroppedFocus.current = "inspector";
              }}
            >
              <div id={INSPECTOR_ID} className="inspector-drawer-body">
                {inspectorBody(session)}
              </div>
            </PaneOverlay>
          )}
        </div>
        {sheets}
        {settingsSheet && ui.settings !== null && settingsPanel("sheet", ui.settings)}
        {session !== null && ui.dialog !== null && ui.dialog.t === "calendar" && (
          <CalendarDialog key={session.view().plan.id} session={session} registry={registry} clock={p.clock} onClose={() => setUi({ dialog: null })} />
        )}
        {session !== null && ui.dialog !== null && ui.dialog.t === "choice" && (
          <ChoiceDialog
            key={`${session.view().plan.id}:${ui.dialog.id}:${ui.dialog.side ?? ""}`}
            session={session}
            id={ui.dialog.id}
            side={ui.dialog.side}
            local={registry.device.name}
            onClose={closeDialog}
          />
        )}
        {session !== null && ui.dialog !== null && ui.dialog.t === "revert" && (
          <RevertDialog key={ui.dialog.id} session={session} id={ui.dialog.id} onClose={() => setUi({ dialog: null })} />
        )}
        {ui.dialog !== null && ui.dialog.t === "palette" && <Palette commands={commands(ctx)} onClose={closeDialog} />}
        {ui.dialog !== null && ui.dialog.t === "sync" && <SyncDialog pane={ui.dialog.pane} onPane={(pane) => setUi({ dialog: { t: "sync", pane } })} onClose={closeDialog} />}
        <ConvertedReport />
        {purging !== null && <PurgeConfirm registry={registry} id={purging} onClose={() => setPurging(null)} />}
        {printing && session !== null && <PrintSheet view={session.view()} onDone={() => setPrinting(false)} />}
        <Toasts />
      </div>
    </OpenChoice.Provider>
  );
}

function WideShell(p: ShellProps & { listMode: WideMode; tier: ToolbarTier | null; size: WindowSize }) {
  const [ui, setUi] = useUi();
  const uiValue = useMemo(() => ({ ui, setUi }), [ui, setUi]);
  return (
    <UiContext.Provider value={uiValue}>
      <WideBody registry={p.registry} clock={p.clock} listMode={p.listMode} tier={p.tier} size={p.size} />
    </UiContext.Provider>
  );
}

export function Shell(p: ShellProps) {
  const { mode: listMode, tier, window: size } = useShellShape();
  useNativeBackground(p.registry.device.platform);
  useNativeScheme();
  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      const error: unknown = e.error;
      if (error === null || error === undefined) return;
      toast(messageOf(error), "bad", detailsOf(error));
    };
    const onRejection = (e: PromiseRejectionEvent): void => {
      const show = takeHapticFault(e.reason) ? toastWithoutHaptic : toast;
      show(messageOf(e.reason), "bad", detailsOf(e.reason));
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  if (listMode === "phone") return <PhoneShell registry={p.registry} clock={p.clock} />;
  return <WideShell registry={p.registry} clock={p.clock} listMode={listMode} tier={tier} size={size} />;
}
