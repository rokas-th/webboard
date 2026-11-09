import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];

export function Dialog(p: { label: string; wide?: boolean; onClose(): void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    const root = ref.current;
    if (root === null) throw new Error("Dialog rendered without its element");
    (focusables(root)[0] ?? root).focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      p.onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const all = focusables(e.currentTarget);
    if (all.length === 0) {
      e.preventDefault();
      return;
    }
    const first = all[0];
    const last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="overlay center">
      <div ref={ref} className={p.wide === true ? "modal modal-wide" : "modal"} role="dialog" aria-modal="true" aria-label={p.label} tabIndex={-1} onKeyDown={onKeyDown}>
        <h3>{p.label}</h3>
        {p.children}
      </div>
    </div>
  );
}
