import type { ReactNode } from "react";
import type { SettingsSection } from "../state";

export const rowKey = (section: SettingsSection, row: string): string => `${section}.${row}`;

export function Row(p: { section: SettingsSection; row: string; label: string; className?: string; stack?: boolean; children: ReactNode }) {
  return (
    <div className={p.stack === true ? "settings-row settings-row-stack" : "settings-row"} data-settings-row={rowKey(p.section, p.row)}>
      <span className="settings-label">{p.label}</span>
      <div className={p.className === undefined ? "settings-control" : `settings-control ${p.className}`}>{p.children}</div>
    </div>
  );
}
