import { useState, type KeyboardEvent } from "react";
import type { ItemId } from "../../domain/model";
import { readPlatform, shortcutsUseCommand } from "../../platform";
import { usePlanView, type PlanSession } from "../../store/session";
import { Sheet, type SheetDetent } from "../common/Sheet";
import { detentText, ItemDetail } from "../detail/ItemDetail";
import { isControl, isTyping } from "../palette/keymap";
import { useReadOnly } from "./readOnly";

const other = (d: SheetDetent): SheetDetent => (d === "medium" ? "large" : "medium");

export function ItemSheet(p: { session: PlanSession; item: ItemId; local: string; naming: boolean; onNamed(): void; onClose(): void }) {
  const view = usePlanView(p.session);
  const readOnly = useReadOnly(p.session);
  const [detent, setDetent] = useState<SheetDetent>("medium");
  const it = view.plan.items.get(p.item);
  if (it === undefined) throw new Error(`ItemSheet: no item ${p.item}`);
  const text = detentText(detent);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== " " || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping(e.target, e.key) || isControl(e.target)) return;
    e.preventDefault();
    if (!e.repeat) setDetent(other);
  };
  return (
    <Sheet open title={it.name} detent={detent} onDetent={setDetent} onClose={p.onClose} onKeyDown={onKeyDown}>
      <ItemDetail
        session={p.session}
        item={p.item}
        container="sheet"
        local={p.local}
        command={shortcutsUseCommand(readPlatform(window).os)}
        readOnly={readOnly}
        naming={p.naming}
        onNamed={p.onNamed}
        onExpand={() => setDetent(other)}
        expandLabel={text.label}
        expandTitle={text.title}
      />
    </Sheet>
  );
}
