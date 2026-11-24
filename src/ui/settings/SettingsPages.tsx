import { useId, type ReactNode, type RefObject } from "react";
import type { SettingsSection } from "../state";
import type { SectionSpec } from "./sections";

export const BACK_TO_SETTINGS = "Back to Settings";

export const BACK_TO_PEOPLE = "Back to People";

export const BACK_TO_WORKFLOW = "Back to Workflow";

export function DetailRow(p: { label: string; children: ReactNode }) {
  return (
    <div className="settings-detail-row">
      <span className="settings-detail-label">{p.label}</span>
      <div className="settings-detail-control">{p.children}</div>
    </div>
  );
}

export const EDIT_LABEL = "Edit";

export const DONE_LABEL = "Done";

export const APP_GROUP_LABEL = "App";

function RootRows(p: { sections: readonly SectionSpec[]; onOpen(s: SettingsSection): void }) {
  return (
    <div className="settings-root-card">
      {p.sections.map((s) => (
        <button key={s.id} type="button" className="settings-root-row" data-section={s.id} onClick={() => p.onOpen(s.id)}>
          <span className="settings-root-name">{s.title}</span>
          <span className="settings-chev" aria-hidden="true">
            ›
          </span>
        </button>
      ))}
    </div>
  );
}

export function SettingsRoot(p: { sections: readonly SectionSpec[]; planName: string | null; hidden: boolean; onOpen(s: SettingsSection): void }) {
  const titleId = useId();
  const app = p.sections.filter((s) => !s.plan);
  const plan = p.sections.filter((s) => s.plan);
  if (plan.length > 0 && p.planName === null) throw new Error("Settings: the root lists plan sections without a plan name");
  return (
    <div className="settings-root" hidden={p.hidden}>
      <div className="settings-root-group" data-group="app" role="group" aria-label={APP_GROUP_LABEL}>
        <RootRows sections={app} onOpen={p.onOpen} />
      </div>
      {plan.length > 0 && (
        <div className="settings-root-group" data-group="plan" role="group" aria-labelledby={titleId}>
          <h2 id={titleId} className="settings-root-title">
            {p.planName}
          </h2>
          <RootRows sections={plan} onOpen={p.onOpen} />
        </div>
      )}
    </div>
  );
}

export function SheetEdit(p: { editing: boolean; disabled: boolean; onToggle(): void }) {
  return (
    <button type="button" className="sheet-edit" disabled={p.disabled} onClick={() => p.onToggle()}>
      {p.editing ? DONE_LABEL : EDIT_LABEL}
    </button>
  );
}

export function SheetBack(p: { label: string; onBack(): void; ref: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={p.ref} type="button" className="sheet-back" aria-label={p.label} onClick={() => p.onBack()}>
      ‹
    </button>
  );
}
