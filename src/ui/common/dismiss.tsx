import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { askNative, usesNativeAlert } from "../../services/alert";
import { AppError } from "../../services/ipc";
import { detailsOf } from "./errorText";
import { toast } from "./Toast";

export type CloseReason = "x" | "scrim" | "swipe" | "escape";

export interface DraftGuard {
  title: string;
  message: string;
}

export const KEEP_EDITING = "Keep editing";

export const DISCARD = "Discard";

export const ASK_WAIT_MS = 1000;

export type CloseClass = "sheet-close" | "modal-close" | "drawer-close" | "popover-close" | "palette-close";

export const CLOSE_CONTROLS = ".sheet-close, .modal-close, .drawer-close, .popover-close, .palette-close";

export function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
      <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CloseButton(p: { className: CloseClass; onPress(): void }) {
  return (
    <button type="button" className={p.className} aria-label="Close" onClick={() => p.onPress()}>
      <CloseGlyph />
    </button>
  );
}

export interface ScrimPress {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(): void;
  onClick(e: MouseEvent<HTMLElement>): void;
}

export function useScrimPress(onPress: () => void, ignore?: () => boolean): ScrimPress {
  const press = useRef<"none" | "down" | "tapped">("none");
  return {
    onPointerDown: (e) => {
      press.current = e.target === e.currentTarget && ignore?.() !== true ? "down" : "none";
    },
    onPointerUp: (e) => {
      press.current = press.current === "down" && document.elementFromPoint(e.clientX, e.clientY) === e.currentTarget ? "tapped" : "none";
    },
    onPointerCancel: () => {
      press.current = "none";
    },
    onClick: (e) => {
      const tapped = press.current === "tapped";
      press.current = "none";
      if (tapped && e.target === e.currentTarget) onPress();
    },
  };
}

function focusReportsError(root: HTMLElement): boolean {
  let reported = false;
  const onError = (): void => {
    reported = true;
  };
  window.addEventListener("error", onError);
  try {
    root.focus();
  } finally {
    window.removeEventListener("error", onError);
  }
  return reported;
}

export function commitFocus(root: HTMLElement, what: string): boolean {
  const active = document.activeElement;
  if (active === root || !root.contains(active)) return true;
  const failed = focusReportsError(root);
  if (document.activeElement !== root) throw new Error(`${what} could not take focus from its field to commit it`);
  return !failed;
}

interface HeldGuard {
  owner: symbol;
  guard: DraftGuard | null;
}

interface GuardSlot {
  current: HeldGuard | null;
}

const GuardContext = createContext<GuardSlot | null>(null);

export function useCloseGuard(guard: DraftGuard | null): void {
  const slot = useContext(GuardContext);
  if (slot === null) throw new Error("useCloseGuard needs a Dialog or Sheet around it");
  const [owner] = useState(() => Symbol("close guard"));
  useLayoutEffect(() => {
    if (slot.current !== null && slot.current.owner !== owner) throw new Error("useCloseGuard: a second guard under one Dialog or Sheet");
    slot.current = { owner, guard: null };
    return () => {
      if (slot.current !== null && slot.current.owner === owner) slot.current = null;
    };
  }, [slot, owner]);
  useLayoutEffect(() => {
    const held = slot.current;
    if (held === null || held.owner !== owner) throw new Error("useCloseGuard set a guard it does not hold");
    held.guard = guard;
  });
}

export interface CloseRequest {
  close(reason: CloseReason): void;
  scope(children: ReactNode): ReactNode;
}

interface NativeAsk {
  at: number;
  token: symbol;
}

