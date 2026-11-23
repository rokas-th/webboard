export function Switch(p: { label: string; checked: boolean; describedBy?: string; onToggle(): void }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={p.checked} aria-label={p.label} aria-describedby={p.describedBy} onClick={p.onToggle}>
      <span className="switch-track" aria-hidden="true" />
    </button>
  );
}
