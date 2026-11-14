import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

export class AppError extends Error {
  readonly code: string;
  readonly cause: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.cause = cause;
  }
}

function commandError(e: unknown): e is { code: string; message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof e.code === "string" &&
    "message" in e &&
    typeof e.message === "string"
  );
}

const kindOf = (x: unknown): string => (typeof x === "object" ? "an object" : `a ${typeof x}`);

const printed = (x: unknown): string => {
  try {
    return String(x);
  } catch {
    return `${kindOf(x)} that cannot be printed`;
  }
};

export async function call<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await invoke<T>(cmd, args, options);
  } catch (e) {
    if (commandError(e)) throw new AppError(e.code, e.message);
    throw new AppError("ipc.failed", `${cmd}: ${e instanceof Error ? e.message : printed(e)}`);
  }
}

const shapeOf = (x: unknown): string => (x === null ? "null" : Array.isArray(x) ? "an array" : x instanceof Uint8Array ? "a Uint8Array" : typeof x);

export async function callBytes(cmd: string, args?: InvokeArgs): Promise<Uint8Array> {
  const out = await call<unknown>(cmd, args);
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  throw new AppError("ipc.shape", `${cmd} answered ${shapeOf(out)} instead of raw bytes`);
}

export async function callName(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<string | null> {
  const out = await call<unknown>(cmd, args, options);
  if (out === null || (typeof out === "string" && out !== "")) return out;
  throw new AppError("ipc.shape", `${cmd} answered ${out === "" ? "an empty string" : shapeOf(out)} instead of a file name or null`);
}

export const answerOf = (x: unknown): string => {
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return `${kindOf(x)} JSON cannot show`;
  }
};

export async function callNull(cmd: string, args?: InvokeArgs): Promise<void> {
  const out = await call<unknown>(cmd, args);
  if (out !== null) throw new AppError("ipc.shape", `${cmd} answered ${answerOf(out)} instead of null`);
}

export interface SpaceInfo {
  server: string;
  spaceId: string;
  deviceId: string;
  deviceName: string;
}

export interface SyncStatus {
  space: SpaceInfo | null;
  revoked: boolean;
}

export interface PairCode {
  code: string;
  expiresAt: number;
}

export interface Ticket {
  ticket: string;
  expiresAt: number;
}

export interface DeviceEntry {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export const syncSetup = (server: string, secret: string, deviceName: string): Promise<SpaceInfo> =>
  call<SpaceInfo>("sync_setup", { server, secret, deviceName });

export const syncPairJoin = (server: string, code: string, deviceName: string): Promise<SpaceInfo> =>
  call<SpaceInfo>("sync_pair_join", { server, code, deviceName });

export const syncPairCode = (): Promise<PairCode> => call<PairCode>("sync_pair_code");

export const syncTicket = (doc: string): Promise<Ticket> => call<Ticket>("sync_ticket", { doc });

export const syncDevices = (): Promise<DeviceEntry[]> => call<DeviceEntry[]>("sync_devices");

export async function syncRemoveDevice(id: string): Promise<void> {
  await call<null>("sync_remove_device", { id });
}

export const syncStatus = (): Promise<SyncStatus> => call<SyncStatus>("sync_status");

export async function syncMarkRevoked(): Promise<void> {
  await call<null>("sync_mark_revoked");
}

export async function syncReset(): Promise<void> {
  await call<null>("sync_reset");
}

export async function syncPurgePlan(doc: string): Promise<void> {
  await call<null>("sync_purge_plan", { doc });
}

export async function storeDelete(doc: string): Promise<void> {
  await call<null>("store_delete", { doc });
}
