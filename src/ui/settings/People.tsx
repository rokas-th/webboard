import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { items } from "../../actions/copy";
import { STEP_COLOURS, type PersonId, type StepColour } from "../../domain/model";
import { initialsOf, peopleOf, type Person } from "../../domain/people";
import type { PlanView } from "../../store/doc";
import { usePlanView, type PlanSession } from "../../store/session";
import { ColourPop } from "../board/StepPopovers";
import type { Point } from "../common/ContextMenu";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { pointBelow } from "../common/pickMenu";
import { toast } from "../common/Toast";
import { TextField } from "../panel/TextField";
import { Avatar } from "../people/Avatar";
import {
  ADD_PERSON,
  ADD_PERSON_ROW,
  NEW_PERSON_LABEL,
  NEW_PERSON_PLACEHOLDER,
  PEOPLE,
  PEOPLE_EDIT_FOOT,
  PEOPLE_EMPTY,
  PEOPLE_FOOT,
  PEOPLE_HEAD,
  PEOPLE_LIST_FOOT,
  personColourLabel,
  personInitialsLabel,
  personNameLabel,
  personReorderLabel,
  REMOVE_ROW,
  removePersonLabel,
  sameNameText,
} from "../people/text";
import { useRun } from "../run";
import { useRemovePerson } from "./RemovePerson";
import { rowKey } from "./Row";

const SECTION = "people";

export type PeopleForm = { kind: "table" } | { kind: "list"; editing: boolean; onOpen(id: PersonId, focus: "initials" | null): void };

type Focus = { person: PersonId; what: "initials" | "grip" };

type Drag = { person: PersonId; over: PersonId | null };

const rowOf = (el: Element | null): PersonId | null => {
  const found = el === null ? null : el.closest<HTMLElement>("li[data-person]");
  const id = found === null ? undefined : found.dataset.person;
  return id === undefined ? null : id;
};

export const liveItemCount = (view: PlanView, id: PersonId): number =>
  [...view.people.assignees].filter(([item, held]) => {
    const it = view.plan.items.get(item);
    if (it === undefined) throw new Error(`People: item ${item} has assignees but is not in the plan`);
    return !it.trashed && held.some((a) => a.kind === "live" && a.person.id === id);
  }).length;

type DraftEnd = "key" | "blur";

function Draft(p: { list: boolean; onAdd(name: string, by: DraftEnd): boolean; onDone(): void }) {
  const [name, setName] = useState("");
  const settled = useRef(false);
  const refused = useRef<string | null>(null);
  const finish = (by: DraftEnd): void => {
    const typed = name.trim();
    if (typed === "") {
      settled.current = true;
      p.onDone();
      return;
    }
    if (p.onAdd(typed, by)) {
      settled.current = true;
      return;
    }
    refused.current = typed;
  };
  return (
    <li className={p.list ? "ios-row ios-draft" : "people-row people-draft"}>
      {!p.list && <span className="people-grip-gap" aria-hidden="true" />}
      <span className={p.list ? "ios-draft-gap" : "people-avatar-gap"} aria-hidden="true" />
      <input
        type="text"
        className="people-draft-name"
        aria-label={NEW_PERSON_LABEL}
        placeholder={NEW_PERSON_PLACEHOLDER}
        enterKeyHint="done"
        autoCapitalize="words"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            settled.current = true;
            p.onDone();
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          finish("key");
        }}
        onBlur={() => {
          if (settled.current || refused.current === name.trim()) return;
          finish("blur");
        }}
      />
    </li>
  );
}

function Status(p: { problems: readonly string[] }) {
  return (
    <p className="people-line" role="status">
      {p.problems.map((text) => (
        <span key={text} className="board-problem">
          {text}
        </span>
      ))}
    </p>
  );
}

interface Rows {
  people: readonly Person[];
  ro: boolean;
  list: RefObject<HTMLUListElement | null>;
  addButton: RefObject<HTMLButtonElement | null>;
  problems: readonly string[];
  draft: ReactNode;
  countOf(id: PersonId): number;
  rowClass(base: string, id: PersonId): string;
  onGripKey(e: ReactKeyboardEvent<HTMLButtonElement>, person: Person): void;
  onGripDown(e: ReactPointerEvent<HTMLButtonElement>, person: Person): void;
  onRemove(id: PersonId): void;
  onAdd(): void;
}

