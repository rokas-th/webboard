import type { PlanListMode } from "../shell/planListMode";

export type KeyInput = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

export interface KeyState {
  command: boolean;
  typing: boolean;
  dialog: boolean;
  selected: boolean;
  control: boolean;
  listMode: PlanListMode;
}

const VIEWS: Readonly<Record<string, string>> = { "1": "view-timeline", "2": "view-board", "3": "view-list" };

const ARROWS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowLeft: -1 };

const STEPS: Readonly<Record<string, string>> = { ArrowUp: "move-up", ArrowDown: "move-down" };

const TEXT_TYPES: ReadonlySet<string> = new Set(["text", "search", "email", "url", "tel", "password", "number", "date"]);

const STEPPED_TYPES: ReadonlySet<string> = new Set(["range", "radio"]);

const ARROW_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function isTyping(target: EventTarget | null, key: string): boolean {
  if (target instanceof HTMLInputElement) return TEXT_TYPES.has(target.type) || (STEPPED_TYPES.has(target.type) && ARROW_KEYS.has(key));
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

const CONTROLS = 'button, a[href], input, select, textarea, summary, [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="slider"]';

export function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROLS) !== null;
}

const PANE_CODES: Readonly<Record<string, string>> = { KeyI: "inspector", KeyL: "outline" };

const panesShown = (s: KeyState): boolean => s.listMode === "column" || s.listMode === "overlay";

function paneKey(e: KeyInput, s: KeyState): string | null {
  if (e.shiftKey || s.typing || s.dialog) return null;
  const pane = PANE_CODES[e.code];
  if (pane === undefined || s.listMode === "phone" || (pane === "inspector" && !panesShown(s))) return null;
  return pane;
}

const STEP_CODE = /^Digit([1-9])$/;

function stepKey(e: KeyInput, s: KeyState): string | null {
  if (e.shiftKey || s.typing || s.dialog || !s.selected) return null;
  const m = STEP_CODE.exec(e.code);
  return m === null ? null : `to-step-${m[1]}`;
}

function modified(e: KeyInput, s: KeyState): string | null {
  const mod = s.command ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  if (e.altKey) return paneKey(e, s) ?? stepKey(e, s);
  if (e.code === "Comma") return e.shiftKey ? null : "settings";
  const key = e.key.toLowerCase();
  if (s.dialog) return null;
  if (key === "k" && !e.shiftKey) return "palette";
  if (key === "p" && !e.shiftKey) return "print";
  if (key === "f" && !e.shiftKey) return "find";
  if (s.typing) return null;
  if (e.key === "ArrowDown" && !e.shiftKey) return s.selected ? "detail-open" : null;
  if (key === "b" && !e.shiftKey) return panesShown(s) ? "sidebar" : null;
  if (key === "d" && !e.shiftKey) return s.selected ? "duplicate" : null;
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !s.command && !e.shiftKey) return "redo";
  return null;
}

export function keyToCommand(e: KeyInput, s: KeyState): string | null {
  if (e.metaKey || e.ctrlKey) return modified(e, s);
  if (e.key === "Escape") {
    if (s.dialog) return "close-dialog";
    return s.typing ? null : "deselect";
  }
  if (s.typing || s.dialog) return null;
  if (e.key === "/") return "find";
  const arrow = ARROWS[e.key];
  if (arrow !== undefined) {
    if (!s.selected) return null;
    const days = arrow * (e.altKey ? 5 : 1);
    return `${e.shiftKey ? "resize" : "nudge"}${days > 0 ? "+" : ""}${days}`;
  }
  if (e.altKey) {
    const step = e.shiftKey || !s.selected ? undefined : STEPS[e.key];
    return step ?? null;
  }
  if (e.key === "Delete" || e.key === "Backspace") return s.selected ? "trash" : null;
  if (e.key.toLowerCase() === "n") return "new-task";
  if (e.key.toLowerCase() === "m") return "new-milestone";
  if (e.shiftKey) return null;
  if (e.key === " " || e.key === "Enter") return s.selected && !s.control ? (e.key === " " ? "detail-modal" : "rename") : null;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") return e.key === "ArrowDown" ? "select-next" : "select-prev";
  const letter = e.key.toLowerCase();
  if (letter === "j" || letter === "k") return letter === "j" ? "select-next" : "select-prev";
  if (e.key.toLowerCase() === "t") return "today";
  return VIEWS[e.key] ?? null;
}
