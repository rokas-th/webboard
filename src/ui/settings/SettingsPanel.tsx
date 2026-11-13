import { useId, type KeyboardEvent, type ReactNode } from "react";
import type { Updates } from "../../store/updates";
import type { SyncState } from "../../sync/manager";
import { docName, useSyncRegistry, useSyncState } from "../../sync/SyncProvider";
import { DISCARDED, useTheme, type ThemeApi } from "../../theme/ThemeContext";
import { AboutText } from "../common/About";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { syncTone } from "../shell/SyncChip";
import { UpdateLine, useUpdates } from "../shell/UpdateLine";
import type { SettingsTab, SyncPane } from "../state";
import { PANE_LABELS, PANE_ORDER, syncMessage } from "../sync/SyncDialog";
import { ThemeBody } from "../theme/ThemePanel";

export const SETTINGS_TITLE = "Settings";

export const TAB_LABELS: Record<SettingsTab, string> = {
  theme: "Theme",
  sync: "Sync",
  updates: "Updates",
  about: "About",
};

export function closeSettings(api: ThemeApi, onClose: () => void): void {
  api.preview(null);
  if (api.draft !== null) {
    api.setDraft(null);
    toast(DISCARDED);
  }
  onClose();
}

export interface SettingsProps {
  frame: "panel" | "sheet";
  tab: SettingsTab;
  hover: boolean;
  onTab(tab: SettingsTab): void;
  onClose(): void;
  onSync(pane: SyncPane): void;
}

export interface SettingsWorld {
  sync: SyncState;
  syncName(doc: string): string | null;
  updates: Updates | null;
}

export const settingsTabs = (updates: Updates | null): readonly SettingsTab[] => (updates === null ? ["theme", "sync", "about"] : ["theme", "sync", "updates", "about"]);

export function SettingsView(p: SettingsProps & SettingsWorld) {
  const api = useTheme();
  const base = useId();
  const tabs = settingsTabs(p.updates);
  if (!tabs.includes(p.tab)) throw new Error(`Settings has no ${p.tab} tab here`);
  const tabId = (t: SettingsTab): string => `${base}-tab-${t}`;
  const panelId = (t: SettingsTab): string => `${base}-panel-${t}`;
  const close = (): void => closeSettings(api, p.onClose);
  const pick = (t: SettingsTab): void => {
    api.preview(null);
    p.onTab(t);
  };

  const content = (t: SettingsTab): ReactNode => {
    switch (t) {
      case "theme":
        return <ThemeBody hover={p.hover} />;
      case "sync":
        return (
          <div className="settings-body">
            <p className={`settings-status ${syncTone(p.sync)}`}>{syncMessage(p.sync, p.syncName)}</p>
            <div className="settings-buttons">
              {PANE_ORDER.map((pane) => (
                <button key={pane} type="button" className="button-small" onClick={() => closeSettings(api, () => p.onSync(pane))}>
                  {PANE_LABELS[pane]}
                </button>
              ))}
            </div>
          </div>
        );
      case "updates":
        if (p.updates === null) throw new Error("Settings shows Updates only with an updater");
        return (
          <div className="settings-body">
            <UpdateLine updates={p.updates} />
          </div>
        );
      case "about":
        return (
          <div className="settings-body settings-about">
            <AboutText />
          </div>
        );
    }
  };

  const body = (
    <>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => (
          <button
            key={t}
            id={tabId(t)}
            type="button"
            role="tab"
            aria-selected={p.tab === t}
            aria-controls={panelId(t)}
            className={p.tab === t ? "active" : undefined}
            onClick={() => pick(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t} id={panelId(t)} role="tabpanel" aria-labelledby={tabId(t)} className="settings-pane" hidden={p.tab !== t}>
          {content(t)}
        </div>
      ))}
    </>
  );

  if (p.frame === "sheet") {
    return (
      <Sheet open title={SETTINGS_TITLE} onClose={close}>
        {body}
      </Sheet>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };

  return (
    <section className="settings-panel" aria-label={SETTINGS_TITLE} onKeyDown={onKeyDown}>
      <div className="settings-head">
        <h2>{SETTINGS_TITLE}</h2>
        <button type="button" className="button-small" onClick={close}>
          Close
        </button>
      </div>
      {body}
    </section>
  );
}

export function SettingsPanel(p: SettingsProps) {
  const { state } = useSyncState();
  const registry = useSyncRegistry();
  const updates = useUpdates();
  return <SettingsView {...p} sync={state} syncName={docName(registry)} updates={updates} />;
}
