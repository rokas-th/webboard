import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent, type ReactNode, type RefObject, type TransitionEvent as ReactTransitionEvent } from "react";
import { focusables } from "../common/Dialog";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export const PLAN_OVERLAY_CLASS = "plan-overlay";

type Phase = "gone" | "mounted" | "shown" | "leaving";

function nextPhase(phase: Phase, open: boolean, reduced: boolean): Phase {
  if (open) return phase === "gone" ? "mounted" : phase === "leaving" ? "shown" : phase;
  if (phase === "mounted") return "gone";
  if (phase === "shown") return reduced ? "gone" : "leaving";
  return phase === "leaving" && reduced ? "gone" : phase;
}

function mounted<T>(el: T | null, what: string): T {
  if (el === null) throw new Error(`PlanOverlay: ${what}`);
  return el;
}

export function PlanOverlay(p: { open: boolean; button: RefObject<HTMLButtonElement | null>; onClose(): void; onFocusDropped(): void; children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(() => (p.open ? "mounted" : "gone"));
  const panel = useRef<HTMLDivElement>(null);
  const press = useRef<"none" | "down" | "tapped">("none");
  const onClose = useRef(p.onClose);
  const onFocusDropped = useRef(p.onFocusDropped);
  useLayoutEffect(() => {
    onClose.current = p.onClose;
    onFocusDropped.current = p.onFocusDropped;
  });
  useLayoutEffect(
    () => () => {
      const active = document.activeElement;
      if (active !== null && active.closest(`.${PLAN_OVERLAY_CLASS}`) !== null) onFocusDropped.current();
    },
    [],
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
      const at = active === root ? (e.shiftKey ? 1 : 0) : active === null ? -1 : cycle.indexOf(active);
      e.preventDefault();
      const to = at === -1 ? cycle[e.shiftKey ? cycle.length - 1 : Math.min(1, cycle.length - 1)] : cycle[(at + (e.shiftKey ? -1 : 1) + cycle.length) % cycle.length];
      if (!(to instanceof HTMLElement)) throw new Error("PlanOverlay: a focus stop is not an HTML element");
      to.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [p.open, p.button]);

  if (phase === "gone" && next === "gone") return null;

  const onEnd = (e: ReactTransitionEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
    if (phase === "leaving") setPhase("gone");
  };
  const scrim = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      press.current = e.target === e.currentTarget ? "down" : "none";
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      press.current = press.current === "down" && document.elementFromPoint(e.clientX, e.clientY) === e.currentTarget ? "tapped" : "none";
    },
    onPointerCancel: () => {
      press.current = "none";
    },
    onClick: (e: MouseEvent<HTMLDivElement>) => {
      const tapped = press.current === "tapped";
      press.current = "none";
      if (tapped && e.target === e.currentTarget && p.open) onClose.current();
    },
  };
  return (
    <div className="plan-overlay-layer" data-shown={phase === "shown" ? "true" : undefined} inert={!p.open}>
      <div className="plan-overlay-scrim" {...scrim} />
      <div ref={panel} className={PLAN_OVERLAY_CLASS} role="dialog" aria-modal="true" aria-label="Plans" tabIndex={-1} onTransitionEnd={onEnd}>
        {p.children}
      </div>
    </div>
  );
}
