import { useCallback, useContext, useEffect, useReducer, useState, type ReactNode } from "react";
import type { ItemId } from "../../domain/model";
import { sideText } from "../../plan/choices";
import { usesNativeAlert } from "../../services/alert";
import type { Clock } from "../../services/clock";
import { noticeText, type HolidayNotice } from "../../services/holidays";
import type { PlanView } from "../../store/doc";
import { SPACE_PREFIX } from "../../store/plan-id";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { chipText, holdsPlan, type SyncState } from "../../sync/manager";
import { canReload } from "../../sync/reload";
import { docName } from "../../sync/SyncProvider";
import type { CalendarReview } from "../calendar/CalendarDialog";
import { CALENDAR_BANNER } from "../choices/CalendarBanner";
import { conflictSuccessor, countedConflicts } from "../choices/HeadCounts";
import { orderedSides } from "../choices/order";
import { Sheet } from "../common/Sheet";
import { OpenChoice } from "../run";
import { NOTICE_LABELS, reviewOf } from "../shell/HolidayState";
import { FILES_STAY, ReloadButton } from "../shell/PlanFailed";
import { ReloadConfirm } from "../shell/ReloadConfirm";
import { useUiValue } from "../state";
import { SyncActionButtons } from "../sync/SyncDialog";
import { CalendarSheet } from "./PlanSheet";

type Tone = "bad" | "cyan" | "amber" | "magenta" | "warn" | "note";

interface Line {
  key: string;
  text: string;
  tone: Tone;
  detail: string | null;
  message: string | null;
  onText: (() => void) | null;
  actions: ReactNode;
}

export interface PhoneSync {
  state: SyncState;
  open(): void;
}

export const NO_REGION = "No holiday region — dates use weekdays and closures";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const line = (key: string, text: string, tone: Tone, actions: ReactNode = null, detail: string | null = null, onText: (() => void) | null = null): Line => ({
  key,
  text,
  tone,
  detail,
  message: null,
  onText,
  actions,
});

function Act(p: { label: string; disabled?: boolean; onPress(): void }) {
  return (
    <button type="button" className="button-small" disabled={p.disabled === true} onClick={p.onPress}>
      {p.label}
    </button>
  );
}

