import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import type { Item, ItemId } from "../../domain/model";
import { usePlanView, type PlanSession } from "../../store/session";
import { CloseButton, commitFocus } from "../common/dismiss";
import { ItemPanel } from "../panel/ItemPanel";
import { useDetail } from "./DetailContext";

export type DetailContainer = "column" | "drawer" | "modal" | "sheet";

export interface ExpandText {
  label: string;
  title: string;
}

export const OPEN_AS_MODAL = "Open as modal";

export const BACK_TO_INSPECTOR = "Back to the inspector";

export function promoteText(command: boolean): ExpandText {
  return { label: OPEN_AS_MODAL, title: `${OPEN_AS_MODAL} (Space, ${command ? "⌘↓" : "Ctrl ↓"})` };
}

export const COLLAPSE_TEXT: ExpandText = { label: BACK_TO_INSPECTOR, title: `${BACK_TO_INSPECTOR} (Space)` };

export const EXPAND_FULL = "Expand to full height";

export const BACK_TO_MEDIUM = "Back to medium height";

export function detentText(detent: "medium" | "large"): ExpandText {
  const label = detent === "medium" ? EXPAND_FULL : BACK_TO_MEDIUM;
  return { label, title: label };
}

const KIND: Readonly<Record<Item["kind"], string>> = {
  task: "TASK",
  milestone: "MILESTONE",
  group: "GROUP",
};

function StepGlyph(p: { up: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points={p.up ? "3.5,10 8,5.5 12.5,10" : "3.5,6 8,10.5 12.5,6"} />
    </svg>
  );
}

function ExpandGlyph(p: { inward: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {p.inward ? (
        <>
          <polyline points="2.5,9.5 6.5,9.5 6.5,13.5" />
          <polyline points="13.5,6.5 9.5,6.5 9.5,2.5" />
        </>
      ) : (
        <>
          <polyline points="9.5,2.5 13.5,2.5 13.5,6.5" />
          <polyline points="6.5,13.5 2.5,13.5 2.5,9.5" />
        </>
      )}
    </svg>
  );
}

export function ItemDetail(p: {
  session: PlanSession;
  item: ItemId;
  container: DetailContainer;
  local: string;
  command: boolean;
  readOnly: boolean;
  naming: boolean;
  onNamed(): void;
  onExpand(): void;
  expandLabel: string;
  expandTitle: string;
  onClose?(): void;
}) {
  const view = usePlanView(p.session);
  const { order, step } = useDetail();
  const root = useRef<HTMLDivElement>(null);
  const bodyFocused = useRef(false);
  const shown = useRef(p.item);
  useLayoutEffect(() => {
    if (shown.current === p.item) return;
    shown.current = p.item;
    const el = root.current;
    if (el === null) throw new Error(`ItemDetail: ${p.item} rendered without its element`);
    if (bodyFocused.current && !el.contains(document.activeElement)) el.focus();
  }, [p.item]);
  const it = view.plan.items.get(p.item);
  if (it === undefined) throw new Error(`ItemDetail: no item ${p.item}`);
  const onClose = p.onClose;
  if (p.container === "column" && onClose === undefined) throw new Error(`ItemDetail: the column holding ${p.item} needs a close`);
  const at = order.indexOf(p.item);
  const last = order.length - 1;
  const stepBy = (by: 1 | -1): void => {
    const el = root.current;
    if (el === null) throw new Error(`ItemDetail: stepped from ${p.item} without its element`);
    if (bodyFocused.current && !flushSync(() => commitFocus(el, "The item detail"))) return;
    step(by);
  };
  return (
    <div
      ref={root}
      className="panel detail"
      data-detail={p.container}
      data-detail-item={p.item}
      tabIndex={-1}
      role="group"
      aria-label={it.name}
      onFocus={(e) => {
        bodyFocused.current = e.target.closest(".detail-body") !== null;
      }}
      onBlur={() => {
        bodyFocused.current = false;
      }}
    >
      <div className="detail-head">
        <span className="kind">{KIND[it.kind]}</span>
        <span className="detail-pos mono">{`${at < 0 ? "–" : at + 1} / ${order.length}`}</span>
        <button type="button" className="detail-prev" aria-label="Previous item" title="Previous (↑ or K)" disabled={order.length === 0 || at === 0} onClick={() => stepBy(-1)}>
          <StepGlyph up />
        </button>
        <button type="button" className="detail-next" aria-label="Next item" title="Next (↓ or J)" disabled={order.length === 0 || at === last} onClick={() => stepBy(1)}>
          <StepGlyph up={false} />
        </button>
        <button type="button" className="detail-expand" aria-label={p.expandLabel} title={p.expandTitle} onClick={() => p.onExpand()}>
          <ExpandGlyph inward={p.container === "modal" || p.expandLabel === BACK_TO_MEDIUM} />
        </button>
        {p.container === "column" && onClose !== undefined && <CloseButton className="inspector-close" onPress={onClose} />}
      </div>
      <ItemPanel key={p.item} session={p.session} item={p.item} local={p.local} command={p.command} readOnly={p.readOnly} naming={p.naming} onNamed={p.onNamed} />
    </div>
  );
}
