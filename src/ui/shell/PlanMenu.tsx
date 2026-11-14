import { useEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";
import type { PlanId } from "../../domain/model";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { moved, useMenuList } from "../common/menu";
import { exportFlow, importFlow } from "./fileFlows";

const mounted = (b: HTMLButtonElement | null, missing: string): HTMLButtonElement => {
  if (b === null) throw new Error(missing);
  return b;
};

export function PlanMenu(p: {
  session: PlanSession;
  registry: Registry;
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpen(id: PlanId): void;
  onPrint?: () => void;
}) {
  const { open, onOpenChange } = p;
  const toggle = useRef<HTMLButtonElement>(null);
  const exportItem = useRef<HTMLButtonElement>(null);
  const importItem = useRef<HTMLButtonElement>(null);
  const printItem = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listClass = useMenuList(open, toggle);

  const items = (): HTMLButtonElement[] => [
    mounted(exportItem.current, "PlanMenu opened without its first item"),
    mounted(importItem.current, "PlanMenu opened without its Import item"),
    ...(p.onPrint === undefined ? [] : [mounted(printItem.current, "PlanMenu opened without its Print item")]),
  ];

  useEffect(() => {
    if (!open) return;
    mounted(exportItem.current, "PlanMenu opened without its first item").focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => {
      if (e.target instanceof Node && box.current !== null && box.current.contains(e.target)) return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, onOpenChange]);

  const close = (): void => {
    onOpenChange(false);
    mounted(toggle.current, "PlanMenu without its toggle").focus();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const list = items();
    const to = moved(e.key, list.findIndex((b) => b === document.activeElement), list.length);
    if (to === null) return;
    e.preventDefault();
    list[to].focus();
  };

  const onLeave = (e: FocusEvent<HTMLDivElement>): void => {
    if (!open) return;
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    onOpenChange(false);
  };

  const exportPlan = (): void => {
    onOpenChange(false);
    void exportFlow(p.session);
  };

  const importPlan = (): void => {
    onOpenChange(false);
    void importFlow(p.registry, p.onOpen);
  };

  const onPrint = p.onPrint;
  const printPlan =
    onPrint === undefined
      ? null
      : (): void => {
          onOpenChange(false);
          onPrint();
        };

  return (
    <div className="plan-menu" ref={box} onKeyDown={onKey} onBlur={onLeave} onMouseDown={(e) => e.preventDefault()}>
      <button
        type="button"
        ref={toggle}
        className="button-small"
        aria-label="Plan menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : onOpenChange(true))}
      >
        ⋯
      </button>
      {open && (
        <div className={listClass} role="menu" aria-label="Plan">
          <button type="button" role="menuitem" ref={exportItem} className="choice-row" onClick={exportPlan}>
            Export plan…
          </button>
          <button type="button" role="menuitem" ref={importItem} className="choice-row" onClick={importPlan}>
            Import plan…
          </button>
          {printPlan !== null && (
            <button type="button" role="menuitem" ref={printItem} className="choice-row" onClick={printPlan}>
              Print…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
