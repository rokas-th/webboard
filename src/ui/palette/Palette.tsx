import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useModalFocus } from "../common/Dialog";
import type { Command } from "./commands";

const LIMIT = 40;

export function shownCommands(all: readonly Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  const hits = q === "" ? all.filter((c) => c.group !== "Go to") : all.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  return hits.slice(0, LIMIT);
}

export function Palette(p: { commands: readonly Command[]; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [on, setOn] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = shownCommands(p.commands, query);
  const at = Math.min(on, Math.max(0, shown.length - 1));

  useModalFocus(box, "Palette");

  useEffect(() => {
    const box = list.current;
    if (box === null) throw new Error("Palette rendered without its list");
    const el = box.querySelector(".palette-item.on");
    if (el instanceof HTMLElement) el.scrollIntoView({ block: "nearest" });
  }, [at, query]);

  const runAt = (i: number): void => {
    const c = shown[i];
    if (c === undefined) return;
    p.onClose();
    c.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOn(Math.min(at + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOn(Math.max(at - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(at);
    } else if (e.key === "Escape") {
      e.preventDefault();
      p.onClose();
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <div ref={box} className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          type="text"
          placeholder="Type a command or an item name"
          autoComplete="off"
          aria-label="Command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOn(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" role="listbox" aria-label="Commands" ref={list}>
          {shown.length === 0 ? (
            <div className="palette-empty">No command or item matches.</div>
          ) : (
            shown.map((c, i) => (
              <div
                key={c.id}
                className={i === at ? "palette-item on" : "palette-item"}
                role="option"
                aria-selected={i === at}
                data-command={c.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runAt(i);
                }}
              >
                <span className="grp">{c.group}</span>
                <span className="palette-label">{c.label}</span>
                {c.keys !== undefined && <span className="kb kbd">{c.keys}</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
