import { chipText, type SyncState } from "../../sync/manager";
import { docName, useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { useUiValue } from "../state";

export type SyncTone = "magenta" | "amber" | "cyan";

export const syncTone = (s: SyncState): SyncTone => {
  if (s.kind === "error") return "magenta";
  if (s.kind === "offline") return "amber";
  return "cyan";
};

export function SyncChip(p: { compact?: boolean }) {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const { setUi } = useUiValue();
  const text = chipText(state, docName(registry));
  const open = (): void => setUi({ settings: "sync", syncPane: null });
  if (p.compact === true) {
    return (
      <button type="button" className={`sync-chip chip-compact chip-${syncTone(state)}`} aria-label={text} title={text} onClick={open}>
        <span className={state.kind === "synced" ? "chip-compact-dot dot-live" : "chip-compact-dot"} aria-hidden="true" />
      </button>
    );
  }
  return (
    <button type="button" className={`sync-chip chip-${syncTone(state)}`} title={text} onClick={open}>
      {state.kind === "synced" && <span className="dot dot-live" aria-hidden="true" />}
      <span className="sync-chip-text">{text}</span>
    </button>
  );
}
