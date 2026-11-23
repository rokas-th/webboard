import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { readPlatform } from "../../platform";
import { usesNativeMenu, type NativeMenuRow, type NativeMenuSection } from "../../services/nativeMenu";
import type { Zoom } from "../state";
import { useNativeMenu } from "../common/menu";
import { ZOOMS } from "./zooms";
import { SEARCH_ROW } from "../search/text";

type Props = {
  zoom: Zoom | null;
  onZoom(z: Zoom): void;
  onToday: (() => void) | null;
  onSettings(): void;
  onPlan: (() => void) | null;
  onSearch: (() => void) | null;
  onFocusDropped(): void;
};

const ZOOM_ID = "zoom-";

function useFocusReport(box: RefObject<HTMLElement | null>, p: Props): void {
  const onFocusDropped = useRef(p.onFocusDropped);
  useLayoutEffect(() => {
    onFocusDropped.current = p.onFocusDropped;
  });
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) throw new Error("MoreMenu: mounted without its box");
    return () => {
      if (el.contains(document.activeElement)) onFocusDropped.current();
    };
  }, [box]);
}

function useRowSetChange(p: Props, open: boolean, close: () => void): void {
  const rowSet = [p.zoom !== null, p.onToday !== null, p.onPlan !== null, p.onSearch !== null].join(" ");
  const seenRows = useRef(rowSet);
  useEffect(() => {
    if (seenRows.current === rowSet) return;
    seenRows.current = rowSet;
    if (open) close();
  }, [rowSet, open, close]);
}

const row = (id: string, title: string, checked = false): NativeMenuRow => ({ id, title, checked });

function moreSections(p: Props): NativeMenuSection[] {
  const { zoom } = p;
  const zooms: NativeMenuSection[] = zoom === null ? [] : [{ title: "Zoom", rows: ZOOMS.map((z) => row(`${ZOOM_ID}${z.zoom}`, z.row, z.zoom === zoom)) }];
  const rest = [...(p.onToday === null ? [] : [row("today", "Go to today")]), row("settings", "Settings"), ...(p.onPlan === null ? [] : [row("plan", "Plan")])];
  const search: NativeMenuSection[] = p.onSearch === null ? [] : [{ title: null, rows: [row("search", SEARCH_ROW)] }];
  return [...search, ...zooms, { title: null, rows: rest }];
}

const present = <T,>(run: T | null, id: string): T => {
  if (run === null) throw new Error(`MoreMenu: the native menu chose ${JSON.stringify(id)}, a row it no longer has`);
  return run;
};

function runRow(p: Props, id: string): void {
  const zoom = ZOOMS.find((z) => `${ZOOM_ID}${z.zoom}` === id);
  if (zoom !== undefined) {
    p.onZoom(zoom.zoom);
    return;
  }
  if (id === "today") present(p.onToday, id)();
  else if (id === "settings") p.onSettings();
  else if (id === "plan") present(p.onPlan, id)();
  else if (id === "search") present(p.onSearch, id)();
  else throw new Error(`MoreMenu: the native menu chose ${JSON.stringify(id)}, which is no row of the More menu`);
}

function NativeMoreMenu(p: Props) {
  const menu = useNativeMenu("MoreMenu");
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });
  useFocusReport(box, p);
  useRowSetChange(p, menu.open, menu.dismiss);
  return (
    <div className="plan-menu" ref={box}>
      <button
        ref={toggle}
        type="button"
        className="glyph-button"
        aria-label="More"
        title="More"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => menu.show(toggle.current, moreSections(p), (id) => runRow(latest.current, id))}
      >
        ⋯
      </button>
    </div>
  );
}

export function MoreMenu(p: Props) {
  if (!usesNativeMenu()) throw new Error(`MoreMenu: rendered on ${readPlatform(window).os}, but only the iPad toolbar folds into More`);
  return <NativeMoreMenu {...p} />;
}
