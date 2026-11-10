import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import type { Answer } from "../tauriMock";

export function encodeLoad(l: { torn?: boolean; snapshot?: Uint8Array; records?: readonly Uint8Array[]; lastSeq: number }): ArrayBuffer {
  const entries = [l.snapshot ?? new Uint8Array(), ...(l.records ?? [])];
  const out = new ArrayBuffer(13 + entries.reduce((n, e) => n + 4 + e.length, 0));
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint8(0, l.torn === true ? 1 : 0);
  view.setBigUint64(1, BigInt(l.lastSeq), true);
  view.setUint32(9, entries.length, true);
  entries.reduce((at, e) => {
    view.setUint32(at, e.length, true);
    bytes.set(e, at + 4);
    return at + 4 + e.length;
  }, 13);
  return out;
}

export interface MemoryDoc {
  snapshot: Uint8Array;
  snapshotSeq: number;
  records: [number, Uint8Array][];
}

type FailingCmd = "store_load" | "store_append" | "store_compact" | "store_set_aside" | "store_delete";

export interface MemoryStore {
  answers: Record<string, Answer>;
  docs: Map<string, MemoryDoc>;
  fail(cmd: FailingCmd, doc: string, e: { code: string; message: string }): void;
  recover(cmd: string, doc: string): void;
  seed(doc: string, update: Uint8Array): void;
}

const lastSeqOf = (d: MemoryDoc): number => d.records.length > 0 ? d.records[d.records.length - 1][0] : d.snapshotSeq;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function docArg(args: InvokeArgs | undefined): string {
  const doc = args !== undefined && !(args instanceof Uint8Array) && !(args instanceof ArrayBuffer) && !Array.isArray(args) ? args.doc : undefined;
  if (typeof doc !== "string") throw new Error(`memoryStore: expected { doc }, got ${String(args)}`);
  return doc;
}

function bodyArg(cmd: string, args: InvokeArgs | undefined): Uint8Array {
  if (!(args instanceof Uint8Array)) throw { code: "store.io", message: `${cmd} expects raw bytes` };
  return args.slice();
}

function headersOf(options: InvokeOptions | undefined): { doc: string; seq: number } {
  const headers = new Headers(options?.headers);
  const doc = headers.get("x-doc");
  if (doc === null) throw { code: "store.io", message: "missing x-doc header" };
  const raw = headers.get("x-seq");
  if (raw === null) throw { code: "store.seq", message: "missing x-seq header" };
  if (!/^\d+$/.test(raw)) throw { code: "store.seq", message: `x-seq is not a number: ${raw}` };
  return { doc, seq: Number(raw) };
}

export function memoryStore(): MemoryStore {
  const docs = new Map<string, MemoryDoc>();
  const failures = new Map<string, { code: string; message: string }>();
  const check = (cmd: string, doc: string): void => {
    const e = failures.get(`${cmd} ${doc}`);
    if (e !== undefined) throw { ...e };
  };
  const docOf = (id: string): MemoryDoc => {
    const found = docs.get(id);
    if (found !== undefined) return found;
    const made: MemoryDoc = { snapshot: new Uint8Array(), snapshotSeq: 0, records: [] };
    docs.set(id, made);
    return made;
  };
  const answers: Record<string, Answer> = {
    store_load: (args) => {
      const id = docArg(args);
      check("store_load", id);
      const d = docOf(id);
      return encodeLoad({ snapshot: d.snapshot, records: d.records.map(([, r]) => r), lastSeq: lastSeqOf(d) });
    },
    store_append: (args, options) => {
      const bytes = bodyArg("store_append", args);
      const { doc, seq } = headersOf(options);
      check("store_append", doc);
      const d = docOf(doc);
      const last = lastSeqOf(d);
      const tail = d.records.length > 0 ? d.records[d.records.length - 1] : undefined;
      if (tail !== undefined && tail[0] === seq && sameBytes(tail[1], bytes)) return null;
      if (seq <= last) throw { code: "store.seq", message: `seq ${seq} is not after ${last}` };
      if (last === 0 && seq > 1) throw { code: "store.seq", message: `seq ${seq} into an empty document` };
      d.records.push([seq, bytes]);
      return null;
    },
    store_compact: (args, options) => {
      const bytes = bodyArg("store_compact", args);
      const { doc, seq } = headersOf(options);
      check("store_compact", doc);
      const d = docOf(doc);
      const last = lastSeqOf(d);
      if (seq < d.snapshotSeq || seq > last) {
        throw { code: "store.seq", message: `compact seq ${seq} is not between ${d.snapshotSeq} and ${last}` };
      }
      d.snapshot = bytes;
      d.snapshotSeq = seq;
      d.records = d.records.filter(([s]) => s > seq);
      return null;
    },
    store_list: () => [...docs.keys()],
    store_set_aside: (args) => {
      const id = docArg(args);
      check("store_set_aside", id);
      if (!docs.delete(id)) throw { code: "store.io", message: `no document ${id}` };
      return null;
    },
    store_delete: (args) => {
      const id = docArg(args);
      check("store_delete", id);
      docs.delete(id);
      return null;
    },
  };
  return {
    answers,
    docs,
    fail: (cmd, doc, e) => {
      failures.set(`${cmd} ${doc}`, e);
    },
    recover: (cmd, doc) => {
      failures.delete(`${cmd} ${doc}`);
    },
    seed: (doc, update) => {
      const d = docOf(doc);
      d.records.push([lastSeqOf(d) + 1, update.slice()]);
    },
  };
}
