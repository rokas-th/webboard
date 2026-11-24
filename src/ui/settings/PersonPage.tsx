import { useLayoutEffect, useRef, useState } from "react";
import { items } from "../../actions/copy";
import type { PersonId, StepColour } from "../../domain/model";
import { peopleOf, type Person } from "../../domain/people";
import { usePlanView, type PlanSession } from "../../store/session";
import { ColourPop } from "../board/StepPopovers";
import type { Point } from "../common/ContextMenu";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { pointBelow } from "../common/pickMenu";
import { toast } from "../common/Toast";
import { TextField } from "../panel/TextField";
import { Avatar } from "../people/Avatar";
import { PERSON_GONE, personColourLabel, personInitialsLabel, personNameLabel, REMOVE_PERSON } from "../people/text";
import { useRun } from "../run";
import { liveItemCount } from "./People";
import { useRemovePerson } from "./RemovePerson";
import { DetailRow } from "./SettingsPages";

export const PERSON_LABELS = { name: "Name", initials: "Initials", colour: "Colour", items: "Items" } as const;

function Fields(p: { session: PlanSession; readOnly: boolean; person: Person; count: number; focus: "initials" | null; onRemove(): void }) {
  const { run } = useRun(p.session);
  const box = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ at: Point; back: HTMLElement } | null>(null);
  const x = p.person;
  const ro = p.readOnly;
  const focus = p.focus;

  useLayoutEffect(() => {
    if (focus === null) return;
    const root = box.current;
    if (root === null) throw new Error("PersonPage: the fields are not rendered");
    const el = root.querySelector<HTMLInputElement>("input.people-initials");
    if (el === null) throw new Error("PersonPage: there are no initials to focus");
    el.focus();
    el.select();
  }, [focus]);

  const pickColour = (c: StepColour): void => {
    setPop(null);
    const now = peopleOf(p.session.view().plan).find((y) => y.id === x.id);
    if (now === undefined) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    if (c !== now.colour) run({ t: "person", op: "colour", person: x.id, colour: c });
  };

  return (
    <div ref={box} className="settings-detail" data-person={x.id}>
      <div className="settings-detail-card">
        <DetailRow label={PERSON_LABELS.name}>
          {ro ? (
            <input type="text" className="people-name" aria-label={personNameLabel(x.name)} value={x.name} disabled readOnly />
          ) : (
            <TextField className="people-name" label={personNameLabel(x.name)} value={x.name} readOnly={false} onCommit={(next) => run({ t: "person", op: "rename", person: x.id, name: next }) !== null} />
          )}
        </DetailRow>
        <DetailRow label={PERSON_LABELS.initials}>
          {ro ? (
            <input type="text" className="people-initials" aria-label={personInitialsLabel(x.name)} value={x.initials} disabled readOnly />
          ) : (
            <TextField className="people-initials" label={personInitialsLabel(x.name)} value={x.initials} readOnly={false} onCommit={(next) => run({ t: "person", op: "initials", person: x.id, initials: next }) !== null} />
          )}
        </DetailRow>
        <DetailRow label={PERSON_LABELS.colour}>
          <button
            type="button"
            className="people-avatar"
            aria-label={personColourLabel(x.name)}
            aria-haspopup="dialog"
            aria-expanded={pop !== null}
            disabled={ro}
            onClick={(e) => setPop({ at: pointBelow(e.currentTarget), back: e.currentTarget })}
          >
            <Avatar assignee={{ kind: "live", person: x }} />
          </button>
        </DetailRow>
        <DetailRow label={PERSON_LABELS.items}>
          <span className="settings-detail-value">{items(p.count)}</span>
        </DetailRow>
      </div>
      <button type="button" className="settings-detail-danger" disabled={ro} onClick={p.onRemove}>
        {REMOVE_PERSON}
      </button>
      {pop !== null && (
        <div
          className="people-pop"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            setPop(null);
          }}
        >
          <ColourPop name={x.name} colour={x.colour} at={pop.at} back={pop.back} onPick={pickColour} onClose={() => setPop(null)} />
        </div>
      )}
    </div>
  );
}

export function PersonPage(p: { session: PlanSession; readOnly: boolean; person: PersonId; focus: "initials" | null; onRemoved(next: PersonId | null): void }) {
  const view = usePlanView(p.session);
  const people = view.people.people;
  const at = people.findIndex((x) => x.id === p.person);
  const person = at < 0 ? null : people[at];
  const removing = useRemovePerson(p.session, (gone) => {
    if (gone !== p.person) throw new Error(`PersonPage: removed ${gone} from the page of ${p.person}`);
    if (at < 0) throw new Error(`PersonPage: removed ${gone}, who was not listed`);
    const next = people[at + 1];
    p.onRemoved(next === undefined ? null : next.id);
  });
  return (
    <>
      {person === null ? (
        <p className="settings-line">{PERSON_GONE}</p>
      ) : (
        <Fields session={p.session} readOnly={p.readOnly} person={person} count={liveItemCount(view, person.id)} focus={p.focus} onRemove={() => removing.ask(person.id)} />
      )}
      {removing.node}
    </>
  );
}
