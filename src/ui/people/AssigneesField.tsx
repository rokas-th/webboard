import { useLayoutEffect, useRef, useState } from "react";
import type { Item, PersonId } from "../../domain/model";
import { peopleOf, type Assignee } from "../../domain/people";
import type { PlanView } from "../../store/doc";
import { useTheme } from "../../theme/ThemeContext";
import { CloseGlyph } from "../common/dismiss";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { pointBelow, usePickMenu } from "../common/pickMenu";
import type { PickSection } from "../common/ContextMenu";
import { toast } from "../common/Toast";
import type { Run } from "../run";
import { useUiValue } from "../state";
import { assigneeName, assignSection, heldOf, PEOPLE_SETTINGS_ROW, personOfRow } from "./assign";
import { Avatar } from "./Avatar";
import { ADD_PEOPLE_IN_SETTINGS, ASSIGN, ASSIGN_MORE, UNASSIGNED, unassignLabel } from "./text";

const idOf = (a: Assignee): PersonId => (a.kind === "live" ? a.person.id : a.id);

const SETTINGS_SECTION: PickSection = { title: null, rows: [{ id: PEOPLE_SETTINGS_ROW, title: ADD_PEOPLE_IN_SETTINGS, checked: false, checkable: false }] };

type Refocus = { chip: PersonId } | { add: true };

export function AssigneesField(p: { view: PlanView; item: Item; readOnly: boolean; run: Run; labelledBy: string }) {
  const theme = useTheme();
  const { setUi } = useUiValue();
  const menu = usePickMenu(ASSIGN);
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(p.view);
  const [refocus, setRefocus] = useState<Refocus | null>(null);
  useLayoutEffect(() => {
    latest.current = p.view;
  });
  const list = p.view.people.assignees.get(p.item.id) ?? [];
  const shown = list.map(idOf);
  const item = p.item.id;

  useLayoutEffect(() => {
    if (refocus === null) return;
    setRefocus(null);
    const el = root.current;
    if (el === null) throw new Error("AssigneesField: the field is not rendered");
    const target = "chip" in refocus ? el.querySelector<HTMLButtonElement>(`.who-chip[data-who="${refocus.chip}"] button.chip-x`) : el.querySelector<HTMLButtonElement>("button.chip-add");
    if (target === null) throw new Error(`AssigneesField: nothing to focus after the unassign, ${JSON.stringify(refocus)}`);
    target.focus();
  }, [refocus]);

  const toggle = (person: PersonId, held: boolean): void => {
    const now = latest.current.plan;
    const it = now.items.get(item);
    if (it === undefined) throw new Error(`AssigneesField: the menu assigned item ${item}, which is not in the plan`);
    if (it.trashed || !peopleOf(now).some((x) => x.id === person)) {
      toast(STALE_CONFIRM, "bad");
      return;
    }
    p.run.run({ t: held ? "unassign" : "assign", items: [item], person });
  };

  const onChosen = (row: string, held: readonly PersonId[]): void => {
    if (row === PEOPLE_SETTINGS_ROW) {
      theme.preview(null);
      setUi({ settings: "people" });
      return;
    }
    const person = personOfRow(row);
    if (person === null) throw new Error(`AssigneesField: the menu chose ${JSON.stringify(row)}, which is no row of it`);
    toggle(person, held.includes(person));
  };

  const open = (anchor: HTMLElement): void => {
    const held = heldOf(p.view, item);
    const assign = assignSection(p.view.people.people, held);
    const section = assign === null ? SETTINGS_SECTION : { title: null, rows: assign.rows };
    menu.open(item, anchor, pointBelow(anchor), [section], (row) => onChosen(row, held));
  };

  const unassign = (id: PersonId): void => {
    const next = shown[shown.indexOf(id) + 1];
    if (p.run.run({ t: "assignees", item, people: shown.filter((x) => x !== id) }) === null) return;
    setRefocus(next === undefined ? { add: true } : { chip: next });
  };

  return (
    <div ref={root} className="assignees" data-detail-field="assignees" role="group" aria-labelledby={p.labelledBy} tabIndex={-1}>
      {list.map((a) => {
        const name = assigneeName(a);
        return (
          <span key={idOf(a)} className={a.kind === "former" ? "who-chip former" : "who-chip"} data-who={idOf(a)}>
            <Avatar assignee={a} />
            <span className="who-name">{name}</span>
            {!p.readOnly && (
              <button type="button" className="chip-x" aria-label={unassignLabel(name)} onClick={() => unassign(idOf(a))}>
                <CloseGlyph />
              </button>
            )}
          </span>
        );
      })}
      {p.readOnly && list.length === 0 && <span className="val dimc">{UNASSIGNED}</span>}
      {!p.readOnly && (
        <button type="button" className="chip-add" aria-haspopup="menu" aria-expanded={menu.openFor === item} onClick={(e) => open(e.currentTarget)}>
          {ASSIGN_MORE}
        </button>
      )}
      {menu.node}
    </div>
  );
}
