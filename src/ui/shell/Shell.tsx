import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
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
import { Sheet } from "../common/Sheet";
import { detailsOf } from "../common/errorText";
import { toast, Toasts } from "../common/Toast";
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
import { Timeline } from "../timeline/Timeline";
import { toastRemoteTrash } from "../trashed";
import { HolidayState } from "./HolidayState";
import { canReload, stopsArrival } from "../../sync/reload";
import { docName, useSyncState } from "../../sync/SyncProvider";
import { RemovedBanner } from "../sync/RemovedBanner";
import { SyncActionButtons, SyncDialog, syncMessage } from "../sync/SyncDialog";
import { FILES_STAY, PlanFailed, ReloadButton } from "./PlanFailed";
import { PlanHead } from "./PlanHead";
import { PlanMenu } from "./PlanMenu";
import { PLAN_OVERLAY_CLASS, PlanOverlay } from "./PlanOverlay";
import { useShellShape, type PlanListMode, type ToolbarTier } from "./planListMode";
import { ConvertedReport } from "./ConvertedReport";
import { PurgeConfirm } from "./PurgeConfirm";
import { ReloadConfirm } from "./ReloadConfirm";
import { moveAllToSpace } from "./moving";
import { messageOf, restorePlan, usePlanFiles, usePlanSelection } from "./selection";
import { ExampleButton, NewPlanButton, PLAN_LIST_ID, Sidebar } from "./Sidebar";
import { listAttention } from "./sidebarAttention";
import { SidebarResizer, useSidebarMax } from "./SidebarResizer";
import { appliedWidth } from "./sidebarWidth";
import { Toolbar } from "./Toolbar";
import { Tray } from "./Tray";
import { useUpdates, useUpdateState } from "./UpdateLine";
import { useNativeBackground, useTheme } from "../../theme/ThemeContext";

export interface ShellProps {
  registry: Registry;
  clock: Clock;
}

type CompactSheet = "plans" | "plan" | null;

type WideMode = Exclude<PlanListMode, "phone">;

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
    const inList = (el: Element | null): boolean => openersFrom(el).some((x) => x.closest(`#${PLAN_LIST_ID}, .sidebar-resizer`) !== null);
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

