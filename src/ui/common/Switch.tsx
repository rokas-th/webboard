export function Switch(p: { label: string; checked: boolean; describedBy?: string; disabled?: boolean; onToggle(): void }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={p.checked} aria-label={p.label} aria-describedby={p.describedBy} disabled={p.disabled} onClick={p.onToggle}>
      <span className="switch-track" aria-hidden="true" />
    </button>
  );
}
