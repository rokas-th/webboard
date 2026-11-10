import { chipText, type SyncState } from "../../sync/manager";
import { docName, useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { useUiValue } from "../state";

const tone = (s: SyncState): string => {
  if (s.kind === "error") return "chip-magenta";
  if (s.kind === "offline") return "chip-amber";
  return "chip-cyan";
};

export function SyncChip(p: { compact?: boolean }) {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const { setUi } = useUiValue();
  const text = chipText(state, docName(registry));
  const open = (): void => setUi({ dialog: { t: "sync", pane: null } });
  if (p.compact === true) {
    return (
      <button type="button" className={`sync-chip chip-compact ${tone(state)}`} aria-label={text} title={text} onClick={open}>
        <span className={state.kind === "synced" ? "chip-compact-dot dot-live" : "chip-compact-dot"} aria-hidden="true" />
      </button>
    );
  }
  return (
    <button type="button" className={`sync-chip ${tone(state)}`} title={text} onClick={open}>
      {state.kind === "synced" && <span className="dot dot-live" aria-hidden="true" />}
      <span className="sync-chip-text">{text}</span>
    </button>
  );
}
