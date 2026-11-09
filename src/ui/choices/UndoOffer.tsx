export function UndoOffer(p: { onKeep(): void; disabled: boolean }) {
  return (
    <div className="undo-offer">
      <button type="button" className="button-primary" disabled={p.disabled} onClick={p.onKeep}>
        Keep the other version
      </button>
    </div>
  );
}
