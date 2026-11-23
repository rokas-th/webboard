import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { PlanSession } from "../../store/session";
import { pointBelow, usePickMenu } from "../common/pickMenu";
import { useRun } from "../run";
import type { UiState, ViewKind, Zoom } from "../state";
import { NewItemMenu } from "../common/NewItemMenu";
import { DISPLAY_OPTIONS, useDisplayMenu, type DisplayMenu } from "./display";
import { MoreMenu } from "./MoreMenu";
import type { ToolbarTier } from "./planListMode";
import { INSPECTOR_ID, PLAN_LIST_ID } from "./Sidebar";
import { SyncChip } from "./SyncChip";
import { useSearchField, useToolbarTight } from "./toolbarFit";
import { SearchField, type SearchProps } from "../search/SearchField";
import { ZOOMS } from "./zooms";

const TABS: readonly (readonly [ViewKind, string, string])[] = [
  ["timeline", "Timeline", "Timeline"],
  ["board", "Board", "Board"],
  ["list", "List", "List"],
];

const TEETH = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  return { x1: 8 + 4.6 * Math.cos(a), y1: 8 + 4.6 * Math.sin(a), x2: 8 + 7 * Math.cos(a), y2: 8 + 7 * Math.sin(a) };
});

function SettingsButton(p: { open: boolean; onToggle(): void; button: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={p.button} type="button" className="icon-button" aria-label="Settings" title="Settings" aria-pressed={p.open} onClick={p.onToggle}>
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

const SLIDERS: readonly { y: number; x: number }[] = [
  { y: 4, x: 10.5 },
  { y: 8, x: 5.5 },
  { y: 12, x: 9 },
];

function DisplayButton(p: { display: DisplayMenu }) {
  const menu = usePickMenu("Display");
  const latest = useRef(p.display);
  useLayoutEffect(() => {
    latest.current = p.display;
  });
  const rowSet = p.display.sections.flatMap((s) => s.rows.map((r) => r.id)).join(" ");
  const seenRows = useRef(rowSet);
  const { close } = menu;
  useEffect(() => {
    if (seenRows.current === rowSet) return;
    seenRows.current = rowSet;
    close();
  }, [rowSet, close]);
  return (
    <>
      <button
        type="button"
        className="icon-button"
        data-tb="display"
        aria-label={DISPLAY_OPTIONS}
        title={DISPLAY_OPTIONS}
        aria-haspopup="menu"
        aria-expanded={menu.openFor !== null}
        onClick={(e) => {
          const anchor = e.currentTarget;
          menu.open("display", anchor, pointBelow(anchor), p.display.sections, (id) => latest.current.run(id));
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
          {SLIDERS.map((s) => (
            <g key={s.y}>
              <line x1="1.5" y1={s.y} x2="14.5" y2={s.y} strokeWidth="1.4" />
              <circle cx={s.x} cy={s.y} r="1.9" fill="currentColor" stroke="none" />
            </g>
          ))}
        </svg>
      </button>
      {menu.node}
    </>
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

export interface InspectorToggle {
  open: boolean;
  button: RefObject<HTMLButtonElement | null>;
  onToggle(): void;
}

function InspectorButton(p: InspectorToggle & { command: boolean }) {
  const title = `${p.open ? "Hide" : "Show"} the inspector (${p.command ? "⌥⌘I" : "Ctrl Alt I"})`;
  return (
    <button
      ref={p.button}
      type="button"
      className="icon-button inspector-toggle"
      aria-label="Inspector"
      aria-expanded={p.open}
      aria-controls={INSPECTOR_ID}
      title={title}
      onClick={p.onToggle}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
        <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="1.6" strokeWidth="1.4" />
        <line x1="9.8" y1="2.7" x2="9.8" y2="13.3" strokeWidth="1.4" />
        {p.open && <rect className="inspector-toggle-fill" x="9.8" y="3.4" width="3.8" height="9.2" rx="0.8" fill="currentColor" stroke="none" />}
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
  onSettings(): void;
  tier: ToolbarTier | null;
  compact: { button: RefObject<HTMLButtonElement | null>; onPlans(): void; onPlan(): void } | null;
  sidebar: SidebarToggle | null;
  inspector: InspectorToggle | null;
  search: SearchProps | null;
}

function ViewTabs(p: { ui: UiState; setUi(patch: Partial<UiState>): void; short: boolean }) {
  return (
    <div className="seg seg-modes" role="tablist" aria-label="Views">
      {TABS.map(([kind, label, short]) => (
        <button
          key={kind}
          type="button"
          role="tab"
          aria-selected={p.ui.view === kind}
          aria-label={p.short ? label : undefined}
          title={p.short ? label : undefined}
          className={p.ui.view === kind ? "active" : undefined}
          onClick={() => p.setUi({ view: kind })}
        >
          {p.short ? short : label}
        </button>
      ))}
    </div>
  );
}

function PlanControls(p: {
  session: PlanSession;
  readOnly: boolean;
  zoom: Zoom | null;
  onZoom(z: Zoom): void;
  onToday: (() => void) | null;
  glyphs: boolean;
}) {
  const { undo, redo } = useRun(p.session);
  const { zoom, onZoom, onToday } = p;
  return (
    <>
      {zoom !== null && (
        <div className="seg seg-zoom" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button
              key={z.zoom}
              type="button"
              title={z.title}
              aria-pressed={zoom === z.zoom}
              className={zoom === z.zoom ? "active" : undefined}
              onClick={() => onZoom(z.zoom)}
            >
              {z.zoom}
            </button>
          ))}
        </div>
      )}
      {onToday !== null && (
        <button type="button" title="Jump to today" onClick={onToday}>
          Today
        </button>
      )}
      {p.glyphs ? (
        <>
          <button type="button" className="glyph-button" aria-label="Undo" title="Undo" disabled={p.readOnly || !p.session.canUndo()} onClick={() => undo()}>
            ↶
          </button>
          <button type="button" className="glyph-button" aria-label="Redo" title="Redo" disabled={p.readOnly || !p.session.canRedo()} onClick={() => redo()}>
            ↷
          </button>
        </>
      ) : (
        <>
          <button type="button" disabled={p.readOnly || !p.session.canUndo()} onClick={() => undo()}>
            Undo
          </button>
          <button type="button" disabled={p.readOnly || !p.session.canRedo()} onClick={() => redo()}>
            Redo
          </button>
        </>
      )}
    </>
  );
}

export function Toolbar(p: ToolbarProps) {
  const bar = useRef<HTMLElement>(null);
  const tight = useToolbarTight(bar);
  const className = ["toolbar", ...(p.mac ? ["toolbar-mac"] : []), ...(tight ? ["toolbar-tight"] : [])].join(" ");
  const tier = p.tier;
  const trimmed = tier !== null;
  const folded = tier === "medium" || tier === "narrow";
  const search = p.search;
  const display = useDisplayMenu(p.session, p.ui.view);
  const field = useSearchField(bar, search !== null && !folded && !tight);
  const moreAnchor = (): HTMLElement => {
    const header = bar.current;
    const button = header === null ? null : header.querySelector<HTMLElement>('.toolbar-end button[aria-label="More"]');
    if (button === null) throw new Error("Toolbar: Search was asked from More, but the toolbar has no More button");
    return button;
  };
  const toggleSettings = p.onSettings;
  const compact = p.compact;
  const onPlan = compact !== null && p.session !== null ? compact.onPlan : null;
  const zoom = p.session !== null && p.ui.view === "timeline" ? p.ui.zoom : null;
  const setUi = p.setUi;
  const zoomTo = (z: Zoom): void => setUi({ zoom: z });
  const onCommand = p.onCommand;
  const goToday = p.session !== null ? () => onCommand("today") : null;
  const inline = tier !== "narrow";
  const settingsButton = useRef<HTMLButtonElement>(null);
  const moreDroppedFocus = useRef(false);
  useLayoutEffect(() => {
    if (folded || !moreDroppedFocus.current) return;
    moreDroppedFocus.current = false;
    const button = settingsButton.current;
    if (button === null) throw new Error("Toolbar: the More menu left with focus, but the toolbar has no Settings button to take it");
    button.focus();
  }, [folded]);
  return (
    <header ref={bar} className={className} data-tauri-drag-region>
      <div className="toolbar-group toolbar-start" data-tauri-drag-region>
        {p.sidebar !== null && <SidebarButton {...p.sidebar} command={p.command} />}
        {p.sidebar === null && p.compact !== null && (
          <button ref={p.compact.button} type="button" onClick={p.compact.onPlans}>
            Plans
          </button>
        )}
        <span className="wordmark">WebBoard</span>
        <SyncChip compact={folded} />
      </div>
      {p.session !== null && <ViewTabs ui={p.ui} setUi={p.setUi} short={folded} />}
      <div className="toolbar-group toolbar-end" data-tauri-drag-region>
        <span className="toolbar-spacer" />
        {p.session !== null && (
          <PlanControls session={p.session} readOnly={p.readOnly} zoom={inline ? zoom : null} onZoom={zoomTo} onToday={inline ? goToday : null} glyphs={trimmed} />
        )}
        {!trimmed && display === null && (
          <button type="button" className="kbd-button" title="Command palette" onClick={() => p.onCommand("palette")}>
            {p.command ? "⌘K" : "Ctrl K"}
          </button>
        )}
        {search !== null && <SearchField {...search} form={folded ? "more" : field ? "field" : "glass"} moreAnchor={moreAnchor} />}
        {p.session !== null && (
          <NewItemMenu label="+ New" className="button-primary" disabled={p.readOnly} onPick={(kind) => p.onCommand(`new-${kind}`)} />
        )}
        {!folded && display !== null && <DisplayButton display={display} />}
        {!folded && <SettingsButton open={p.ui.settings !== null} onToggle={toggleSettings} button={settingsButton} />}
        {!folded && onPlan !== null && (
          <button type="button" onClick={onPlan}>
            Plan
          </button>
        )}
        {folded && (
          <MoreMenu
            zoom={inline ? null : zoom}
            onZoom={zoomTo}
            onToday={inline ? null : goToday}
            onSettings={toggleSettings}
            onPlan={onPlan}
            onSearch={search === null ? null : () => onCommand("find")}
            display={display}
            onFocusDropped={() => {
              moreDroppedFocus.current = true;
            }}
          />
        )}
        {p.session !== null && p.inspector !== null && <InspectorButton {...p.inspector} command={p.command} />}
      </div>
    </header>
  );
}
