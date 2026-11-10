import { useRef, type ReactNode } from "react";
import { modalKeyDown, useModalFocus } from "./Dialog";

function OpenSheet(p: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, "Sheet");
  return (
    <div className="overlay sheet-overlay">
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={p.title} tabIndex={-1} onKeyDown={(e) => modalKeyDown(e, p.onClose)}>
        <div className="sheet-head">
          <h3 className="sheet-title">{p.title}</h3>
          <button type="button" className="button-small" onClick={p.onClose}>
            Close
          </button>
        </div>
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
