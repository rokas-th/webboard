import { useId, useState, useSyncExternalStore } from "react";
import { passes } from "../../theme/checks";
import { derive, schemeOf, type Scheme, type Seeds } from "../../theme/derive";
import { DEFAULT_DARK, DEFAULT_LIGHT, tokensOf } from "../../theme/presets";
import { allThemes, DEFAULT_STORE, themeById, ThemeSaveError } from "../../theme/store";
import { DISCARDED, useTheme } from "../../theme/ThemeContext";
import { toast } from "../common/Toast";
import { ThemeCards } from "./ThemeCards";
import { Customize, ImportColours, Notes, Readability } from "./ThemeEditor";

export { DISCARDED };

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
            {t.group === "mine" ? `${t.name} (yours)` : t.name}
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

const defaultName = (scheme: Scheme): string => themeById(DEFAULT_STORE, scheme === "dark" ? DEFAULT_DARK : DEFAULT_LIGHT).name;

const slotName = (scheme: Scheme): string => (scheme === "dark" ? "When dark" : "When light");

export function ThemeBody(p: { hover: boolean }) {
  const api = useTheme();
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saveNotes, setSaveNotes] = useState<readonly string[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);

  const { draft, shown } = api;
  const target = allThemes(api.store).find((t) => t.id === picked) ?? shown;
  const seeds = draft?.seeds ?? target.seeds;
  const tokens = draft !== null ? derive(draft.seeds) : tokensOf(target);
  const edited = draft?.base ?? null;
  const own = api.store.mine.find((t) => t.id === edited) ?? null;
  const canSave = draft !== null && passes(draft.seeds, derive(draft.seeds));
  const following = api.store.mode === "system";

  const edit = (next: Seeds): void => {
    api.setDraft({ seeds: next, base: draft === null ? target.id : draft.base });
  };

  const make = (next: Seeds): void => {
    if (draft !== null) toast(DISCARDED);
    api.setDraft({ seeds: next, base: null });
  };

  const choose = (id: string): void => {
    if (draft !== null) {
      api.setDraft(null);
      toast(DISCARDED);
    }
    setPicked(id);
    setDeleting(null);
    api.choose(id);
  };

  const attempt = (as: string, replace: string | null, seedsToSave: Seeds): { id: string; reset: readonly Scheme[] } | ThemeSaveError => {
    try {
      return api.save(as, seedsToSave, replace);
    } catch (e) {
      if (e instanceof ThemeSaveError) return e;
      throw e;
    }
  };

  const save = (replace: string | null, as: string): void => {
    if (draft === null) throw new Error("There are no unsaved colours to save.");
    const r = attempt(as, replace, draft.seeds);
    if (r instanceof ThemeSaveError) {
      setSaveNotes([r.message]);
      return;
    }
    api.choose(r.id);
    api.setDraft(null);
    setPicked(r.id);
    setName("");
    setSaveNotes(following ? r.reset.map((scheme) => `${as.trim()} is no longer a ${scheme} theme, so ${slotName(scheme)} uses ${defaultName(scheme)}.`) : []);
  };

  const remove = (id: string): void => {
    if (deleting !== id) {
      setDeleting(id);
      return;
    }
    setDeleting(null);
    setPicked(null);
    const reset = api.remove(id);
    setSaveNotes(following ? reset.map((scheme) => `${slotName(scheme)} uses ${defaultName(scheme)} again.`) : []);
  };

  const useCyberdeck = (): void => {
    setPicked(null);
    setDeleting(null);
    api.useCyberdeck();
  };

  return (
    <div className="theme-body">
      <ThemeCards hover={p.hover} edited={edited} onChoose={choose} />
      <Follow />
      <Customize seeds={seeds} tokens={tokens} unsaved={draft !== null} onChange={edit} />
      <ImportColours onMake={make} />
      <Readability seeds={seeds} tokens={tokens} onFix={edit} />
      <div className="theme-section">
        <div className="theme-save">
          <input type="text" aria-label="Theme name" placeholder="Name, e.g. Night shift" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="button-primary" disabled={!canSave} onClick={() => save(null, name)}>
            Save theme
          </button>
        </div>
        {(own !== null || target.group === "mine") && (
          <div className="theme-buttons">
            {own !== null && (
              <button type="button" className="button-small" disabled={!canSave} onClick={() => save(own.id, own.name)}>
                Save changes
              </button>
            )}
            {target.group === "mine" && (
              <button type="button" className={deleting === target.id ? "button-small button-danger" : "button-small"} onClick={() => remove(target.id)}>
                {deleting === target.id ? `Delete ${target.name}` : "Delete"}
              </button>
            )}
          </div>
        )}
        <Notes notes={saveNotes} />
      </div>
      <div className="theme-buttons">
        <button type="button" className="button-small" onClick={useCyberdeck}>
          Use Cyberdeck
        </button>
      </div>
    </div>
  );
}

const HOVER_QUERY = "(hover: hover)";

const canHover = (): boolean => window.matchMedia(HOVER_QUERY).matches;

const onHoverChange = (cb: () => void): (() => void) => {
  const list = window.matchMedia(HOVER_QUERY);
  list.addEventListener("change", cb);
  return () => list.removeEventListener("change", cb);
};

export const useCanHover = (): boolean => useSyncExternalStore(onHoverChange, canHover);
