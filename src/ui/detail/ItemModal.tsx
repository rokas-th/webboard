import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import type { ItemId } from "../../domain/model";
import { usePlanView, type PlanSession } from "../../store/session";
import { Dialog } from "../common/Dialog";
import { commitFocus } from "../common/dismiss";
import { isControl, isTyping } from "../palette/keymap";
import { useDetail } from "./DetailContext";
import { COLLAPSE_TEXT, ItemDetail } from "./ItemDetail";

export interface FocusMemo {
  field: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  scrollTop: number;
}

export function rememberFocus(detail: HTMLElement, scroller: HTMLElement): FocusMemo {
  const active = document.activeElement;
  const field = active instanceof HTMLElement && detail.contains(active) ? active.closest<HTMLElement>("[data-detail-field]") : null;
  const text = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null;
  return {
    field: field === null ? null : (field.dataset.detailField ?? null),
    selectionStart: text === null ? null : text.selectionStart,
    selectionEnd: text === null ? null : text.selectionEnd,
    scrollTop: scroller.scrollTop,
  };
}

const STEP_KEYS: Readonly<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1, J: 1, K: -1 };

function restore(body: HTMLElement, memo: FocusMemo | null, item: ItemId): void {
  const root = body.querySelector('[data-detail="modal"]');
  if (!(root instanceof HTMLElement)) throw new Error(`ItemModal: no detail to focus for ${item}`);
  const named = memo === null || memo.field === null ? null : root.querySelector(`[data-detail-field="${memo.field}"]`);
  const target = named instanceof HTMLElement ? named : root;
  target.focus({ preventScroll: true });
  const same = memo !== null && memo.field === target.dataset.detailField;
  if (same && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && memo.selectionStart !== null && memo.selectionEnd !== null) {
    target.setSelectionRange(memo.selectionStart, memo.selectionEnd);
  }
  body.scrollTop = memo === null ? 0 : memo.scrollTop;
}

export function ItemModal(p: {
  session: PlanSession;
  item: ItemId;
  local: string;
  command: boolean;
  readOnly: boolean;
  naming: boolean;
  memo: FocusMemo | null;
  onNamed(): void;
  onRename(): void;
  onClose(): void;
}) {
  const view = usePlanView(p.session);
  const { step } = useDetail();
  const body = useRef<HTMLDivElement>(null);
  const [memo] = useState(p.memo);
  const [first] = useState(p.item);
  const it = view.plan.items.get(p.item);
  if (it === undefined) throw new Error(`ItemModal: no item ${p.item}`);

  useLayoutEffect(() => {
    const el = body.current;
    if (el === null) throw new Error("ItemModal: no body to restore focus in");
    restore(el, memo, first);
  }, [memo, first]);

  const collapse = (): void => {
    const el = body.current;
    if (el === null) throw new Error("ItemModal: closed without its body");
    const root = el.closest<HTMLElement>("[data-item-modal]");
    if (root === null) throw new Error("ItemModal: the body is outside the item modal");
    if (!flushSync(() => commitFocus(root, "The item modal"))) return;
    p.onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping(e.target, e.key) || isControl(e.target)) return;
    const by = STEP_KEYS[e.key];
    if (by !== undefined) {
      e.preventDefault();
      step(by);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (!e.repeat) collapse();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      p.onRename();
    }
  };

  return (
    <Dialog label={it.name} size="item" onClose={p.onClose} onKeyDown={onKeyDown}>
      <div ref={body} className="modal-item-body">
        <ItemDetail
          session={p.session}
          item={p.item}
          container="modal"
          local={p.local}
          command={p.command}
          readOnly={p.readOnly}
          naming={p.naming}
          onNamed={p.onNamed}
          onExpand={collapse}
          expandLabel={COLLAPSE_TEXT.label}
          expandTitle={COLLAPSE_TEXT.title}
        />
      </div>
    </Dialog>
  );
}