export function PhoneStatus(p: { session: PlanSession | null; registry: Registry; clock: Clock; sync?: PhoneSync; onOpenItem: (item: ItemId) => void }) {
  const { session, registry } = p;
  const holidays = registry.holidays;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState(false);
  const [choicesOpen, setChoicesOpen] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [review, setReview] = useState<CalendarReview | null>(null);
  const { setUi } = useUiValue();
  const openChoice = useContext(OpenChoice);
  if (openChoice === null) throw new Error("PhoneStatus needs an OpenChoice provider");
  useEffect(() => registry.subscribe(bump), [registry]);
  useEffect(() => (session === null ? undefined : session.subscribe(bump)), [session]);
  useEffect(() => holidays.subscribe(bump), [holidays]);
  useEffect(() => {
    setChoicesOpen(false);
    setReview(null);
  }, [session]);

  const leave = (then: () => void): void => {
    setOpen(false);
    setChoicesOpen(false);
    then();
  };
  const openCalendar = (): void => leave(() => setUi({ dialog: { t: "calendar" } }));

  const reloadable = p.sync === undefined || canReload(p.sync.state);

  const syncLead = (sync: PhoneSync): Line[] => {
    const s = sync.state;
    if (s.kind !== "error") return [];
    const holds = s.doc !== null && !s.doc.startsWith(SPACE_PREFIX) && holdsPlan(registry, s.doc);
    const actions = (
      <SyncActionButtons holds={holds} small>
        <Act label="Open sync" onPress={() => leave(sync.open)} />
      </SyncActionButtons>
    );
    return [{ ...line("sync", chipText(s, docName(registry)), "magenta", actions), message: s.message }];
  };

  const syncTail = (sync: PhoneSync): Line[] => {
    const s = sync.state;
    const text = chipText(s, docName(registry));
    if (s.kind === "offline") return [line("sync", text, "amber")];
    if (s.kind === "receiving" && (session === null || session.view().pending === 0)) return [line("sync", text, "cyan")];
    return [];
  };

  const index = registry.indexError();
  const indexDoc = registry.indexErrorDoc();
  const space = index !== null && index.code === "store.corrupt" && indexDoc !== null && indexDoc.startsWith(SPACE_PREFIX) ? indexDoc : null;
  const spaceReadOnly = registry.spaceReadOnly();
  const offer = space !== null && !spaceReadOnly ? space : null;

  const registryLines = (): Line[] => {
    const settings = registry.settingsError();
    const asking = usesNativeAlert() && offer !== null && (confirm !== null || registry.reloading(offer));
    return [
      ...(index === null
        ? []
        : [
            line(
              "index",
              index.message,
              "bad",
              <>
                <Act label="Try again" disabled={asking} onPress={() => void registry.retryIndex()} />
                {offer !== null && <ReloadButton enabled={reloadable} small asking={asking} onOpen={() => setConfirm(offer)} />}
              </>,
              space !== null && spaceReadOnly ? FILES_STAY : null,
            ),
          ]),
      ...(settings === null ? [] : [line("settings", settings.message, "bad", <Act label="Try again" onPress={() => void registry.retrySettings()} />)]),
      ...registry.indexUnreadable().map((m, i) => line(`index-unreadable ${i}`, m, "bad")),
    ];
  };

  const noticeLine = (s: PlanSession, view: PlanView, n: HolidayNotice): Line => {
    const t = noticeText(n);
    const planId = view.plan.id;
    const press = (): void => {
      if (t.action === "load" || t.action === "retry") void holidays.load(planId, s, n.year);
      if (t.action === "review") {
        const r = reviewOf(n);
        leave(() => setReview(r));
      }
      if (t.action === "calendar") openCalendar();
    };
    return line(
      `notice ${n.k} ${n.year}`,
      t.text,
      n.k === "failed" || n.k === "refreshFailed" ? "warn" : "note",
      t.action === null ? null : <Act label={NOTICE_LABELS[t.action]} onPress={press} />,
      t.detail,
    );
  };

  const storeLines = (s: PlanSession): Line[] => {
    const stored = s.storeError();
    const id = s.view().plan.id;
    return stored === null ? [] : [line("store", stored.message, "bad", <Act label="Try again" onPress={() => void registry.retryPlan(id).finally(bump)} />)];
  };

  const planLines = (s: PlanSession): Line[] => {
    const view = s.view();
    const plan = view.plan;
    const conflicts = countedConflicts(view);
    const first = conflicts[0];
    return [
      ...view.unreadable.map((u) => line(`unreadable ${u.id}`, u.message, "bad")),
      ...(view.pending > 0 ? [line("pending", `Receiving… · ${plural(view.pending, "change waiting", "changes waiting")}`, "cyan")] : []),
      ...(plan.calendar.region === null ? [line("region", NO_REGION, "warn", <Act label="Choose region" onPress={openCalendar} />)] : []),
      ...holidays.notices(plan.id).map((n) => noticeLine(s, view, n)),
      ...(first === undefined
        ? []
        : [
            line(
              "conflicts",
              plural(conflicts.length, "conflict", "conflicts"),
              "magenta",
              <Act label="Go to first conflict" onPress={() => leave(() => p.onOpenItem(conflictSuccessor(view, first)))} />,
            ),
          ]),
      ...(view.choices.length === 0
        ? []
        : [line("choices", `${plural(view.choices.length, "open choice", "open choices")} · Choose…`, "amber", null, null, () => setChoicesOpen(true))]),
      ...view.choices
        .filter((c) => c.kind === "calendar")
        .map((c) => line(`calendar ${c.id}`, CALENDAR_BANNER, "amber", <Act label="Choose…" onPress={() => leave(() => openChoice(c.id))} />)),
    ];
  };

  const sync = p.sync;
  const lines = [
    ...(sync === undefined ? [] : syncLead(sync)),
    ...(session === null ? [] : storeLines(session)),
    ...registryLines(),
    ...(session === null ? [] : planLines(session)),
    ...(sync === undefined ? [] : syncTail(sync)),
  ];
  const none = lines.length === 0;
  useEffect(() => {
    if (none) setOpen(false);
  }, [none]);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const view = session?.view() ?? null;
  const noChoices = view === null || view.choices.length === 0;
  useEffect(() => {
    if (noChoices) setChoicesOpen(false);
  }, [noChoices]);
  const showChoices = choicesOpen && !noChoices;

  const first = lines[0];
  const local = registry.device.name;
  const sheets = (
    <>
      {open && (confirm === null || usesNativeAlert()) && !showChoices && (
        <Sheet open title="Status" onClose={() => setOpen(false)}>
          <ul className="status-lines">
            {lines.map((l) => (
              <li key={l.key} className={`status-line ${l.tone}`}>
                {l.onText === null ? (
                  <span className="status-text">{l.text}</span>
                ) : (
                  <button type="button" className="status-text line-button" onClick={l.onText}>
                    {l.text}
                  </button>
                )}
                {l.detail !== null && <span className="status-detail">{l.detail}</span>}
                {l.message !== null && <p className="sync-message bad">{l.message}</p>}
                {l.actions !== null && <div className="status-actions">{l.actions}</div>}
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      {showChoices && view !== null && (
        <Sheet open title="Open choices" onClose={() => setChoicesOpen(false)}>
          <ul className="status-choices" aria-label="Open choices">
            {view.choices.map((c) => (
              <li key={c.id}>
                <button type="button" className="choice-row" onClick={() => leave(() => openChoice(c.id))}>
                  {orderedSides(c, local)
                    .map((side) => sideText(c, side.key, view.plan))
                    .join(" or ")}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      {confirm !== null && <ReloadConfirm registry={registry} docId={confirm} offered={offer === confirm} frame="sheet" onClose={closeConfirm} />}
      {review !== null && session !== null && (
        <CalendarSheet session={session} registry={registry} clock={p.clock} review={review} onClose={() => setReview(null)} />
      )}
    </>
  );
  if (first === undefined && confirm === null && review === null) return null;
  return (
    <>
      {first !== undefined && (
        <div className="phone-status">
          <button type="button" className={`status-strip ${first.tone}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <span className="status-text">{first.text}</span>
            {lines.length > 1 && <span className="status-more">{` · +${lines.length - 1} more`}</span>}
          </button>
        </div>
      )}
      {sheets}
    </>
  );
}
