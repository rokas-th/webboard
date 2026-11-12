import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "../ui/common/Toast";
import { applyTokens, paintNative } from "./apply";
import { derive, type Scheme, type Seeds } from "./derive";
import { DEFAULT_ID, tokensOf, type Theme } from "./presets";
import {
  THEME_UNREADABLE,
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

export interface ThemeApi {
  store: ThemeStore;
  shown: Theme;
  systemDark: boolean;
  draft: Seeds | null;
  setDraft(s: Seeds | null): void;
  preview(id: string | null): void;
  choose(id: string): void;
  setMode(m: Mode): void;
  setSlot(scheme: Scheme, id: string): void;
  save(name: string, seeds: Seeds, replace: string | null): string;
  remove(id: string): void;
  useCyberdeck(): void;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<ThemeApi | null>(null);

export function ThemeProvider(p: { storage: Storage; initial: { store: ThemeStore; unreadable: boolean }; children: ReactNode }) {
  const { storage, initial } = p;
  const [store, setStore] = useState<ThemeStore>(initial.store);
  const current = useRef<ThemeStore>(initial.store);
  const [systemDark, setSystemDark] = useState<boolean>(() => window.matchMedia(DARK_QUERY).matches);
  const [draft, setDraft] = useState<Seeds | null>(null);
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
    if (!initial.unreadable || told.current) return;
    told.current = true;
    toast(THEME_UNREADABLE, "bad");
  }, [initial.unreadable]);

  const shown = useMemo(() => shownTheme(store, systemDark), [store, systemDark]);
  const tokens = useMemo(() => (draft !== null ? derive(draft) : tokensOf(previewed ?? shown)), [draft, previewed, shown]);

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
        const r = withSaved(current.current, name, seeds, replace);
        commit(r.store);
        return r.id;
      },
      remove: (id) => commit(withRemoved(current.current, id)),
      useCyberdeck: () => {
        commit(withChosen(withMode(current.current, "fixed"), DEFAULT_ID));
        setDraft(null);
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
  useEffect(() => {
    if (platform === "ios") return;
    paintNative(ground).catch((e: unknown) => toast(`Window colour could not be set: ${e instanceof Error ? e.message : String(e)}`, "bad"));
  }, [platform, ground]);
}
