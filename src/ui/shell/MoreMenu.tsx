import { useEffect, useLayoutEffect, useRef } from "react";
import type { Zoom } from "../state";
import { useMenu } from "../common/menu";
import { ZOOMS } from "./zooms";

const ROWS = '[role="menuitem"], [role="menuitemradio"]';

export function MoreMenu(p: {
  zoom: Zoom | null;
  onZoom(z: Zoom): void;
  onToday: (() => void) | null;
  onSettings(): void;
  onPlan: (() => void) | null;
  onFocusDropped(): void;
}) {
  const menu = useMenu("MoreMenu", ROWS, true);
  const { zoom, onZoom, onToday, onPlan } = p;
  const onFocusDropped = useRef(p.onFocusDropped);
  useLayoutEffect(() => {
    onFocusDropped.current = p.onFocusDropped;
  });
  const box = menu.box.ref;
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) throw new Error("MoreMenu: mounted without its box");
    return () => {
      if (el.contains(document.activeElement)) onFocusDropped.current();
    };
  }, [box]);
  const rowSet = [zoom !== null, onToday !== null, onPlan !== null].join(" ");
  const seenRows = useRef(rowSet);
  const { open, close } = menu;
  useEffect(() => {
    if (seenRows.current === rowSet) return;
    seenRows.current = rowSet;
    if (open) close();
  }, [rowSet, open, close]);
  const choose = (run: () => void) => (): void => {
    close();
    run();
  };
  return (
    <div className="plan-menu" {...menu.box}>
      <button
        ref={menu.toggle}
        type="button"
        className="glyph-button"
        aria-label="More"
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={menu.onToggle}
      >
        ⋯
      </button>
      {open && (
        <div ref={menu.list} className={menu.listClass} role="menu" aria-label="More">
          {zoom !== null && (
            <div role="group" aria-label="Zoom">
              <div className="menu-group-label" aria-hidden="true">
                Zoom
              </div>
              {ZOOMS.map((z) => (
                <button key={z.zoom} type="button" role="menuitemradio" aria-checked={zoom === z.zoom} className="choice-row" onClick={choose(() => onZoom(z.zoom))}>
                  {z.row}
                </button>
              ))}
            </div>
          )}
          {onToday !== null && (
            <button type="button" role="menuitem" className="choice-row" onClick={choose(onToday)}>
              Go to today
            </button>
          )}
          <button type="button" role="menuitem" className="choice-row" onClick={choose(p.onSettings)}>
            Settings
          </button>
          {onPlan !== null && (
            <button type="button" role="menuitem" className="choice-row" onClick={choose(onPlan)}>
              Plan
            </button>
          )}
        </div>
      )}
    </div>
  );
}
