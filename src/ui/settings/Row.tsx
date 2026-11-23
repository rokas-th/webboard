import type { ReactNode } from "react";
import type { SettingsSection } from "../state";

export const rowKey = (section: SettingsSection, row: string): string => `${section}.${row}`;

export interface RowHint {
  id: string;
  text: string;
}

export function Row(p: { section: SettingsSection; row: string; label: string; className?: string; rowClassName?: string; stack?: boolean; hint?: RowHint; children: ReactNode }) {
  const classes = ["settings-row", ...(p.stack === true ? ["settings-row-stack"] : []), ...(p.rowClassName === undefined ? [] : [p.rowClassName])].join(" ");
  const label = <span className="settings-label">{p.label}</span>;
  return (
    <div className={classes} data-settings-row={rowKey(p.section, p.row)}>
      {p.hint === undefined ? (
        label
      ) : (
        <div className="settings-text">
          {label}
          <p className="settings-line settings-hint" id={p.hint.id}>
            {p.hint.text}
          </p>
        </div>
      )}
      <div className={p.className === undefined ? "settings-control" : `settings-control ${p.className}`}>{p.children}</div>
    </div>
  );
}
