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
