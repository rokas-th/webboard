import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { STEP_COLOURS, type StepColour } from "../../domain/model";
import type { Step } from "../../domain/steps";
import { clampedAt, type Point } from "../common/ContextMenu";
import { Popover } from "../common/Popover";
import { APPLY, CLEAR, colourName, colourTitle, LIMIT_INPUT, LIMIT_NONE, LIMIT_NOTE, limitTitle } from "./text";

const swatchStyle = (c: StepColour): CSSProperties => ({ "--step": `var(--s-${c})` });

const LIMIT_TEXT = /^\d{1,2}$/;

export const limitOfText = (text: string): number | null => {
  const typed = text.trim();
  if (typed === "") return null;
  return LIMIT_TEXT.test(typed) ? Number(typed) : Number.NaN;
};

const GRID_COLUMNS = 4;

const swatchStep = (key: string): number | null => {
  if (key === "ArrowLeft") return -1;
  if (key === "ArrowRight") return 1;
  if (key === "ArrowUp") return -GRID_COLUMNS;
  if (key === "ArrowDown") return GRID_COLUMNS;
  return null;
};

function Floating(p: { at: Point; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Point>(p.at);
  useLayoutEffect(() => {
    const pop = box.current?.querySelector(".popover") ?? null;
    if (pop === null) throw new Error("Board: a step popover rendered without its element");
    const r = pop.getBoundingClientRect();
    setPlaced(clampedAt(p.at, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [p.at]);
  return (
    <div ref={box} className="board-float" style={{ left: `${placed.x}px`, top: `${placed.y}px` }}>
      {p.children}
    </div>
  );
}

export function ColourPop(p: { name: string; colour: StepColour; at: Point; back: HTMLElement; onPick(c: StepColour): void; onClose(): void }) {
  const [focused, setFocused] = useState<StepColour>(p.colour);
  const grid = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const by = swatchStep(e.key);
    if (by === null) return;
    e.preventDefault();
    const at = STEP_COLOURS.indexOf(focused);
    const next = STEP_COLOURS[(at + by + STEP_COLOURS.length) % STEP_COLOURS.length];
    const root = grid.current;
    if (root === null) throw new Error("Board: the colour grid is not rendered");
    const el = root.querySelector<HTMLElement>(`[data-colour="${next}"]`);
    if (el === null) throw new Error(`Board: the colour grid has no ${next} swatch`);
    setFocused(next);
    el.focus();
  };
  return (
    <Floating at={p.at}>
      <Popover label={colourTitle(p.name)} className="colour-pop" returnFocus={p.back} onClose={p.onClose}>
        <div className="step-pop-body">
          <h3 className="step-pop-title">{colourTitle(p.name)}</h3>
          <div ref={grid} className="colour-grid" role="radiogroup" aria-label={colourTitle(p.name)} onKeyDown={onKeyDown}>
            {STEP_COLOURS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === p.colour}
                aria-label={colourName(c)}
                title={colourName(c)}
                className={c === p.colour ? "colour-swatch on" : "colour-swatch"}
                style={swatchStyle(c)}
                data-colour={c}
                tabIndex={c === focused ? 0 : -1}
                autoFocus={c === p.colour}
                onFocus={() => setFocused(c)}
                onClick={() => p.onPick(c)}
              />
            ))}
          </div>
        </div>
      </Popover>
    </Floating>
  );
}

export function LimitPop(p: { step: Step; at: Point; back: HTMLElement; onApply(text: string): void; onClear(): void; onClose(): void }) {
  const [text, setText] = useState(p.step.limit === null ? "" : String(p.step.limit));
  return (
    <Floating at={p.at}>
      <Popover label={limitTitle(p.step.name)} className="limit-pop" returnFocus={p.back} onClose={p.onClose}>
        <div className="step-pop-body">
          <h3 className="step-pop-title">{limitTitle(p.step.name)}</h3>
          <p className="pop-note">{LIMIT_NOTE}</p>
          <div className="limit-row">
            <input
              type="text"
              inputMode="numeric"
              className="limit-input"
              aria-label={LIMIT_INPUT}
              placeholder={LIMIT_NONE}
              maxLength={2}
              value={text}
              autoFocus
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                p.onApply(text);
              }}
            />
            <button type="button" className="button-small" onClick={p.onClear}>
              {CLEAR}
            </button>
            <button type="button" className="button-small button-primary" onClick={() => p.onApply(text)}>
              {APPLY}
            </button>
          </div>
        </div>
      </Popover>
    </Floating>
  );
}
