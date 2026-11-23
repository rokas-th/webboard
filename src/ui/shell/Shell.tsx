import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Refused } from "../../actions/intents";
import type { ItemId, PlanId } from "../../domain/model";
import { usesNativeAlert } from "../../services/alert";
import type { Clock } from "../../services/clock";
import { AppError } from "../../services/ipc";
import { SPACE_PREFIX } from "../../store/plan-id";
import type { PlanListing, Registry } from "../../store/registry";
import { useNotes, type PlanSession } from "../../store/session";
import { readPlatform, shortcutsUseCommand } from "../../platform";
import { openersFrom } from "../common/Dialog";
import { closeTopOverlay, commitFocus } from "../common/dismiss";
import { Sheet } from "../common/Sheet";
import { detailsOf } from "../common/errorText";
import { takeHapticFault } from "../../services/haptics";
import { toast, Toasts, toastWithoutHaptic } from "../common/Toast";
import { revealPatch } from "../choices/HeadCounts";
import { commands, type CommandCtx } from "../palette/commands";
import { isControl, isTyping, keyToCommand } from "../palette/keymap";
import { Palette } from "../palette/Palette";
import { PhoneShell } from "../phone/PhoneShell";
import { OpenChoice, runWith } from "../run";
import { UiContext, useUi, useUiValue, type SyncPane } from "../state";
import { Board } from "../board/Board";
import { ChoiceDialog } from "../choices/ChoiceDialog";
import { ghostIds } from "../ghosts";
import { List } from "../list/List";
import { RevertDialog } from "../panel/History";
import { PlanPanel } from "../panel/PlanPanel";
import { DetailContext, type DetailApi } from "../detail/DetailContext";
import { createClickPair, type ClickMark } from "../detail/clickPair";
import { ItemDetail, promoteText, type DetailContainer } from "../detail/ItemDetail";
import { ItemModal, rememberFocus, type FocusMemo } from "../detail/ItemModal";
import { useBoardPrefs } from "../board/prefs";
import { useListPrefs } from "../list/prefs";
import { GROUP_NO_STEP, noStepNumber, SELECTION_GONE } from "../board/text";
import { stepsOf } from "../../domain/steps";
import { firstMatch, stepPatch, tabSearch, type TabSearch } from "../detail/order";
import type { SearchProps } from "../search/SearchField";
import { countText } from "../search/text";
import { PrintSheet } from "../print/PrintSheet";
import { startPrint } from "../print/start";
import { useCanHover } from "../theme/ThemePanel";
import { settingsFrame } from "../settings/frame";
import { lastSection } from "../settings/lastSection";
import { Settings, type SettingsCloser } from "../settings/Settings";
import { Timeline, type OutlineControl } from "../timeline/Timeline";
import { toastRemoteTrash } from "../trashed";
import { HolidayState } from "./HolidayState";
import { ListEdge } from "./ListEdge";
import { canReload, stopsArrival } from "../../sync/reload";
import { docName, useSyncState } from "../../sync/SyncProvider";
import { RemovedBanner } from "../sync/RemovedBanner";
import { SyncActionButtons, syncMessage } from "../sync/SyncPanes";
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

const DRAWER_PASS: ReadonlySet<string> = new Set(["sidebar", "inspector", "outline", "palette", "settings"]);

const SETTINGS_PASSES = "[data-item-modal], [data-settings-modal]";

const INSPECTOR_DRAWER_PASS: ReadonlySet<string> = new Set(["select-next", "select-prev", "detail-modal", "detail-open", "rename"]);

const TO_STEP = /^to-step-([1-9])$/;

const NO_SEARCH: TabSearch = { order: [], match: null, count: null };

function toStepByKey(c: CommandCtx, n: number): void {
  if (c.session === null) throw new Error(`Shell: ⌥⌘${n} reached the shell without an open plan`);
  if (c.run === null) throw new Error("Shell: an open plan has no run");
  const sel = c.ui.selected;
  if (sel === null) throw new Error(`Shell: ⌥⌘${n} reached the shell without a selection`);
  const plan = c.session.view().plan;
  const item = plan.items.get(sel);
  if (item === undefined) {
    toast(SELECTION_GONE, "bad");
    return;
  }
  if (item.kind === "group") {
    toast(GROUP_NO_STEP, "bad");
    return;
  }
  const step = stepsOf(plan)[n - 1];
  if (step === undefined) {
    toast(noStepNumber(n), "bad");
    return;
  }
  c.run({ t: "toStep", items: [sel], step: step.id });
}

