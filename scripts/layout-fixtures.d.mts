export function buildFixtures(): Record<string, { docs: Record<string, Uint8Array>; ipc: Record<string, unknown>; newDocs?: boolean }>;
export function encodeTuple(a: { dev: string; ses: string; at: number; par: readonly string[]; lbl: string; w: readonly { u: string; v: unknown; c: string }[]; meta?: Readonly<Record<string, string>> }): unknown[];
export function orderKey(n: number): string;
export const LONG_NAMES: readonly string[];
export const OUT_OF_RANGE: { code: string; message: string };
export const UNREADABLE_ID: string;
export const UNREADABLE_LINE: string;
export const UPDATE_VERSION: string;
export const UPDATE_CHECK_FAILED: string;
