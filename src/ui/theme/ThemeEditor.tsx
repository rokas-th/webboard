import { useState, type DragEvent } from "react";
import { checks, fix, type Check, type CheckId } from "../../theme/checks";
import type { Hex } from "../../theme/colour";
import type { Scheme, Seeds, Tokens } from "../../theme/derive";
import { readImageColours } from "../../theme/image";
import { assignRoles, parseColours } from "../../theme/importer";
import { swatch } from "./ThemeCards";

const ROLES: readonly { role: keyof Seeds; name: string; hint: string }[] = [
  { role: "ground", name: "Background", hint: "Window, panels and lines are mixed from it" },
  { role: "text", name: "Text", hint: "Headings and secondary text follow it" },
  { role: "accent", name: "Accent", hint: "Bars, links, focus, the open view" },
  { role: "highlight", name: "Highlight", hint: "Selection, today, held items, slip" },
  { role: "danger", name: "Danger", hint: "Conflicts, broken links, delete. Nothing else" },
];

const DERIVED: readonly { token: keyof Tokens; name: string }[] = [
  { token: "panel", name: "Panel" },
  { token: "panel-2", name: "Raised" },
  { token: "line", name: "Lines" },
  { token: "dim", name: "Secondary text" },
  { token: "heading", name: "Headings" },
  { token: "cyan-dim", name: "Done bars" },
  { token: "danger-bg", name: "Danger fill" },
  { token: "dot-idle", name: "Idle dot" },
];

const HEX_INPUT = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

