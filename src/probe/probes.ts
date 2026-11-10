import { AppError, call, callBytes, callName } from "../services/ipc";
import { unframe } from "../store/file";

export type ProbeData = Record<string, unknown>;
export type ProbeEntry = readonly [name: string, data: ProbeData];

export const PROBE_DOC = "probe";
export const PROBE_BYTES = Uint8Array.from({ length: 16 }, (_, i) => i);
export const PROBE_REGION = { src: "openholidays", country: "CH", subdivision: "CH-ZH" } as const;
export const PROBE_YEAR = 2027;

export function probeLine(name: string, data: ProbeData): string {
  return `${name} ${JSON.stringify(data)}`;
}

export async function sendLine(line: string): Promise<void> {
  await call<null>("probe_log", { line });
}

export function failure(e: unknown): ProbeData {
  if (e instanceof AppError) return { error: e.code, message: e.message };
  return { thrown: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
}

function lastSeqOf(load: Uint8Array): number {
  if (load.length < 13) throw new AppError("ipc.shape", `store_load ${PROBE_DOC}: ${load.length} bytes is shorter than the 13-byte header`);
  const seq = new DataView(load.buffer, load.byteOffset, load.byteLength).getBigUint64(1, true);
  if (seq > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError("ipc.shape", `store_load ${PROBE_DOC}: last seq ${seq} is too large`);
  return Number(seq);
}

export async function probePaths(): Promise<ProbeEntry> {
  try {
    const seq = lastSeqOf(await callBytes("store_load", { doc: PROBE_DOC })) + 1;
    await call<null>("store_append", PROBE_BYTES, { headers: { "x-doc": PROBE_DOC, "x-seq": String(seq) } });
    const docs = await call<string[]>("store_list");
    return ["paths", { appended: seq, docs, listed: docs.includes(PROBE_DOC) }];
  } catch (e) {
    return ["paths", failure(e)];
  }
}

interface YearAnswer {
  days: readonly { date: string }[];
  fromCache: boolean;
}

export async function probeHolidays(): Promise<ProbeEntry> {
  try {
    const answer = await call<YearAnswer>("holidays_year", { region: PROBE_REGION, year: PROBE_YEAR, fresh: false });
    return ["holidays", { days: answer.days.length, fromCache: answer.fromCache, first: answer.days[0]?.date ?? null }];
  } catch (e) {
    return ["holidays", failure(e)];
  }
}

export async function probeSave(): Promise<ProbeEntry> {
  try {
    const name = await callName("plan_export", PROBE_BYTES, { headers: { "x-name": PROBE_DOC } });
    return ["files", { saved: name }];
  } catch (e) {
    return ["files", failure(e)];
  }
}

export async function probeOpen(): Promise<ProbeEntry> {
  try {
    const answer = await callBytes("plan_import");
    if (answer.length === 0) return ["files", { opened: null }];
    const { name, bytes } = unframe(answer);
    return ["files", { opened: name, read: bytes.length }];
  } catch (e) {
    return ["files", failure(e)];
  }
}

export function keyData(e: KeyboardEvent): ProbeData {
  const target = e.target instanceof HTMLElement ? e.target.tagName.toLowerCase() : "window";
  return { key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, target };
}

export function insetsOf(el: HTMLElement): { top: string; right: string; bottom: string; left: string } {
  const s = getComputedStyle(el);
  return { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft };
}

export function windowData(on: string, insetEl: HTMLElement): ProbeData {
  const vv = window.visualViewport ?? null;
  return {
    on,
    inner: [window.innerWidth, window.innerHeight],
    screen: [window.screen.width, window.screen.height],
    visual: vv === null ? null : [Math.round(vv.width), Math.round(vv.height), vv.scale],
    orientation: window.screen.orientation?.type ?? null,
    insets: insetsOf(insetEl),
  };
}
