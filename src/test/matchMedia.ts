const DARK_QUERY = "(prefers-color-scheme: dark)";

type Listener = (e: MediaQueryListEvent) => void;

const listeners = new Set<Listener>();
let dark = true;

const event = (matches: boolean): MediaQueryListEvent => {
  const e = new Event("change");
  Object.defineProperty(e, "matches", { value: matches });
  Object.defineProperty(e, "media", { value: DARK_QUERY });
  return e as MediaQueryListEvent;
};

const list = (query: string): MediaQueryList => {
  const live = query === DARK_QUERY;
  const mql = {
    get matches() {
      return live ? dark : false;
    },
    media: query,
    onchange: null,
    addEventListener: (type: string, cb: Listener) => {
      if (live && type === "change") listeners.add(cb);
    },
    removeEventListener: (type: string, cb: Listener) => {
      if (live && type === "change") listeners.delete(cb);
    },
    addListener: (cb: Listener) => {
      if (live) listeners.add(cb);
    },
    removeListener: (cb: Listener) => {
      if (live) listeners.delete(cb);
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
  [...listeners].forEach((cb) => cb(event(next)));
}

export function resetSystemDark(): void {
  dark = true;
}

export const darkListenerCount = (): number => listeners.size;
