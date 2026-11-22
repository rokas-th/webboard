import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { holders } from "../../actions/people";
import type { PersonId, PlanState } from "../../domain/model";
import { peopleOf, type Person } from "../../domain/people";
import { CANCEL_LABEL, usesNativeAlert } from "../../services/alert";
import { usePlanView, type PlanSession } from "../../store/session";
import { Dialog } from "../common/Dialog";
import { NativeConfirm, STALE_CONFIRM } from "../common/NativeConfirm";
import { toast } from "../common/Toast";
import { Avatar } from "../people/Avatar";
import { GIVE_TO_GROUP, REMOVE, REMOVE_PERSON, removeEmptyText, removeHeldText, trashedOfThem, UNASSIGNED } from "../people/text";
import { useRun } from "../run";

export interface RemovePersonAsk {
  ask(person: PersonId): void;
  node: ReactNode;
}

type Asking = { person: Person; variant: "empty" | "give" };

const NONE = "none";

function personHolding(plan: PlanState, person: PersonId): { held: number; trashed: number } {
  const items = holders(plan, person).map(([item]) => {
    const it = plan.items.get(item);
    if (it === undefined) throw new Error(`RemovePerson: item ${item} holds ${person} but is not in the plan`);
    return it;
  });
  return { held: items.length, trashed: items.filter((it) => it.trashed).length };
}

const emptyNow = (plan: PlanState, person: PersonId): boolean => peopleOf(plan).some((x) => x.id === person) && personHolding(plan, person).held === 0;

function NativeRemove(p: { session: PlanSession; person: Person; current: boolean; onRemoved(): void; onClose(): void }) {
  const { run } = useRun(p.session);
  return (
    <NativeConfirm
      ask={{ title: REMOVE_PERSON, message: removeEmptyText(p.person.name), confirm: { label: REMOVE, destructive: true }, cancel: CANCEL_LABEL }}
      current={p.current}
      run={() => {
        if (run({ t: "person", op: "remove", person: p.person.id, to: null }) !== null) p.onRemoved();
      }}
      onClose={p.onClose}
    />
  );
}

function EmptyRemove(p: { session: PlanSession; person: Person; onRemoved(): void; onClose(): void }) {
  const { run } = useRun(p.session);
  const remove = (): void => {
    if (!emptyNow(p.session.view().plan, p.person.id)) {
      toast(STALE_CONFIRM, "bad");
      p.onClose();
      return;
    }
    if (run({ t: "person", op: "remove", person: p.person.id, to: null }) === null) return;
    p.onRemoved();
    p.onClose();
  };
  return (
    <Dialog label={REMOVE_PERSON} onClose={p.onClose}>
      <p className="remove-person-text">{removeEmptyText(p.person.name)}</p>
      <div className="modal-actions">
        <button type="button" onClick={p.onClose}>
          {CANCEL_LABEL}
        </button>
        <button type="button" className="button-danger" onClick={remove}>
          {REMOVE}
        </button>
      </div>
    </Dialog>
  );
}

function GiveRemove(p: { session: PlanSession; person: Person; others: readonly Person[]; held: number; trashed: number; onRemoved(): void; onClose(): void }) {
  const { run } = useRun(p.session);
  const group = useId();
  const [picked, setPicked] = useState<PersonId | null>(null);
  const to = picked === null ? null : (p.others.find((x) => x.id === picked) ?? null);
  const pickGone = picked !== null && to === null;
  useEffect(() => {
    if (!pickGone) return;
    setPicked(null);
    toast(STALE_CONFIRM, "bad");
  }, [pickGone]);
  const remove = (): void => {
    if (pickGone) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    if (run({ t: "person", op: "remove", person: p.person.id, to: to === null ? null : to.id }) === null) return;
    p.onRemoved();
    p.onClose();
  };
  return (
    <Dialog label={REMOVE_PERSON} onClose={p.onClose}>
      <p className="remove-person-text">{removeHeldText(p.person.name, p.held)}</p>
      {p.trashed > 0 && <p className="remove-person-trashed">{trashedOfThem(p.trashed)}</p>}
      <div className="step-pick person-pick" role="radiogroup" aria-label={GIVE_TO_GROUP}>
        <label className={picked === null ? "step-pick-row on" : "step-pick-row"} data-pick={NONE}>
          <input type="radio" name={group} value={NONE} checked={picked === null} onChange={() => setPicked(null)} />
          <span className="step-pick-name">{UNASSIGNED}</span>
        </label>
        {p.others.map((x) => (
          <label key={x.id} className={x.id === picked ? "step-pick-row on" : "step-pick-row"} data-pick={x.id}>
            <input type="radio" name={group} value={x.id} checked={x.id === picked} onChange={() => setPicked(x.id)} />
            <Avatar assignee={{ kind: "live", person: x }} />
            <span className="step-pick-name">{x.name}</span>
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={p.onClose}>
          {CANCEL_LABEL}
        </button>
        <button type="button" className="button-danger" onClick={remove}>
          {REMOVE}
        </button>
      </div>
    </Dialog>
  );
}

function Gone(p: { onClose(): void }) {
  const { onClose } = p;
  useEffect(() => {
    toast(STALE_CONFIRM, "bad");
    onClose();
  }, [onClose]);
  return null;
}

function RemovePerson(p: { session: PlanSession; asking: Asking; onRemoved(): void; onClose(): void }) {
  const view = usePlanView(p.session);
  const { variant } = p.asking;
  if (variant === "empty" && usesNativeAlert()) {
    return <NativeRemove session={p.session} person={p.asking.person} current={emptyNow(view.plan, p.asking.person.id)} onRemoved={p.onRemoved} onClose={p.onClose} />;
  }
  const people = peopleOf(view.plan);
  const person = people.find((x) => x.id === p.asking.person.id);
  if (person === undefined) return <Gone onClose={p.onClose} />;
  if (variant === "empty") return <EmptyRemove session={p.session} person={person} onRemoved={p.onRemoved} onClose={p.onClose} />;
  const { held, trashed } = personHolding(view.plan, person.id);
  return <GiveRemove session={p.session} person={person} others={people.filter((x) => x.id !== person.id)} held={held} trashed={trashed} onRemoved={p.onRemoved} onClose={p.onClose} />;
}

export function useRemovePerson(session: PlanSession, onRemoved: (person: PersonId) => void): RemovePersonAsk {
  const [asking, setAsking] = useState<Asking | null>(null);
  const latest = useRef(onRemoved);
  useLayoutEffect(() => {
    latest.current = onRemoved;
  });
  const close = useCallback(() => setAsking(null), []);
  const ask = useCallback(
    (id: PersonId): void => {
      const plan = session.view().plan;
      const person = peopleOf(plan).find((x) => x.id === id);
      if (person === undefined) {
        toast(STALE_CONFIRM, "bad");
        return;
      }
      setAsking({ person, variant: personHolding(plan, id).held === 0 ? "empty" : "give" });
    },
    [session],
  );
  const removed = useCallback(() => {
    if (asking === null) throw new Error("RemovePerson: a removal finished with nothing asked");
    latest.current(asking.person.id);
  }, [asking]);
  return { ask, node: asking === null ? null : <RemovePerson session={session} asking={asking} onRemoved={removed} onClose={close} /> };
}
