import { FIRST_PLAN_DATE, LAST_PLAN_DATE } from "../../domain/dates";
import { useEffect, useRef, useState } from "react";

const leave = (el: HTMLInputElement): void => {
  const modal = el.closest('[aria-modal="true"]');
  if (modal instanceof HTMLElement) modal.focus();
  else el.blur();
};

export function TextField(p: {
  value: string;
  label: string;
  className: string;
  readOnly: boolean;
  type?: "text" | "date" | "number";
  min?: string;
  max?: string;
  onCommit(next: string): boolean;
}) {
  const [draft, setDraft] = useState(p.value);
  const sent = useRef<string | null>(null);
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const base = useRef(p.value);
  useEffect(() => {
    const was = base.current;
    const own = sent.current;
    base.current = p.value;
    sent.current = null;
    const editing = input.current !== null && input.current === document.activeElement;
    setDraft((d) => (editing && d !== was && d.trim() !== own ? d : p.value));
  }, [p.value]);
  if (p.readOnly) {
    return (
      <span className={`${p.className} as-text`} aria-label={p.label}>
        {p.value === "" ? "—" : p.value}
      </span>
    );
  }
  const commit = (): void => {
    const next = draft.trim();
    if (next === p.value) {
      setDraft(p.value);
      return;
    }
    if (next === sent.current) return;
    sent.current = next;
    if (!p.onCommit(next)) setDraft(p.value);
  };
  const date = p.type === "date";
  return (
    <input
      ref={input}
      type={p.type ?? "text"}
      min={p.min ?? (date ? FIRST_PLAN_DATE : undefined)}
      max={p.max ?? (date ? LAST_PLAN_DATE : undefined)}
      className={p.className}
      aria-label={p.label}
      value={draft}
      onChange={(e) => {
        sent.current = null;
        setDraft(e.target.value);
      }}
      onBlur={() => {
        if (!cancelled.current) {
          commit();
          return;
        }
        cancelled.current = false;
        setDraft(p.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelled.current = e.currentTarget === document.activeElement;
          setDraft(p.value);
          leave(e.currentTarget);
          return;
        }
        if (e.key !== "Enter") return;
        e.preventDefault();
        commit();
        leave(e.currentTarget);
      }}
    />
  );
}
