import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Refused } from "../../actions/intents";
import type { ItemId, PlanId } from "../../domain/model";
import type { Clock } from "../../services/clock";
import { AppError } from "../../services/ipc";
import type { PlanListing, Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { toast, Toasts } from "../common/Toast";
import { OpenChoice } from "../run";
import { pickPlan, UiContext, useUi } from "../state";
import { Board } from "../board/Board";
import { CalendarDialog } from "../calendar/CalendarDialog";
import { ChoiceDialog } from "../choices/ChoiceDialog";
import { ghostIds } from "../ghosts";
import { List } from "../list/List";
import { RevertDialog } from "../panel/History";
import { ItemPanel } from "../panel/ItemPanel";
import { PlanPanel } from "../panel/PlanPanel";
import { Timeline } from "../timeline/Timeline";
import { HolidayState } from "./HolidayState";
import { FILES_STAY, PlanFailed } from "./PlanFailed";
import { PlanHead } from "./PlanHead";
import { RELOAD_LABEL, ReloadConfirm } from "./ReloadConfirm";
import { NewPlanButton, Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { Tray } from "./Tray";

export interface ShellProps {
  registry: Registry;
  clock: Clock;
}

type Main =
  | { k: "none" }
  | { k: "opening"; id: PlanId }
  | { k: "open"; id: PlanId; session: PlanSession }
  | { k: "incomplete"; id: PlanId; message: string }
  | { k: "failed"; id: PlanId }
  | { k: "error"; id: PlanId; message: string };

const quoted = (l: PlanListing | undefined): string => (l === undefined || l.name === null ? "the plan" : `“${l.name}”`);

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function trashRootOf(s: PlanSession, id: ItemId): ItemId {
  const plan = s.view().plan;
  const it = plan.items.get(id);
  if (it === undefined) throw new Error(`Shell: no item ${id}`);
  const parent = it.place.parent === null ? undefined : plan.items.get(it.place.parent);
  return parent !== undefined && parent.trashed ? trashRootOf(s, parent.id) : id;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function surfaced(e: unknown): string {
  if (e instanceof AppError || e instanceof Refused) return e.message;
  throw e;
}

function takeRepair(s: PlanSession): void {
  const notice = s.takeRepairNotice();
  if (notice !== null) toast(notice);
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
  const [confirm, setConfirm] = useState<string | null>(null);
  const doc = p.registry.indexErrorDoc();
  const space = p.error.code === "store.corrupt" && doc !== null && doc.startsWith("ix-") ? doc : null;
  const readOnly = p.registry.spaceReadOnly();
  return (
    <Banner message={p.error.message}>
      <button type="button" className="button-small" onClick={() => void p.registry.retryIndex()}>
        Try again
      </button>
      {space !== null && !readOnly && (
        <button type="button" className="button-small" onClick={() => setConfirm(space)}>
          {RELOAD_LABEL}
        </button>
      )}
      {space !== null && readOnly && <span className="banner-note">{FILES_STAY}</span>}
      {confirm !== null && <ReloadConfirm registry={p.registry} docId={confirm} onClose={() => setConfirm(null)} />}
    </Banner>
  );
}

export function Shell(p: ShellProps) {
  const registry = p.registry;
  const [ui, setUi] = useUi();
  const uiValue = useMemo(() => ({ ui, setUi }), [ui, setUi]);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const [main, setMainState] = useState<Main>({ k: "none" });
  const [creating, setCreating] = useState(false);
  const selected = useRef(ui.plan);
  const mainRef = useRef<Main>(main);
  const creatingRef = useRef(false);
  const ownTrash = useRef(new Set<PlanId>());
  const selectedItem = useRef<ItemId | null>(ui.selected);
  const lastTrashed = useRef(new Map<PlanId, boolean>());

  const setMain = useCallback((m: Main) => {
    mainRef.current = m;
    setMainState(m);
  }, []);

  const select = useCallback(
    (id: PlanId | null) => {
      if (id === selected.current) {
        setUi({ plan: id });
        return;
      }
      selected.current = id;
      selectedItem.current = null;
      setUi({ plan: id, selected: null });
    },
    [setUi],
  );

  const open = useCallback(
    (id: PlanId) => {
      const m = mainRef.current;
      if (!(m.k === "incomplete" && m.id === id)) setMain({ k: "opening", id });
      registry.session(id).then(
        (s) => {
          if (selected.current !== id) return;
          setMain({ k: "open", id, session: s });
          takeRepair(s);
        },
        (e: unknown) => {
          const recorded = e instanceof AppError && registry.failures().get(id) === e;
          const incomplete = e instanceof AppError && e.code === "plan.incomplete";
          if (!recorded && !incomplete) {
            if (selected.current === id) setMain({ k: "error", id, message: messageOf(e) });
            throw e;
          }
          if (selected.current !== id) return;
          setMain(incomplete ? { k: "incomplete", id, message: e.message } : { k: "failed", id });
        },
      );
    },
    [registry, setMain],
  );

  useEffect(() => {
    const takeIndexRepair = (): void => {
      const notice = registry.takeIndexRepairNotice();
      if (notice !== null) toast(notice);
    };
    const remember = (plans: readonly PlanListing[]): void => {
      lastTrashed.current = new Map(plans.map((l) => [l.id, l.trashed]));
    };
    const reselect = (plans: readonly PlanListing[]): boolean => {
      const next = pickPlan(plans, selected.current);
      if (next === selected.current) return false;
      select(next);
      return true;
    };
    const onNotify = (): void => {
      bump();
      const plans = registry.plans();
      const current = selected.current;
      const listing = plans.find((l) => l.id === current);
      if (current !== null && listing !== undefined && listing.trashed && lastTrashed.current.get(current) === false && !ownTrash.current.has(current)) {
        toast(`${capital(quoted(listing))} was moved to the Trash on another device. Restore it from the Trash.`);
      }
      remember(plans);
      if (!reselect(plans) && current !== null) {
        const m = mainRef.current;
        if (m.k === "incomplete" && m.id === current) open(current);
        if (m.k === "failed" && m.id === current && !registry.failures().has(current)) open(current);
      }
      takeIndexRepair();
    };
    const plans = registry.plans();
    remember(plans);
    reselect(plans);
    takeIndexRepair();
    return registry.subscribe(onNotify);
  }, [registry, select, open]);

  useEffect(() => {
    if (ui.plan === null) {
      setMain({ k: "none" });
      return;
    }
    if (pickPlan(registry.plans(), ui.plan) !== ui.plan) return;
    selected.current = ui.plan;
    open(ui.plan);
  }, [ui.plan, registry, open, setMain]);

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
      takeRepair(session);
      letGo();
    });
  }, [session, setUi, registry]);

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

  const openChoice = useCallback(
    (choice: string, side?: string) => setUi({ dialog: side === undefined ? { t: "choice", id: choice } : { t: "choice", id: choice, side } }),
    [setUi],
  );

  const closeDialog = useCallback(() => setUi({ dialog: null }), [setUi]);

  const newPlan = (): void => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    registry
      .createPlan("New plan")
      .then(
        (id) => select(id),
        (e: unknown) => toast(surfaced(e), "bad"),
      )
      .finally(() => {
        creatingRef.current = false;
        setCreating(false);
      });
  };

  const plans = registry.plans();
  const listingOf = (id: PlanId): PlanListing | undefined => plans.find((l) => l.id === id);

  const trash = (id: PlanId): void => {
    const listing = listingOf(id);
    ownTrash.current.add(id);
    try {
      registry.trashPlan(id);
    } catch (e) {
      toast(surfaced(e), "bad");
      return;
    } finally {
      ownTrash.current.delete(id);
    }
    toast(`Moved ${quoted(listing)} to the Trash. Restore it from the Trash.`);
  };

  const restore = (id: PlanId): void => {
    const listing = listingOf(id);
    try {
      registry.restorePlan(id);
    } catch (e) {
      toast(surfaced(e), "bad");
      return;
    }
    toast(`Restored ${quoted(listing)} from the Trash.`);
  };

  const sel = ui.plan;
  const listing = sel === null ? undefined : listingOf(sel);
  const failure = sel === null ? undefined : registry.failures().get(sel);
  const indexError = registry.indexError();
  const settingsError = registry.settingsError();
  const readOnly = session?.readOnly ?? false;

  const content = (() => {
    if (sel === null) {
      return (
        <div className="empty-state">
          <NewPlanButton creating={creating} onNew={newPlan} />
        </div>
      );
    }
    if (failure !== undefined && (session === null || (listing !== undefined && !listing.loaded))) {
      return <PlanFailed registry={registry} id={sel} error={failure} onTrash={trash} />;
    }
    if (main.k === "incomplete" && main.id === sel) return <p className="main-note">{main.message}</p>;
    if (main.k === "error" && main.id === sel) {
      return (
        <Banner message={main.message}>
          <button type="button" className="button-small" onClick={() => open(sel)}>
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
        <PlanHead session={session} onChoose={(choice) => openChoice(choice)}>
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

  return (
    <UiContext.Provider value={uiValue}>
      <OpenChoice.Provider value={openChoice}>
        <div className="app">
          <Toolbar session={session} readOnly={readOnly} ui={ui} setUi={setUi} mac={registry.device.platform === "macos"} />
          <div className="app-body">
            <Sidebar
              registry={registry}
              plans={plans}
              selected={sel}
              creating={creating}
              onNew={newPlan}
              onSelect={(id) => select(id)}
              onTrash={trash}
              onRestore={restore}
            />
            <main className="main">
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
            {session !== null && (
              <div className="slot slot-panel" data-slot="panel">
                {ui.selected !== null && session.view().plan.items.has(ui.selected) ? (
                  <ItemPanel key={ui.selected} session={session} item={ui.selected} readOnly={readOnly} />
                ) : (
                  <PlanPanel session={session} readOnly={readOnly} />
                )}
              </div>
            )}
          </div>
          {session !== null && ui.dialog !== null && ui.dialog.t === "calendar" && (
            <CalendarDialog key={session.view().plan.id} session={session} registry={registry} clock={p.clock} onClose={() => setUi({ dialog: null })} />
          )}
          {session !== null && ui.dialog !== null && ui.dialog.t === "choice" && (
            <ChoiceDialog key={`${ui.dialog.id}:${ui.dialog.side ?? ""}`} session={session} id={ui.dialog.id} side={ui.dialog.side} onClose={closeDialog} />
          )}
          {session !== null && ui.dialog !== null && ui.dialog.t === "revert" && (
            <RevertDialog key={ui.dialog.id} session={session} id={ui.dialog.id} onClose={() => setUi({ dialog: null })} />
          )}
          <Toasts />
        </div>
      </OpenChoice.Provider>
    </UiContext.Provider>
  );
}
