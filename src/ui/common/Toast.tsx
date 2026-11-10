import { useSyncExternalStore } from "react";

export type Tone = "ok" | "bad";

interface Entry {
  id: number;
  text: string;
  tone: Tone | null;
  details: string | null;
}

export const TOAST_MS = 4000;
export const DISMISS = "Dismiss";
export const COPY_DETAILS = "Copy details";
export const DETAILS_COPIED = "Details copied";

const listeners = new Set<() => void>();
let entries: readonly Entry[] = [];
let next = 0;

const publish = (list: readonly Entry[]): void => {
  entries = list;
  [...listeners].forEach((cb) => cb());
};

const drop = (id: number): void => publish(entries.filter((e) => e.id !== id));

export function toast(text: string, tone?: Tone, details?: string): void {
  const id = next;
  next += 1;
  publish([...entries, { id, text, tone: tone ?? null, details: details ?? null }]);
  if (tone !== "bad") setTimeout(() => drop(id), TOAST_MS);
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

const copyFailed = (e: unknown): void => {
  console.error(e);
  toast(`Could not copy the details: ${e instanceof Error ? e.message : String(e)}. Select the text and copy it by hand.`, "bad");
};

const copy = (details: string): void => {
  try {
    navigator.clipboard.writeText(details).then(() => toast(DETAILS_COPIED, "ok"), copyFailed);
  } catch (e) {
    copyFailed(e);
  }
};

function Held(p: { entry: Entry }) {
  const details = p.entry.details;
  return (
    <div className="toast-bad">
      <div role="alert" className="toast bad">
        {p.entry.text}
      </div>
      <div className="toast-actions">
        {details !== null && (
          <button type="button" className="button-small" onClick={() => copy(details)}>
            {COPY_DETAILS}
          </button>
        )}
        <button type="button" className="button-small" onClick={() => drop(p.entry.id)}>
          {DISMISS}
        </button>
      </div>
    </div>
  );
}

export function Toasts() {
  const list = useSyncExternalStore(subscribe, snapshot);
  return (
    <div className="toasts">
      {list.map((e) =>
        e.tone === "bad" ? (
          <Held key={e.id} entry={e} />
        ) : (
          <div key={e.id} role="status" className={e.tone === null ? "toast" : `toast ${e.tone}`}>
            {e.text}
          </div>
        ),
      )}
    </div>
  );
}