export const normaliseHex = (raw: string): Hex | null => {
  const m = HEX_INPUT.exec(raw.trim());
  if (m === null) return null;
  const digits = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${digits.toUpperCase()}`;
};

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function Notes(p: { notes: readonly string[] }) {
  if (p.notes.length === 0) return null;
  return (
    <ul className="theme-notes">
      {p.notes.map((n, i) => (
        <li key={`${i}-${n}`}>{n}</li>
      ))}
    </ul>
  );
}

function RoleRow(p: { role: keyof Seeds; name: string; hint: string; value: Hex; onChange(c: Hex): void }) {
  const [typed, setTyped] = useState<{ text: string; value: Hex } | null>(null);
  const text = typed !== null && typed.value === p.value ? typed.text : p.value;
  const invalid = normaliseHex(text) === null;
  const onText = (raw: string): void => {
    const c = normaliseHex(raw);
    setTyped({ text: raw, value: c ?? p.value });
    if (c !== null && c !== p.value) p.onChange(c);
  };
  const onPick = (raw: string): void => {
    const c = normaliseHex(raw);
    if (c === null) throw new Error(`The colour picker gave ${raw}, which is not a colour.`);
    setTyped(null);
    if (c !== p.value) p.onChange(c);
  };
  return (
    <div className="theme-role">
      <input type="color" className="theme-picker" aria-label={p.name} value={p.value.toLowerCase()} onChange={(e) => onPick(e.target.value)} />
      <span>
        <b className="theme-role-name">{p.name}</b>
        <small className="dim theme-hint">{p.hint}</small>
      </span>
      <input
        type="text"
        className={invalid ? "theme-hex theme-hex-bad" : "theme-hex"}
        aria-label={`${p.name} hex`}
        aria-invalid={invalid}
        spellCheck={false}
        maxLength={7}
        value={text}
        onChange={(e) => onText(e.target.value)}
        onBlur={() => {
          if (!invalid) setTyped(null);
        }}
      />
    </div>
  );
}

export function Customize(p: { seeds: Seeds; tokens: Tokens; unsaved: boolean; onChange(s: Seeds): void }) {
  return (
    <div className="theme-section">
      <h3 className="theme-eyebrow">
        Customize
        {p.unsaved && <span className="theme-tag">Unsaved</span>}
      </h3>
      <div className="theme-roles">
        {ROLES.map((r) => (
          <RoleRow key={r.role} role={r.role} name={r.name} hint={r.hint} value={p.seeds[r.role]} onChange={(c) => p.onChange({ ...p.seeds, [r.role]: c })} />
        ))}
      </div>
      <div className="theme-derived">
        {DERIVED.map((d) => (
          <span key={d.token} className="theme-derived-item">
            <span className="theme-swatch" style={swatch(p.tokens[d.token])} />
            {d.name}
          </span>
        ))}
      </div>
    </div>
  );
}

type Source = "paste" | "image";

const plural = (n: number): string => `${n} colour${n === 1 ? "" : "s"}`;

const tooFew = (source: Source, n: number): string =>
  source === "paste" ? `Found ${plural(n)}; paste at least three.` : n === 0 ? "Choose an image first." : `Found ${plural(n)}; choose an image with at least three.`;

export function ImportColours(p: { onMake(s: Seeds): void }) {
  const [source, setSource] = useState<Source>("paste");
  const [text, setText] = useState("");
  const [image, setImage] = useState<readonly Hex[]>([]);
  const [over, setOver] = useState(false);
  const [notes, setNotes] = useState<readonly string[]>([]);

  const take = (file: File): void => {
    readImageColours(file).then(
      (c) => {
        setImage(c);
        setNotes([]);
      },
      (e: unknown) => {
        setImage([]);
        setNotes([messageOf(e)]);
      },
    );
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>): void => {
    e.preventDefault();
    setOver(false);
    Array.from(e.dataTransfer.files).slice(0, 1).forEach(take);
  };

  const make = (scheme: Scheme): void => {
    const colours = source === "paste" ? parseColours(text) : image;
    if (colours.length < 3) {
      setNotes([tooFew(source, colours.length)]);
      return;
    }
    const r = assignRoles(colours, scheme);
    setNotes([`Used ${colours.length} colours.`, ...r.notes]);
    p.onMake(r.seeds);
  };

  return (
    <div className="theme-section">
      <h3 className="theme-eyebrow">Bring your own colours</h3>
      <div className="seg theme-source">
        <button type="button" className={source === "paste" ? "active" : undefined} aria-pressed={source === "paste"} onClick={() => setSource("paste")}>
          Paste
        </button>
        <button type="button" className={source === "image" ? "active" : undefined} aria-pressed={source === "image"} onClick={() => setSource("image")}>
          From an image
        </button>
      </div>
      {source === "paste" ? (
        <textarea
          className="theme-paste"
          aria-label="Colours to paste"
          spellCheck={false}
          placeholder="Paste hex codes, or the CSS variables colorfetcher.com exports"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <>
          <label
            className={over ? "theme-drop theme-drop-over" : "theme-drop"}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <span>Drop an image here, or choose one. It stays on this device.</span>
            <input
              type="file"
              accept="image/*"
              aria-label="Choose an image"
              onChange={(e) => Array.from(e.target.files ?? []).slice(0, 1).forEach(take)}
            />
          </label>
          {image.length > 0 && (
            <div className="theme-strip">
              {image.map((c) => (
                <span key={c} className="theme-swatch" style={swatch(c)} title={c} />
              ))}
            </div>
          )}
        </>
      )}
      <div className="theme-buttons">
        <button type="button" className="button-small" onClick={() => make("dark")}>
          Make a dark theme
        </button>
        <button type="button" className="button-small" onClick={() => make("light")}>
          Make a light theme
        </button>
      </div>
      <Notes notes={notes} />
    </div>
  );
}

const valueOf = (c: Check): string => (c.unit === "ratio" ? `${c.value.toFixed(1)}:1` : c.unit === "deg" ? `${Math.round(c.value)}°` : c.value === 1 ? "yes" : "no");

const badgeOf = (c: Check): string => (c.unit !== "ratio" ? "OK" : c.value >= 7 ? "AAA" : "AA");

export function Readability(p: { seeds: Seeds; tokens: Tokens; onFix(s: Seeds): void }) {
  const [note, setNote] = useState<string | null>(null);
  const onFix = (id: CheckId, label: string): void => {
    const next = fix(id, p.seeds);
    if (next === null) {
      setNote(`Could not fix ${label} automatically; change the colour by hand.`);
      return;
    }
    setNote(null);
    p.onFix(next);
  };
  return (
    <div className="theme-section">
      <h3 className="theme-eyebrow">Readability</h3>
      <div className="theme-checks">
        {checks(p.seeds, p.tokens).map((c) => {
          const badge = badgeOf(c);
          return (
            <div key={c.id} className="theme-check">
              <span>{c.label}</span>
              <span className="theme-check-value">{valueOf(c)}</span>
              {c.pass ? (
                <span className={badge === "AAA" ? "theme-badge theme-badge-aaa" : "theme-badge"}>{badge}</span>
              ) : (
                <button type="button" className="button-small" onClick={() => onFix(c.id, c.label)}>
                  Fix
                </button>
              )}
            </div>
          );
        })}
      </div>
      <Notes notes={note === null ? [] : [note]} />
    </div>
  );
}