function ListRows(p: Rows & { editing: boolean; onOpen(id: PersonId): void }) {
  return (
    <div className="people-ios" data-settings-row={rowKey(SECTION, "people")}>
      <Status problems={p.problems} />
      {p.people.length === 0 && <p className="settings-line people-empty">{PEOPLE_EMPTY}</p>}
      <ul ref={p.list} className="ios-list" data-list="people">
        {p.people.map((x) => (
          <li key={x.id} className={p.rowClass("ios-row", x.id)} data-person={x.id}>
            {p.editing && (
              <button type="button" className="ios-minus" aria-label={removePersonLabel(x.name)} onClick={() => p.onRemove(x.id)}>
                <span className="danger-disc" aria-hidden="true" />
              </button>
            )}
            <button type="button" className="ios-row-main" disabled={p.editing} onClick={() => p.onOpen(x.id)}>
              <Avatar assignee={{ kind: "live", person: x }} />
              <span className="ios-row-name">{x.name}</span>
              <span className="ios-row-count">{items(p.countOf(x.id))}</span>
              {!p.editing && (
                <span className="settings-chev" aria-hidden="true">
                  ›
                </span>
              )}
            </button>
            {p.editing && (
              <button type="button" className="ios-grip" aria-label={personReorderLabel(x.name)} onKeyDown={(e) => p.onGripKey(e, x)} onPointerDown={(e) => p.onGripDown(e, x)}>
                <span className="workflow-grip-dots" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
        {p.draft}
        <li className="ios-row ios-add-row" data-settings-row={rowKey(SECTION, "add")}>
          <button ref={p.addButton} type="button" className="ios-add" disabled={p.ro} onClick={p.onAdd}>
            <span className="ios-plus" aria-hidden="true">
              +
            </span>
            {ADD_PERSON_ROW}
          </button>
        </li>
      </ul>
      <p className="settings-foot">{p.editing ? PEOPLE_EDIT_FOOT : PEOPLE_LIST_FOOT}</p>
    </div>
  );
}

function TableRows(p: Rows & { drafting: boolean; colourOpen: PersonId | null; onColour(id: PersonId, back: HTMLElement): void; rename(person: Person, name: string): boolean; setInitials(person: Person, initials: string): boolean }) {
  const ro = p.ro;
  return (
    <>
      <div className="settings-row settings-row-stack" data-settings-row={rowKey(SECTION, "people")}>
        <span className="settings-label">{PEOPLE}</span>
        <div className="people-control">
          <Status problems={p.problems} />
          {p.people.length === 0 && <p className="settings-line people-empty">{PEOPLE_EMPTY}</p>}
          {(p.people.length > 0 || p.drafting) && (
            <div className="people-head" aria-hidden="true">
              {PEOPLE_HEAD.map((h, i) => (
                <span key={i}>{h}</span>
              ))}
            </div>
          )}
          <ul ref={p.list} className="people-list">
            {p.people.map((x) => (
              <li key={x.id} className={p.rowClass("people-row", x.id)} data-person={x.id}>
                <button type="button" className="people-grip" aria-label={personReorderLabel(x.name)} disabled={ro} onKeyDown={(e) => p.onGripKey(e, x)} onPointerDown={(e) => p.onGripDown(e, x)}>
                  <span className="workflow-grip-dots" aria-hidden="true" />
                </button>
                <button type="button" className="people-avatar" aria-label={personColourLabel(x.name)} aria-haspopup="dialog" aria-expanded={p.colourOpen === x.id} disabled={ro} onClick={(e) => p.onColour(x.id, e.currentTarget)}>
                  <Avatar assignee={{ kind: "live", person: x }} />
                </button>
                {ro ? (
                  <input type="text" className="people-name" aria-label={personNameLabel(x.name)} value={x.name} disabled readOnly />
                ) : (
                  <TextField className="people-name" label={personNameLabel(x.name)} value={x.name} readOnly={false} onCommit={(next) => p.rename(x, next)} />
                )}
                {ro ? (
                  <input type="text" className="people-initials" aria-label={personInitialsLabel(x.name)} value={x.initials} disabled readOnly />
                ) : (
                  <TextField className="people-initials" label={personInitialsLabel(x.name)} value={x.initials} readOnly={false} onCommit={(next) => p.setInitials(x, next)} />
                )}
                <span className="people-count">{items(p.countOf(x.id))}</span>
                <button type="button" className="people-remove" aria-label={removePersonLabel(x.name)} disabled={ro} onClick={() => p.onRemove(x.id)}>
                  {REMOVE_ROW}
                </button>
              </li>
            ))}
            {p.draft}
          </ul>
          <p className="settings-line people-foot">{PEOPLE_FOOT}</p>
        </div>
      </div>
      <div className="people-add-row" data-settings-row={rowKey(SECTION, "add")}>
        <button ref={p.addButton} type="button" className="people-add" disabled={ro} onClick={p.onAdd}>
          {ADD_PERSON}
        </button>
      </div>
    </>
  );
}

export function People(p: { session: PlanSession; readOnly: boolean; form: PeopleForm }) {
  const view = usePlanView(p.session);
  const { run } = useRun(p.session);
  const [afterRemove, setAfterRemove] = useState<{ next: PersonId | null } | null>(null);
  const removing = useRemovePerson(p.session, (gone) => {
    const at = view.people.people.findIndex((x) => x.id === gone);
    if (at < 0) throw new Error(`People: removed ${gone}, who was not listed`);
    const next = view.people.people[at + 1];
    setAfterRemove({ next: next === undefined ? null : next.id });
  });
  const list = useRef<HTMLUListElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [pop, setPop] = useState<{ person: PersonId; at: Point; back: HTMLElement } | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drafting, setDrafting] = useState(false);
  const people = view.people.people;
  const ro = p.readOnly;
  const form = p.form;
  const listed = form.kind === "list";
  const editing = form.kind === "list" && form.editing && !ro;
  const gripClass = listed ? "ios-grip" : "people-grip";
  const removeClass = listed ? "ios-minus" : "people-remove";

  const reorderTo = (source: PersonId, target: PersonId): boolean => {
    const all = peopleOf(p.session.view().plan);
    const from = all.findIndex((x) => x.id === source);
    const to = all.findIndex((x) => x.id === target);
    if (from < 0 || to < 0) throw new Error(`People: reorder from ${source} to ${target} names a person who is not live`);
    if (from === to) return false;
    const after = to > from ? target : to === 0 ? null : all[to - 1].id;
    return run({ t: "person", op: "reorder", person: source, after }) !== null;
  };

  const reorderRef = useRef(reorderTo);
  const sessionRef = useRef(p.session);
  useLayoutEffect(() => {
    reorderRef.current = reorderTo;
    sessionRef.current = p.session;
  });

  const dragging = drag === null ? null : drag.person;
  useEffect(() => {
    if (dragging === null) return;
    const over: { current: PersonId | null } = { current: null };
    const onMove = (e: PointerEvent): void => {
      const at = rowOf(document.elementFromPoint(e.clientX, e.clientY));
      over.current = at;
      setDrag({ person: dragging, over: at });
    };
    const onUp = (): void => {
      setDrag(null);
      const target = over.current;
      if (target === null) return;
      const live = peopleOf(sessionRef.current.view().plan);
      if (![dragging, target].every((id) => live.some((x) => x.id === id))) {
        toast(STALE_CONFIRM, "bad");
        return;
      }
      reorderRef.current(dragging, target);
    };
    const onCancel = (): void => setDrag(null);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };
  }, [dragging]);

  useLayoutEffect(() => {
    if (focus === null) return;
    const root = list.current;
    if (root === null) throw new Error("People: the person list is not rendered");
    const el = root.querySelector<HTMLElement>(`li[data-person="${focus.person}"] ${focus.what === "initials" ? "input.people-initials" : `button.${gripClass}`}`);
    if (el === null) throw new Error(`People: person ${focus.person} has no ${focus.what} to focus`);
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, [focus, gripClass]);

  useEffect(() => {
    if (afterRemove === null) return;
    setAfterRemove(null);
    const el = afterRemove.next === null ? addButton.current : list.current === null ? null : list.current.querySelector<HTMLElement>(`li[data-person="${afterRemove.next}"] button.${removeClass}`);
    if (el === null) throw new Error(`People: nothing to focus after a removal, ${JSON.stringify(afterRemove)}`);
    el.focus();
  }, [afterRemove, removeClass]);

  const add = (name: string, by: DraftEnd): boolean => {
    const all = peopleOf(p.session.view().plan);
    const used = new Set(all.map((x) => x.colour));
    const colour: StepColour = STEP_COLOURS.find((c) => !used.has(c)) ?? "slate";
    const after = all.length === 0 ? null : all[all.length - 1].id;
    const known = new Set(all.map((x) => x.id));
    if (run({ t: "person", op: "add", name, initials: initialsOf(name), colour, after }) === null) return false;
    const made = peopleOf(p.session.view().plan).filter((x) => !known.has(x.id));
    if (made.length !== 1) throw new Error(`People: adding ${name} made ${made.length} people`);
    setDrafting(false);
    if (form.kind === "list") {
      if (by === "key") form.onOpen(made[0].id, "initials");
    } else setFocus({ person: made[0].id, what: "initials" });
    return true;
  };

  const rename = (person: Person, name: string): boolean => run({ t: "person", op: "rename", person: person.id, name }) !== null;

  const setInitials = (person: Person, initials: string): boolean => run({ t: "person", op: "initials", person: person.id, initials }) !== null;

  const pickColour = (id: PersonId, c: StepColour): void => {
    const person = peopleOf(p.session.view().plan).find((x) => x.id === id);
    setPop(null);
    if (person === undefined) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    if (c !== person.colour) run({ t: "person", op: "colour", person: id, colour: c });
  };

  const onGripKey = (e: ReactKeyboardEvent<HTMLButtonElement>, person: Person): void => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const at = people.findIndex((x) => x.id === person.id);
    if (at < 0) throw new Error(`People: person ${person.id} is not live`);
    const target = people[e.key === "ArrowUp" ? at - 1 : at + 1];
    if (target === undefined) return;
    if (reorderTo(person.id, target.id)) setFocus({ person: person.id, what: "grip" });
  };

  const onGripDown = (e: ReactPointerEvent<HTMLButtonElement>, person: Person): void => {
    if (ro || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    setDrag({ person: person.id, over: null });
  };

  const popPerson = pop === null ? null : (people.find((x) => x.id === pop.person) ?? null);
  const popGone = pop !== null && popPerson === null;
  useEffect(() => {
    if (!popGone) return;
    setPop(null);
    toast(STALE_CONFIRM, "bad");
  }, [popGone]);

  const problems = view.people.problems.map((pr) => {
    const first = people.find((x) => x.id === pr.people[0]);
    if (first === undefined) throw new Error(`People: a same-name problem names ${pr.people[0]}, who is not live`);
    return sameNameText(first.name);
  });

  const rowClass = (base: string, id: PersonId): string => {
    const lifted = drag !== null && drag.person === id ? ["dragging"] : [];
    const target = drag !== null && drag.over === id && drag.person !== id ? ["drop-over"] : [];
    return [base, ...lifted, ...target].join(" ");
  };

  const startDraft = (): void => {
    if (drafting) {
      const el = list.current === null ? null : list.current.querySelector<HTMLInputElement>("input.people-draft-name");
      if (el === null) throw new Error("People: the draft row is not rendered");
      el.focus();
      return;
    }
    setDrafting(true);
  };

  const rows: Rows = {
    people,
    ro,
    list,
    addButton,
    problems,
    draft: drafting && !ro ? <Draft list={listed} onAdd={add} onDone={() => setDrafting(false)} /> : null,
    countOf: (id) => liveItemCount(view, id),
    rowClass,
    onGripKey,
    onGripDown,
    onRemove: (id) => removing.ask(id),
    onAdd: startDraft,
  };

  return (
    <>
      {form.kind === "list" ? (
        <ListRows {...rows} editing={editing} onOpen={(id) => form.onOpen(id, null)} />
      ) : (
        <TableRows
          {...rows}
          drafting={drafting}
          colourOpen={pop === null ? null : pop.person}
          onColour={(id, back) => setPop({ person: id, at: pointBelow(back), back })}
          rename={rename}
          setInitials={setInitials}
        />
      )}
      {pop !== null && popPerson !== null && (
        <div
          className="people-pop"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            setPop(null);
          }}
        >
          <ColourPop name={popPerson.name} colour={popPerson.colour} at={pop.at} back={pop.back} onPick={(c) => pickColour(popPerson.id, c)} onClose={() => setPop(null)} />
        </div>
      )}
      {removing.node}
    </>
  );
}
