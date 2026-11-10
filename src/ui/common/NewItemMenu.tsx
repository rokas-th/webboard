import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import type { ItemKind } from "../../domain/model";
import { NEW_NAME } from "../palette/commands";

const KINDS: readonly ItemKind[] = ["task", "milestone", "group"];

export function NewItemMenu(p: { label: string; className: string; disabled: boolean; onPick(kind: ItemKind): void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const shown = open && !p.disabled;
  useEffect(() => {
    if (!shown) return;
    if (first.current === null) throw new Error("NewItemMenu: open without its first item");
    first.current.focus();
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const away = (e: PointerEvent): void => {
      if (e.target instanceof Node && box.current !== null && box.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [shown]);
  const close = (): void => {
    setOpen(false);
    toggle.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Escape" || !shown) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onLeave = (e: FocusEvent<HTMLDivElement>): void => {
    const next = e.relatedTarget;
    if (next instanceof Node && box.current?.contains(next)) return;
    setOpen(false);
  };
  return (
    <div className="plan-menu" ref={box} onKeyDown={onKey} onBlur={onLeave} onMouseDown={(e) => e.preventDefault()}>
      <button
        ref={toggle}
        type="button"
        className={p.className}
        aria-haspopup="menu"
        aria-expanded={shown}
        disabled={p.disabled}
        onClick={() => (shown ? close() : setOpen(true))}
      >
        {p.label}
      </button>
      {shown && (
        <div className="plan-menu-list" role="menu" aria-label="New item">
          {KINDS.map((kind, i) => (
            <button
              key={kind}
              ref={i === 0 ? first : undefined}
              type="button"
              role="menuitem"
              className="choice-row"
              onClick={() => {
                close();
                p.onPick(kind);
              }}
            >
              {NEW_NAME[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
