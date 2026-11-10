import { usePlanView, type PlanSession } from "../../store/session";
import { useRun } from "../run";
import type { UiState, ViewKind, Zoom } from "../state";
import { NewItemMenu } from "../common/NewItemMenu";
import { SyncChip } from "./SyncChip";

const TABS: readonly (readonly [ViewKind, string])[] = [
  ["timeline", "Timeline"],
  ["board", "Now · Next · Later"],
  ["list", "List"],
];

const ZOOMS: readonly (readonly [Zoom, string])[] = [
  ["W", "Week"],
  ["M", "Month"],
  ["Q", "Quarter"],
  ["F", "Fit the whole plan"],
];

interface ToolbarProps {
  session: PlanSession | null;
  readOnly: boolean;
  ui: UiState;
  setUi(patch: Partial<UiState>): void;
  mac: boolean;
  onCommand(id: string): void;
  compact: { onPlans(): void; onPlan(): void } | null;
}

function PlanControls(p: { session: PlanSession; readOnly: boolean; ui: UiState; setUi(patch: Partial<UiState>): void; onCommand(id: string): void }) {
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
      {p.ui.view === "timeline" && (
        <div className="seg seg-zoom" aria-label="Zoom">
          {ZOOMS.map(([z, title]) => (
            <button
              key={z}
              type="button"
              title={title}
              aria-pressed={p.ui.zoom === z}
              className={p.ui.zoom === z ? "active" : undefined}
              onClick={() => p.setUi({ zoom: z })}
            >
              {z}
            </button>
          ))}
        </div>
      )}
      <button type="button" title="Jump to today" onClick={() => p.onCommand("today")}>
        Today
      </button>
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
    <header className={p.mac ? "toolbar toolbar-mac" : "toolbar"} data-tauri-drag-region>
      {p.compact !== null && (
        <button type="button" onClick={p.compact.onPlans}>
          Plans
        </button>
      )}
      <span className="wordmark">WebBoard</span>
      {p.session === null ? (
        <span className="toolbar-spacer" />
      ) : (
        <PlanControls session={p.session} readOnly={p.readOnly} ui={p.ui} setUi={p.setUi} onCommand={p.onCommand} />
      )}
      <button type="button" className="kbd-button" title="Command palette" onClick={() => p.onCommand("palette")}>
        {p.mac ? "⌘K" : "Ctrl K"}
      </button>
      {p.session !== null && (
        <NewItemMenu label="+ New" className="button-primary" disabled={p.readOnly} onPick={(kind) => p.onCommand(`new-${kind}`)} />
      )}
      <SyncChip />
      {p.compact !== null && p.session !== null && (
        <button type="button" onClick={p.compact.onPlan}>
          Plan
        </button>
      )}
    </header>
  );
}
