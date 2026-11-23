import * as Y from "yjs";
import type { IsoDate } from "../domain/dates";
import type { DefaultsProjection } from "../domain/defaults";
import type { Derived } from "../domain/derive";
import type { ItemId, PersonId, PersonValue, PlanState } from "../domain/model";
import type { PeopleProjection } from "../domain/people";
import type { Action, ActionId, Cause, Write } from "../log/types";
import type { Choice } from "../plan/choices";

export const LOCAL: unique symbol = Symbol("LOCAL");

export interface PlanView { plan: PlanState; derived: Derived; people: PeopleProjection; former: ReadonlyMap<PersonId, PersonValue>; defaults: DefaultsProjection; choices: readonly Choice[]; held: ReadonlySet<ItemId>; pending: number; today: IsoDate; unreadable: readonly { id: ActionId; message: string }[]; newer: boolean }

const LETTER: Readonly<Record<Cause, string>> = {
  own: "o",
  push: "p",
  recalendar: "r",
  undo: "u",
  revert: "v",
  resolution: "s",
};

const CAUSES: readonly Cause[] = ["own", "push", "recalendar", "undo", "revert", "resolution"];

const CAUSE: ReadonlyMap<unknown, Cause> = new Map(CAUSES.map((cause) => [LETTER[cause], cause]));

const META_KEYS: ReadonlySet<string> = new Set(["undo", "redo", "revert", "resolves", "imported"]);

const letterOf = (id: ActionId, c: Cause): string => {
  const letter = LETTER[c];
  if (CAUSE.get(letter) !== c) throw new Error(`Action ${id} has a malformed w`);
  return letter;
};

export function encodeAction(a: Action): unknown[] {
  const tuple: unknown[] = [a.dev, a.ses, a.at, [...a.par], a.lbl, a.w.flatMap((w) => [w.u, w.v, letterOf(a.id, w.c)])];
  return a.meta === undefined ? tuple : [...tuple, { ...a.meta }];
}

const isString = (x: unknown): x is string => typeof x === "string";

const decodeWrites = (raw: unknown): Write[] | null => {
  if (!Array.isArray(raw) || raw.length % 3 !== 0) return null;
  const writes = Array.from({ length: raw.length / 3 }, (_, k) => {
    const [u, v, letter] = raw.slice(k * 3, k * 3 + 3);
    const c = CAUSE.get(letter);
    return isString(u) && c !== undefined ? { u, v, c } : null;
  });
  return writes.every((w): w is Write => w !== null) ? writes : null;
};

const decodeMeta = (raw: unknown): Action["meta"] | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  return entries.every(([k, v]) => META_KEYS.has(k) && isString(v)) ? Object.fromEntries(entries) : null;
};

export function decodeAction(id: ActionId, raw: unknown): Action {
  const bad = (field: string): Error => new Error(`Action ${id} has a malformed ${field}`);
  if (!Array.isArray(raw)) throw bad("dev");
  const [dev, ses, at, par, lbl, flat, meta] = raw;
  if (!isString(dev)) throw bad("dev");
  if (!isString(ses)) throw bad("ses");
  if (typeof at !== "number" || !Number.isFinite(at)) throw bad("at");
  if (!Array.isArray(par) || !par.every(isString)) throw bad("par");
  if (!isString(lbl)) throw bad("lbl");
  const w = decodeWrites(flat);
  if (w === null) throw bad("w");
  if (raw.length === 6) return { id, dev, ses, at, par: [...par], lbl, w };
  const m = raw.length === 7 ? decodeMeta(meta) : null;
  if (m === null) throw bad("meta");
  return { id, dev, ses, at, par: [...par], lbl, w, meta: m };
}

export class PlanDoc {
  readonly ydoc: Y.Doc;
  private readonly actionMap: Y.Map<unknown>;
  private readonly notes: Y.Map<unknown>;

  constructor(doc: Y.Doc) {
    this.ydoc = doc;
    this.actionMap = doc.getMap("actions");
    this.notes = doc.getMap("notes");
  }

  append(action: Action, newNotes: readonly ItemId[]): void {
    if (this.actionMap.has(action.id)) throw new Error(`Action ${action.id} already exists`);
    const taken = newNotes.find((item) => this.notes.has(item));
    if (taken !== undefined) throw new Error(`Item ${taken} already has a note`);
    const twice = newNotes.find((item, n) => newNotes.indexOf(item) !== n);
    if (twice !== undefined) throw new Error(`Item ${twice} is listed twice in newNotes`);
    const tuple = encodeAction(action);
    decodeAction(action.id, tuple);
    this.ydoc.transact(() => {
      this.actionMap.set(action.id, tuple);
      newNotes.forEach((item) => this.notes.set(item, new Y.Text()));
    }, LOCAL);
  }

  actions(): Iterable<Action> {
    return [...this.actionMap.entries()].map(([id, raw]) => decodeAction(id, raw));
  }

  onActions(cb: (added: readonly Action[], local: boolean) => void): () => void {
    const observer = (event: Y.YMapEvent<unknown>): void => {
      const changes = [...event.changes.keys];
      changes.forEach(([id, change]) => {
        if (change.action === "update") throw new Error(`Action ${id} was updated; the action log is append-only`);
        if (change.action === "delete") throw new Error(`Action ${id} was deleted; the action log is append-only`);
      });
      const added = changes.map(([id]) => decodeAction(id, this.actionMap.get(id)));
      if (added.length > 0) cb(added, event.transaction.origin === LOCAL);
    };
    this.actionMap.observe(observer);
    return () => this.actionMap.unobserve(observer);
  }

  onNotes(cb: () => void): () => void {
    const observer = (): void => cb();
    this.notes.observeDeep(observer);
    return () => this.notes.unobserveDeep(observer);
  }

  note(item: ItemId): Y.Text {
    const text = this.notes.get(item);
    if (text === undefined) throw new Error(`Item ${item} has no note: it was created without one`);
    if (!(text instanceof Y.Text)) throw new Error(`Item ${item} has a note that is not text`);
    return text;
  }
}
