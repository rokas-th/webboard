import { useRef, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { readPlatform } from "../../platform";
import { modalKeyDown, useModalFocus } from "./Dialog";

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
      <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function focusReportsError(root: HTMLElement): boolean {
  let reported = false;
  const onError = (): void => {
    reported = true;
  };
  window.addEventListener("error", onError);
  try {
    root.focus();
  } finally {
    window.removeEventListener("error", onError);
  }
  return reported;
}

function OpenSheet(p: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const press = useRef<"none" | "down" | "tapped">("none");
  const ios = readPlatform(window).os === "ios";
  useModalFocus(ref, "Sheet", ios);
  const close = (): void => {
    const root = ref.current;
    if (root === null) throw new Error("Sheet closed without its element");
    const active = document.activeElement;
    if (active !== root && root.contains(active)) {
      const failed = focusReportsError(root);
      if (document.activeElement !== root) throw new Error("Sheet could not take focus from its field to commit it");
      if (failed) return;
    }
    p.onClose();
  };
  const outside = ios
    ? {
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
          press.current = e.target === e.currentTarget ? "down" : "none";
        },
        onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
          press.current = press.current === "down" && document.elementFromPoint(e.clientX, e.clientY) === e.currentTarget ? "tapped" : "none";
        },
        onPointerCancel: () => {
          press.current = "none";
        },
        onClick: (e: MouseEvent<HTMLDivElement>) => {
          const tapped = press.current === "tapped";
          press.current = "none";
          if (tapped && e.target === e.currentTarget) close();
        },
      }
    : {};
  return (
    <div className="overlay sheet-overlay" {...outside}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={p.title} tabIndex={-1} onKeyDown={(e) => modalKeyDown(e, p.onClose)}>
        {ios ? (
          <div className="sheet-head">
            <button type="button" className="sheet-close" aria-label="Close" onClick={close}>
              <CloseGlyph />
            </button>
            <h3 className="sheet-title">{p.title}</h3>
            <span className="sheet-head-end" aria-hidden="true" />
          </div>
        ) : (
          <div className="sheet-head">
            <h3 className="sheet-title">{p.title}</h3>
            <button type="button" className="button-small" onClick={close}>
              Close
            </button>
          </div>
        )}
        <div className="sheet-body">{p.children}</div>
      </div>
    </div>
  );
}

export function Sheet(p: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!p.open) return null;
  return (
    <OpenSheet title={p.title} onClose={p.onClose}>
      {p.children}
    </OpenSheet>
  );
}
