import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { RegionRef } from "../../domain/calendar";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import type { PlanListing } from "../../store/registry";
import type { Clock } from "../../services/clock";
import { usePlanView, type PlanSession } from "../../store/session";
import type { Updates } from "../../store/updates";
import { chipText, type SyncState } from "../../sync/manager";
import { docName, useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { DISCARDED, useTheme, type ThemeApi } from "../../theme/ThemeContext";
import { CalendarBody, type CalendarStash } from "../calendar/CalendarDialog";
import { messageOf } from "../calendar/message";
import { AboutText } from "../common/About";
import { Dialog, focusables } from "../common/Dialog";
import { requestCloseOf, type AfterClose, type CloseReason } from "../common/dismiss";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { Baselines } from "../panel/Baselines";
import { commitPlanName } from "../panel/planName";
import { TextField } from "../panel/TextField";
import { ImportButton } from "../phone/PlansSheet";
import { useRun } from "../run";
import { exportFlow } from "../shell/fileFlows";
import type { PlanFiles } from "../shell/selection";
import { syncTone } from "../shell/SyncChip";
import { UpdateLine, useUpdates } from "../shell/UpdateLine";
import type { SettingsSection, SyncPane } from "../state";
import { isSyncPane, SyncPanes } from "../sync/SyncPanes";
import { ThemeBody } from "../theme/ThemePanel";
import type { SettingsFrame } from "./frame";
import { saveSection } from "./lastSection";
import { filterSections, isPlanSection, sectionTitle, shownSections, type RowSpec, type SectionMatch, type SectionSpec } from "./sections";

export const SETTINGS_TITLE = "Settings";

export function closeSettings(api: ThemeApi, onClose: () => void): void {
  api.preview(null);
  if (api.draft !== null) {
    api.setDraft(null);
    toast(DISCARDED);
  }
  onClose();
}

export type SettingsCloser = (reason: CloseReason, then?: AfterClose) => boolean;

export interface SettingsProps {
  frame: SettingsFrame;
  section: SettingsSection;
  session: PlanSession | null;
  readOnly: boolean;
  device: string;
  clock: Clock;
  hover: boolean;
  closer: RefObject<SettingsCloser | null>;
  files: PlanFiles;
  onSection(s: SettingsSection): void;
  syncPane: SyncPane | null;
  onClose(): void;
  onSyncPane(pane: SyncPane): void;
  onTrashPlan(id: PlanId): void;
}

export interface SettingsWorld {
  sync: SyncState;
  syncName(doc: string): string | null;
  updates: Updates | null;
  syncPanes: ReactNode;
  planLocked: boolean;
}

interface Jump {
  section: SettingsSection;
  row: RowSpec | null;
}

interface Group {
  key: "app" | "plan";
  title: string;
  matches: readonly SectionMatch[];
}

const rowKey = (section: SettingsSection, row: string): string => `${section}.${row}`;

function Row(p: { section: SettingsSection; row: string; label: string; className?: string; stack?: boolean; children: ReactNode }) {
  return (
    <div className={p.stack === true ? "settings-row settings-row-stack" : "settings-row"} data-settings-row={rowKey(p.section, p.row)}>
      <span className="settings-label">{p.label}</span>
      <div className={p.className === undefined ? "settings-control" : `settings-control ${p.className}`}>{p.children}</div>
    </div>
  );
}

const trashLine = (name: string): string => `Moves “${name}” to the Trash. Restore it from the plan list's Trash.`;

const DELETE_FOREVER_LINE = "To delete this plan forever, move it to the Trash, then choose Delete forever there.";

function OverviewSection(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  const name = view.plan.name;
  return (
    <Row section="overview" row="name" label="Name">
      <TextField className="settings-plan-name" label="Plan name" value={name} readOnly={p.readOnly} onCommit={(next) => commitPlanName(run, name, next)} />
    </Row>
  );
}

function BaselinesSection(p: { session: PlanSession; readOnly: boolean }) {
  const view = usePlanView(p.session);
  const run = useRun(p.session);
  return (
    <Row section="baselines" row="baselines" label="Baselines" stack>
      <Baselines view={view} readOnly={p.readOnly} run={run} titled={false} />
    </Row>
  );
}

interface RegionFailure {
  region: RegionRef;
  message: string;
}

function WorkingTimeSection(p: { session: PlanSession; clock: Clock; frame: SettingsFrame; stash: RefObject<CalendarStash | null> }) {
  const registry = useSyncRegistry();
  const [round, next] = useReducer((n: number) => n + 1, 0);
  const [failure, setFailure] = useState<RegionFailure | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (round === 0) return;
    const el = box.current;
    if (el === null) throw new Error("Settings: Working time lost its body after an apply");
    el.focus();
  }, [round]);
  const save = (region: RegionRef): void => {
    setFailure(null);
    registry.setLastRegion(region).then(
      () => undefined,
      (e: unknown) => {
        setFailure({ region, message: messageOf(e) });
        if (!(e instanceof AppError)) throw e;
      },
    );
  };
  const applied = (region: RegionRef | null): void => {
    p.stash.current = null;
    setFailure(null);
    next();
    if (region !== null) save(region);
  };
  return (
    <div ref={box} className="settings-calendar" tabIndex={-1}>
      <CalendarBody
        key={round}
        session={p.session}
        registry={registry}
        clock={p.clock}
        frame="inline"
        reviewIn={p.frame === "sheet" ? "sheet" : "dialog"}
        stash={p.stash}
        onApplied={applied}
      />
      {failure !== null && (
        <div className="cal-failed settings-region-failed">
          <span className="note bad">{failure.message}</span>
          <button type="button" className="button-small" onClick={() => save(failure.region)}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

function DangerSection(p: { session: PlanSession; locked: boolean; onTrash(): void }) {
  const view = usePlanView(p.session);
  return (
    <>
      <Row section="danger" row="trash" label="Move to Trash" stack>
        <button type="button" className="button-danger" disabled={p.locked} onClick={p.onTrash}>
          Move to Trash
        </button>
        <p className="settings-line">{trashLine(view.plan.name)}</p>
      </Row>
      <Row section="danger" row="delete" label="Delete forever" stack>
        <p className="settings-line">{DELETE_FOREVER_LINE}</p>
      </Row>
    </>
  );
}

function usePlanName(session: PlanSession | null): string | null {
  const subscribe = useCallback((cb: () => void) => (session === null ? () => undefined : session.subscribe(cb)), [session]);
  const snapshot = useCallback(() => (session === null ? null : session.view().plan.name), [session]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function trashLocked(plans: readonly PlanListing[], planId: PlanId | null, spaceReadOnly: boolean): boolean {
  if (planId === null) return false;
  const listing = plans.find((l) => l.id === planId);
  return listing === undefined || (listing.space !== null && spaceReadOnly);
}

const countLine = (n: number, q: string): string => (n === 0 ? `No setting matches “${q}”.` : n === 1 ? "1 section matches." : `${n} sections match.`);

function groupsOf(matches: readonly SectionMatch[], planName: string | null): Group[] {
  const app: Group = {
    key: "app",
    title: "App",
    matches: matches.filter((m) => !m.section.plan),
  };
  const plan: Group[] =
    planName === null
      ? []
      : [
          {
            key: "plan",
            title: planName,
            matches: matches.filter((m) => m.section.plan),
          },
        ];
  return [app, ...plan].filter((g) => g.matches.length > 0);
}

export function SettingsView(p: SettingsProps & SettingsWorld) {
  const api = useTheme();
  const planId = p.session === null ? null : p.session.view().plan.id;
  const planName = usePlanName(p.session);
  const list = shownSections(p.session !== null, p.updates !== null);
  const [owner, setOwner] = useState<PlanId | null>(planId);
  const [asked, setAsked] = useState<SettingsSection>(p.section);
  const fresh = asked !== p.section;
  if (fresh) {
    setAsked(p.section);
    if (isPlanSection(p.section)) setOwner(planId);
  }
  const ownerNow = fresh && isPlanSection(p.section) ? planId : owner;
  const listed = list.some((s) => s.id === p.section);
  const shown: SettingsSection = !listed || (isPlanSection(p.section) && ownerNow !== planId) ? "general" : p.section;
  const [visited, setVisited] = useState<ReadonlySet<SettingsSection>>(() => new Set([shown]));
  if (!visited.has(shown)) setVisited(new Set([...visited, shown]));
  const [query, setQuery] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const jumped = useRef<Jump | null>(null);
  const placed = useRef<SettingsSection | null>(null);
  const saved = useRef<SettingsSection | null>(null);
  const corrected = useRef<SettingsSection | null>(null);
  const previewed = useRef<SettingsSection>(shown);
  const calendarStash = useRef<CalendarStash | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const groupId = useId();
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });

  const closer = p.closer;
  const frame = p.frame;
  useLayoutEffect(() => {
    closer.current = (reason, then) => {
      const el = body.current;
      if (el === null) throw new Error("Settings: asked to close without its body");
      const root = el.closest<HTMLElement>('[role="dialog"]');
      if (root === null) throw new Error("Settings: its body is outside a dialog");
      return requestCloseOf(root, reason, then);
    };
    return () => {
      closer.current = null;
    };
  }, [closer]);

  const section = p.section;
  useLayoutEffect(() => {
    if (shown !== section) {
      corrected.current = shown;
      latest.current.onSection(shown);
      return;
    }
    if (corrected.current === shown) return;
    corrected.current = null;
    if (saved.current === shown) return;
    saved.current = shown;
    saveSection(window.localStorage, shown);
  }, [shown, section]);

  useLayoutEffect(() => {
    if (previewed.current === shown) return;
    previewed.current = shown;
    api.preview(null);
  }, [shown, api]);

  useLayoutEffect(() => {
    if (frame !== "modal") return;
    const column = main.current;
    if (column === null) throw new Error("Settings: the modal rendered without its main column");
    if (placed.current !== shown) {
      placed.current = shown;
      column.scrollTop = 0;
    }
    const target = jump;
    if (target === null || target === jumped.current || target.section !== shown) return;
    jumped.current = target;
    if (target.row === null || !target.row.anchor) {
      column.scrollTop = 0;
      return;
    }
    const key = rowKey(target.section, target.row.id);
    const row = column.querySelector<HTMLElement>(`[data-settings-row="${key}"]`);
    if (row === null) throw new Error(`Settings: the ${key} row is not in its section`);
    row.scrollIntoView({ block: "nearest" });
    focusables(row)[0]?.focus();
  }, [frame, shown, jump]);

  const opened = useRef(shown);
  useLayoutEffect(() => {
    if (frame !== "sheet") return;
    const list = body.current;
    if (list === null) throw new Error("Settings: the sheet rendered without its list");
    const heading = list.querySelector<HTMLElement>(`section.settings-group[data-section="${opened.current}"] h2`);
    if (heading === null) throw new Error(`Settings: the sheet has no ${opened.current} heading to scroll to`);
    heading.scrollIntoView({ block: "start" });
  }, [frame]);

  const go = (s: SettingsSection, row: RowSpec | null = null): void => {
    setJump({ section: s, row });
    setOwner(planId);
    corrected.current = null;
    saved.current = s;
    saveSection(window.localStorage, s);
    if (s === "sync" && row !== null && isSyncPane(row.id)) p.onSyncPane(row.id);
    p.onSection(s);
  };
  const close = (): void => closeSettings(api, p.onClose);
  const planSession = (id: SettingsSection): PlanSession => {
    if (p.session === null) throw new Error(`Settings: the ${id} section rendered without a plan`);
    return p.session;
  };
  const trash = (): void => {
    const id = planId;
    if (id === null) throw new Error("Settings: Move to Trash without a plan");
    const request = closer.current;
    if (request === null) throw new Error("Settings: Move to Trash before Settings could close");
    const onTrashPlan = p.onTrashPlan;
    request("x", () => onTrashPlan(id));
  };

  const content = (s: SectionSpec): ReactNode => {
    switch (s.id) {
      case "general":
        return (
          <>
            <Row section="general" row="device" label="This device">
              <span className="settings-value">{p.device}</span>
            </Row>
            {p.updates !== null && (
              <Row section="general" row="updates" label="Updates">
                <UpdateLine updates={p.updates} />
              </Row>
            )}
            <Row section="general" row="about" label="About" className="settings-about">
              <AboutText />
            </Row>
          </>
        );
      case "theme":
        return <ThemeBody hover={p.hover} />;
      case "sync":
        return (
          <>
            <Row section="sync" row="status" label="Status">
              <p className={`settings-status ${syncTone(p.sync)}`}>{chipText(p.sync, p.syncName)}</p>
            </Row>
            <div className="settings-sync">{p.syncPanes}</div>
          </>
        );
      case "files": {
        const session = p.session;
        return (
          <>
            <Row section="files" row="import" label="Import">
              <ImportButton files={p.files} />
            </Row>
            <Row section="files" row="export" label="Export">
              {session === null ? (
                <span className="settings-value dim">Open a plan to export it.</span>
              ) : (
                <button type="button" onClick={() => void exportFlow(session)}>
                  Export plan…
                </button>
              )}
            </Row>
          </>
        );
      }
      case "overview":
        return <OverviewSection session={planSession(s.id)} readOnly={p.readOnly} />;
      case "baselines":
        return <BaselinesSection session={planSession(s.id)} readOnly={p.readOnly} />;
      case "danger":
        return <DangerSection session={planSession(s.id)} locked={p.planLocked} onTrash={trash} />;
      case "working-time":
        return <WorkingTimeSection session={planSession(s.id)} clock={p.clock} frame={p.frame} stash={calendarStash} />;
    }
  };

  const sectionKey = (s: SectionSpec): string => (s.plan ? `${s.id}:${planId ?? ""}` : s.id);

  if (p.frame === "sheet") {
    const groups = groupsOf(filterSections(list, ""), planName);
    return (
      <Sheet open title={SETTINGS_TITLE} onClose={close}>
        <div ref={body} className="settings-list">
          {groups.map((g) => (
            <div key={g.key} className="settings-list-group">
              {g.key === "plan" && <p className="settings-list-plan">{g.title}</p>}
              {g.matches.map(({ section: s }) => (
                <section key={sectionKey(s)} className="settings-group" data-section={s.id} aria-label={s.title}>
                  <h2 className="settings-group-title">{s.title}</h2>
                  {content(s)}
                </section>
              ))}
            </div>
          ))}
        </div>
      </Sheet>
    );
  }

  const matches = filterSections(list, query);
  const groups = groupsOf(matches, planName);
  const searching = query.trim() !== "";
  const enter = (m: SectionMatch): void => {
    const row = m.byTitle ? null : m.rows[0];
    go(m.section.id, row ?? null);
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      const first = navRef.current?.querySelector<HTMLButtonElement>("button") ?? null;
      if (first === null) return;
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.key === "Escape" && query !== "") {
      e.preventDefault();
      setQuery("");
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = matches[0];
    if (first !== undefined && searching) enter(first);
  };

  return (
    <Dialog label={sectionTitle(shown)} size="settings" onClose={close}>
      <div ref={body} className="settings-layout">
        <aside className="settings-side">
          <input
            type="search"
            className="settings-search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <p className="settings-count" role="status" aria-live="polite">
            {searching ? countLine(matches.length, query.trim()) : ""}
          </p>
          <nav ref={navRef} className="settings-nav" aria-label="Settings sections">
            {groups.map((g) => (
              <div key={g.key} className="settings-nav-group" data-group={g.key} role="group" aria-labelledby={`${groupId}-${g.key}`}>
                <div id={`${groupId}-${g.key}`} className="settings-nav-title">
                  {g.title}
                </div>
                {g.matches.map((m) => (
                  <div key={m.section.id} className="settings-nav-entry">
                    <button
                      type="button"
                      className="settings-nav-item"
                      data-section={m.section.id}
                      aria-current={m.section.id === shown ? "page" : undefined}
                      onClick={() => go(m.section.id)}
                    >
                      {m.section.title}
                    </button>
                    {m.rows.map((r) => (
                      <button key={r.id} type="button" className="settings-nav-row" data-row={rowKey(m.section.id, r.id)} onClick={() => go(m.section.id, r)}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))}
            {groups.length === 0 && <p className="settings-empty">{`No setting matches “${query.trim()}”.`}</p>}
          </nav>
        </aside>
        <div ref={main} className="settings-main">
          {list
            .filter((s) => visited.has(s.id) || s.id === shown)
            .map((s) => (
              <section key={sectionKey(s)} className="settings-section" data-section={s.id} aria-label={s.title} hidden={s.id !== shown}>
                {content(s)}
              </section>
            ))}
        </div>
      </div>
    </Dialog>
  );
}

export function Settings(p: SettingsProps) {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const updates = useUpdates();
  const panes = <SyncPanes pane={p.syncPane} frame={p.frame === "sheet" ? "sheet" : "dialog"} onPane={p.onSyncPane} />;
  const planId = p.session === null ? null : p.session.view().plan.id;
  const planLocked = trashLocked(registry.plans(), planId, registry.spaceReadOnly());
  return <SettingsView {...p} sync={state} syncName={docName(registry)} updates={updates} syncPanes={panes} planLocked={planLocked} />;
}
