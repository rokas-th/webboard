import { notifyEach } from "../services/clock";

export type InstallProgress = { t: "downloading"; downloaded: number; total: number | null } | { t: "installing" };

export type UpdateState =
  | { k: "idle" }
  | { k: "checking" }
  | { k: "current"; at: number }
  | { k: "available"; version: string }
  | { k: "downloading"; version: string; percent: number | null }
  | { k: "installing"; version: string }
  | { k: "checkFailed"; message: string }
  | { k: "installFailed"; version: string; message: string }
  | { k: "closeFailed"; version: string; line: string }
  | { k: "restartFailed"; version: string; line: string };

export interface UpdateDeps<U extends { version: string }> {
  check(): Promise<U | null>;
  install(update: U, onProgress: (p: InstallProgress) => void): Promise<void>;
  closeRegistry(): Promise<void>;
  restart(): Promise<void>;
  report(e: unknown): void;
  now(): number;
  setTimer(cb: () => void, ms: number): () => void;
}

export interface Updates {
  state(): UpdateState;
  subscribe(cb: () => void): () => void;
  start(): void;
  stop(): void;
  check(): Promise<void>;
  install(): Promise<void>;
}

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

export const installedButNotSaved = (version: string, message: string): string =>
  `WebBoard ${version} is installed, but WebBoard could not save everything before restarting: ${message} Close the window again to quit, then start WebBoard.`;

export const restartFailedLine = (version: string, message: string): string =>
  `WebBoard ${version} is installed and everything is saved, but WebBoard could not restart: ${message} Quit WebBoard and start it again.`;

export function updateMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

const BUSY: ReadonlySet<UpdateState["k"]> = new Set(["checking", "downloading", "installing", "closeFailed", "restartFailed"]);

const KNOWN: ReadonlySet<UpdateState["k"]> = new Set(["available", "installFailed"]);

export function createUpdates<U extends { version: string }>(deps: UpdateDeps<U>): Updates {
  let state: UpdateState = { k: "idle" };
  let found: U | null = null;
  let installing = false;
  let cancelTimer: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const set = (next: UpdateState): void => {
    state = next;
    notifyEach(listeners);
  };

  const check = async (): Promise<void> => {
    if (installing || BUSY.has(state.k)) return;
    set({ k: "checking" });
    let update: U | null;
    try {
      update = await deps.check();
    } catch (e) {
      deps.report(e);
      set({ k: "checkFailed", message: updateMessage(e) });
      return;
    }
    found = update;
    set(update === null ? { k: "current", at: deps.now() } : { k: "available", version: update.version });
  };

  const percentOf = (downloaded: number, total: number | null): number | null =>
    total === null || total <= 0 ? null : Math.min(100, Math.floor((downloaded / total) * 100));

  const install = async (): Promise<void> => {
    const update = found;
    if (installing || update === null || (state.k !== "available" && state.k !== "installFailed")) return;
    installing = true;
    const version = update.version;
    set({ k: "downloading", version, percent: null });
    try {
      await deps.install(update, (p) => {
        set(p.t === "installing" ? { k: "installing", version } : { k: "downloading", version, percent: percentOf(p.downloaded, p.total) });
      });
    } catch (e) {
      installing = false;
      deps.report(e);
      set({ k: "installFailed", version, message: updateMessage(e) });
      return;
    }
    try {
      await deps.closeRegistry();
    } catch (e) {
      deps.report(e);
      set({ k: "closeFailed", version, line: installedButNotSaved(version, updateMessage(e)) });
      return;
    }
    try {
      await deps.restart();
    } catch (e) {
      deps.report(e);
      set({ k: "restartFailed", version, line: restartFailedLine(version, updateMessage(e)) });
    }
  };

  return {
    state: () => state,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    start: () => {
      if (cancelTimer !== null) throw new Error("Updates: start() while it runs");
      cancelTimer = deps.setTimer(() => {
        if (!KNOWN.has(state.k)) void check();
      }, CHECK_EVERY_MS);
      void check();
    },
    stop: () => {
      cancelTimer?.();
      cancelTimer = null;
    },
    check,
    install,
  };
}
