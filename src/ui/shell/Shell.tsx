import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Refused } from "../../actions/intents";
import type { ItemId, PlanId } from "../../domain/model";
import type { Clock } from "../../services/clock";
import { AppError } from "../../services/ipc";
import type { PlanListing, Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { About } from "../common/About";
import { Sheet } from "../common/Sheet";
import { toast, Toasts } from "../common/Toast";
import { revealPatch } from "../choices/HeadCounts";
import { commands, type CommandCtx } from "../palette/commands";
import { isTyping, keyToCommand } from "../palette/keymap";
import { Palette } from "../palette/Palette";
import { PhoneShell } from "../phone/PhoneShell";
import { OpenChoice, runWith } from "../run";
import { UiContext, useUi, useUiValue } from "../state";
import { Board } from "../board/Board";
import { CalendarDialog } from "../calendar/CalendarDialog";
import { ChoiceDialog } from "../choices/ChoiceDialog";
import { ghostIds } from "../ghosts";
import { List } from "../list/List";
import { RevertDialog } from "../panel/History";
import { ItemPanel } from "../panel/ItemPanel";
import { PlanPanel } from "../panel/PlanPanel";
import { Timeline } from "../timeline/Timeline";
import { trashRootOf } from "../trashed";
import { HolidayState } from "./HolidayState";
import { canReload, stopsArrival } from "../../sync/reload";
import { docName, useSyncState } from "../../sync/SyncProvider";
import { RemovedBanner } from "../sync/RemovedBanner";
import { SyncActionButtons, SyncDialog, syncMessage } from "../sync/SyncDialog";
import { useFormFactor } from "./formFactor";
import { FILES_STAY, PlanFailed, ReloadButton } from "./PlanFailed";
import { PlanHead } from "./PlanHead";
import { PlanMenu } from "./PlanMenu";
import { ReloadConfirm } from "./ReloadConfirm";
import { messageOf, restorePlan, usePlanFiles, usePlanSelection } from "./selection";
import { NewPlanButton, Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { Tray } from "./Tray";
import { useUpdates, useUpdateState } from "./UpdateLine";

export interface ShellProps {
  registry: Registry;
  clock: Clock;
}

type CompactSheet = "plans" | "plan" | null;

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
  const space = p.error.code === "store.corrupt" && doc !== null && doc.startsWith("ix-") ? doc : null;
  const readOnly = p.registry.spaceReadOnly();
  return (
    <Banner message={p.error.message}>
      <button type="button" className="button-small" onClick={() => void p.registry.retryIndex()}>
        Try again
      </button>
      {space !== null && !readOnly && <ReloadButton enabled={reloadable} small onOpen={() => setConfirm(space)} />}
      {space !== null && readOnly && <span className="banner-note">{FILES_STAY}</span>}
      {confirm !== null && <ReloadConfirm registry={p.registry} docId={confirm} onClose={() => setConfirm(null)} />}
    </Banner>
  );
}

function WideBody(p: ShellProps & { compact: boolean }) {
  const registry = p.registry;
  const compact = p.compact;
  const { state: syncState } = useSyncState();
  const updates = useUpdates();
  useUpdateState(updates);
  const { ui, setUi } = useUiValue();
  const { main, open: openPlan, trashOwn } = usePlanSelection(registry);
  const files = usePlanFiles(registry, openPlan);
  const { creating, importing, importPlan } = files;
  const newPlan = (): void => files.newPlan("New plan", (message) => toast(message, "bad"));
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const [sheet, setSheet] = useState<CompactSheet>(null);
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
      const root = trashRootOf(session, item);
      const a = session.authorOf("e:" + root);
      if (a === null) throw new Error(`Shell: trashed item ${root} has no author`);
      if (a.dev === registry.device.deviceId) return;
      const rootItem = view.plan.items.get(root);
      if (rootItem === undefined) throw new Error(`Shell: no item ${root}`);
      toast(`“${rootItem.name}” was moved to the Trash on ${a.device}. Restore it from the Trash.`);
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

  const sel = ui.plan;
  const listing = sel === null ? undefined : listingOf(sel);
  const failure = sel === null ? undefined : registry.failures().get(sel);
  const indexError = registry.indexError();
  const settingsError = registry.settingsError();
  const readOnly = session?.readOnly ?? false;
  const mac = registry.device.platform === "macos";

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
    mac,
    clock: p.clock,
    select: openPlan,
    newPlan,
    reveal,
    updates,
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
      const typing = isTyping(e.target, e.key);
      const dialog = c.ui.dialog !== null || (target !== null && target.closest('[aria-modal="true"]') !== null);
      const id = keyToCommand(e, { mac: c.mac, typing, dialog, selected: c.ui.selected !== null });
      if (id === null) return;
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
            <NewPlanButton creating={creating} onNew={newPlan} />
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
          onChoose={(choice) => openChoice(choice)}
          menu={(open, setOpen) => (
            <PlanMenu session={session} registry={registry} open={open} onOpenChange={setOpen} onOpen={(id) => openPlan(id)} />
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
      onNew={newPlan}
      onSelect={(id) => openPlan(id)}
      onTrash={(id) => void trashOwn(id)}
      onRestore={(id) => restorePlan(registry, id)}
      onMove={moveToSpace}
    />
  );

  const selectedItemShown = session !== null && ui.selected !== null && session.view().plan.items.has(ui.selected) ? ui.selected : null;
  const itemPanel = (item: ItemId, s: PlanSession) => (
    <ItemPanel key={item} session={s} item={item} local={registry.device.name} mac={mac} readOnly={readOnly} naming={ui.naming === item} onNamed={clearNaming} />
  );
  const closeSheet = (): void => setSheet(null);
  useEffect(() => {
    if (session === null && sheet === "plan") setSheet(null);
  }, [session, sheet]);
  useEffect(() => {
    if (!compact) setSheet(null);
  }, [compact]);
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
        <Sheet open={sheet === null} title={itemName(session, selectedItemShown)} onClose={() => setUi({ selected: null })}>
          {itemPanel(selectedItemShown, session)}
        </Sheet>
      )}
    </>
  );

  return (
    <OpenChoice.Provider value={openChoice}>
      <div className="app">
        <Toolbar
          session={session}
          readOnly={readOnly}
          ui={ui}
          setUi={setUi}
          mac={mac}
          onCommand={runCommand}
          compact={compact ? { onPlans: () => setSheet("plans"), onPlan: () => setSheet("plan") } : null}
        />
        <div className="app-body">
          {!compact && sidebar}
          <main className="main">
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
          {session !== null && !compact && (
            <div className="slot slot-panel" data-slot="panel">
              {selectedItemShown !== null ? itemPanel(selectedItemShown, session) : <PlanPanel session={session} readOnly={readOnly} />}
            </div>
          )}
        </div>
        {sheets}
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
        {ui.dialog !== null && ui.dialog.t === "about" && <About onClose={closeDialog} />}
        {ui.dialog !== null && ui.dialog.t === "sync" && <SyncDialog pane={ui.dialog.pane} onPane={(pane) => setUi({ dialog: { t: "sync", pane } })} onClose={closeDialog} />}
        <Toasts />
      </div>
    </OpenChoice.Provider>
  );
}

function WideShell(p: ShellProps & { compact: boolean }) {
  const [ui, setUi] = useUi();
  const uiValue = useMemo(() => ({ ui, setUi }), [ui, setUi]);
  return (
    <UiContext.Provider value={uiValue}>
      <WideBody registry={p.registry} clock={p.clock} compact={p.compact} />
    </UiContext.Provider>
  );
}

export function Shell(p: ShellProps) {
  const form = useFormFactor();
  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      const error: unknown = e.error;
      if (error === null || error === undefined) return;
      toast(messageOf(error), "bad");
    };
    const onRejection = (e: PromiseRejectionEvent): void => {
      toast(messageOf(e.reason), "bad");
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  if (form === "phone") return <PhoneShell registry={p.registry} clock={p.clock} />;
  return <WideShell registry={p.registry} clock={p.clock} compact={form === "compact"} />;
}
