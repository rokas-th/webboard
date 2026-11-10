import { chipText, type SyncState } from "../../sync/manager";
import { docName, useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { useUiValue } from "../state";

const tone = (s: SyncState): string => {
  if (s.kind === "error") return "chip-magenta";
  if (s.kind === "offline") return "chip-amber";
  return "chip-cyan";
};

export function SyncChip() {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const { setUi } = useUiValue();
  const text = chipText(state, docName(registry));
  return (
    <button type="button" className={`sync-chip ${tone(state)}`} title={text} onClick={() => setUi({ dialog: { t: "sync", pane: null } })}>
      {state.kind === "synced" && <span className="dot dot-live" aria-hidden="true" />}
      <span className="sync-chip-text">{text}</span>
    </button>
  );
}