const drawerPasses = (drawer: Drawer | null, dialog: boolean, id: string): boolean =>
  drawer === null || dialog || DRAWER_PASS.has(id) || (drawer === "inspector" && INSPECTOR_DRAWER_PASS.has(id));

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
  const boardPrefs = useBoardPrefs(session === null ? null : session.view().plan.id);
  const listPrefs = useListPrefs(session === null ? null : session.view().plan.id);
  const notesSeen = useNotes(session, ui.query.trim() !== "" || (ui.view === "list" && listPrefs.cols.some((c) => c.id === "note")));
  const shownView = session === null ? null : session.view();
  const found = useMemo(
    () => (session === null || shownView === null ? NO_SEARCH : tabSearch(shownView, { view: ui.view, collapsed: ui.collapsed, query: ui.query }, boardPrefs, listPrefs, (id) => session.note(id).toString())),
    [session, shownView, ui.view, ui.collapsed, ui.query, boardPrefs, listPrefs, notesSeen],
  );
  const selectedItemShown = session !== null && ui.selected !== null && session.view().plan.items.has(ui.selected) ? ui.selected : null;
  const itemModal = session !== null && selectedItemShown !== null && ui.dialog !== null && ui.dialog.t === "item";
  const modalHidesInspector = itemModal;
  const settingsCloser = useRef<SettingsCloser | null>(null);

  const timeline = session !== null && ui.view === "timeline";
  const inspectorHolds = session !== null;
  const layoutOf = (set: PaneSet, hidden: boolean = modalHidesInspector) =>
    paneLayout({ window: size.w, base: listMode, timeline, panes: inspectorHolds && !hidden ? set : { ...set, inspector: { ...set.inspector, open: false } }, listDefault });
  const layout = layoutOf(panes);
  const listDrawer = drawerAsked === "list" && layout.list.mode === "overlay";
  const inspectorDrawer = drawerAsked === "inspector" && layout.inspector.mode === "overlay" && session !== null;
  const drawerOpen = listDrawer || inspectorDrawer;
  useEffect(() => {
    if (drawerAsked === "list" && !listDrawer) setDrawerAsked(null);
    if (drawerAsked === "inspector" && !inspectorDrawer) setDrawerAsked(null);
  }, [drawerAsked, listDrawer, inspectorDrawer]);

  const commitPane = (key: PaneKey, next: PaneState): void => {
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
  const seenSettings = useRef(ui.settings);
  const revealForSelection = useRef<() => void>(() => undefined);
  const modalUp = useRef(itemModal);
  const revealDetail = (): void => {
    const mode = layoutOf(panes, false).inspector.mode;
    if (mode === "overlay") {
      setDrawerAsked("inspector");
      return;
    }
    if (mode !== "closed") return;
    const next: PaneState = { open: true, w: panes.inspector.w };
    commitPane("inspector", next);
    if (layoutOf({ ...panes, inspector: next }, false).inspector.mode === "overlay") setDrawerAsked("inspector");
  };
  useLayoutEffect(() => {
    modalUp.current = itemModal;
    revealForSelection.current = revealDetail;
  });
  useEffect(() => {
    const was = seenSelection.current;
    seenSelection.current = ui.selected;
    if (ui.selected === null || ui.selected === was || modalUp.current) return;
    revealForSelection.current();
  }, [ui.selected]);
  useLayoutEffect(() => {
    const was = seenSettings.current;
    seenSettings.current = ui.settings;
    if (was !== null || ui.settings === null) return;
    setSheet(null);
    if (!modalUp.current) return;
    const modal = document.querySelector<HTMLElement>("[data-item-modal]");
    if (modal === null) throw new Error("Shell: Settings opened over the item modal, but the modal is not in the page");
    if (!commitFocus(modal, "The item modal")) {
      setUi({ settings: null });
      return;
    }
    setUi({ dialog: null });
  }, [ui.settings, setUi]);

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
  const openSync = (pane: SyncPane | null): void => setUi({ settings: "sync", syncPane: pane });

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

  const pair = useRef(createClickPair());
  const [focusMemo, setFocusMemo] = useState<FocusMemo | null>(null);
  const liveDetail = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-detail]:not([data-detail="modal"])');
  const scrollerOf = (detail: HTMLElement): HTMLElement => {
    const scroller = detail.closest<HTMLElement>(`#${INSPECTOR_ID}, .sheet-body`);
    if (scroller === null) throw new Error("Shell: the inspector's detail is outside #inspector and .sheet-body");
    return scroller;
  };
  const closeSettingsFirst = (): boolean => {
    if (ui.settings === null) return true;
    const close = settingsCloser.current;
    if (close === null) throw new Error("Shell: Settings is open but has no close to call");
    return close("x");
  };
  const toggleSettings = (): void => {
    if (ui.settings !== null) {
      closeSettingsFirst();
      return;
    }
    setUi({ settings: lastSection(window.localStorage, session !== null) });
  };
  const promote = (id: ItemId): void => {
    if (session === null || !session.view().plan.items.has(id)) throw new Error(`Shell: no item ${id} to open as a modal`);
    if (!closeSettingsFirst()) return;
    const detail = liveDetail();
    const memo = detail === null ? null : rememberFocus(detail, scrollerOf(detail));
    if (detail !== null && !flushSync(() => commitFocus(detail, "The inspector"))) return;
    setFocusMemo(memo);
    pair.current.reset();
    setDrawerAsked(null);
    setUi({ selected: id, dialog: { t: "item" } });
  };
  const closeItemModal = (): void => {
    setUi({ dialog: null });
    revealDetail();
  };
  const toggleModal = (): void => {
    if (itemModal) throw new Error("Shell: the item modal closes through its own keys and controls, not the command");
    if (ui.selected === null) throw new Error("Shell: no selection to open as a modal");
    promote(ui.selected);
  };
  const rename = (item?: ItemId): void => {
    const target = item ?? ui.selected;
    if (target === null) throw new Error("Shell: no selection to rename");
    if (session === null) throw new Error(`Shell: no open plan to rename ${target} in`);
    const it = session.view().plan.items.get(target);
    if (it === undefined) throw new Error(`Shell: no item ${target} to rename`);
    setUi(readOnly || it.trashed ? { selected: target } : { selected: target, naming: target });
    if (!itemModal) revealDetail();
  };
  const press = (m: ClickMark): void => {
    setUi(ui.view === "timeline" ? { selected: m.item, follow: m.item } : { selected: m.item });
    if (pair.current.press(m) === "double") promote(m.item);
  };
  const scrimPress = (x: number, y: number, at: number): boolean => {
    const item = ui.selected;
    if (item === null || pair.current.press({ item, x, y, at }) === "single") {
      pair.current.reset();
      return false;
    }
    promote(item);
    return true;
  };
  const deselected = ui.selected === null;
  useEffect(() => {
    pair.current.reset();
  }, [ui.view]);
  useEffect(() => {
    if (deselected) pair.current.reset();
  }, [deselected]);
  useEffect(() => {
    if (ui.dialog !== null && ui.dialog.t === "item" && selectedItemShown === null) setUi({ dialog: null });
  }, [ui.dialog, selectedItemShown, setUi]);
  const modalWas = useRef(itemModal);
  useEffect(() => {
    const was = modalWas.current;
    modalWas.current = itemModal;
    if (!was || itemModal) return;
    const back = liveDetail();
    if (back !== null) {
      back.focus();
      return;
    }
    if (ui.settings !== null || ui.dialog !== null || selectedItemShown === null) return;
    throw new Error("Shell: the item modal closed but no column, drawer or sheet detail came back to take focus");
  }, [itemModal, ui.settings, ui.dialog, selectedItemShown]);

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
    detail: session === null ? null : { promote, toggleModal, rename },
  };
  const ctxRef = useRef(ctx);
  const openDrawer: Drawer | null = listDrawer ? "list" : inspectorDrawer ? "inspector" : null;
  const drawerRef = useRef(openDrawer);
  const toggleRef = useRef(toggleSettings);
  useLayoutEffect(() => {
    ctxRef.current = ctx;
    drawerRef.current = openDrawer;
    toggleRef.current = toggleSettings;
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
      const modals = [...document.querySelectorAll(`[aria-modal="true"]${NOT_A_PANE_OVERLAY}`)];
      const dialog = c.ui.dialog !== null || modals.length > 0;
      const id = keyToCommand(e, { command: c.command, typing, dialog, selected: c.ui.selected !== null, control: isControl(e.target), listMode: c.listMode });
      if (id === null || !drawerPasses(drawerRef.current, dialog, id)) return;
      if (id === "settings") {
        const quiet = c.ui.dialog === null || c.ui.dialog.t === "item";
        const passes = modals.length === 0 || (modals.length === 1 && (c.ui.settings !== null || modals.every((m) => m.matches(SETTINGS_PASSES))));
        if (!quiet || !passes) return;
        e.preventDefault();
        toggleRef.current();
        return;
      }
      if (id === "detail-modal" && e.repeat) {
        e.preventDefault();
        return;
      }
      if (id === "close-dialog") {
        if (!closeTopOverlay()) c.setUi({ dialog: null });
        return;
      }
      if (id === "deselect") {
        c.setUi({ selected: null });
        return;
      }
      const stepKey = TO_STEP.exec(id);
      if (stepKey !== null) {
        e.preventDefault();
        toStepByKey(c, Number(stepKey[1]));
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
            <button type="button" onClick={() => openSync("join")}>
              Join with a code
            </button>
            <button type="button" onClick={() => openSync("setup")}>
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
            <button type="button" onClick={() => openSync(null)}>
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

  const closeColumn = (): void => {
    const column = document.querySelector<HTMLElement>(`#${INSPECTOR_ID} [data-detail="column"]`);
    if (column === null) throw new Error("Shell: the column X was pressed, but the column's detail is not in the page");
    if (!flushSync(() => commitFocus(column, "The inspector"))) return;
    const button = inspectorButton.current;
    if (button === null) throw new Error("Shell: the inspector column closed, but the toolbar has no Inspector button to take focus");
    commitPane("inspector", { open: false, w: panes.inspector.w });
    button.focus();
  };
  const promoted = promoteText(command);
  const itemDetail = (item: ItemId, s: PlanSession, container: Exclude<DetailContainer, "modal" | "sheet">) => (
    <ItemDetail
      session={s}
      item={item}
      container={container}
      local={registry.device.name}
      command={command}
      readOnly={readOnly}
      naming={ui.naming === item}
      onNamed={clearNaming}
      onExpand={() => promote(item)}
      expandLabel={promoted.label}
      expandTitle={promoted.title}
      {...(container === "column" ? { onClose: closeColumn } : {})}
    />
  );
  const closeSheet = (): void => setSheet(null);
  useEffect(() => {
    if (session === null && sheet === "plan") setSheet(null);
  }, [session, sheet]);
  useEffect(() => {
    if (!sheetBase) setSheet(null);
  }, [sheetBase]);
  const hover = useCanHover();
  const sheets = sheetBase && ui.dialog === null && (
    <>
      <Sheet open={sheet === "plans"} title="Plans" onClose={closeSheet}>
        {sidebar}
      </Sheet>
      {session !== null && (
        <Sheet open={sheet === "plan"} title="Plan" onClose={closeSheet}>
          <PlanPanel key={session.view().plan.id} session={session} readOnly={readOnly} />
        </Sheet>
      )}
      {session !== null && selectedItemShown !== null && (
        <Sheet open={sheet === null && ui.settings === null} title={itemName(session, selectedItemShown)} onClose={() => setUi({ selected: null })}>
          {itemDetail(selectedItemShown, session, "drawer")}
        </Sheet>
      )}
    </>
  );

  const listColumn = layout.list.mode === "column" ? layout.list.w : null;
  const inspectorColumn = layout.inspector.mode === "column" && session !== null ? layout.inspector.w : null;
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
    if (itemModal) return;
    const toInspector = dropped === "inspector" && inspectorButtonShown;
    const button = toInspector ? inspectorButton.current : sidebarButton.current;
    if (button === null) throw new Error(`Shell: the ${dropped} drawer left with focus, but the toolbar has no ${toInspector ? "Inspector" : "plan list"} button to take it`);
    button.focus();
  }, [listMode, listSlotMode, inspectorMode, inspectorButtonShown, itemModal]);
  const attention = listAttention({ open: listOpen, plans, failures: registry.failures(), selected: sel, update: updateState });
  const sidebarToggle = sheetBase ? null : { open: listOpen, attention, button: sidebarButton, onToggle: () => togglePane("list") };
  const inspectorToggle = sheetBase ? null : { open: inspectorOpen, button: inspectorButton, onToggle: () => togglePane("inspector") };
  const bodyStyle: CSSProperties = {
    ...(listColumn !== null && panes.list.w !== null ? { "--sidebar-w": `${listColumn}px` } : {}),
    ...(inspectorColumn !== null && panes.inspector.w !== null ? { "--panel-w": `${inspectorColumn}px` } : {}),
  };
  const inspectorBody = (s: PlanSession, container: "column" | "drawer") =>
    selectedItemShown !== null ? itemDetail(selectedItemShown, s, container) : <PlanPanel key={s.view().plan.id} session={s} readOnly={readOnly} />;
  const order = found.order;
  const follows = ui.view === "timeline";
  const search: SearchProps | null =
    session === null
      ? null
      : {
          query: ui.query,
          count: found.count === null ? null : countText(found.count.shown, found.count.total),
          ask: ui.searchAsk,
          onQuery: (query) => setUi({ query }),
          onFirst: () => {
            const first = firstMatch(found);
            if (first === null) return;
            setUi(follows ? { selected: first, follow: first } : { selected: first });
          },
        };
  const detailApi: DetailApi = {
    order,
    press,
    promote,
    rename,
    step: (by) => {
      const patch = stepPatch(order, ui.selected, by, follows);
      if (patch !== null) setUi(patch);
    },
  };

  const app = (
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
          onSettings={toggleSettings}
          tier={p.tier}
          compact={sheetBase ? { button: sidebarButton, onPlans: () => setSheet("plans"), onPlan: () => setSheet("plan") } : null}
          sidebar={sidebarToggle}
          inspector={inspectorToggle}
          search={search}
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
          {inspectorColumn !== null && session !== null && (
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
                {inspectorBody(session, "column")}
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
          {inspectorDrawerW !== null && session !== null && !modalHidesInspector && (
            <PaneOverlay
              kind="inspector"
              label="Inspector"
              open={inspectorDrawer}
              button={inspectorButton}
              width={inspectorDrawerW}
              onClose={closeInspectorDrawer}
              onScrimPress={scrimPress}
              onFocusDropped={() => {
                drawerDroppedFocus.current = "inspector";
              }}
            >
              <div id={INSPECTOR_ID} className="inspector-drawer-body">
                {inspectorBody(session, "drawer")}
              </div>
            </PaneOverlay>
          )}
        </div>
        {sheets}
        {ui.settings !== null && (
          <Settings
            frame={settingsFrame(readPlatform(window).os, listMode)}
            section={ui.settings}
            session={session}
            readOnly={readOnly}
            device={registry.device.name}
            clock={p.clock}
            hover={hover}
            closer={settingsCloser}
            files={files}
            onSection={(s) => setUi({ settings: s })}
            syncPane={ui.syncPane}
            onClose={() => setUi({ settings: null, syncPane: null })}
            onSyncPane={(pane) => setUi({ syncPane: pane })}
            onTrashPlan={(id) => void trashOwn(id)}
          />
        )}
        {session !== null && itemModal && selectedItemShown !== null && (
          <ItemModal
            session={session}
            item={selectedItemShown}
            local={registry.device.name}
            command={command}
            readOnly={readOnly}
            naming={ui.naming === selectedItemShown}
            memo={focusMemo}
            onNamed={clearNaming}
            onRename={() => rename(selectedItemShown)}
            onClose={closeItemModal}
          />
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
        <ConvertedReport />
        {purging !== null && <PurgeConfirm registry={registry} id={purging} onClose={() => setPurging(null)} />}
        {printing && session !== null && <PrintSheet view={session.view()} onDone={() => setPrinting(false)} />}
        <Toasts />
      </div>
    </OpenChoice.Provider>
  );
  return <DetailContext.Provider value={detailApi}>{app}</DetailContext.Provider>;
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
