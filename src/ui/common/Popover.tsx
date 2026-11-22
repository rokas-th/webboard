import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CloseButton, useScrimPress } from "./dismiss";

export function Popover(p: { label: string; className: string; returnFocus?: HTMLElement; onClose(): void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const onClose = useRef(p.onClose);
  useLayoutEffect(() => {
    onClose.current = p.onClose;
  });
  const [opener] = useState(() => p.returnFocus ?? document.activeElement);
  const scrim = useScrimPress(() => onClose.current());

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const active = document.activeElement;
      if (active !== null && active.closest('[aria-modal="true"]') !== null) return;
      e.preventDefault();
      onClose.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useLayoutEffect(() => {
    const root = box.current;
    if (root === null) throw new Error("Popover rendered without its element");
    return () => {
      if (!root.contains(document.activeElement)) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  return (
    <>
      <div className="popover-scrim" {...scrim} onMouseDown={(e) => e.preventDefault()} />
      <div ref={box} className={`popover ${p.className}`} role="dialog" aria-label={p.label}>
        {p.children}
        <CloseButton className="popover-close" onPress={() => onClose.current()} />
      </div>
    </>
  );
}
