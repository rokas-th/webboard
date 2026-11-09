import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

export class AppError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

function commandError(e: unknown): e is { code: string; message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string" &&
    typeof (e as { message?: unknown }).message === "string"
  );
}

export async function call<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await invoke<T>(cmd, args, options);
  } catch (e) {
    if (commandError(e)) throw new AppError(e.code, e.message);
    throw new AppError("ipc.failed", `${cmd}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const shapeOf = (x: unknown): string => (x === null ? "null" : Array.isArray(x) ? "an array" : x instanceof Uint8Array ? "a Uint8Array" : typeof x);

export async function callBytes(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<Uint8Array> {
  const out = await call<unknown>(cmd, args, options);
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  throw new AppError("ipc.shape", `${cmd} answered ${shapeOf(out)} instead of raw bytes`);
}
