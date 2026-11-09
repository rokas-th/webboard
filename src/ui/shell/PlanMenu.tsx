import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PlanId } from "../../domain/model";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { exportFlow, importFlow } from "./fileFlows";

export function PlanMenu(p: { session: PlanSession; registry: Registry; onOpen(id: PlanId): void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const away = (e: PointerEvent): void => {
      if (e.target instanceof Node && box.current !== null && box.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    setOpen(false);
    toggle.current?.focus();
  };

  const exportPlan = (): void => {
    setOpen(false);
    void exportFlow(p.session);
  };

  const importPlan = (): void => {
    setOpen(false);
    void importFlow(p.registry, p.onOpen);
  };

  return (
    <div className="plan-menu" ref={box} onKeyDown={onKey}>
      <button
        type="button"
        ref={toggle}
        className="button-small"
        aria-label="Plan menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      {open && (
        <div className="plan-menu-list" role="menu" aria-label="Plan">
          <button type="button" role="menuitem" ref={first} className="choice-row" onClick={exportPlan}>
            Export plan…
          </button>
          <button type="button" role="menuitem" className="choice-row" onClick={importPlan}>
            Import plan…
          </button>
        </div>
      )}
    </div>
  );
}
