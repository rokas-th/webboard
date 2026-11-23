import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Popover } from "../common/Popover";
import { SEARCH, SEARCH_THIS_PLAN } from "./text";

export type SearchForm = "field" | "glass" | "more";

export interface SearchProps {
  query: string;
  count: string | null;
  ask: number;
  onQuery(q: string): void;
  onFirst(): void;
}

const POP_GAP = 6;

function Glass(p: { className: string }) {
  return (
    <svg className={p.className} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
      <circle cx="7" cy="7" r="4.5" strokeWidth="1.4" />
      <line x1="10.4" y1="10.4" x2="14" y2="14" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SearchInput(p: SearchProps & { input: RefObject<HTMLInputElement | null>; className: string; onEmptyEscape(e: ReactKeyboardEvent<HTMLInputElement>): void; onPicked(): void }) {
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      if (e.currentTarget.value === "") {
        p.onEmptyEscape(e);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      p.onQuery("");
      return;
    }
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    p.onFirst();
    p.onPicked();
  };
  return (
    <input
      ref={p.input}
      type="search"
      className={p.className}
      placeholder={SEARCH}
      aria-label={SEARCH_THIS_PLAN}
      value={p.query}
      onChange={(e) => p.onQuery(e.target.value)}
      onKeyDown={onKey}
    />
  );
}

const Count = (p: { count: string | null }) =>
  p.count === null ? null : (
    <span className="search-count" data-search-count="">
      {p.count}
    </span>
  );

function placeBelow(anchor: HTMLElement): CSSProperties {
  const box = anchor.getBoundingClientRect();
  return { top: box.bottom + POP_GAP, right: Math.max(document.documentElement.clientWidth - box.right, 0) };
}

function SearchPopover(p: SearchProps & { anchor: HTMLElement; onClose(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<CSSProperties>(() => placeBelow(p.anchor));
  const anchor = p.anchor;
  const focusField = (): void => {
    const el = input.current;
    if (el === null) throw new Error("Search: the popover is open without its field");
    el.focus();
  };
  useLayoutEffect(() => {
    const el = input.current;
    if (el === null) throw new Error("Search: the popover opened without its field");
    el.focus();
  }, []);
  useAsked(p.ask, focusField);
  useEffect(() => {
    const onResize = (): void => setPlace(placeBelow(anchor));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [anchor]);
  return createPortal(
    <div className="search-pop-host" style={place}>
      <Popover label={SEARCH} className="search-pop" returnFocus={anchor} onClose={p.onClose}>
        <div className="search-pop-body">
          <SearchInput {...p} input={input} className="search-input" onEmptyEscape={() => undefined} onPicked={p.onClose} />
          <Count count={p.count} />
        </div>
      </Popover>
    </div>,
    document.body,
  );
}

function useAsked(ask: number, onAsk: () => void): void {
  const seen = useRef(ask);
  const latest = useRef(onAsk);
  useLayoutEffect(() => {
    latest.current = onAsk;
  });
  useEffect(() => {
    if (seen.current === ask) return;
    seen.current = ask;
    latest.current();
  }, [ask]);
}

function SearchBox(p: SearchProps) {
  const input = useRef<HTMLInputElement>(null);
  useAsked(p.ask, () => {
    const el = input.current;
    if (el === null) throw new Error("Search: asked to focus a field that is not mounted");
    el.focus();
    el.select();
  });
  return (
    <label className="search-field">
      <Glass className="search-glass" />
      <SearchInput
        {...p}
        input={input}
        className="search-input"
        onEmptyEscape={(e) => {
          e.preventDefault();
          e.currentTarget.blur();
        }}
        onPicked={() => undefined}
      />
      <Count count={p.count} />
    </label>
  );
}

function SearchGlass(p: SearchProps) {
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = (): void => {
    const el = button.current;
    if (el === null) throw new Error("Search: the glass is not mounted");
    setAnchor(el);
  };
  useAsked(p.ask, open);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={p.query === "" ? "icon-button" : "icon-button has-query"}
        aria-label={SEARCH}
        title={SEARCH}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        data-tb="search"
        onClick={open}
      >
        <Glass className="search-glass-icon" />
      </button>
      {anchor !== null && <SearchPopover {...p} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

function SearchInMore(p: SearchProps & { anchor(): HTMLElement }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useAsked(p.ask, () => setAnchor(p.anchor()));
  return anchor === null ? null : <SearchPopover {...p} anchor={anchor} onClose={() => setAnchor(null)} />;
}

export function SearchField(p: SearchProps & { form: SearchForm; moreAnchor(): HTMLElement }) {
  if (p.form === "field") return <SearchBox {...p} />;
  if (p.form === "glass") return <SearchGlass {...p} />;
  return <SearchInMore {...p} anchor={p.moreAnchor} />;
}
