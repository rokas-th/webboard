import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import { readPlatform } from "../platform";

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

const UIKIT_COMMANDS: readonly (readonly [cmd: string, key: string, allowed: readonly string[]])[] = [
  ["appearance_set", "scheme", ["light", "dark", "system"]],
  ["haptic", "kind", ["selection", "light", "medium", "success", "warning", "error"]],
];

const refusals: string[] = [];

export const takeRefusals = (): string[] => refusals.splice(0);

const refuse = (text: string): never => {
  refusals.push(text);
  throw new Error(text);
};

const argOf = (args: InvokeArgs | undefined, key: string): unknown =>
  args !== undefined && !(args instanceof Uint8Array) && !(args instanceof ArrayBuffer) && !Array.isArray(args) ? args[key] : undefined;

const iosOnly =
  (cmd: string, key: string, allowed: readonly string[]): Answer =>
  (args) => {
    const { os } = readPlatform(window);
    if (os !== "ios") return refuse(`${cmd} was called on ${os}, where only iOS has it`);
    const value = argOf(args, key);
    if (typeof value !== "string" || !allowed.includes(value)) return refuse(`${cmd} got ${JSON.stringify(args)}, not a ${key} of ${allowed.join(", ")}`);
    return null;
  };

const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

const exactly = (x: unknown, keys: readonly string[]): x is Record<string, unknown> =>
  record(x) && Object.keys(x).length === keys.length && keys.every((k) => k in x);

const filled = (x: unknown): boolean => typeof x === "string" && x.trim() !== "";

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

const goodAnchor = (a: unknown): boolean =>
  exactly(a, ["x", "y", "width", "height"]) && finite(a.x) && finite(a.y) && finite(a.width) && finite(a.height) && a.width >= 0 && a.height >= 0;

const goodRow = (r: unknown): r is { id: string } => exactly(r, ["id", "title", "checked"]) && filled(r.id) && filled(r.title) && typeof r.checked === "boolean";

const rowsOf = (s: unknown): readonly unknown[] | null =>
  exactly(s, ["title", "rows"]) && (s.title === null || filled(s.title)) && Array.isArray(s.rows) && s.rows.length > 0 ? s.rows : null;

function goodMenu(m: unknown): boolean {
  if (!exactly(m, ["token", "anchor", "sections"]) || !filled(m.token) || !goodAnchor(m.anchor) || !Array.isArray(m.sections) || m.sections.length === 0) return false;
  const rows = m.sections.map(rowsOf);
  if (rows.some((r) => r === null)) return false;
  const all = rows.flatMap((r) => r ?? []);
  if (!all.every(goodRow)) return false;
  const ids = all.filter(goodRow).map((r) => r.id);
  return new Set(ids).size === ids.length;
}

const iosShaped =
  (cmd: string, key: string, good: (value: unknown) => boolean, shape: string): Answer =>
  (args) => {
    const { os } = readPlatform(window);
    if (os !== "ios") return refuse(`${cmd} was called on ${os}, where only iOS has it`);
    if (!good(argOf(args, key))) return refuse(`${cmd} got ${JSON.stringify(args)}, not a ${key} that is ${shape}`);
    return null;
  };

export const DEFAULT_ANSWERS: Readonly<Record<string, Answer>> = {
  sync_status: () => ({ space: null, revoked: false }),
  ...Object.fromEntries(UIKIT_COMMANDS.map(([cmd, key, allowed]) => [cmd, iosOnly(cmd, key, allowed)])),
  menu_show: iosShaped("menu_show", "menu", goodMenu, "a menu menu.rs accepts"),
  menu_dismiss: iosShaped("menu_dismiss", "token", filled, "a non-empty string"),
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

const listenFailures = new Map<string, unknown>();

export function failNextListen(name: string, e: unknown): void {
  listenFailures.set(name, e);
}

export function listen(name: string, handler: EventHandler): Promise<() => void> {
  if (listenFailures.has(name)) {
    const e = listenFailures.get(name);
    listenFailures.delete(name);
    return Promise.reject(e);
  }
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
  listenFailures.clear();
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
