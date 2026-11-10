import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export const focusables = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.closest("[hidden]") === null);

export function useModalFocus(ref: RefObject<HTMLElement | null>, what: string): void {
  const [opener] = useState(() => document.activeElement);
  useEffect(() => {
    const root = ref.current;
    if (root === null) throw new Error(`${what} rendered without its element`);
    if (!root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected && !root.contains(opener)) opener.focus();
    };
  }, [ref, what, opener]);
}

export function modalKeyDown(e: KeyboardEvent<HTMLElement>, onClose: () => void): void {
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
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
}

export function Dialog(p: { label: string; wide?: boolean; onClose(): void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, "Dialog");
  return (
    <div className="overlay center">
      <div
        ref={ref}
        className={p.wide === true ? "modal modal-wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={p.label}
        tabIndex={-1}
        onKeyDown={(e) => modalKeyDown(e, p.onClose)}
      >
        <h3>{p.label}</h3>
        {p.children}
      </div>
    </div>
  );
}
