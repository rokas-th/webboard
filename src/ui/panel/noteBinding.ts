import * as Y from "yjs";

export const LOCAL_NOTE: unique symbol = Symbol("LOCAL_NOTE");

export interface NoteBinding {
  undo(): boolean;
  redo(): boolean;
  dispose(): void;
}

function diff(before: string, after: string): { at: number; remove: number; insert: string } {
  const most = Math.min(before.length, after.length);
  let head = 0;
  while (head < most && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < most - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { at: head, remove: before.length - head - tail, insert: after.slice(head, after.length - tail) };
}

export function bindTextarea(el: HTMLTextAreaElement, text: Y.Text): NoteBinding {
  const doc = text.doc;
  if (doc === null) throw new Error("bindTextarea needs a Y.Text inside a Y.Doc");
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL_NOTE]) });
  let caret: { start: Y.RelativePosition; end: Y.RelativePosition } | null = null;
  el.value = text.toString();

  const onInput = (): void => {
    const d = diff(text.toString(), el.value);
    if (d.remove === 0 && d.insert === "") return;
    doc.transact(() => {
      if (d.remove > 0) text.delete(d.at, d.remove);
      if (d.insert !== "") text.insert(d.at, d.insert);
    }, LOCAL_NOTE);
  };

  const remember = (tr: Y.Transaction): void => {
    if (tr.origin === LOCAL_NOTE) return;
    caret = {
      start: Y.createRelativePositionFromTypeIndex(text, el.selectionStart),
      end: Y.createRelativePositionFromTypeIndex(text, el.selectionEnd),
    };
  };

  const indexOf = (rel: Y.RelativePosition): number => {
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
    if (abs === null) throw new Error("A note caret position no longer resolves");
    return abs.index;
  };

  const onChange = (_e: Y.YTextEvent, tr: Y.Transaction): void => {
    if (tr.origin === LOCAL_NOTE) return;
    const value = text.toString();
    if (value === el.value) return;
    const at = caret;
    el.value = value;
    if (at !== null && el.ownerDocument.activeElement === el) el.setSelectionRange(indexOf(at.start), indexOf(at.end));
  };

  doc.on("beforeTransaction", remember);
  text.observe(onChange);
  el.addEventListener("input", onInput);

  return {
    undo: () => undoManager.undo() !== null,
    redo: () => undoManager.redo() !== null,
    dispose: () => {
      el.removeEventListener("input", onInput);
      text.unobserve(onChange);
      doc.off("beforeTransaction", remember);
      undoManager.destroy();
    },
  };
}
