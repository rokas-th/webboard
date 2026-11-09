import { useSyncExternalStore } from "react";

export type Tone = "ok" | "bad";

interface Entry {
  id: number;
  text: string;
  tone: Tone | null;
}

export const TOAST_MS = 4000;

const listeners = new Set<() => void>();
let entries: readonly Entry[] = [];
let next = 0;

const publish = (list: readonly Entry[]): void => {
  entries = list;
  [...listeners].forEach((cb) => cb());
};

export function toast(text: string, tone?: Tone): void {
  const id = next;
  next += 1;
  publish([...entries, { id, text, tone: tone ?? null }]);
  setTimeout(() => publish(entries.filter((e) => e.id !== id)), TOAST_MS);
}

export function clearToasts(): void {
  publish([]);
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const snapshot = (): readonly Entry[] => entries;

export function Toasts() {
  const list = useSyncExternalStore(subscribe, snapshot);
  return (
    <div className="toasts">
      {list.map((e) => (
        <div key={e.id} role="status" className={e.tone === null ? "toast" : `toast ${e.tone}`}>
          {e.text}
        </div>
      ))}
    </div>
  );
}
