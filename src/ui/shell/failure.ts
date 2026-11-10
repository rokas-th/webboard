import type { AppError } from "../../services/ipc";

export interface FailureActions {
  action: "retry" | "trash" | "reload" | null;
  filesStay: boolean;
}

export function failureActions(error: AppError, space: string | null, spaceReadOnly: boolean): FailureActions {
  if (error.code !== "store.corrupt") return { action: "retry", filesStay: false };
  if (space === null) return { action: "trash", filesStay: true };
  return spaceReadOnly ? { action: null, filesStay: true } : { action: "reload", filesStay: false };
}
