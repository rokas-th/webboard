import { CloseGlyph } from "../common/dismiss";
import type { BoardLayout } from "./layout";
import { CLEAR_SEARCH, filteredText, hiddenDoneText } from "./text";

export function BoardLine(p: { layout: BoardLayout; completing: boolean; query: string; byDates: string; onClear(): void }) {
  const l = p.layout;
  return (
    <p className="board-line" role="status">
      {p.query !== "" && (
        <span className="filter-chip" data-filter-chip="">
          <span className="chip-text">{filteredText(p.query)}</span>
          <button type="button" className="chip-x" aria-label={CLEAR_SEARCH} title={CLEAR_SEARCH} onClick={p.onClear}>
            <CloseGlyph />
          </button>
        </span>
      )}
      {l.mode === "dates" && (
        <span className="quiet-line" data-by-dates="">
          {p.byDates}
        </span>
      )}
      {!p.completing && l.hiddenDone > 0 && (
        <span className="quiet-line" data-done-hidden="">
          {hiddenDoneText(l.hiddenDone)}
        </span>
      )}
      {l.problems.map((text) => (
        <span key={text} className="board-problem">
          {text}
        </span>
      ))}
    </p>
  );
}
