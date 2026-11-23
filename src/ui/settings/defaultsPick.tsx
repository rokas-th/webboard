import type { DefaultsIntent } from "../../actions/intents";
import { defaultsOf } from "../../domain/defaults";
import type { PlanSession } from "../../store/session";
import type { PickRow } from "../common/ContextMenu";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { toast } from "../common/Toast";
import type { Run } from "../run";

export type PickField = "who" | "group" | "step";

export const checkRow = (id: string, title: string, checked: boolean): PickRow => ({ id, title, checked, checkable: true });

export const idOfRow = (prefix: string, row: string, menu: string): string => {
  if (!row.startsWith(prefix) || row.length === prefix.length) throw new Error(`${menu}: the menu chose ${JSON.stringify(row)}, which is no row of it`);
  return row.slice(prefix.length);
};

export function setDefault(session: PlanSession, run: Run, intent: DefaultsIntent, live: boolean): void {
  if (!live) {
    toast(STALE_CONFIRM, "bad");
    return;
  }
  if (defaultsOf(session.view().plan)[intent.field] === intent.value) return;
  run.run(intent);
}

export function DefaultsPick(p: { field: PickField; label: string; value: string; expanded: boolean; disabled: boolean; onOpen(anchor: HTMLElement): void }) {
  return (
    <button
      type="button"
      className="defaults-pick"
      data-pick={p.field}
      aria-label={`${p.label}: ${p.value}`}
      aria-haspopup="menu"
      aria-expanded={p.expanded}
      disabled={p.disabled}
      onClick={(e) => p.onOpen(e.currentTarget)}
    >
      {p.value}
    </button>
  );
}
