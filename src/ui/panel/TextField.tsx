import { useEffect, useRef, useState } from "react";

export function TextField(p: {
  value: string;
  label: string;
  className: string;
  readOnly: boolean;
  type?: "text" | "date";
  onCommit(next: string): boolean;
}) {
  const [draft, setDraft] = useState(p.value);
  const sent = useRef<string | null>(null);
  useEffect(() => {
    setDraft(p.value);
    sent.current = null;
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
  return (
    <input
      type={p.type ?? "text"}
      className={p.className}
      aria-label={p.label}
      value={draft}
      onChange={(e) => {
        sent.current = null;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        commit();
      }}
    />
  );
}
