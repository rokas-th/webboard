import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { detailsOf, messageOf } from "../ui/common/errorText";
import { toast } from "../ui/common/Toast";
import { applyTokens, paintNative } from "./apply";
import { derive, type Scheme, type Seeds } from "./derive";
import { DEFAULT_ID, tokensOf, type Theme } from "./presets";
import {
  THEME_BACKUP_KEY,
  THEME_UNREADABLE,
  resetSlots,
  saveStore,
  shownTheme,
  themeById,
  withChosen,
  withMode,
  withRemoved,
  withSaved,
  withSlot,
  type Mode,
  type ThemeStore,
} from "./store";

export const DISCARDED = "Unsaved colours discarded.";

export interface Draft {
  seeds: Seeds;
  base: string | null;
}

export interface ThemeApi {
  store: ThemeStore;
  shown: Theme;
  systemDark: boolean;
  draft: Draft | null;
  setDraft(d: Draft | null): void;
  preview(id: string | null): void;
  choose(id: string): void;
  setMode(m: Mode): void;
  setSlot(scheme: Scheme, id: string): void;
  save(name: string, seeds: Seeds, replace: string | null): { id: string; reset: readonly Scheme[] };
  remove(id: string): readonly Scheme[];
  useCyberdeck(): void;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<ThemeApi | null>(null);

export function ThemeProvider(p: { storage: Storage; initial: { store: ThemeStore; unreadable: string | null }; children: ReactNode }) {
  const { storage, initial } = p;
  const [store, setStore] = useState<ThemeStore>(initial.store);
  const current = useRef<ThemeStore>(initial.store);
  const [systemDark, setSystemDark] = useState<boolean>(() => window.matchMedia(DARK_QUERY).matches);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [previewed, setPreviewed] = useState<Theme | null>(null);
  const told = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    setSystemDark(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (initial.unreadable === null || told.current) return;
    told.current = true;
    toast(THEME_UNREADABLE, "bad", `${initial.unreadable}. The unreadable settings are kept in local storage under ${THEME_BACKUP_KEY}.`);
  }, [initial.unreadable]);

  const shown = useMemo(() => shownTheme(store, systemDark), [store, systemDark]);
  const tokens = useMemo(() => (draft !== null ? derive(draft.seeds) : tokensOf(previewed ?? shown)), [draft, previewed, shown]);

  useLayoutEffect(() => {
    applyTokens(document.documentElement, tokens);
  }, [tokens]);

  const commit = useCallback(
    (next: ThemeStore): void => {
      saveStore(storage, next);
      current.current = next;
      setStore(next);
    },
    [storage],
  );

  const api = useMemo<ThemeApi>(
    () => ({
      store,
      shown,
      systemDark,
      draft,
      setDraft,
      preview: (id) => setPreviewed(id === null ? null : themeById(current.current, id)),
      choose: (id) => commit(withChosen(current.current, id)),
      setMode: (m) => commit(withMode(current.current, m)),
      setSlot: (scheme, id) => commit(withSlot(current.current, scheme, id)),
      save: (name, seeds, replace) => {
        const before = current.current;
        const r = withSaved(before, name, seeds, replace);
        commit(r.store);
        return { id: r.id, reset: resetSlots(before, r.store) };
      },
      remove: (id) => {
        const before = current.current;
        const next = withRemoved(before, id);
        commit(next);
        return resetSlots(before, next);
      },
      useCyberdeck: () => {
        commit(withChosen(withMode(current.current, "fixed"), DEFAULT_ID));
        if (draft !== null) {
          setDraft(null);
          toast(DISCARDED);
        }
        setPreviewed(null);
      },
    }),
    [store, shown, systemDark, draft, commit],
  );

  return <ThemeContext.Provider value={api}>{p.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  const api = useContext(ThemeContext);
  if (api === null) throw new Error("useTheme needs a ThemeProvider");
  return api;
}

export function useNativeBackground(platform: "macos" | "linux" | "ios"): void {
  const ground = tokensOf(useTheme().shown).void;
  const failing = useRef(false);
  useEffect(() => {
    if (platform === "ios") return;
    paintNative(ground).then(
      () => {
        failing.current = false;
      },
      (e: unknown) => {
        console.error(e);
        if (failing.current) return;
        failing.current = true;
        toast(`Window colour could not be set: ${messageOf(e)}`, "bad", detailsOf(e));
      },
    );
  }, [platform, ground]);
}
