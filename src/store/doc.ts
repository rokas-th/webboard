import * as Y from "yjs";
import type { ItemId } from "../domain/model";
import type { Action, ActionId, Cause, Write } from "../log/types";

export const LOCAL: unique symbol = Symbol("LOCAL");

const LETTER: Readonly<Record<Cause, string>> = {
  own: "o",
  push: "p",
  recalendar: "r",
  undo: "u",
  revert: "v",
  resolution: "s",
};

const CAUSE: ReadonlyMap<unknown, Cause> = new Map(
  (Object.entries(LETTER) as [Cause, string][]).map(([cause, letter]) => [letter, cause]),
);

const META_KEYS: ReadonlySet<string> = new Set(["undo", "redo", "revert", "resolves", "imported"]);

export function encodeAction(a: Action): unknown[] {
  const tuple: unknown[] = [a.dev, a.ses, a.at, [...a.par], a.lbl, a.w.flatMap((w) => [w.u, w.v, LETTER[w.c]])];
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
  return writes.every((w) => w !== null) ? (writes as Write[]) : null;
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
    const taken = newNotes.find((item, n) => this.notes.has(item) || newNotes.indexOf(item) !== n);
    if (taken !== undefined) throw new Error(`Item ${taken} already has a note`);
    this.ydoc.transact(() => {
      this.actionMap.set(action.id, encodeAction(action));
      newNotes.forEach((item) => this.notes.set(item, new Y.Text()));
    }, LOCAL);
  }

  actions(): Iterable<Action> {
    return [...this.actionMap.entries()].map(([id, raw]) => decodeAction(id, raw));
  }

  onActions(cb: (added: readonly Action[], local: boolean) => void): () => void {
    const observer = (event: Y.YMapEvent<unknown>): void => {
      const added = [...event.changes.keys]
        .filter(([, change]) => change.action === "add")
        .map(([id]) => decodeAction(id, this.actionMap.get(id)));
      if (added.length > 0) cb(added, event.transaction.origin === LOCAL);
    };
    this.actionMap.observe(observer);
    return () => this.actionMap.unobserve(observer);
  }

  note(item: ItemId): Y.Text {
    const text = this.notes.get(item);
    if (!(text instanceof Y.Text)) throw new Error(`Item ${item} has no note: it was created without one`);
    return text;
  }
}
