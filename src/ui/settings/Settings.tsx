import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { RegionRef } from "../../domain/calendar";
import type { PersonId, PlanId, StepId } from "../../domain/model";
import { readPlatform } from "../../platform";
import { usesNativeAlert } from "../../services/alert";
import { AppError } from "../../services/ipc";
import type { PlanListing } from "../../store/registry";
import type { Clock } from "../../services/clock";
import { stepsOf } from "../../domain/steps";
import { usePlanView, type PlanSession } from "../../store/session";
import type { Updates } from "../../store/updates";
import { chipText, type SyncState } from "../../sync/manager";
import { docName, useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { DISCARDED, useTheme, type ThemeApi } from "../../theme/ThemeContext";
import { STEP_TITLE } from "../board/text";
import { CalendarBody, type CalendarStash } from "../calendar/CalendarDialog";
import { messageOf } from "../calendar/message";
import { Dialog, focusables } from "../common/Dialog";
import { PERSON_TITLE } from "../people/text";
import { requestCloseOf, useCloseGuard, type AfterClose, type CloseReason, type DraftGuard } from "../common/dismiss";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { Baselines } from "../panel/Baselines";
import { commitPlanName } from "../panel/planName";
import { TextField } from "../panel/TextField";
import { useRun } from "../run";
import { backupFlow } from "../shell/fileFlows";
import type { PlanFiles } from "../shell/selection";
import { syncTone } from "../shell/SyncChip";
import { useUpdates } from "../shell/UpdateLine";
import type { SettingsSection, SyncPane } from "../state";
import { isSyncPane, SyncPanes } from "../sync/SyncPanes";
import { ThemeBody } from "../theme/ThemePanel";
import type { SettingsFrame } from "./frame";
import { Defaults } from "./Defaults";
import { Files } from "./Files";
import { General } from "./General";
import { Look } from "./Look";
import { saveSection } from "./lastSection";
import { People } from "./People";
import { PersonPage } from "./PersonPage";
import { Row, rowKey } from "./Row";
import { BACK_TO_PEOPLE, BACK_TO_SETTINGS, BACK_TO_WORKFLOW, SettingsRoot, SheetBack, SheetEdit } from "./SettingsPages";
import { filterSections, isPlanSection, sectionTitle, SETTINGS_SECTIONS, shownSections, type RowSpec, type SectionMatch, type SectionSpec } from "./sections";
import { StepPage } from "./StepPage";
import { Workflow } from "./Workflow";

export const SETTINGS_TITLE = "Settings";

export const THEME_DRAFT: DraftGuard = { title: "Discard theme changes?", message: "Your colour changes are not saved yet." };

export function closeSettings(api: ThemeApi, onClose: () => void, asked = false): void {
  api.preview(null);
  if (api.draft !== null) {
    api.setDraft(null);
    if (!asked) toast(DISCARDED);
  }
  onClose();
}

function ThemeDraftGuard() {
  const api = useTheme();
  useCloseGuard(api.draft === null ? null : THEME_DRAFT);
  return null;
}

export type SettingsCloser = (reason: CloseReason, then?: AfterClose) => boolean;

export interface SettingsProps {
  frame: SettingsFrame;
  section: SettingsSection;
  root: boolean;
  onRoot(root: boolean): void;
  row: string | null;
  onRowShown(): void;
  session: PlanSession | null;
  readOnly: boolean;
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
  device: string;
  renameDevice(name: string): void;
  backup(): void;
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

interface Return {
  section: SettingsSection;
  scroll: number;
}

type Detail = { kind: "person"; id: PersonId; focus: "initials" | null } | { kind: "step"; id: StepId; select: boolean };

type DetailRef = { kind: "person"; id: PersonId } | { kind: "step"; id: StepId };

type Editing = "people" | "workflow";

const detailSection = (d: DetailRef): Editing => (d.kind === "person" ? "people" : "workflow");

interface DetailReturn {
  section: Editing;
  to: DetailRef | null;
  scroll: number;
}

function nameIn(session: PlanSession, ref: DetailRef): string | null {
  const view = session.view();
  const found = ref.kind === "person" ? view.people.people.find((x) => x.id === ref.id) : stepsOf(view.plan).find((s) => s.id === ref.id);
  return found === undefined ? null : found.name;
}

interface Group {
  key: "app" | "plan";
  title: string;
  matches: readonly SectionMatch[];
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

function useDetailName(session: PlanSession | null, detail: DetailRef | null): string | null {
  const subscribe = useCallback((cb: () => void) => (session === null ? () => undefined : session.subscribe(cb)), [session]);
  const snapshot = useCallback(() => (session === null || detail === null ? null : nameIn(session, detail)), [session, detail]);
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
  const list = shownSections(p.session !== null, p.updates !== null, readPlatform(window));
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
  const atRoot = p.frame === "sheet" && p.root;
  const [visited, setVisited] = useState<ReadonlySet<SettingsSection>>(() => new Set(atRoot ? [] : [shown]));
  if (!atRoot && !visited.has(shown)) setVisited(new Set([...visited, shown]));
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
  const backRef = useRef<HTMLButtonElement>(null);
  const pushing = useRef(false);
  const returning = useRef<Return | null>(null);
  const rootScroll = useRef(0);
  const sheetJumped = useRef<Jump | null>(null);
  const [held, setDetail] = useState<Detail | null>(null);
  const detail = held !== null && !atRoot && p.session !== null && shown === detailSection(held) ? held : null;
  if (held !== null && detail === null) setDetail(null);
  const [heldEdit, setEdit] = useState<Editing | null>(null);
  const edit = heldEdit !== null && !atRoot && shown === heldEdit && !p.readOnly ? heldEdit : null;
  if (heldEdit !== null && edit === null) setEdit(null);
  const detailPushed = useRef(false);
  const detailReturn = useRef<DetailReturn | null>(null);
  const pageScroll = useRef(0);
  const detailName = useDetailName(p.session, detail);
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
    if (atRoot || saved.current === shown) return;
    saved.current = shown;
    saveSection(window.localStorage, shown);
  }, [shown, section, atRoot]);

  useLayoutEffect(() => {
    if (previewed.current === shown) return;
    previewed.current = shown;
    api.preview(null);
  }, [shown, api]);

  const askedRow = p.row === null ? null : (list.find((s) => s.id === shown)?.rows.find((r) => r.id === p.row) ?? null);
  if (p.row !== null && askedRow === null) throw new Error(`Settings: ${shown} has no row ${p.row} to open at`);
  useLayoutEffect(() => {
    if (askedRow === null) return;
    setJump({ section: shown, row: askedRow });
    const now = latest.current;
    now.onRowShown();
    if (now.frame !== "sheet" || !now.root) return;
    pushing.current = true;
    now.onRoot(false);
  }, [askedRow, shown]);

  const scrollerOf = (el: HTMLElement): HTMLElement => {
    const scroller = el.closest<HTMLElement>(".sheet-body");
    if (scroller === null) throw new Error("Settings: the sheet pages are outside the sheet body");
    return scroller;
  };

  useLayoutEffect(() => {
    if (frame !== "sheet") return;
    const pages = body.current;
    if (pages === null) throw new Error("Settings: the sheet rendered without its pages");
    const scroller = scrollerOf(pages);
    if (atRoot) {
      const from = returning.current;
      if (from === null) return;
      returning.current = null;
      scroller.scrollTop = from.scroll;
      const row = pages.querySelector<HTMLElement>(`button.settings-root-row[data-section="${from.section}"]`);
      if (row === null) throw new Error(`Settings: the root has no ${from.section} row to return to`);
      row.focus();
      return;
    }
    const pushed = pushing.current;
    pushing.current = false;
    if (pushed) scroller.scrollTop = 0;
    const target = jump;
    if (target !== null && target.row !== null && target !== sheetJumped.current && target.section === shown) {
      sheetJumped.current = target;
      const key = rowKey(target.section, target.row.id);
      const row = pages.querySelector<HTMLElement>(`section.settings-page[data-section="${target.section}"] [data-settings-row="${key}"]`);
      if (row === null) throw new Error(`Settings: the ${key} row is not on its page`);
      row.scrollIntoView({ block: "nearest" });
      const first = focusables(row)[0] ?? backRef.current;
      if (first === null) throw new Error(`Settings: the ${key} row and the bar have nothing to focus`);
      first.focus();
      return;
    }
    if (!pushed) return;
    const backButton = backRef.current;
    if (backButton === null) throw new Error("Settings: a page was pushed without its Back");
    backButton.focus();
  }, [frame, atRoot, shown, jump]);

  useLayoutEffect(() => {
    if (frame !== "sheet") return;
    const pages = body.current;
    if (pages === null) throw new Error("Settings: the sheet rendered without its pages");
    const scroller = scrollerOf(pages);
    if (detail !== null) {
      if (!detailPushed.current) return;
      detailPushed.current = false;
      scroller.scrollTop = 0;
      if (detail.kind === "person" ? detail.focus !== null : detail.select) return;
      const backButton = backRef.current;
      if (backButton === null) throw new Error(`Settings: a ${detail.kind} was pushed without its Back`);
      backButton.focus();
      return;
    }
    const from = detailReturn.current;
    if (from === null) return;
    scroller.scrollTop = from.scroll;
  }, [frame, detail]);

  useEffect(() => {
    if (frame !== "sheet" || detail !== null) return;
    const from = detailReturn.current;
    if (from === null) return;
    detailReturn.current = null;
    const pages = body.current;
    if (pages === null) throw new Error("Settings: the sheet rendered without its pages");
    const page = pages.querySelector<HTMLElement>(`section.settings-page[data-section="${from.section}"]`);
    if (page === null) throw new Error(`Settings: returned to ${from.section} without its page`);
    const to = from.to;
    const row = to === null ? null : page.querySelector<HTMLElement>(`li[data-${to.kind}="${to.id}"]`);
    const session = latest.current.session;
    if (to !== null && row === null && session !== null && nameIn(session, to) !== null) throw new Error(`Settings: ${from.section} has no row for ${to.kind} ${to.id}, which is still in the plan`);
    const add = page.querySelector<HTMLButtonElement>("button.ios-add:not(:disabled)");
    const target = (row === null ? undefined : focusables(row)[0]) ?? add ?? backRef.current;
    if (target === null) throw new Error(`Settings: nothing to focus on ${from.section} after ${JSON.stringify(from)}`);
    target.focus();
  }, [frame, detail]);

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

  const go = (s: SettingsSection, row: RowSpec | null = null): void => {
    setJump({ section: s, row });
    setOwner(planId);
    corrected.current = null;
    saved.current = s;
    saveSection(window.localStorage, s);
    if (s === "sync" && row !== null && isSyncPane(row.id)) p.onSyncPane(row.id);
    p.onSection(s);
    if (frame === "modal" && p.root) p.onRoot(false);
  };
  const push = (s: SettingsSection, row: RowSpec | null = null): void => {
    const pages = body.current;
    if (pages === null) throw new Error(`Settings: asked to push ${s} without the sheet pages`);
    if (atRoot) rootScroll.current = scrollerOf(pages).scrollTop;
    pushing.current = true;
    go(s, row);
    p.onRoot(false);
  };
  const goBack = (): void => {
    returning.current = { section: shown, scroll: rootScroll.current };
    setEdit(null);
    p.onRoot(true);
  };
  const openDetail = (next: Detail): void => {
    const pages = body.current;
    if (pages === null) throw new Error(`Settings: asked to open ${next.kind} ${next.id} without the sheet pages`);
    pageScroll.current = scrollerOf(pages).scrollTop;
    detailPushed.current = true;
    setDetail(next);
  };
  const leaveDetail = (from: Detail, to: DetailRef | null): void => {
    detailReturn.current = { section: detailSection(from), to, scroll: pageScroll.current };
    setDetail(null);
  };
  const toPeople = (): void => {
    const add = SETTINGS_SECTIONS.flatMap((s) => (s.id === "people" ? s.rows : [])).find((r) => r.id === "add");
    if (add === undefined) throw new Error("Settings: People has no Add person row");
    if (frame === "sheet") push("people", add);
    else go("people", add);
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
        return <General session={p.session} device={p.device} renameDevice={p.renameDevice} clock={p.clock} updates={p.updates} onPeople={toPeople} />;
      case "theme":
        return (
          <>
            <ThemeBody hover={p.hover} />
            <Look />
          </>
        );
      case "sync":
        return (
          <>
            <Row section="sync" row="status" label="Status">
              <p className={`settings-status ${syncTone(p.sync)}`}>{chipText(p.sync, p.syncName)}</p>
            </Row>
            <div className="settings-sync">{p.syncPanes}</div>
          </>
        );
      case "files":
        return <Files session={p.session} files={p.files} clock={p.clock} backup={p.backup} />;
      case "overview":
        return <OverviewSection session={planSession(s.id)} readOnly={p.readOnly} />;
      case "people":
        return (
          <People
            session={planSession(s.id)}
            readOnly={p.readOnly}
            form={p.frame === "sheet" ? { kind: "list", editing: edit === "people", onOpen: (id, focus) => openDetail({ kind: "person", id, focus }) } : { kind: "table" }}
          />
        );
      case "workflow":
        return (
          <Workflow
            session={planSession(s.id)}
            readOnly={p.readOnly}
            form={p.frame === "sheet" ? { kind: "list", editing: edit === "workflow", onOpen: (id, select) => openDetail({ kind: "step", id, select }) } : { kind: "table" }}
          />
        );
      case "baselines":
        return <BaselinesSection session={planSession(s.id)} readOnly={p.readOnly} />;
      case "danger":
        return <DangerSection session={planSession(s.id)} locked={p.planLocked} onTrash={trash} />;
      case "defaults":
        return <Defaults session={planSession(s.id)} readOnly={p.readOnly} onPeople={toPeople} />;
      case "working-time":
        return <WorkingTimeSection session={planSession(s.id)} clock={p.clock} frame={p.frame} stash={calendarStash} />;
    }
  };

  const sectionKey = (s: SectionSpec): string => (s.plan ? `${s.id}:${planId ?? ""}` : s.id);

  if (p.frame === "sheet") {
    const back = atRoot ? undefined : detail !== null ? <SheetBack ref={backRef} label={detail.kind === "person" ? BACK_TO_PEOPLE : BACK_TO_WORKFLOW} onBack={() => leaveDetail(detail, detail)} /> : <SheetBack ref={backRef} label={BACK_TO_SETTINGS} onBack={goBack} />;
    const editable: Editing | null = atRoot || detail !== null ? null : shown === "people" || shown === "workflow" ? shown : null;
    const editButton = editable === null ? undefined : <SheetEdit editing={edit === editable} disabled={p.readOnly} onToggle={() => setEdit(edit === null ? editable : null)} />;
    const detailTitle = detailName ?? (detail !== null && detail.kind === "step" ? STEP_TITLE : PERSON_TITLE);
    const title = atRoot ? SETTINGS_TITLE : detail !== null ? detailTitle : sectionTitle(shown);
    const native = usesNativeAlert();
    return (
      <Sheet open title={title} label={SETTINGS_TITLE} kind="settings" lead={back} actions={editButton} onClose={() => closeSettings(api, p.onClose, native)}>
        {native && <ThemeDraftGuard />}
        <div ref={body} className="settings-pushed">
          <SettingsRoot sections={list} planName={planName} hidden={!atRoot} onOpen={(s) => push(s)} />
          {list
            .filter((s) => visited.has(s.id) || (!atRoot && s.id === shown))
            .map((s) => (
              <section key={sectionKey(s)} className="settings-page" data-section={s.id} aria-label={s.title} hidden={atRoot || s.id !== shown || detail !== null}>
                {content(s)}
              </section>
            ))}
          {detail !== null && (
            <section key={`${detail.kind}:${detail.id}`} className="settings-page" data-detail={detail.kind} aria-label={detailTitle}>
              {detail.kind === "person" ? (
                <PersonPage session={planSession("people")} readOnly={p.readOnly} person={detail.id} focus={detail.focus} onRemoved={(next) => leaveDetail(detail, next === null ? null : { kind: "person", id: next })} />
              ) : (
                <StepPage session={planSession("workflow")} readOnly={p.readOnly} step={detail.id} select={detail.select} />
              )}
            </section>
          )}
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
  const subscribe = useCallback((cb: () => void) => registry.subscribe(cb), [registry]);
  const device = useSyncExternalStore(subscribe, () => registry.device.name);
  return (
    <SettingsView
      {...p}
      device={device}
      renameDevice={(name) => registry.renameDevice(name)}
      backup={() => void backupFlow(registry, p.clock)}
      sync={state}
      syncName={docName(registry)}
      updates={updates}
      syncPanes={panes}
      planLocked={planLocked}
    />
  );
}
