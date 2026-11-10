import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { openPersisted, COMPACT_EVERY_MS, COMPACT_AFTER_BYTES } from "./persist";
import { AppError, callBytes } from "../services/ipc";
import { resetTauri, hold, tauri, type Call } from "../test/tauriMock";
import { encodeLoad } from "../test/fixtures/store";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const headerOf = (c: Call, name: string): string | null => new Headers(c.options?.headers).get(name);

const writes = (): Call[] => tauri.calls.filter((c) => c.cmd === "store_append" || c.cmd === "store_compact");

const seqs = (cmd: string): number[] => tauri.calls.filter((c) => c.cmd === cmd).map((c) => Number(headerOf(c, "x-seq")));

function remoteUpdate(f: (d: Y.Doc) => void): Uint8Array {
  const d = new Y.Doc();
  let out: Uint8Array | null = null;
  d.on("update", (u: Uint8Array) => {
    out = u;
  });
  f(d);
  if (out === null) throw new Error("no update");
  return out;
}

function present<T>(x: T | undefined, what: string): T {
  if (x === undefined) throw new Error(`missing ${what}`);
  return x;
}

function bodyOf(c: Call): Uint8Array {
  if (!(c.args instanceof Uint8Array)) throw new Error(`${c.cmd} was not sent raw bytes`);
  return c.args;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("openPersisted", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serial appends in seq order", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 7 }), store_append: () => null });
    const p = await openPersisted("p1");
    const first = hold("store_append");
    p.ydoc.getMap("m").set("a", 1);
    Y.applyUpdate(p.ydoc, remoteUpdate((d) => d.getMap("r").set("x", 1)), "remote");
    p.ydoc.getMap("m").set("b", 2);
    await settle();
    expect(seqs("store_append")).toEqual([8]);
    const second = hold("store_append");
    first.resolve(null);
    await settle();
    expect(seqs("store_append")).toEqual([8, 9]);
    second.resolve(null);
    await p.flush();
    expect(seqs("store_append")).toEqual([8, 9, 10]);
    expect(tauri.calls.filter((c) => c.cmd === "store_append").map((c) => headerOf(c, "x-doc"))).toEqual(["p1", "p1", "p1"]);
    expect(tauri.calls.filter((c) => c.cmd === "store_append").every((c) => c.args instanceof Uint8Array)).toBe(true);
    expect(p.error()).toBeNull();
  });

  it("rebuilds from snapshot and records", async () => {
    const source = new Y.Doc();
    source.getMap("m").set("a", 1);
    const snapshot = Y.encodeStateAsUpdate(source);
    const records: Uint8Array[] = [];
    source.on("update", (u: Uint8Array) => records.push(u));
    source.getMap("m").set("b", 2);
    source.getMap("m").set("c", 3);
    resetTauri({ store_load: () => encodeLoad({ snapshot, records, lastSeq: 3 }) });
    const p = await openPersisted("p1");
    expect(p.ydoc.getMap("m").toJSON()).toEqual({ a: 1, b: 2, c: 3 });
    expect(p.id).toBe("p1");
    await p.flush();
    expect(writes()).toEqual([]);
    expect(tauri.calls[0]).toMatchObject({ cmd: "store_load", args: { doc: "p1" } });
  });

  it("reports a repaired torn tail", async () => {
    resetTauri({ store_load: () => encodeLoad({ torn: true, lastSeq: 0 }) });
    expect((await openPersisted("p1")).repairedTornTail).toBe(true);
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 0 }) });
    expect((await openPersisted("p1")).repairedTornTail).toBe(false);
  });

  it("timer compaction", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 7 }), store_append: () => null, store_compact: () => null });
    const p = await openPersisted("p1");
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS);
    expect(writes()).toEqual([]);
    p.ydoc.getMap("m").set("a", 1);
    p.ydoc.getMap("m").set("b", 2);
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS - 1);
    expect(seqs("store_compact")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seqs("store_compact")).toEqual([9]);
    const compact = present(tauri.calls.find((c) => c.cmd === "store_compact"), "store_compact call");
    expect(headerOf(compact, "x-doc")).toBe("p1");
    expect(compact.args).toEqual(Y.encodeStateAsUpdate(p.ydoc));
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS * 3);
    expect(seqs("store_compact")).toEqual([9]);
  });

  it("size compaction", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 0 }), store_append: () => null, store_compact: () => null });
    const p = await openPersisted("p1");
    const text = p.ydoc.getText("t");
    text.insert(0, "x".repeat(600_000));
    await settle();
    expect(seqs("store_compact")).toEqual([]);
    text.insert(0, "y".repeat(600_000));
    await settle();
    const sizes = tauri.calls.filter((c) => c.cmd === "store_append").map((c) => bodyOf(c).length);
    expect(sizes[0]).toBeLessThan(COMPACT_AFTER_BYTES);
    expect(sizes[0] + sizes[1]).toBeGreaterThanOrEqual(COMPACT_AFTER_BYTES);
    expect(seqs("store_compact")).toEqual([2]);
    expect(tauri.calls.map((c) => c.cmd)).toEqual(["store_load", "store_append", "store_append", "store_compact"]);
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS * 2);
    expect(seqs("store_compact")).toEqual([2]);
  });

  it("failed append halts and surfaces", async () => {
    let failing = true;
    resetTauri({
      store_load: () => encodeLoad({ lastSeq: 7 }),
      store_append: () => {
        if (failing) throw { code: "store.io", message: "disk full" };
        return null;
      },
    });
    const p = await openPersisted("p1");
    const seen: AppError[] = [];
    p.onError((e) => seen.push(e));
    p.ydoc.getMap("m").set("a", 1);
    p.ydoc.getMap("m").set("b", 2);
    await settle();
    p.ydoc.getMap("m").set("c", 3);
    await settle();
    expect(seqs("store_append")).toEqual([8]);
    expect(p.error()).toBeInstanceOf(AppError);
    expect(p.error()).toMatchObject({ code: "store.io", message: "disk full" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(p.error());
    await expect(p.flush()).rejects.toBe(p.error());
    failing = false;
    await p.retry();
    expect(seqs("store_append")).toEqual([8, 8, 9, 10]);
    expect(p.error()).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("close flushes", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 7 }), store_append: () => null, store_compact: () => null });
    const p = await openPersisted("p1");
    p.ydoc.getMap("m").set("a", 1);
    p.ydoc.getMap("m").set("b", 2);
    await p.close();
    expect(writes().map((c) => [c.cmd, Number(headerOf(c, "x-seq"))])).toEqual([
      ["store_append", 8],
      ["store_append", 9],
      ["store_compact", 9],
    ]);
    expect(tauri.calls[tauri.calls.length - 1].args).toEqual(Y.encodeStateAsUpdate(p.ydoc));
    const seen: Uint8Array[] = [];
    p.ydoc.on("update", (u: Uint8Array) => {
      seen.push(u);
    });
    const edit = (key: string, value: number): unknown => {
      try {
        p.ydoc.getMap("m").set(key, value);
        return null;
      } catch (e) {
        return e;
      }
    };
    const thrown = [edit("c", 3), edit("d", 4), edit("e", 5)];
    thrown.forEach((t) => {
      expect(t).toBeInstanceOf(AppError);
      expect(t).toMatchObject({ code: "store.closed", message: "Document p1 was edited after close" });
    });
    expect(seen).toHaveLength(3);
    expect(p.ydoc.getMap("m").toJSON()).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    await expect(p.compact()).rejects.toMatchObject({ code: "store.closed", message: "Document p1 is closed" });
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS * 2);
    expect(writes()).toHaveLength(3);
    expect(writes().filter((c) => c.cmd === "store_append")).toHaveLength(2);
  });

  it("close after a failed save tries the store once more and compacts last", async () => {
    let failing = true;
    resetTauri({
      store_load: () => encodeLoad({ lastSeq: 7 }),
      store_append: () => {
        if (failing) throw { code: "store.io", message: "disk full" };
        return null;
      },
      store_compact: () => null,
    });
    const p = await openPersisted("p1");
    const seen: AppError[] = [];
    p.onError((e) => seen.push(e));
    p.ydoc.getMap("m").set("a", 1);
    await settle();
    p.ydoc.getMap("m").set("b", 2);
    await settle();
    expect(p.error()).toMatchObject({ code: "store.io", message: "disk full" });
    failing = false;
    await p.close();
    expect(p.error()).toBeNull();
    expect(writes().map((c) => [c.cmd, Number(headerOf(c, "x-seq"))])).toEqual([
      ["store_append", 8],
      ["store_append", 8],
      ["store_append", 9],
      ["store_compact", 9],
    ]);
    expect(tauri.calls[tauri.calls.length - 1].args).toEqual(Y.encodeStateAsUpdate(p.ydoc));
    expect(seen).toHaveLength(1);
  });

  it("close after a failed save rejects with the store's new error when it fails again", async () => {
    let message = "disk full";
    resetTauri({
      store_load: () => encodeLoad({ lastSeq: 7 }),
      store_append: () => {
        throw { code: "store.io", message };
      },
      store_compact: () => null,
    });
    const p = await openPersisted("p1");
    p.ydoc.getMap("m").set("a", 1);
    await settle();
    expect(p.error()).toMatchObject({ message: "disk full" });
    message = "volume gone";
    await expect(p.close()).rejects.toMatchObject({ code: "store.io", message: "volume gone" });
    expect(p.error()).toMatchObject({ code: "store.io", message: "volume gone" });
    expect(writes().map((c) => c.cmd)).toEqual(["store_append", "store_append"]);
  });

  it("a throwing onError listener does not stop the queue", async () => {
    let failing = true;
    resetTauri({
      store_load: () => encodeLoad({ lastSeq: 7 }),
      store_append: () => {
        if (failing) throw { code: "store.io", message: "disk full" };
        return null;
      },
    });
    const p = await openPersisted("p1");
    const second: AppError[] = [];
    p.onError(() => {
      throw new Error("listener broke");
    });
    p.onError((e) => second.push(e));
    p.ydoc.getMap("m").set("a", 1);
    await expect(vi.advanceTimersByTimeAsync(0)).rejects.toThrow("listener broke");
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ code: "store.io", message: "disk full" });
    p.ydoc.getMap("m").set("b", 2);
    failing = false;
    await p.retry();
    expect(seqs("store_append")).toEqual([8, 8, 9]);
    expect(p.error()).toBeNull();
    expect(second).toHaveLength(1);
  });

  it("every onError listener runs and the throws are counted", async () => {
    resetTauri({
      store_load: () => encodeLoad({ lastSeq: 0 }),
      store_append: () => {
        throw { code: "store.io", message: "disk full" };
      },
    });
    const p = await openPersisted("p1");
    const ran: string[] = [];
    p.onError(() => {
      ran.push("one");
      throw new Error("first broke");
    });
    p.onError(() => {
      ran.push("two");
      throw new Error("second broke");
    });
    p.ydoc.getMap("m").set("a", 1);
    await expect(vi.advanceTimersByTimeAsync(0)).rejects.toThrow("2 onError listeners threw; the first: first broke");
    expect(ran).toEqual(["one", "two"]);
    expect(p.error()).toMatchObject({ code: "store.io" });
  });

  it("a loaded doc with records compacts on the timer", async () => {
    const source = new Y.Doc();
    const records: Uint8Array[] = [];
    source.on("update", (u: Uint8Array) => records.push(u));
    source.getMap("m").set("a", 1);
    source.getMap("m").set("b", 2);
    resetTauri({ store_load: () => encodeLoad({ records, lastSeq: 5 }), store_compact: () => null });
    const p = await openPersisted("p1");
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS - 1);
    expect(writes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes().map((c) => [c.cmd, Number(headerOf(c, "x-seq"))])).toEqual([["store_compact", 5]]);
    const body = bodyOf(present(writes()[0], "store_compact call"));
    expect(body).toEqual(Y.encodeStateAsUpdate(p.ydoc));
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, body);
    expect(rebuilt.getMap("m").toJSON()).toEqual({ a: 1, b: 2 });
  });

  it("stored updates that reference missing state are corrupt", async () => {
    const source = new Y.Doc();
    const records: Uint8Array[] = [];
    source.on("update", (u: Uint8Array) => records.push(u));
    source.getMap("m").set("a", 1);
    source.getMap("m").set("b", 2);
    resetTauri({ store_load: () => encodeLoad({ records: [records[1]], lastSeq: 2 }) });
    await expect(openPersisted("p1")).rejects.toMatchObject({ code: "store.corrupt", message: "p1: stored updates reference missing state" });
  });

  it("a record count larger than the answer is refused", async () => {
    const bytes = new Uint8Array(encodeLoad({ lastSeq: 0 }));
    new DataView(bytes.buffer).setUint32(9, 0xffffffff, true);
    resetTauri({ store_load: () => bytes.buffer });
    await expect(openPersisted("p1")).rejects.toMatchObject({ code: "ipc.shape", message: "store_load p1: count 4294967295 does not fit in 4 bytes" });
  });

  it("a load failure rejects with its AppError", async () => {
    resetTauri({
      store_load: () => {
        throw { code: "store.corrupt", message: "seg-1.log: bad record" };
      },
    });
    await expect(openPersisted("p1")).rejects.toMatchObject({ code: "store.corrupt", message: "seg-1.log: bad record" });
  });

  it("discard on a dirty load never compacts", async () => {
    const source = new Y.Doc();
    const records: Uint8Array[] = [];
    source.on("update", (u: Uint8Array) => records.push(u));
    source.getMap("m").set("a", 1);
    resetTauri({ store_load: () => encodeLoad({ records, lastSeq: 5 }), store_compact: () => null, store_append: () => null });
    const p = await openPersisted("p1");
    await p.discard();
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS * 2);
    expect(writes()).toEqual([]);
    let thrown: unknown = null;
    try {
      p.ydoc.getMap("m").set("b", 2);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ code: "store.closed", message: "Document p1 was edited after close" });
    await expect(p.compact()).rejects.toMatchObject({ code: "store.closed" });
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS * 2);
    expect(writes()).toEqual([]);
  });

  it("discard rejects queued appends and waits for the one in flight", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 7 }), store_append: () => null, store_compact: () => null });
    const p = await openPersisted("p1");
    const first = hold("store_append");
    p.ydoc.getMap("m").set("a", 1);
    await settle();
    const inFlight = p.flush();
    p.ydoc.getMap("m").set("b", 2);
    p.ydoc.getMap("m").set("c", 3);
    const queued = p.flush();
    const queuedOutcome = queued.then(
      () => null,
      (e: unknown) => e,
    );
    let done = false;
    const discarded = p.discard().then(() => {
      done = true;
    });
    const gone = await queuedOutcome;
    expect(gone).toBeInstanceOf(AppError);
    expect(gone).toMatchObject({ code: "store.closed", message: "Document p1 was discarded" });
    await settle();
    expect(done).toBe(false);
    first.resolve(null);
    await discarded;
    await inFlight;
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS * 2);
    expect(writes().map((c) => [c.cmd, Number(headerOf(c, "x-seq"))])).toEqual([["store_append", 8]]);
  });

  it("discard resolves when the op in flight fails and tells no listener", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 7 }), store_append: () => null });
    const p = await openPersisted("p1");
    const heard: AppError[] = [];
    p.onError((e) => heard.push(e));
    const first = hold("store_append");
    p.ydoc.getMap("m").set("a", 1);
    await settle();
    const discarded = p.discard();
    expect(p.discard()).toBe(discarded);
    first.reject({ code: "store.io", message: "disk full" });
    await expect(discarded).resolves.toBeUndefined();
    await settle();
    expect(heard).toEqual([]);
    expect(writes()).toHaveLength(1);
  });
});

describe("callBytes", () => {
  it("callBytes shape", async () => {
    resetTauri({ plan_import: () => [1, 2], store_load: () => new Uint8Array([1, 2]).buffer });
    const e = await callBytes("plan_import").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.shape" });
    await expect(callBytes("store_load", { doc: "p1" })).resolves.toEqual(new Uint8Array([1, 2]));
    resetTauri({ plan_import: () => new ArrayBuffer(0) });
    await expect(callBytes("plan_import")).resolves.toEqual(new Uint8Array(0));
    expect(tauri.calls).toHaveLength(1);
    expect(tauri.calls[0].args).toBeUndefined();
    expect(tauri.calls[0].options).toBeUndefined();
  });
});
