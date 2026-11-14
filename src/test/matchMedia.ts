const DARK_QUERY = "(prefers-color-scheme: dark)";
const COARSE_QUERY = "(pointer: coarse)";
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

type Listener = (e: MediaQueryListEvent) => void;

const listeners = new Map<string, Set<Listener>>([
  [DARK_QUERY, new Set<Listener>()],
  [COARSE_QUERY, new Set<Listener>()],
  [REDUCED_QUERY, new Set<Listener>()],
]);
let dark = true;
let coarse = false;
let reduced = false;

const listenersOf = (query: string): Set<Listener> | undefined => listeners.get(query);

const event = (query: string, matches: boolean): MediaQueryListEvent => {
  const e = new Event("change");
  Object.defineProperty(e, "matches", { value: matches });
  Object.defineProperty(e, "media", { value: query });
  return e as MediaQueryListEvent;
};

const tell = (query: string, matches: boolean): void => {
  [...(listenersOf(query) ?? [])].forEach((cb) => cb(event(query, matches)));
};

const list = (query: string): MediaQueryList => {
  const live = listenersOf(query);
  const mql = {
    get matches() {
      if (query === COARSE_QUERY) return coarse;
      if (query === REDUCED_QUERY) return reduced;
      return query === DARK_QUERY ? dark : false;
    },
    media: query,
    onchange: null,
    addEventListener: (type: string, cb: Listener) => {
      if (type === "change") live?.add(cb);
    },
    removeEventListener: (type: string, cb: Listener) => {
      if (type === "change") live?.delete(cb);
    },
    addListener: (cb: Listener) => {
      live?.add(cb);
    },
    removeListener: (cb: Listener) => {
      live?.delete(cb);
    },
    dispatchEvent: () => true,
  };
  return mql as unknown as MediaQueryList;
};

export function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: list });
}

export function setSystemDark(next: boolean): void {
  dark = next;
  tell(DARK_QUERY, next);
}

export function setSystemDarkSilently(next: boolean): void {
  dark = next;
}

export function resetMediaQueries(): void {
  dark = true;
  coarse = false;
  reduced = false;
}

export function setCoarsePointer(next: boolean): void {
  coarse = next;
  tell(COARSE_QUERY, next);
}

export function setReducedMotion(next: boolean): void {
  reduced = next;
  tell(REDUCED_QUERY, next);
}

export const darkListenerCount = (): number => listenersOf(DARK_QUERY)?.size ?? 0;