export function useRequestClose(ref: RefObject<HTMLElement | null>, onClose: () => void, what: string): CloseRequest {
  const slot = useRef<HeldGuard | null>(null);
  const native = useRef<NativeAsk | null>(null);
  const inline = useRef(false);
  const mounted = useRef(false);
  const latest = useRef(onClose);
  const back = useRef<Element | null>(null);
  const [asking, setAsking] = useState<DraftGuard | null>(null);
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = useCallback(
    (reason: CloseReason): void => {
      if (inline.current) return;
      const waiting = native.current;
      if (waiting !== null) {
        if (performance.now() - waiting.at < ASK_WAIT_MS) return;
        native.current = null;
        throw new Error(`${what}'s discard ask got no answer from iOS within ${ASK_WAIT_MS} ms`);
      }
      const root = ref.current;
      if (root === null) throw new Error(`${what} closed without its element`);
      const was = document.activeElement;
      if (reason !== "escape" && !flushSync(() => commitFocus(root, what))) return;
      const held = slot.current;
      const guard = held === null ? null : held.guard;
      if (guard === null) {
        latest.current();
        return;
      }
      if (!usesNativeAlert()) {
        inline.current = true;
        back.current = was;
        setAsking(guard);
        return;
      }
      const token = Symbol("discard ask");
      native.current = { at: performance.now(), token };
      const current = (): boolean => native.current !== null && native.current.token === token;
      void askNative({ title: guard.title, message: guard.message, confirm: { label: DISCARD, destructive: true }, cancel: KEEP_EDITING }).then(
        (answer) => {
          if (!current()) return;
          native.current = null;
          if (answer === "confirm" && mounted.current) latest.current();
        },
        (e: unknown) => {
          if (current()) native.current = null;
          if (!(e instanceof AppError)) throw e;
          toast(e.message, "bad", detailsOf(e));
        },
      );
    },
    [ref, what],
  );
  const keep = (): void => {
    inline.current = false;
    flushSync(() => setAsking(null));
    const root = ref.current;
    if (root === null) throw new Error(`${what} kept editing without its element`);
    const was = back.current;
    back.current = null;
    (was instanceof HTMLElement && was.isConnected && root.contains(was) ? was : root).focus();
  };
  const discard = (): void => {
    inline.current = false;
    back.current = null;
    flushSync(() => setAsking(null));
    latest.current();
  };
  const scope = (children: ReactNode): ReactNode => (
    <GuardContext.Provider value={slot}>
      {children}
      {asking !== null && <DiscardAsk guard={asking} onKeep={keep} onDiscard={discard} />}
    </GuardContext.Provider>
  );
  return { close, scope };
}

function DiscardAsk(p: { guard: DraftGuard; onKeep(): void; onDiscard(): void }) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  useOverlayEntry(scrimRef, () => p.onKeep());
  useEffect(() => {
    const keep = keepRef.current;
    if (keep === null) throw new Error("The discard ask rendered without Keep editing");
    keep.focus();
    const onFocusIn = (e: FocusEvent): void => {
      const box = boxRef.current;
      if (box === null) throw new Error("The discard ask lost its box");
      if (e.target instanceof Node && box.contains(e.target)) return;
      keep.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      p.onKeep();
      return;
    }
    if (e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    const keep = keepRef.current;
    const discard = discardRef.current;
    if (keep === null || discard === null) throw new Error("The discard ask lost its buttons");
    (document.activeElement === keep ? discard : keep).focus();
  };
  return (
    <div
      ref={scrimRef}
      className="discard-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div ref={boxRef} className="discard-ask" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} onKeyDown={onKeyDown}>
        <h4 id={titleId}>{p.guard.title}</h4>
        <p id={messageId}>{p.guard.message}</p>
        <div className="modal-actions">
          <button ref={keepRef} type="button" onClick={() => p.onKeep()}>
            {KEEP_EDITING}
          </button>
          <button ref={discardRef} type="button" className="button-danger" onClick={() => p.onDiscard()}>
            {DISCARD}
          </button>
        </div>
      </div>
    </div>
  );
}

interface OverlayEntry {
  element: RefObject<HTMLElement | null>;
  requestClose(reason: CloseReason): void;
}

const overlays: OverlayEntry[] = [];

export function useOverlayEntry(element: RefObject<HTMLElement | null>, requestClose: (reason: CloseReason) => void): void {
  const latest = useRef(requestClose);
  useLayoutEffect(() => {
    latest.current = requestClose;
  });
  useEffect(() => {
    const entry: OverlayEntry = { element, requestClose: (reason) => latest.current(reason) };
    overlays.push(entry);
    return () => {
      const at = overlays.indexOf(entry);
      if (at < 0) throw new Error("an overlay left the stack twice");
      overlays.splice(at, 1);
    };
  }, [element]);
}

export function closeTopOverlay(): boolean {
  const placed = overlays.map((entry) => {
    const el = entry.element.current;
    if (el === null) throw new Error("an open overlay has no element to order it by");
    return { entry, el };
  });
  const innermost = placed.filter((a) => !placed.some((b) => b !== a && a.el.contains(b.el)));
  const top = innermost[innermost.length - 1];
  if (top === undefined) return false;
  top.entry.requestClose("escape");
  return true;
}
