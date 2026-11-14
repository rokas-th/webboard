import { useRef, type RefObject } from "react";
import type { PlanSession } from "../../store/session";
import { useTheme } from "../../theme/ThemeContext";
import { useRun } from "../run";
import type { UiState, ViewKind, Zoom } from "../state";
import { NewItemMenu } from "../common/NewItemMenu";
import { closeSettings } from "../settings/SettingsPanel";
import { PLAN_LIST_ID } from "./Sidebar";
import { SyncChip } from "./SyncChip";
import { useToolbarTight } from "./toolbarFit";

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

const TEETH = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  return { x1: 8 + 4.6 * Math.cos(a), y1: 8 + 4.6 * Math.sin(a), x2: 8 + 7 * Math.cos(a), y2: 8 + 7 * Math.sin(a) };
});

function SettingsButton(p: { open: boolean; setUi(patch: Partial<UiState>): void }) {
  const theme = useTheme();
  const toggle = (): void => {
    if (p.open) closeSettings(theme, () => p.setUi({ settings: null }));
    else p.setUi({ settings: "theme" });
  };
  return (
    <button type="button" className="icon-button" aria-label="Settings" title="Settings" aria-pressed={p.open} onClick={toggle}>
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
        <circle cx="8" cy="8" r="4.6" strokeWidth="1.4" />
        <circle cx="8" cy="8" r="1.9" strokeWidth="1.4" />
        {TEETH.map((t, i) => (
          <line key={i} {...t} strokeWidth="2" />
        ))}
      </svg>
    </button>
  );
}

export interface SidebarToggle {
  open: boolean;
  attention: boolean;
  button: RefObject<HTMLButtonElement | null>;
  onToggle(): void;
}

function SidebarButton(p: SidebarToggle & { command: boolean }) {
  const title = `${p.open ? "Hide" : "Show"} the plan list (${p.command ? "⌘B" : "Ctrl B"})${p.attention ? " · needs attention" : ""}`;
  return (
    <button
      ref={p.button}
      type="button"
      className="icon-button sidebar-toggle"
      aria-label="Plan list"
      aria-expanded={p.open}
      aria-controls={PLAN_LIST_ID}
      title={title}
      data-attention={p.attention ? "true" : undefined}
      onClick={p.onToggle}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
        <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="1.6" strokeWidth="1.4" />
        <line x1="6.2" y1="2.7" x2="6.2" y2="13.3" strokeWidth="1.4" />
        {p.open && <rect className="sidebar-toggle-fill" x="2.4" y="3.4" width="3.8" height="9.2" rx="0.8" fill="currentColor" stroke="none" />}
      </svg>
    </button>
  );
}

interface ToolbarProps {
  session: PlanSession | null;
  readOnly: boolean;
  ui: UiState;
  setUi(patch: Partial<UiState>): void;
  mac: boolean;
  command: boolean;
  onCommand(id: string): void;
  compact: { button: RefObject<HTMLButtonElement | null>; onPlans(): void; onPlan(): void } | null;
  sidebar: SidebarToggle | null;
}

function ViewTabs(p: { ui: UiState; setUi(patch: Partial<UiState>): void }) {
  return (
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
  );
}

function PlanControls(p: { session: PlanSession; readOnly: boolean; ui: UiState; setUi(patch: Partial<UiState>): void; onCommand(id: string): void }) {
  const { undo, redo } = useRun(p.session);
  return (
    <>
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
  const bar = useRef<HTMLElement>(null);
  const tight = useToolbarTight(bar);
  const className = ["toolbar", ...(p.mac ? ["toolbar-mac"] : []), ...(tight ? ["toolbar-tight"] : [])].join(" ");
  return (
    <header ref={bar} className={className} data-tauri-drag-region>
      <div className="toolbar-group toolbar-start" data-tauri-drag-region>
        {p.sidebar !== null && <SidebarButton {...p.sidebar} command={p.command} />}
        {p.compact !== null && (
          <button ref={p.compact.button} type="button" onClick={p.compact.onPlans}>
            Plans
          </button>
        )}
        <span className="wordmark">WebBoard</span>
      </div>
      {p.session !== null && <ViewTabs ui={p.ui} setUi={p.setUi} />}
      <div className="toolbar-group toolbar-end" data-tauri-drag-region>
        <span className="toolbar-spacer" />
        {p.session !== null && <PlanControls session={p.session} readOnly={p.readOnly} ui={p.ui} setUi={p.setUi} onCommand={p.onCommand} />}
        <button type="button" className="kbd-button" title="Command palette" onClick={() => p.onCommand("palette")}>
          {p.command ? "⌘K" : "Ctrl K"}
        </button>
        {p.session !== null && (
          <NewItemMenu label="+ New" className="button-primary" disabled={p.readOnly} onPick={(kind) => p.onCommand(`new-${kind}`)} />
        )}
        <SyncChip />
        <SettingsButton open={p.ui.settings !== null} setUi={p.setUi} />
        {p.compact !== null && p.session !== null && (
          <button type="button" onClick={p.compact.onPlan}>
            Plan
          </button>
        )}
      </div>
    </header>
  );
}
