import { usePlanView, type PlanSession } from "../../store/session";
import { useRun } from "../run";
import type { UiState, ViewKind, Zoom } from "../state";
import { SyncChip } from "./SyncChip";

const TABS: readonly (readonly [ViewKind, string])[] = [
  ["timeline", "Timeline"],
  ["board", "Now · Next · Later"],
  ["list", "List"],
];

const ZOOMS: readonly Zoom[] = ["W", "M", "Q"];

interface ToolbarProps {
  session: PlanSession | null;
  readOnly: boolean;
  ui: UiState;
  setUi(patch: Partial<UiState>): void;
  mac: boolean;
}

function PlanControls(p: { session: PlanSession; readOnly: boolean; ui: UiState; setUi(patch: Partial<UiState>): void }) {
  const view = usePlanView(p.session);
  const { undo, redo } = useRun(p.session);
  return (
    <>
      <span className="toolbar-plan">{view.plan.name}</span>
      <div className="seg seg-modes" role="tablist" aria-label="Views">
        {TABS.map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={p.ui.view === kind}
            className={p.ui.view === kind ? "active" : undefined}
            onClick={() => p.setUi({ view: kind })}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="toolbar-spacer" />
      <div className="seg seg-zoom" aria-label="Zoom">
        {ZOOMS.map((z) => (
          <button
            key={z}
            type="button"
            aria-pressed={p.ui.zoom === z}
            className={p.ui.zoom === z ? "active" : undefined}
            onClick={() => p.setUi({ zoom: z })}
          >
            {z}
          </button>
        ))}
      </div>
      <button type="button" disabled={p.readOnly || !p.session.canUndo()} onClick={() => undo()}>
        Undo
      </button>
      <button type="button" disabled={p.readOnly || !p.session.canRedo()} onClick={() => redo()}>
        Redo
      </button>
    </>
  );
}

export function Toolbar(p: ToolbarProps) {
  return (
    <header className="toolbar" data-tauri-drag-region>
      <span className="wordmark">WebBoard</span>
      {p.session === null ? (
        <span className="toolbar-spacer" />
      ) : (
        <PlanControls session={p.session} readOnly={p.readOnly} ui={p.ui} setUi={p.setUi} />
      )}
      <button type="button" className="kbd-button" onClick={() => p.setUi({ dialog: { t: "palette" } })}>
        {p.mac ? "⌘K" : "Ctrl K"}
      </button>
      <SyncChip />
    </header>
  );
}
