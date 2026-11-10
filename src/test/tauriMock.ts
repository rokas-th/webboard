import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";

export interface Call {
  cmd: string;
  args: InvokeArgs | undefined;
  options: InvokeOptions | undefined;
}

export type Answer = (args: InvokeArgs | undefined, options?: InvokeOptions) => unknown;

export const offeredSettings = (): { v: 1; lastRegion: null; names: Record<string, string>; exampleOffered: true } => ({
  v: 1,
  lastRegion: null,
  names: {},
  exampleOffered: true,
});

export const DEFAULT_ANSWERS: Readonly<Record<string, Answer>> = {
  sync_status: () => ({ space: null, revoked: false }),
};

export const tauri = {
  calls: [] as Call[],
  answers: { ...DEFAULT_ANSWERS } as Record<string, Answer>,
};

interface Held {
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(e: { code: string; message: string }): void;
}

const holds = new Map<string, Held>();

export function invoke(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<unknown> {
  tauri.calls.push({ cmd, args, options });
  const held = holds.get(cmd);
  if (held !== undefined) {
    holds.delete(cmd);
    return held.promise;
  }
  const answer = tauri.answers[cmd];
  if (answer === undefined) {
    return Promise.reject(new Error(`no fixture answers ${cmd}`));
  }
  try {
    return Promise.resolve(answer(args, options));
  } catch (e) {
    return Promise.reject(e);
  }
}

export function hold(cmd: string): {
  resolve(value: unknown): void;
  reject(e: { code: string; message: string }): void;
} {
  if (holds.has(cmd)) throw new Error(`hold(${cmd}) is already pending`);
  let resolve!: (value: unknown) => void;
  let reject!: (e: { code: string; message: string }) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  holds.set(cmd, { promise, resolve, reject });
  return { resolve, reject };
}

type EventHandler = (event: { payload: never }) => void;

const subscriptions = new Map<string, Set<EventHandler>>();

export function listen(name: string, handler: EventHandler): Promise<() => void> {
  let open = subscriptions.get(name);
  if (open === undefined) {
    open = new Set();
    subscriptions.set(name, open);
  }
  open.add(handler);
  return Promise.resolve(() => {
    open.delete(handler);
  });
}

export function emitFromRust(name: string, payload: unknown): void {
  const open = subscriptions.get(name);
  if (open === undefined) return;
  for (const handler of [...open]) handler({ payload } as { payload: never });
}

export function listenerCount(name: string): number {
  return subscriptions.get(name)?.size ?? 0;
}

type CloseHandler = (event: { preventDefault(): void }) => void | Promise<void>;

const closeHandlers = new Set<CloseHandler>();

export const windowState: { destroyed: number; destroyFailure: Error | null } = { destroyed: 0, destroyFailure: null };

function destroy(): Promise<void> {
  if (windowState.destroyFailure !== null) return Promise.reject(windowState.destroyFailure);
  windowState.destroyed += 1;
  return Promise.resolve();
}

export function getCurrentWindow() {
  return {
    startDragging: () => Promise.resolve(),
    startResizeDragging: () => Promise.resolve(),
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    destroy,
    onCloseRequested: (handler: CloseHandler): Promise<() => void> => {
      closeHandlers.add(handler);
      return Promise.resolve(() => {
        closeHandlers.delete(handler);
      });
    },
  };
}

export function closeListenerCount(): number {
  return closeHandlers.size;
}

export async function requestWindowClose(): Promise<{ prevented: boolean }> {
  const results = await Promise.all(
    [...closeHandlers].map(async (handler) => {
      let prevented = false;
      await handler({
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) await destroy();
      return prevented;
    }),
  );
  return { prevented: results.some((p) => p) };
}

export function resetTauri(answers: Record<string, Answer>): void {
  subscriptions.clear();
  closeHandlers.clear();
  windowState.destroyed = 0;
  windowState.destroyFailure = null;
  holds.clear();
  tauri.calls.length = 0;
  for (const k of Object.keys(tauri.answers)) delete tauri.answers[k];
  Object.assign(tauri.answers, DEFAULT_ANSWERS, answers);
}

export function commandsSince(from: number): string[] {
  return tauri.calls.slice(from).map((c) => c.cmd);
}

function recordArgs(a: InvokeArgs | undefined): Record<string, unknown> | undefined {
  if (a === undefined || a instanceof Uint8Array || a instanceof ArrayBuffer || Array.isArray(a)) return undefined;
  return a as Record<string, unknown>;
}

export function commandsWith(from: number, cmd: string, args: Record<string, unknown>): number {
  return tauri.calls
    .slice(from)
    .filter((c) => c.cmd === cmd && Object.entries(args).every(([k, v]) => recordArgs(c.args)?.[k] === v)).length;
}
