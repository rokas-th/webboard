import { useId, useState, type KeyboardEvent } from "react";
import { passes } from "../../theme/checks";
import { derive, schemeOf, type Scheme, type Seeds } from "../../theme/derive";
import { tokensOf } from "../../theme/presets";
import { allThemes } from "../../theme/store";
import { useTheme, type ThemeApi } from "../../theme/ThemeContext";
import { Sheet } from "../common/Sheet";
import { toast } from "../common/Toast";
import { ThemeCards } from "./ThemeCards";
import { Customize, ImportColours, Notes, Readability, messageOf } from "./ThemeEditor";

export const THEME_TITLE = "Theme";
export const DISCARDED = "Unsaved colours discarded.";

function SlotSelect(p: { scheme: Scheme; label: string }) {
  const api = useTheme();
  const id = useId();
  const options = allThemes(api.store).filter((t) => schemeOf(t.seeds.ground) === p.scheme);
  return (
    <>
      <label htmlFor={id} className="dim">
        {p.label}
      </label>
      <select id={id} value={p.scheme === "dark" ? api.store.dark : api.store.light} onChange={(e) => api.setSlot(p.scheme, e.target.value)}>
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </>
  );
}

function Follow() {
  const api = useTheme();
  const on = api.store.mode === "system";
  const hint = useId();
  return (
    <div className="theme-section">
      <div className="theme-switch-row">
        <span>
          Follow the system
          <small id={hint} className="dim theme-hint">
            Switch with the light and dark mode of macOS, Pop!_OS and iOS
          </small>
        </span>
        <button
          type="button"
          role="switch"
          className="theme-switch"
          aria-checked={on}
          aria-label="Follow the system"
          aria-describedby={hint}
          onClick={() => api.setMode(on ? "fixed" : "system")}
        />
      </div>
      {on && (
        <div className="theme-follow">
          <SlotSelect scheme="dark" label="When dark" />
          <SlotSelect scheme="light" label="When light" />
        </div>
      )}
    </div>
  );
}

function Body(p: { hover: boolean }) {
  const api = useTheme();
  const [base, setBase] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const { draft, shown } = api;
  const seeds = draft ?? shown.seeds;
  const tokens = draft !== null ? derive(draft) : tokensOf(shown);
  const edited = draft !== null ? base : null;
  const own = api.store.mine.find((t) => t.id === edited) ?? null;
  const canSave = draft !== null && passes(draft, derive(draft));

  const edit = (next: Seeds): void => {
    if (draft === null) setBase(shown.id);
    api.setDraft(next);
  };

  const choose = (id: string): void => {
    if (draft !== null) {
      api.setDraft(null);
      toast(DISCARDED);
    }
    api.choose(id);
  };

  const save = (replace: string | null, as: string): void => {
    if (draft === null) throw new Error("There are no unsaved colours to save.");
    try {
      const id = api.save(as, draft, replace);
      api.choose(id);
      api.setDraft(null);
      setName("");
      setSaveNote(null);
    } catch (e) {
      setSaveNote(messageOf(e));
    }
  };

  const remove = (id: string): void => {
    if (deleting !== id) {
      setDeleting(id);
      return;
    }
    setDeleting(null);
    api.remove(id);
  };

  return (
    <div className="theme-body">
      <ThemeCards hover={p.hover} edited={edited} onChoose={choose} />
      <Follow />
      <Customize seeds={seeds} tokens={tokens} unsaved={draft !== null} onChange={edit} />
      <ImportColours onMake={edit} />
      <Readability seeds={seeds} tokens={tokens} onFix={edit} />
      <div className="theme-section">
        <div className="theme-save">
          <input type="text" aria-label="Theme name" placeholder="Name, e.g. Night shift" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="button-primary" disabled={!canSave} onClick={() => save(null, name)}>
            Save theme
          </button>
        </div>
        {(own !== null || shown.group === "mine") && (
          <div className="theme-buttons">
            {own !== null && (
              <button type="button" className="button-small" disabled={!canSave} onClick={() => save(own.id, own.name)}>
                Save changes
              </button>
            )}
            {shown.group === "mine" && (
              <button type="button" className={deleting === shown.id ? "button-small button-danger" : "button-small"} onClick={() => remove(shown.id)}>
                {deleting === shown.id ? `Delete ${shown.name}` : "Delete"}
              </button>
            )}
          </div>
        )}
        <Notes notes={saveNote === null ? [] : [saveNote]} />
      </div>
      <div className="theme-buttons">
        <button type="button" className="button-small" onClick={() => api.useCyberdeck()}>
          Use Cyberdeck
        </button>
      </div>
    </div>
  );
}

export const canHover = (): boolean => window.matchMedia("(hover: hover)").matches;

export function closeTheme(api: ThemeApi, onClose: () => void): void {
  api.preview(null);
  if (api.draft !== null) {
    api.setDraft(null);
    toast(DISCARDED);
  }
  onClose();
}

export function ThemePanel(p: { frame: "panel" | "sheet"; hover: boolean; onClose(): void }) {
  const api = useTheme();
  const close = (): void => closeTheme(api, p.onClose);

  if (p.frame === "sheet") {
    return (
      <Sheet open title={THEME_TITLE} onClose={close}>
        <Body hover={p.hover} />
      </Sheet>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };

  return (
    <section className="theme-panel" aria-label={THEME_TITLE} onKeyDown={onKeyDown}>
      <div className="theme-head">
        <h2>{THEME_TITLE}</h2>
        <button type="button" className="button-small" onClick={close}>
          Close
        </button>
      </div>
      <Body hover={p.hover} />
    </section>
  );
}