function WideBody(p: ShellProps & { listMode: WideMode; tier: ToolbarTier | null }) {
  const registry = p.registry;
  const listMode = p.listMode;
  const compact = listMode !== "column";
  const { state: syncState } = useSyncState();
  const updates = useUpdates();
  const updateState = useUpdateState(updates);
  const listMax = useSidebarMax();
  const sidebarButton = useRef<HTMLButtonElement>(null);
  const focusLeftList = useRef(false);
  const appBody = useRef<HTMLDivElement>(null);
  const { ui, setUi } = useUiValue();
  const theme = useTheme();
  const [overlayAsked, setOverlayAsked] = useState(false);
  const overlayOpen = listMode === "overlay" && overlayAsked;
  const toggleOverlay = useCallback(() => setOverlayAsked((open) => !open), []);
  const closeOverlay = useCallback(() => setOverlayAsked(false), []);
  const { main, open: selectPlan, trashOwn } = usePlanSelection(registry);
  const openPlan = useCallback(
    (id: PlanId): void => {
      selectPlan(id);
      closeOverlay();
    },
    [selectPlan, closeOverlay],
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
  const overlayDroppedFocus = useRef(false);
  useEffect(() => {
    if (listMode !== "overlay") setOverlayAsked(false);
  }, [listMode]);
  const selectedItem = useRef<ItemId | null>(ui.selected);

  const session = main.k === "open" && main.id === ui.plan ? main.session : null;

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
    overlay: { open: overlayOpen, toggle: toggleOverlay },
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
  useLayoutEffect(() => {
    ctxRef.current = ctx;
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
      const dialog = c.ui.dialog !== null || document.querySelector(`[aria-modal="true"]:not(.${PLAN_OVERLAY_CLASS})`) !== null;
      if (e.key === "Escape" && c.ui.settings !== null && !dialog && !typing) {
        e.preventDefault();
        closeSettings(c.theme, () => c.setUi({ settings: null }));
        return;
      }
      const id = keyToCommand(e, { command: c.command, typing, dialog, selected: c.ui.selected !== null, listMode: c.listMode });
      if (id === null || (c.overlay.open && !dialog && id !== "sidebar" && id !== "palette")) return;
      if (id === "close-dialog" || id === "deselect") {
        c.setUi(id === "close-dialog" ? { dialog: null } : { selected: null });
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
            {ui.view === "timeline" && <Timeline session={session} readOnly={readOnly} />}
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
    if (!compact) setSheet(null);
  }, [compact]);
  useEffect(() => {
    if (listMode !== "sheet" && sheet === "plans") setSheet(null);
  }, [listMode, sheet]);
  useEffect(() => {
    if (compact && ui.settings !== null) setSheet(null);
  }, [compact, ui.settings]);
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
  const sheets = compact && ui.dialog === null && (
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

  const listShown = !compact && ui.sidebarOpen;
  const listWidth = listShown ? appliedWidth(ui.sidebarWidth, listMax) : null;
  useLayoutEffect(() => {
    if (listShown || !focusLeftList.current) return;
    focusLeftList.current = false;
    const button = sidebarButton.current;
    if (button === null) throw new Error("Shell: focus left the plan list, but the toolbar has no plan list button to take it");
    button.focus();
  }, [listShown]);
  useLayoutEffect(() => {
    if (!overlayDroppedFocus.current) return;
    overlayDroppedFocus.current = false;
    const button = sidebarButton.current;
    if (button === null) throw new Error("Shell: the plan list overlay left with focus, but the toolbar has no plan list button to take it");
    button.focus();
  }, [listMode]);
  const listOpen = listMode === "overlay" ? overlayOpen : ui.sidebarOpen;
  const attention = listAttention({ open: listOpen, plans, failures: registry.failures(), selected: sel, update: updateState });
  const sidebarToggle =
    listMode === "column"
      ? { open: ui.sidebarOpen, attention, button: sidebarButton, onToggle: () => setUi({ sidebarOpen: !ui.sidebarOpen }) }
      : listMode === "overlay"
        ? { open: overlayOpen, attention, button: sidebarButton, onToggle: toggleOverlay }
        : null;

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
          compact={compact ? { button: sidebarButton, onPlans: () => setSheet("plans"), onPlan: () => setSheet("plan") } : null}
          sidebar={sidebarToggle}
        />
        <div ref={appBody} className="app-body" style={listWidth === null ? undefined : { "--sidebar-w": `${listWidth}px` }}>
          {listShown && (
            <ShownList
              onFocusOut={() => {
                focusLeftList.current = true;
              }}
            >
              {sidebar}
              <SidebarResizer width={listWidth} max={listMax} body={appBody} onCommit={(width) => setUi({ sidebarWidth: width })} />
            </ShownList>
          )}
          <main className="main" inert={overlayOpen}>
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
          {listMode === "overlay" && (
            <PlanOverlay
              open={overlayOpen}
              button={sidebarButton}
              onClose={closeOverlay}
              onFocusDropped={() => {
                overlayDroppedFocus.current = true;
              }}
            >
              {sidebar}
            </PlanOverlay>
          )}
          {!compact && (session !== null || ui.settings !== null) && (
            <div className="slot slot-panel" data-slot="panel">
              {ui.settings !== null ? (
                settingsPanel("panel", ui.settings)
              ) : session === null ? null : selectedItemShown !== null ? (
                itemPanel(selectedItemShown, session)
              ) : (
                <PlanPanel session={session} readOnly={readOnly} />
              )}
            </div>
          )}
        </div>
        {sheets}
        {compact && ui.settings !== null && settingsPanel("sheet", ui.settings)}
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

function WideShell(p: ShellProps & { listMode: WideMode; tier: ToolbarTier | null }) {
  const [ui, setUi] = useUi();
  const uiValue = useMemo(() => ({ ui, setUi }), [ui, setUi]);
  return (
    <UiContext.Provider value={uiValue}>
      <WideBody registry={p.registry} clock={p.clock} listMode={p.listMode} tier={p.tier} />
    </UiContext.Provider>
  );
}

export function Shell(p: ShellProps) {
  const { mode: listMode, tier } = useShellShape();
  useNativeBackground(p.registry.device.platform);
  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      const error: unknown = e.error;
      if (error === null || error === undefined) return;
      toast(messageOf(error), "bad", detailsOf(error));
    };
    const onRejection = (e: PromiseRejectionEvent): void => {
      toast(messageOf(e.reason), "bad", detailsOf(e.reason));
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  if (listMode === "phone") return <PhoneShell registry={p.registry} clock={p.clock} />;
  return <WideShell registry={p.registry} clock={p.clock} listMode={listMode} tier={tier} />;
}
