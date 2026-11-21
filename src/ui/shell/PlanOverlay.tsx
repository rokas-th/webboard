import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type TransitionEvent as ReactTransitionEvent } from "react";
import { focusables } from "../common/Dialog";
import { CLOSE_CONTROLS, CloseButton, useScrimPress } from "../common/dismiss";
import { OPEN_MENU } from "../common/menu";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export type PaneOverlayKind = "plan" | "inspector";

const CLASSES: Readonly<Record<PaneOverlayKind, { panel: string; layer: string; scrim: string }>> = {
  plan: { panel: "plan-overlay", layer: "plan-overlay-layer", scrim: "plan-overlay-scrim" },
  inspector: { panel: "inspector-overlay", layer: "inspector-overlay-layer", scrim: "inspector-overlay-scrim" },
};

export const NOT_A_PANE_OVERLAY = Object.values(CLASSES)
  .map((c) => `:not(.${c.panel})`)
  .join("");

type Phase = "gone" | "mounted" | "shown" | "leaving";

function nextPhase(phase: Phase, open: boolean, reduced: boolean): Phase {
  if (open) return phase === "gone" ? "mounted" : phase === "leaving" ? "shown" : phase;
  if (phase === "mounted") return "gone";
  if (phase === "shown") return reduced ? "gone" : "leaving";
  return phase === "leaving" && reduced ? "gone" : phase;
}

function mounted<T>(el: T | null, what: string): T {
  if (el === null) throw new Error(`PaneOverlay: ${what}`);
  return el;
}

export interface PaneOverlayProps {
  kind: PaneOverlayKind;
  label: string;
  open: boolean;
  button: RefObject<HTMLButtonElement | null>;
  width: number;
  onClose(): void;
  onScrimPress?(x: number, y: number, at: number): boolean;
  onFocusDropped(): void;
  children: ReactNode;
}

export function PaneOverlay(p: PaneOverlayProps) {
  const classes = CLASSES[p.kind];
  const panelClass = classes.panel;
  const [phase, setPhase] = useState<Phase>(() => (p.open ? "mounted" : "gone"));
  const panel = useRef<HTMLDivElement>(null);
  const onClose = useRef(p.onClose);
  const onFocusDropped = useRef(p.onFocusDropped);
  useLayoutEffect(() => {
    onClose.current = p.onClose;
    onFocusDropped.current = p.onFocusDropped;
  });
  useLayoutEffect(
    () => () => {
      const active = document.activeElement;
      if (active !== null && active.closest(`.${panelClass}`) !== null) onFocusDropped.current();
    },
    [panelClass],
  );
  const next = nextPhase(phase, p.open, window.matchMedia(REDUCED_MOTION).matches);
  if (next !== phase) setPhase(next);

  useLayoutEffect(() => {
    if (phase === "shown") getComputedStyle(mounted(panel.current, "shown without its panel")).getPropertyValue("transform");
    if (phase !== "mounted") return;
    mounted(panel.current, "mounted without its panel").getBoundingClientRect();
    setPhase("shown");
  }, [phase]);

  useEffect(() => {
    if (phase !== "leaving") return;
    const root = mounted(panel.current, "leaving without its panel");
    const query = window.matchMedia(REDUCED_MOTION);
    const onChange = (): void => {
      if (query.matches) setPhase("gone");
    };
    const onCancel = (e: TransitionEvent): void => {
      if (e.target !== root || e.propertyName !== "transform") return;
      if (root.getAnimations().length === 0) setPhase("gone");
    };
    query.addEventListener("change", onChange);
    root.addEventListener("transitioncancel", onCancel);
    return () => {
      query.removeEventListener("change", onChange);
      root.removeEventListener("transitioncancel", onCancel);
    };
  }, [phase]);

  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (p.open) {
      wasOpen.current = true;
      const root = mounted(panel.current, "opened without its panel");
      if (!root.contains(document.activeElement)) root.focus();
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const active = document.activeElement;
    const root = panel.current;
    const lost = active === null || active === document.body || (root !== null && root.contains(active));
    if (lost) mounted(p.button.current, "closed with no toolbar button to take focus back").focus();
  }, [p.open, p.button]);

  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const root = mounted(panel.current, "open without its panel");
      const button = mounted(p.button.current, "open with no toolbar button");
      const active = document.activeElement;
      const modal = active === null ? null : active.closest('[aria-modal="true"]');
      if (modal !== null && modal !== root) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose.current();
        return;
      }
      if (e.key !== "Tab") return;
      const cycle: Element[] = [button, ...focusables(root)];
      const entry = cycle.findIndex((el, i) => i > 0 && !el.matches(CLOSE_CONTROLS));
      const first = entry === -1 ? Math.min(1, cycle.length - 1) : entry;
      const at = active === root ? (e.shiftKey ? 1 : first - 1) : active === null ? -1 : cycle.indexOf(active);
      e.preventDefault();
      const to = at === -1 ? cycle[e.shiftKey ? cycle.length - 1 : first] : cycle[(at + (e.shiftKey ? -1 : 1) + cycle.length) % cycle.length];
      if (!(to instanceof HTMLElement)) throw new Error("PaneOverlay: a focus stop is not an HTML element");
      to.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [p.open, p.button]);

  const paired = useRef(false);
  const scrim = useScrimPress(
    () => {
      if (paired.current) return;
      if (p.open) onClose.current();
    },
    () => document.querySelector(OPEN_MENU) !== null,
  );
  const onScrimPress = p.onScrimPress;
  if (onScrimPress !== undefined && p.kind !== "inspector") throw new Error(`PaneOverlay: only the inspector drawer pairs scrim presses, not the ${p.kind} one`);
  const scrimHandlers = {
    ...scrim,
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>): void => {
      paired.current = false;
      scrim.onPointerDown(e);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>): void => {
      scrim.onPointerUp(e);
      if (onScrimPress === undefined || !p.open || e.target !== e.currentTarget) return;
      paired.current = onScrimPress(e.clientX, e.clientY, performance.now());
    },
  };

  if (phase === "gone" && next === "gone") return null;

  const onEnd = (e: ReactTransitionEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
    if (phase === "leaving") setPhase("gone");
  };
  return (
    <div className={classes.layer} data-shown={phase === "shown" ? "true" : undefined} inert={!p.open}>
      <div className={classes.scrim} {...scrimHandlers} />
      <div
        ref={panel}
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-label={p.label}
        tabIndex={-1}
        style={{ "--drawer-w": `${p.width}px` }}
        onTransitionEnd={onEnd}
      >
        <div className="drawer-head">
          <CloseButton className="drawer-close" onPress={() => onClose.current()} />
        </div>
        {p.children}
      </div>
    </div>
  );
}
