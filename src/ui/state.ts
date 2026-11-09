import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { BaselineId, ItemId, PlanId } from "../domain/model";
import type { PlanListing } from "../store/registry";
import { toast } from "./common/Toast";

export type ViewKind = "timeline" | "board" | "list";
export type Zoom = "W" | "M" | "Q";

export type DialogState =
  | { t: "calendar" }
  | { t: "choice"; id: string; side?: string }
  | { t: "palette" }
  | { t: "revert"; id: string }
  | { t: "about" };

export interface UiState {
  plan: PlanId | null;
  view: ViewKind;
  zoom: Zoom;
  selected: ItemId | null;
  collapsed: ReadonlySet<ItemId>;
  baseline: BaselineId | null;
  dialog: DialogState | null;
  reveal: ItemId | null;
}

export const PLACE_KEY = "webboard.place";
export const PLACE_UNREADABLE = "Saved view settings could not be read; they were reset.";

const VIEWS: readonly string[] = ["timeline", "board", "list"];
const ZOOMS: readonly string[] = ["W", "M", "Q"];

const isView = (v: unknown): v is ViewKind => typeof v === "string" && VIEWS.includes(v);
const isZoom = (v: unknown): v is Zoom => typeof v === "string" && ZOOMS.includes(v);
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const DEFAULTS: UiState = {
  plan: null,
  view: "timeline",
  zoom: "W",
  selected: null,
  collapsed: new Set(),
  baseline: null,
  dialog: null,
  reveal: null,
};

type Place = Pick<UiState, "plan" | "view" | "zoom" | "collapsed">;

function parsePlace(raw: string): Place | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const plan = "plan" in v ? v.plan : DEFAULTS.plan;
  const view = "view" in v ? v.view : DEFAULTS.view;
  const zoom = "zoom" in v ? v.zoom : DEFAULTS.zoom;
  const collapsed = "collapsed" in v ? v.collapsed : [];
  if (!(plan === null || typeof plan === "string") || !isView(view) || !isZoom(zoom) || !isIds(collapsed)) return null;
  return { plan, view, zoom, collapsed: new Set(collapsed) };
}

function loadPlace(): { state: UiState; unreadable: boolean } {
  const raw = window.localStorage.getItem(PLACE_KEY);
  if (raw === null) return { state: DEFAULTS, unreadable: false };
  const place = parsePlace(raw);
  if (place === null) return { state: DEFAULTS, unreadable: true };
  return { state: { ...DEFAULTS, ...place }, unreadable: false };
}

const savePlace = (s: UiState): void => {
  window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: s.plan, view: s.view, zoom: s.zoom, collapsed: [...s.collapsed] }));
};

const placeChanged = (a: UiState, b: UiState): boolean =>
  a.plan !== b.plan || a.view !== b.view || a.zoom !== b.zoom || a.collapsed !== b.collapsed;

export type SetUi = (patch: Partial<UiState>) => void;

export interface UiValue {
  ui: UiState;
  setUi: SetUi;
}

export const UiContext = createContext<UiValue | null>(null);

export function useUiValue(): UiValue {
  const value = useContext(UiContext);
  if (value === null) throw new Error("useUiValue needs a UiContext provider");
  return value;
}

export function useUi(): [UiState, SetUi] {
  const [loaded] = useState(loadPlace);
  const [ui, setState] = useState<UiState>(loaded.state);
  const told = useRef(false);
  useEffect(() => {
    if (!loaded.unreadable || told.current) return;
    told.current = true;
    toast(PLACE_UNREADABLE, "bad");
  }, [loaded]);
  const saved = useRef<UiState>(loaded.state);
  useEffect(() => {
    if (!placeChanged(saved.current, ui)) return;
    saved.current = ui;
    savePlace(ui);
  }, [ui.plan, ui.view, ui.zoom, ui.collapsed]);
  const setUi = useCallback((patch: Partial<UiState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);
  return [ui, setUi];
}

export function pickPlan(plans: readonly PlanListing[], current: PlanId | null): PlanId | null {
  if (current !== null && plans.some((p) => p.id === current && !p.trashed)) return current;
  return plans.find((p) => !p.trashed)?.id ?? null;
}
