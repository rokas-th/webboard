import * as Y from "yjs";
import { AppError, call, callBytes } from "../services/ipc";

export const COMPACT_EVERY_MS = 60_000,
  COMPACT_AFTER_BYTES = 1_048_576;

export interface PersistedDoc {
  readonly id: string;
  readonly ydoc: Y.Doc;
  readonly repairedTornTail: boolean;
  error(): AppError | null;
  onError(cb: (e: AppError) => void): () => void;
  retry(): Promise<void>;
  flush(): Promise<void>;
  compact(): Promise<void>;
  close(): Promise<void>;
}

const LOAD_ORIGIN: unique symbol = Symbol("LOAD_ORIGIN");

interface Load {
  torn: boolean;
  lastSeq: number;
  snapshot: Uint8Array;
  records: Uint8Array[];
}

function decodeLoad(id: string, bytes: Uint8Array): Load {
  const bad = (what: string): AppError => new AppError("ipc.shape", `store_load ${id}: ${what}`);
  if (bytes.length < 13) throw bad(`${bytes.length} bytes is shorter than the 13-byte header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(0);
  if ((flags & ~1) !== 0) throw bad(`unknown flags ${flags}`);
  const seq = view.getBigUint64(1, true);
  if (seq > BigInt(Number.MAX_SAFE_INTEGER)) throw bad(`last seq ${seq} is too large`);
  const count = view.getUint32(9, true);
  if (count < 1) throw bad("no snapshot entry");
  if (count * 4 > bytes.length - 13) throw bad(`count ${count} does not fit in ${bytes.length - 13} bytes`);
  const { entries, end } = Array.from({ length: count }).reduce<{ entries: Uint8Array[]; end: number }>(
    (acc, _, i) => {
      if (acc.end + 4 > bytes.length) throw bad(`entry ${i} of ${count} is cut short`);
      const len = view.getUint32(acc.end, true);
      const start = acc.end + 4;
      if (start + len > bytes.length) throw bad(`entry ${i} of ${count} is cut short`);
      acc.entries.push(bytes.subarray(start, start + len));
      return { entries: acc.entries, end: start + len };
    },
    { entries: [], end: 13 },
  );
  if (end !== bytes.length) throw bad(`${bytes.length - end} bytes after the last entry`);
  const [snapshot, ...records] = entries;
  return { torn: (flags & 1) === 1, lastSeq: Number(seq), snapshot, records };
}

function rebuild(id: string, load: Load): Y.Doc {
  const ydoc = new Y.Doc();
  const updates = load.snapshot.length > 0 ? [load.snapshot, ...load.records] : load.records;
  try {
    ydoc.transact(() => updates.forEach((u) => Y.applyUpdate(ydoc, u, LOAD_ORIGIN)), LOAD_ORIGIN);
  } catch (e) {
    throw new AppError("store.corrupt", `${id}: a stored update could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (ydoc.store.pendingStructs !== null || ydoc.store.pendingDs !== null) {
    throw new AppError("store.corrupt", `${id}: stored updates reference missing state`);
  }
  return ydoc;
}

function listenerFailure(thrown: unknown[]): unknown {
  if (thrown.length === 1) return thrown[0];
  const first = thrown[0];
  return Object.assign(new Error(`${thrown.length} onError listeners threw; the first: ${first instanceof Error ? first.message : String(first)}`), { cause: first });
}

function raise(e: unknown): void {
  setTimeout(() => {
    throw e;
  }, 0);
}

interface Waiter {
  resolve(): void;
  reject(e: AppError): void;
}

interface Op {
  cmd: "store_append" | "store_compact";
  seq: number;
  bytes: Uint8Array;
  waiters: Waiter[];
}

export async function openPersisted(id: string): Promise<PersistedDoc> {
  const load = decodeLoad(id, await callBytes("store_load", { doc: id }));
  const ydoc = rebuild(id, load);
  const listeners = new Set<(e: AppError) => void>();
  const queue: Op[] = [];
  let lastSeq = load.lastSeq;
  let failure: AppError | null = null;
  let running = false;
  let closed = false;
  let dirty = load.records.length > 0;
  let bytesSince = load.records.reduce((n, r) => n + r.length, 0);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const halt = (e: AppError): void => {
    failure = e;
    queue.flatMap((op) => op.waiters.splice(0)).forEach((w) => w.reject(e));
    const thrown = [...listeners].flatMap((cb) => {
      try {
        cb(e);
        return [];
      } catch (x) {
        return [x];
      }
    });
    if (thrown.length > 0) throw listenerFailure(thrown);
  };

  const send = async (op: Op): Promise<AppError | null> => {
    try {
      await call<null>(op.cmd, op.bytes, { headers: { "x-doc": id, "x-seq": String(op.seq) } });
      return null;
    } catch (e) {
      return e instanceof AppError ? e : new AppError("ipc.failed", `${op.cmd}: ${String(e)}`);
    }
  };

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0 && failure === null) {
        const op = queue[0];
        const e = await send(op);
        if (e !== null) {
          halt(e);
        } else {
          queue.shift();
          op.waiters.forEach((w) => w.resolve());
        }
      }
    } finally {
      running = false;
    }
  };

  const start = (): void => {
    run().catch(raise);
  };

  const settled = (): Promise<void> => {
    if (failure !== null) return Promise.reject(failure);
    const last: Op | undefined = queue[queue.length - 1];
    if (last === undefined) return Promise.resolve();
    return new Promise<void>((resolve, reject) => last.waiters.push({ resolve, reject }));
  };

  const enqueue = (op: Omit<Op, "waiters">): void => {
    queue.push({ ...op, waiters: [] });
    start();
  };

  const enqueueCompact = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    dirty = false;
    bytesSince = 0;
    enqueue({ cmd: "store_compact", seq: lastSeq, bytes: Y.encodeStateAsUpdate(ydoc) });
  };

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === LOAD_ORIGIN) return;
    if (closed) throw new AppError("store.closed", `Document ${id} was edited after close`);
    lastSeq += 1;
    enqueue({ cmd: "store_append", seq: lastSeq, bytes: update });
    dirty = true;
    bytesSince += update.length;
    if (bytesSince >= COMPACT_AFTER_BYTES) {
      enqueueCompact();
    } else if (timer === null) {
      timer = setTimeout(enqueueCompact, COMPACT_EVERY_MS);
    }
  };
  ydoc.on("update", onUpdate);
  if (dirty) timer = setTimeout(enqueueCompact, COMPACT_EVERY_MS);

  return {
    id,
    ydoc,
    repairedTornTail: load.torn,
    error: () => failure,
    onError(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    retry() {
      failure = null;
      const done = settled();
      start();
      return done;
    },
    flush: settled,
    compact() {
      if (closed) return Promise.reject(new AppError("store.closed", `Document ${id} is closed`));
      enqueueCompact();
      return settled();
    },
    close() {
      if (closed) return settled();
      closed = true;
      if (dirty) {
        enqueueCompact();
      } else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      return settled();
    },
  };
}
